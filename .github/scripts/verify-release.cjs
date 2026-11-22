const { execFileSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");

const repository = "panda-repair/vscode-panda";
const workflow = ".github/workflows/ci.yml";

function command(executable, args, failure) {
  try { return execFileSync(executable, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 }); }
  catch { throw new Error(failure); }
}

function approvedDigest(tag, sha, submitted) {
  // Capture the outer object and its signature together, even if the ref moves afterwards.
  const format = "%(objecttype)%00%(objectname)%00%(contents:signature)";
  const record = command("git", ["--no-replace-objects", "tag", "--list", tag, "--format=" + format], "Could not read the release tag.");
  const fields = record.slice(0, -1).split("\0");
  const [type, objectId, signature] = fields;
  if (fields.length !== 3 || type !== "tag") throw new Error("Expected an annotated release tag.");
  const raw = command("git", ["--no-replace-objects", "cat-file", "tag", objectId], "Could not read the annotated release tag.");
  const headerEnd = raw.indexOf("\n\n");
  const [objectHeader, typeHeader] = raw.slice(0, headerEnd).split("\n", 2);
  if (headerEnd < 0 || objectHeader !== "object " + sha || typeHeader !== "type commit") {
    throw new Error("The release tag must point directly to the exact reviewed commit.");
  }
  const contents = raw.slice(headerEnd + 2);
  if (contents.includes("\0") || !contents.endsWith(signature)) throw new Error("Invalid release tag message.");
  const message = contents.slice(0, contents.length - signature.length);
  const lines = message.split("\n").filter(line => line.trimStart().toLowerCase().startsWith("vsix-sha256"));
  const digest = /^vsix-sha256: ([a-fA-F0-9]{64})$/.exec(lines[0])?.[1].toLowerCase();
  if (!digest || lines.length !== 1) throw new Error("Expected one vsix-sha256: <64 hex> line in the tag message.");
  if (digest !== submitted.toLowerCase()) throw new Error("The dispatch digest must match the protected tag's approval.");
  return digest;
}

function checkCI(sha, approved) {
  const url = "repos/" + repository + "/actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=" + sha + "&per_page=100";
  const pages = JSON.parse(command("gh", ["api", "--paginate", "--slurp", url], "Could not read the CI runs."));
  const runs = pages.flatMap(page => page.workflow_runs);
  if (!runs.length || pages.some(page => page.total_count !== runs.length) ||
      new Set(runs.map(run => run.run_number)).size !== runs.length) {
    throw new Error("Expected a complete list of CI runs for the reviewed commit.");
  }
  const paths = [workflow, workflow + "@main", workflow + "@refs/heads/main", workflow + "@" + sha];
  for (const run of runs) {
    if (!paths.includes(run.path) || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository ||
        run.event !== "push" || run.head_branch !== "main" || run.head_sha !== sha ||
        !Number.isSafeInteger(run.run_number) || run.run_number < 1) {
      throw new Error("CI evidence does not match the canonical main push for this commit.");
    }
  }
  const latest = runs.reduce((newest, run) => run.run_number > newest.run_number ? run : newest);
  if (latest.status !== "completed" || latest.conclusion !== "success") {
    throw new Error("The latest main push CI for the reviewed commit must be complete and successful.");
  }
  if (![latest.id, latest.run_attempt].every(n => Number.isSafeInteger(n) && n > 0)) {
    throw new Error("Expected a CI run ID and attempt for the canonical package.");
  }
  const name = `canonical-panda-${latest.run_attempt}.vsix`;
  const path = `repos/${repository}/actions/runs/${latest.id}/artifacts?name=${name}&per_page=100`;
  const listing = JSON.parse(command("gh", ["api", path], "Could not read the canonical CI artifact."));
  const [artifact] = listing.artifacts;
  const source = artifact?.workflow_run;
  if (listing.total_count !== 1 || listing.artifacts.length !== 1 || artifact?.name !== name || artifact.expired !== false ||
      !Number.isSafeInteger(artifact.id) || artifact.id < 1 ||
      (source && (source.id !== latest.id || source.head_sha !== sha)) ||
      artifact.digest !== "sha256:" + approved) {
    throw new Error("The tag must approve the current canonical CI artifact. If it is missing or expired, re-run all CI jobs.");
  }
}

function verify() {
  const { GITHUB_EVENT_NAME, GITHUB_REF, GITHUB_REPOSITORY, TAG, REVIEWED_SHA, VSIX_SHA256 } = process.env;
  if (GITHUB_EVENT_NAME !== "workflow_dispatch" || GITHUB_REF !== "refs/heads/main" || GITHUB_REPOSITORY !== repository) {
    throw new Error("Dispatch the release from the canonical repository's main branch.");
  }
  const stableTag = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
  if (!stableTag.test(TAG) || !/^[a-f0-9]{40}$/i.test(REVIEWED_SHA) || !/^[a-f0-9]{64}$/i.test(VSIX_SHA256)) {
    throw new Error("Supply a stable vMAJOR.MINOR.PATCH tag, a full commit SHA and a VSIX SHA-256.");
  }
  const sha = REVIEWED_SHA.toLowerCase();
  const digest = approvedDigest(TAG, sha, VSIX_SHA256);
  const main = command("git", ["show-ref", "--verify", "--hash", "refs/remotes/origin/main"], "Missing origin/main.").trim();
  command("git", ["merge-base", "--is-ancestor", sha, main], "The reviewed commit must be on main.");
  const { version } = JSON.parse(command("git", ["show", sha + ":package.json"], "Missing package.json in the reviewed commit."));
  if (typeof version !== "string" || "v" + version !== TAG) throw new Error("The manifest version must exactly match the tag.");
  checkCI(sha, digest);
  const epoch = command("git", ["show", "-s", "--format=%ct", sha], "Missing reviewed commit timestamp.").trim();
  appendFileSync(process.env.GITHUB_OUTPUT, "sha=" + sha + "\nepoch=" + epoch + "\napproved_digest=" + digest + "\n");
}

try { verify(); } catch (error) { console.error(error.message); process.exitCode = 1; }
