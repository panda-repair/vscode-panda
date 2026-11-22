# Releasing Panda to Visual Studio Marketplace

A `vMAJOR.MINOR.PATCH` tag publishes the matching commit from `main`. Set up the publisher and GitHub protections before pushing the first release tag.

## One-time setup

1. Sign in to the Visual Studio Marketplace with the Microsoft account that will manage this extension. Create or open the publisher and record its permanent ID. The current `panda-repair` ID is provisional. Confirm ownership or replace it in `package.json`, the README and the integration tests that identify `<publisher>.panda`. The first successful publish creates the extension listing. [Publisher management](https://marketplace.visualstudio.com/manage) · [Register a publisher](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#_create-a-publisher)
2. On the GitHub repository that will host releases, enable Actions and put `.github/workflows/release.yml` on `main`. The optional `repository` field in `package.json` adds a Marketplace link to the actual source repository.
3. In **Settings → Rules → Rulesets**, create an active **tag ruleset** targeting `v*`. Enable **Restrict creations**, **Restrict updates** and **Restrict deletions**. Give bypass permission only to the designated releasers. [GitHub tag rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository)
4. In **Settings → Environments**, create `marketplace`. Under **Deployment branches and tags**, select **Selected branches and tags** and add a **Tag** rule for `v*`. Keep this environment restricted to release tags. [GitHub deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
5. In the Marketplace publisher portal, open **Trusted Publishing → Create**. Give the policy a descriptive name. Enter the exact GitHub owner login, the repository name alone, the workflow filename `release.yml`, and the environment `marketplace`. For a private repository, complete the first successful token exchange within **48 hours** of creating the policy. That exchange activates it permanently. [Marketplace Trusted Publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#_publish-with-github-actions-and-trusted-publishing)

GitHub Actions supplies the short-lived identity to `vsce publish --oidc`. This path requires no PAT, Azure DevOps organization or Entra service connection. Microsoft's `--azure-credential` instructions apply to Azure Pipelines. [Microsoft's publishing methods](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#_secure-automated-publishing-to-visual-studio-marketplace)

## Publish a version

1. Confirm the version in `package.json` and `package-lock.json`. For later releases, use `npm version X.Y.Z --no-git-tag-version` and commit the version change. Merge the release changes to `main` and confirm CI passed for the intended commit.
2. As a designated releaser, tag that commit. These commands publish the first release at the tip of `origin/main`.

   ```sh
   git fetch origin main
   git tag -a v0.1.0 origin/main -m "Release 0.1.0"
   git push origin refs/tags/v0.1.0
   ```

3. Open **Actions → Release to Visual Studio Marketplace** and check the result. The workflow validates the tag and ancestry, installs locked dependencies with Node 24, runs the unit tests and builds the VSIX in UTC using the tagged commit's timestamp. It publishes that exact file with the locked `vsce` binary. Confirm the version appears under the publisher in Marketplace. For a correction after publication, release a new version.
