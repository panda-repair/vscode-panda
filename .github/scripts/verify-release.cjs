const { execFileSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");

const repository = "panda-repair/vscode-panda";
const workflow = ".github/workflows/ci.yml";

function command(executable, args, failure) {
  try { return execFileSync(executable, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 }); }
  catch { throw new Error(failure); }
}

function checkCI(sha) {
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
  const tagCommit = command("git", ["rev-parse", "--verify", "refs/tags/" + TAG + "^{commit}"], "Release tag not found.").trim();
  if (tagCommit !== sha) throw new Error("The release tag must point to the exact reviewed commit.");
  const main = command("git", ["show-ref", "--verify", "--hash", "refs/remotes/origin/main"], "Missing origin/main.").trim();
  command("git", ["merge-base", "--is-ancestor", sha, main], "The reviewed commit must be on main.");
  const { version } = JSON.parse(command("git", ["show", sha + ":package.json"], "Missing package.json in the reviewed commit."));
  if (typeof version !== "string" || "v" + version !== TAG) throw new Error("The manifest version must exactly match the tag.");
  checkCI(sha);
  const epoch = command("git", ["show", "-s", "--format=%ct", sha], "Missing reviewed commit timestamp.").trim();
  appendFileSync(process.env.GITHUB_OUTPUT, "sha=" + sha + "\nepoch=" + epoch + "\n");
}

try { verify(); } catch (error) { console.error(error.message); process.exitCode = 1; }
