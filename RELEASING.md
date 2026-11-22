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

1. For a new version, update `package.json` and the lockfile with `npm version X.Y.Z --no-git-tag-version`. Merge the reviewed changes to `main`. Wait for the **Check extension** workflow for that exact push to succeed.
2. From a clean checkout of the intended commit, build and inspect the archive. The packaging command builds in a temporary directory with normalized file modes. Record both the first command's full commit SHA and the last command's VSIX SHA-256 in the release approval. The commands below build version 0.1.0.

   ```sh
   git rev-parse HEAD
   npm ci
   TZ=UTC SOURCE_DATE_EPOCH="$(git show -s --format=%ct HEAD)" npm run package
   shasum -a 256 panda-0.1.0.vsix
   ```

3. A designated releaser copies the approved values, tags that SHA and dispatches **Release to Visual Studio Marketplace** on `main`. Substitute the recorded hashes below.

   ```sh
   tag=v0.1.0
   sha='<reviewed 40-character commit SHA>'
   vsix_sha256='<approved 64-character VSIX SHA-256>'
   git tag -a "$tag" "$sha" -m "Release $tag" -m "vsix-sha256: $vsix_sha256"
   git push origin "refs/tags/$tag"
   gh workflow run release.yml --repo panda-repair/vscode-panda --ref main \
     -f tag="$tag" -f sha="$sha" -f vsix_sha256="$vsix_sha256"
   ```

4. Check the release run in **Actions**. Protected main's workflow verifies the annotated tag's approval, commit, manifest version and latest CI result for that main push. Read-only jobs prepare the locked publisher and rebuild the VSIX against the digest from the tag. The publishing job downloads both artifacts by ID and rechecks the VSIX against the dispatch digest. If publication needs a retry, select **Re-run all jobs** to refresh verification and build both artifacts. Confirm the version in Marketplace. To correct a published release, prepare a new version.
