# First-publication handoff

## Current state and owner

The maintainer owns npm's first publication and external configuration.
`@pegma/agent-access` is unpublished at source version `0.1.0`. Merging this
follow-up creates no tag, GitHub release, npm publication, publisher setting,
or protection setting. Knowledge Base has its own release handoff.

Creating the package name and advertising the first trusted release are
separate steps. Maintainer 2FA publication supplies no OIDC provenance and
cannot substitute for strict `verify` in [release operations](RELEASING.md).
The historical AUTH-01 source result does not replace this change's required
current-head code/security review and Node 22/24 gate.

## Prepare the initial exact artifact

1. Confirm npm ownership and publishing permission for `@pegma/agent-access`.
   Record the responsible maintainer and keep credentials and one-time codes
   out of repository files and logs.
2. Merge reviewed source and exact pins to protected `origin/main`. Record the
   full commit, passing current-head Node 22/24 gates, and clean applicable
   code/security review. Configure approved SSH signers and protected immutable
   `v*` tags outside this source change.
3. The maintainer creates the approved signed annotated `v0.1.0` tag at that
   merged commit. Use a clean complete checkout at the tag with approved signer
   verification. Supply the reviewed npm `11.18.0` artifact and SHA-256 from
   `publish.yml`, set `RELEASE_NPM_CLI` to its absolute `npm-cli.js` path and
   `RELEASE_NPM_VERSION=11.18.0`, then run strict preparation. Alternatively use
   the workflow's prepare-only dispatch:

   ```sh
   node scripts/release-packages.mjs prepare --tag v0.1.0 --expected-commit FULL_COMMIT_SHA
   ```

4. Retain the prepared directory intact. Independently record the emitted
   manifest SHA-256, source identity, directory, and tarball hashes. Obtain the
   digest from trusted preparation output, rather than a file bundled with
   downloaded artifacts. Prepare-only dispatch supplies immutable artifact IDs
   and independent job outputs.
5. Run read-only preflight with that independent digest:

   ```sh
   node scripts/release-packages.mjs preflight --prepared-dir PREPARED_DIRECTORY --manifest-sha256 INDEPENDENT_SHA256 --tag v0.1.0 --expected-commit FULL_COMMIT_SHA
   ```

   An existing exact version must match prepared metadata and downloaded bytes.
   Only HTTP 404 establishes absence. Stop on mismatch, access failure, or an
   uncertain response.

## Maintainer 2FA bootstrap

Using the maintainer's interactive npm login and 2FA, publish only the exact
prepared tarball. This command is an operator handoff, not a CI step or an
instruction for a source-preparation agent:

```sh
npm publish PREPARED_DIRECTORY/pegma-agent-access-0.1.0.tgz --access public --ignore-scripts --registry https://registry.npmjs.org --tag bootstrap
```

Use the filename from the verified manifest. Publish no source directory and
add no token fallback. Rerun preflight before continuing an interrupted
bootstrap. Skip an existing version only after preflight confirms identical
prepared bytes; npm versions are immutable. Repeat preflight after publication
to retain the registry metadata and downloaded-byte match.

Record manual publication receipts and bootstrap integrity with provenance
explicitly absent. Leave `0.1.0` under `bootstrap`; do not advertise it as the
released production dependency or authorize host installation from it.

## First advertised trusted release

Once the name exists, the maintainer configures its trusted publisher, the
protected `npm-publish` environment, approved signers, and immutable tag
protection described in [release operations](RELEASING.md). Bind the publisher
to `pegma-dev/agent-access`, exact workflow `publish.yml`, and environment
`npm-publish`; explicitly permit direct publishing. Check npm's first-use
timing before configuring it for the reviewed trusted release.

The first advertised release needs a separately reviewed package-version and
dependent-pin change synchronized across its consumers. This source change
chooses no future version and performs no bump. A manually published version
cannot be republished through OIDC to acquire provenance. Run the full
current-head review and Node 22/24 gate for the new release commit, create its
approved signed annotated version tag on `origin/main`, then create the GitHub
release with `--verify-tag` to trigger the trusted workflow. It prepares once,
checks the independent artifact binding, preflights the exact version, and
publishes only the absent prepared tarball.

Advertise availability only after the separate unprivileged strict `verify`
job succeeds: registry bytes/dependencies, a clean exact-version registry
consumer, registry signatures, and matching source/workflow/tag/commit
provenance. Preserve that result with the release identity and independent
manifest digest. Both hosts additionally require published Knowledge Base
and their retained actual login/Admin-consent/client/staging acceptance before
activation. Registry publication closes none of those host gates.
