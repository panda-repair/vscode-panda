const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

test("the release guard binds a stable tag, reviewed Git object and latest canonical main push CI", t => {
  const cwd = mkdtempSync(join(tmpdir(), "panda-release-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(cwd, "empty.gitconfig"),
    GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@test.invalid",
    GIT_COMMITTER_EMAIL: "fixture@test.invalid", GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: "panda-repair/vscode-panda", GITHUB_REF: "refs/heads/main", GITHUB_OUTPUT: join(cwd, "output") };
  const git = (...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const approval = "vsix-sha256: " + "A".repeat(64);
  const tagRelease = (tag, target, text = approval) => git("tag", "-am", "Release fixture", "-m", text, tag, target);
  git("init", "-q", "-b", "main");
  function commit(version) {
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ version }));
    git("add", "package.json"); git("-c", "commit.gpgSign=false", "commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  }
  const side = commit("0.0.9");
  tagRelease("v0.0.9", side);
  git("switch", "--orphan", "reviewed");
  const sha = commit("0.1.0");
  tagRelease("v0.1.0", sha);
  const malformed = commit("0.2.0\n"); tagRelease("v0.2.0", malformed);
  const main = commit("0.3.0"); tagRelease("v0.4.0", main);
  git("update-ref", "refs/remotes/origin/main", main);
  const script = resolve(__dirname, "../.github/scripts/verify-release.cjs");
  // Only the Actions API is substituted. Execute the same guard and Git queries as the workflow.
  const stub = join(cwd, "offline-gh.cjs");
  writeFileSync(stub, `const cp = require("node:child_process"), original = cp.execFileSync;
cp.execFileSync = (file, args, options) => {
  if (file !== "gh") return original(file, args, options);
  if (args.length === 2) {
    const runs = JSON.parse(process.env.RUN_PAGES).flatMap(page => page.workflow_runs);
    const latest = runs.reduce((a, b) => a.run_number > b.run_number ? a : b);
    const name = "canonical-panda-" + latest.run_attempt + ".vsix";
    const url = "repos/panda-repair/vscode-panda/actions/runs/" + latest.id + "/artifacts?name=" + name + "&per_page=100";
    require("node:assert/strict").deepEqual(args, ["api", url]);
    if (process.env.FAIL_ARTIFACT) throw new Error("Fixture artifact API failure");
    return process.env.ARTIFACT_LIST ?? JSON.stringify({ total_count: 1, artifacts: [
      { id: 123, name, expired: false, digest: "sha256:" + "a".repeat(64), workflow_run: { id: latest.id, head_sha: latest.head_sha } }
    ] });
  }
  const path = "repos/panda-repair/vscode-panda/actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=" +
    process.env.REVIEWED_SHA.toLowerCase() + "&per_page=100";
  require("node:assert/strict").deepEqual(args, ["api", "--paginate", "--slurp", path]);
  if (process.env.FAIL_API) throw new Error("Offline API failure");
  return process.env.RUN_PAGES;
};`);
  const canonical = { full_name: env.GITHUB_REPOSITORY };
  const green = { id: 1, run_attempt: 2, run_number: 10, head_sha: sha, event: "push", head_branch: "main", path: ".github/workflows/ci.yml",
    repository: canonical, head_repository: canonical, status: "completed", conclusion: "success" };
  const fixture = (runs, total = runs.length) => [{ total_count: total, workflow_runs: runs }];
  const cases = [
    ["annotated tag on main", {}, fixture([green]), true],
    ["mixed-case input agrees with the tag", { VSIX_SHA256: "aA".repeat(32) }, fixture([green]), true],
    ["uppercase hashes and documented workflow path", { REVIEWED_SHA: sha.toUpperCase() }, fixture([{ ...green, path: green.path + "@main" }]), true],
    ["wrong repository", { GITHUB_REPOSITORY: "fixture/fork" }],
    ["wrong ref", { GITHUB_REF: "refs/tags/v0.1.0" }],
    ["wrong event", { GITHUB_EVENT_NAME: "push" }],
    ["short commit", { REVIEWED_SHA: sha.slice(0, 7) }],
    ["bad digest", { VSIX_SHA256: "a".repeat(63) }],
    ["nonstable tag", { TAG: "v01.0.0" }],
    ["missing tag", { TAG: "v5.0.0" }],
    ["digest differs from tag", { VSIX_SHA256: "0".repeat(64) }],
    ["wrong tagged commit", { REVIEWED_SHA: main }],
    ["outside main", { TAG: "v0.0.9", REVIEWED_SHA: side }],
    ["unmodified JSON string", { TAG: "v0.2.0", REVIEWED_SHA: malformed }],
    ["manifest mismatch", { TAG: "v0.4.0", REVIEWED_SHA: main }],
    ["no CI", {}, fixture([])],
    ["API error", { FAIL_API: "yes" }],
    ["incomplete API pages", {}, fixture([green], 2)],
    ["in-progress newer CI", {}, fixture([{ ...green, id: 2, run_number: 11, status: "in_progress", conclusion: null }, green])],
    ["newer failed CI", {}, fixture([green, { ...green, id: 2, run_number: 11, conclusion: "failure" }])],
    ["newer successful CI", {}, fixture([{ ...green, run_number: 9, conclusion: "failure" }, { ...green, id: 2 }]), true],
  ];
  for (const change of [{ path: ".github/workflows/other.yml" }, { path: green.path + "@topic" }, { event: "pull_request" },
    { repository: { full_name: "fixture/fork" } }, { head_repository: { full_name: "fixture/fork" } },
    { head_branch: "topic" }, { head_sha: main }]) {
    cases.push(["wrong CI identity " + Object.keys(change)[0], {}, fixture([{ ...green, ...change }])]);
  }
  function check([name, override, pages = fixture([green]), allowed = false]) {
    writeFileSync(env.GITHUB_OUTPUT, "");
    const result = spawnSync(process.execPath, ["--require", stub, script], { cwd, encoding: "utf8", env: {
      ...env, TAG: "v0.1.0", REVIEWED_SHA: sha, VSIX_SHA256: "A".repeat(64), RUN_PAGES: JSON.stringify(pages), ...override,
    } });
    assert.equal(result.status, allowed ? 0 : 1, name + ": " + result.stderr);
    const expected = "sha=" + sha + "\nepoch=" + git("show", "-s", "--format=%ct", sha) + "\napproved_digest=" + "a".repeat(64) + "\n";
    assert.equal(readFileSync(env.GITHUB_OUTPUT, "utf8"), allowed ? expected : "", name);
  }
  cases.forEach(check);
  const artifact = { id: 123, name: "canonical-panda-2.vsix", expired: false, digest: "sha256:" + "a".repeat(64) };
  for (const [label, artifacts] of [
    ["legacy CI with no package", []], ["ambiguous artifacts", [artifact, artifact]],
    ["expired package", [{ ...artifact, expired: true }]],
    ["artifact from another run", [{ ...artifact, workflow_run: { id: 99, head_sha: sha } }]],
    ["package from an older attempt", [{ ...artifact, name: "canonical-panda-1.vsix" }]],
    ["tag approved different archive bytes", [{ ...artifact, digest: "sha256:" + "b".repeat(64) }]],
  ]) check([label, { ARTIFACT_LIST: JSON.stringify({ total_count: artifacts.length, artifacts }) }, fixture([green])]);
  check(["artifact API unavailable", { FAIL_ARTIFACT: "yes" }, fixture([green])]);
  check(["missing attempt", {}, fixture([{ ...green, run_attempt: undefined }])]);
  tagRelease("approved-inner", sha);
  git("tag", "-d", "v0.1.0");
  git("-c", "advice.nestedTag=false", "tag", "-a", "-m", approval, "-m", "object " + sha + "\ntype commit",
    "v0.1.0", "approved-inner");
  check(["both annotations approve the digest, but the release tag targets another tag", {}]);
  const signature = "-----BEGIN SSH SIGNATURE-----\n" + approval + "\n-----END SSH SIGNATURE-----";
  for (const [name, text, allowed] of [
    ["lightweight tag", null], ["missing digest line", "Release approved without a checksum"],
    ["duplicate digest", approval + "\n" + approval], ["conflicting malformed line", approval + "\nVSIX-sha256: invalid"],
    ["invalid tag hex", "vsix-sha256: " + "Z".repeat(64)], ["digest in signature only", signature],
    ["valid digest in message, signature ignored", approval + "\n\n" + signature, true],
  ]) {
    git("tag", "-d", "v0.1.0");
    if (text === null) git("tag", "v0.1.0", sha);
    else tagRelease("v0.1.0", sha, text);
    check([name, {}, fixture([green]), allowed]);
  }
  git("update-ref", "-d", "refs/remotes/origin/main");
  check(["missing exact remote main", {}]);
});

test("the canonical CI artifact and the release's two packs obey the same approval", t => {
  const root = resolve(__dirname, "..");
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8").split("\n  canonical-package:\n")[1];
  const release = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
  assert.match(ci, /github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.match(ci, /github\.repository == 'panda-repair\/vscode-panda'/);
  assert.match(ci, /permissions:\s*contents: read\n/);
  assert.match(ci, /archive: false/);
  assert.match(ci, /run: npm ci --ignore-scripts\n/);
  assert.match(release, /test "\$\(git rev-parse HEAD\)" = "\$REVIEWED_SHA"\n\s+npm ci --ignore-scripts\n/);
  assert.match(ci, /steps\.package\.outputs\.artifact-digest/);
  assert.match(ci, /GITHUB_STEP_SUMMARY/);
  const pin = ci.match(/node-version: "(\d+\.\d+\.\d+)"/)[1];
  assert.deepEqual([...release.matchAll(/node-version: (.+)/g)].map(match => match[1]), Array(3).fill('"' + pin + '"'));

  const canonicalPack = ci.match(/^        run: (bash \.github\/scripts\/pack-release\.sh .+)$/m)[1];
  const step = release.split("      - name: Build and verify the reviewed archive\n")[1];
  const releasePack = step.split("        run: |\n")[1].split("\n      - name:")[0].replace(/^ {10}/gm, "");
  const cwd = mkdtempSync(join(tmpdir(), "canonical-package-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const scripts = join(cwd, ".github", "scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, "pack-release.sh"),
    'set -eu\n[[ "$1" == "$GITHUB_SHA" ]]\nprintf reviewed > "$2"\nif [[ "${DIVERGE:-}" && "$2" == */second-* ]]; then printf different >> "$2"; fi\n');
  const sha = "1".repeat(40);
  const env = { PATH: process.env.PATH, RUNNER_TEMP: cwd, GITHUB_RUN_ATTEMPT: "2", GITHUB_SHA: sha, REVIEWED_SHA: sha };
  const run = (shell, extra = {}) => spawnSync("bash", ["-eo", "pipefail", "-c", shell], { cwd, env: { ...env, ...extra }, encoding: "utf8" });
  assert.equal(run(canonicalPack).status, 0);
  const artifact = readFileSync(join(cwd, "canonical-panda-2.vsix"));
  const digest = createHash("sha256").update(artifact).digest("hex");
  assert.equal(run(releasePack, { VSIX_SHA256: digest }).status, 0);
  assert.equal(run(releasePack, { VSIX_SHA256: "b".repeat(64) }).status, 1);
  assert.equal(run(releasePack, { VSIX_SHA256: digest, DIVERGE: "1" }).status, 1);
});

test("package content approval ignores compression and checks the package and VSIX metadata", t => {
  const helper = resolve(__dirname, "../.github/scripts/compare-package.py");
  const cwd = mkdtempSync(join(tmpdir(), "package-comparison-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  execFileSync("python3", ["-I", "-B", "-W", "ignore::UserWarning", "-c", `
import stat, zipfile
for case in ("canonical", "local", "changed", "missing", "duplicate", "link"):
    compression = zipfile.ZIP_STORED if case == "local" else zipfile.ZIP_DEFLATED
    with zipfile.ZipFile(case + ".vsix", "w", compression=compression) as package:
        package.writestr("extension/package.json", b"approved")
        package.writestr("extension.vsixmanifest", b"changed platform" if case == "changed" else b"approved platform")
        if case != "missing":
            package.writestr("[Content_Types].xml", b"types")
        if case == "duplicate":
            package.writestr("extension/package.json", b"again")
        if case == "link":
            member = zipfile.ZipInfo("extension/link")
            member.external_attr = (stat.S_IFLNK | 0o777) << 16
            package.writestr(member, "package.json")
`], { cwd });
  const compare = (a, b) => spawnSync("python3", ["-I", "-B", helper, a + ".vsix", b + ".vsix"], { cwd, encoding: "utf8" });
  assert.notDeepEqual(readFileSync(join(cwd, "canonical.vsix")), readFileSync(join(cwd, "local.vsix")));
  const match = compare("canonical", "local");
  assert.equal(match.status, 0, match.stderr);
  assert.ok(match.stdout.includes("extension.vsixmanifest"));
  for (const change of ["changed", "missing"]) assert.equal(compare("canonical", change).status, 1);
  for (const unsafe of ["duplicate", "link"]) assert.equal(compare(unsafe, unsafe).status, 1);
});
