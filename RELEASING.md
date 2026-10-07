# Releasing

A release lives in five places that must agree: `package.json`, a `vX.Y.Z` git tag, npm
(`@alexwkleung/reika`), the Homebrew tap (`alexwkleung/homebrew-tap`) and the GitHub release.
The rule that keeps them in sync: **build the tarball once, then publish, hash and attach that same
file everywhere.**

`X.Y.Z` below is the new version. A version can never be published twice, so a broken release is
fixed by the next patch, not a re-publish.

## Automated (`.github/workflows/release.yml`)

1. **Bump.** Set `version` in `package.json` in a PR and merge it. CI must be green on `main`.

2. **Tag.** `git checkout main && git pull && git tag vX.Y.Z && git push origin vX.Y.Z`. The workflow
   refuses a tag that disagrees with `package.json` or is not on `main`. It runs `check` and
   `release:check`, stages that tarball on npm, creates the GitHub release with the same file and
   opens a PR on the tap with its sha256. Edit the generated release notes if they need it.

3. **Approve on npm.** In a normal terminal (2FA):

   ```sh
   npm whoami   # an expired login reports E404 on a scoped package, not 401
   npm stage list @alexwkleung/reika
   npm stage approve <stage-id>
   ```

   `npm stage reject <stage-id>` throws a bad build away. That version is then spent.

4. **Merge the tap PR** in `alexwkleung/homebrew-tap`.

5. **Verify.** `pnpm run release:verify` (below).

### One-time setup

- **npm trust, staging only.** CI gets no npm token; GitHub's OIDC identity for this workflow may
  stage and nothing else, so nothing reaches `latest` without a 2FA approve:

  ```sh
  npm trust github @alexwkleung/reika --repo alexwkleung/reika --file release.yml --allow-stage-publish
  ```

  Then on npmjs.com, package settings → publishing access: _Require two-factor authentication and
  disallow tokens_.

- **`TAP_TOKEN` secret.** A fine-grained GitHub token for `alexwkleung/homebrew-tap` only, with
  Contents and Pull requests read/write: `gh secret set TAP_TOKEN --repo alexwkleung/reika`.

## By hand

The fallback when the workflow cannot run, and what it automates.

1. **Bump.** Set `version` in `package.json` in a PR and merge it. CI must be green on `main`.

2. **Build once.** On `main` with a clean tree:

   ```sh
   OUT=~/reika-release pnpm run release:check
   ```

   It packs, installs, runs and imports the package, and prints the sha256. Keep the tarball.

3. **npm.** In a normal terminal, since 2FA opens a browser and has to wait for you. Check
   `npm whoami` first: an expired login fails the publish as `E404 … could not be found`.

   ```sh
   npm publish ~/reika-release/alexwkleung-reika-X.Y.Z.tgz
   ```

   The registry can take a minute or two to serve a new version, and the npm website lags it further.
   Check with `npm view @alexwkleung/reika version` rather than the web page.

4. **Tap.** In `~/Git/homebrew-tap`, set `url` (`…/reika-X.Y.Z.tgz`) and `sha256` (from step 2) in
   `Formula/reika.rb`, commit and push. Optionally: `brew install alexwkleung/tap/reika`,
   `brew test` and `brew audit --strict --online`.

5. **GitHub release.** `--target` needs the full commit SHA:

   ```sh
   cp ~/reika-release/alexwkleung-reika-X.Y.Z.tgz ~/reika-release/reika-X.Y.Z.tgz
   gh release create vX.Y.Z --target "$(git rev-parse main)" --title "Reika X.Y.Z" \
     --notes "…" ~/reika-release/reika-X.Y.Z.tgz
   ```

6. **Verify.**

   ```sh
   pnpm run release:verify
   ```

   This checks that `package.json`, npm `latest`, the tap formula and the latest GitHub release all
   name the same version, and that npm, the tap and the release asset serve the same bytes. It hashes
   the downloads rather than trusting metadata. It exits non-zero on any mismatch.
