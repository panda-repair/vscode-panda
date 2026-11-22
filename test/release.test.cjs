const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
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
  const path = "repos/panda-repair/vscode-panda/actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=" +
    process.env.REVIEWED_SHA.toLowerCase() + "&per_page=100";
  require("node:assert/strict").deepEqual(args, ["api", "--paginate", "--slurp", path]);
  if (process.env.FAIL_API) throw new Error("Offline API failure");
  return process.env.RUN_PAGES;
};`);
  const canonical = { full_name: env.GITHUB_REPOSITORY };
  const green = { id: 1, run_number: 10, head_sha: sha, event: "push", head_branch: "main", path: ".github/workflows/ci.yml",
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
