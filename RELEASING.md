# Releasing Panda to Visual Studio Marketplace

A release publishes the reviewed VSIX for a specific commit. A designated releaser records the archive's SHA-256 in a protected annotated tag on that commit. Start the workflow from protected `main` with the same tag, full SHA and digest.

## One-time setup

1. Sign in to Visual Studio Marketplace with the Microsoft account that will manage this extension. Create or open the publisher and record its permanent ID. The current `panda-repair` ID is provisional. Confirm ownership or replace it in `package.json`, the README and the integration tests that identify `<publisher>.panda`. The first successful publish creates the listing. [Publisher management](https://marketplace.visualstudio.com/manage) · [Register a publisher](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#_create-a-publisher)
2. The workflow checks the canonical GitHub name `panda-repair/vscode-panda` because the repository's numeric ID is not yet known. Confirm the name before enabling releases. Enable Actions, put `.github/workflows/release.yml` on the default branch `main`, and protect `main` with review and CI requirements. Review changes to the release workflow, its verification script, CI and the publishing tool's lockfile. The optional `repository` field in `package.json` links the listing to the source.
3. In **Settings → Rules → Rulesets**, create an active **tag ruleset** targeting `v*`. Enable **Restrict creations**, **Restrict updates** and **Restrict deletions**. Give bypass permission only to designated releasers. Their digest in the tag message approves the exact VSIX. [GitHub tag rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository)
4. In **Settings → Environments → marketplace → Deployment branches and tags**, choose **Selected branches and tags**. Add one **Branch** rule, `main`. Remove any tag rules, including an earlier `v*` rule. The project owner can also require an environment reviewer for a separate go-live decision. For a private repository, confirm the plan supports these deployment restrictions. [GitHub deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
5. In the Marketplace publisher portal, open **Trusted Publishing → Create**. Enter a policy name, the exact GitHub owner login, the repository name alone, the workflow filename `release.yml` and the environment `marketplace`. For a private repository, complete the first successful token exchange within **48 hours** of creating the policy. That exchange activates it permanently. [Marketplace Trusted Publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#_publish-with-github-actions-and-trusted-publishing)

GitHub Actions supplies the short-lived publishing identity to `vsce publish --oidc`. This path requires no PAT, Azure DevOps organization or Entra service connection. Microsoft's `--azure-credential` instructions apply to Azure Pipelines. [Microsoft's publishing methods](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#_secure-automated-publishing-to-visual-studio-marketplace)

## Review and publish

1. For a new version, run `npm version X.Y.Z --no-git-tag-version` to update `package.json` and the lockfile in your checkout. Running `npm run package -- patch --no-git-tag-version` changes the version only in the staged VSIX. Merge the reviewed changes to `main`. Wait for the latest **Check extension** **push** run for that exact commit to succeed. Open its **canonical-package** job summary. It links the raw `canonical-panda-<attempt>.vsix` and gives its artifact ID, commit SHA and SHA-256. Copy those three values from the same attempt. If the artifact expired or a partial rerun lacks one, use **Re-run all jobs**. A commit predating the canonical job must be replaced by a reviewed commit that includes it.
2. As a designated releaser, start in a clean checkout of the reported commit. In Bash, substitute the three values below. The commands verify the downloaded bytes against the summary, then compare every filename and its SHA-256 with a local package including the generated VSIX manifest and content-types XML. Different compressors can produce different archive bytes for identical contents. The tag approves the **CI archive’s digest**. Any failed check stops the commands before tagging or dispatch.

   ```bash
   (
     set -euo pipefail
     sha='<full commit SHA from the canonical job>'
     digest='<SHA-256 from the same summary>'
     artifact_id='<artifact ID from the same summary>'
     [[ "$sha" =~ ^[0-9a-f]{40}$ && "$digest" =~ ^[0-9a-fA-F]{64}$ && "$artifact_id" =~ ^[1-9][0-9]*$ ]]
     head=$(git rev-parse --verify HEAD)
     changes=$(git status --porcelain)
     [[ "$head" == "$sha" && -z "$changes" ]]
     out=$(mktemp -d "${TMPDIR:-/tmp}/panda-approval.XXXXXXXX")
     gh api "repos/panda-repair/vscode-panda/actions/artifacts/$artifact_id/zip" > "$out/ci.vsix"
     printf '%s  %s\n' "$digest" "$out/ci.vsix" | shasum -a 256 --check --strict
     npm ci --ignore-scripts
     bash .github/scripts/pack-release.sh "$sha" "$out/local.vsix"
     python3 .github/scripts/compare-package.py "$out/ci.vsix" "$out/local.vsix"

     tag="v$(node -p 'require("./package.json").version')"
     git tag -a "$tag" "$sha" -m "Release $tag" -m "vsix-sha256: $digest"
     git push origin "refs/tags/$tag"
     gh workflow run release.yml --repo panda-repair/vscode-panda --ref main \
       -f tag="$tag" -f sha="$sha" -f vsix_sha256="$digest"
   )
   ```

Protected main’s workflow checks the tag, commit, manifest version and latest main-push CI artifact. Read-only jobs prepare the locked publisher and build the VSIX twice. Dependency installation skips lifecycle scripts. Each package build still runs the extension’s prepublish hook to typecheck and bundle it. Both archives must match byte for byte and match the tag digest. The publishing job downloads the verified VSIX and trusted tool by ID and checks the VSIX against the dispatch digest. To retry the release, choose **Re-run all jobs**. GitHub allows reruns for 30 days after the original run. Artifacts expire after 90 days by default, so **Re-run all jobs** can be unavailable when the verifier rejects an expired artifact. In that case, merge a new reviewed commit and approve its canonical main-push build. If the SHA, approved digest or workflow changes, start a fresh release dispatch. A rerun keeps its original SHA and inputs. Confirm the version in Marketplace. To correct a published release, prepare a new version.

Use Node **24.21.0** for the comparison build. When changing the toolchain, update both packaging jobs in `.github/workflows/ci.yml` and every `setup-node` step in `.github/workflows/release.yml` together. Approve the digest from a successful main push that built with the new pin.
