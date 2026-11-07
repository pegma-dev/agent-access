# First-publication handoff

## Current state and owner

The maintainer owns npm publication and external configuration. As of
2026-11-07, `@pegma/agent-access@0.1.0` has completed maintainer 2FA bootstrap
with exact registry bytes confirmed and no OIDC provenance. Source version
`0.1.1` is the candidate for the first advertised trusted release; that release
is not yet verified. Knowledge Base has its own release handoff and waits for
verified Agent Access `0.1.1` before its advertised release.

Creating the package name and advertising the first trusted release are
separate steps. Maintainer 2FA publication supplies no OIDC provenance and
cannot substitute for strict `verify` in [release operations](RELEASING.md).
The historical AUTH-01 source result does not replace this change's required
current-head code/security review and Node 22/24 gate.

## Bootstrap receipt: 2026-11-07

The signed [`v0.1.0` tag](https://github.com/pegma-dev/agent-access/tree/v0.1.0)
targets commit
[`d4db0065f22a9c090fc2831b3e18fbbc37c1639c`](https://github.com/pegma-dev/agent-access/commit/d4db0065f22a9c090fc2831b3e18fbbc37c1639c).
[Preparation run 42415787142](https://github.com/pegma-dev/agent-access/actions/runs/42415787142)
retained immutable artifact `13591317099` with independently recorded manifest
SHA-256 `885d5422930e2dd3435f0ebea02fb74238b946c962715b2b1d81954684a10312`.
Manual npm publication was accepted. Strict post-publication preflight returned
`skip`, confirming exact registry bytes match that prepared artifact.

All four Knowledge Base `0.1.0` bootstrap uploads were also accepted, and the
full five-package set's exact registry bytes were confirmed. These are bootstrap
integrity receipts, with OIDC provenance absent; they do not establish trusted
release availability or host/client acceptance. Operators must verify actual
distribution tags and investigate unexpected defaults before advertisement.
The requested publish tag alone is not evidence that another tag is absent.

## Historical bootstrap procedure: 0.1.0

The following procedure records the completed first publication. Do not
recreate or move its tag, rebuild its artifact, or republish the immutable
version. Use the separate trusted-release procedure for the `0.1.1` candidate.

1. Confirm npm ownership and publishing permission for `@pegma/agent-access`.
   Record the responsible maintainer and keep credentials and one-time codes
   out of repository files and logs.
2. Merge reviewed source and exact pins to protected `origin/main`. Record the
   full commit, passing current-head Node 22/24 gates, and clean applicable
   code/security review. Configure approved SSH signers and protected immutable
   `v*` tags outside this source change.
3. The maintainer creates the approved signed annotated `v0.1.0` tag at that
   merged commit. Use a clean complete checkout at the tag with approved signer
   verification. Before standalone preparation, extract the reviewed npm
   `11.18.0` tarball after checking the SHA-256 pinned in the
   [npm setup action](../.github/actions/setup-release-npm/action.yml).
   Explicitly set `RELEASE_NPM_CLI` to the extracted regular `npm-cli.js` file's
   canonical absolute path and set `RELEASE_NPM_VERSION=11.18.0`; both are
   required, and linked paths are rejected. Alternatively use the workflow's
   prepare-only dispatch, which supplies both variables. Then run strict
   preparation:

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

## Historical maintainer 2FA bootstrap

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
explicitly absent. Verify `bootstrap` and all other distribution tags after the
write; investigate and correct unexpected defaults through maintainer operations
before advertisement. Do not infer actual tag state from `--tag bootstrap`.
Do not advertise `0.1.0` as the trusted production dependency or authorize host
installation from it.

## First advertised trusted release

Once the name exists, the maintainer configures its trusted publisher, the
protected `npm-publish` environment, approved signers, and immutable tag
protection described in [release operations](RELEASING.md). Bind the publisher
to `pegma-dev/agent-access`, exact workflow `publish.yml`, and environment
`npm-publish`; explicitly permit direct publishing. Check npm's first-use
timing before configuring it for the reviewed trusted release.

The `0.1.1` candidate proposes the package-version change for the first
advertised release; dependent pins must be synchronized across consumers.
It still requires fresh current-head code/security review and the full Node
22/24 gate. A manually published version cannot be republished through OIDC to
acquire provenance. After the candidate's gates pass and external publisher
configuration is verified, create its
approved signed annotated version tag on `origin/main`, then create the GitHub
release with `--verify-tag` to trigger the trusted workflow. It prepares once,
checks the independent artifact binding, preflights the exact version, and
publishes only the absent prepared tarball.

Advertise availability only after the separate unprivileged strict `verify`
job succeeds: registry bytes/dependencies, a clean exact-version registry
consumer, registry signatures, and matching source/workflow/tag/commit
provenance. Preserve that result with the release identity and independent
manifest digest. Knowledge Base's advertised release follows verified Agent
Access `0.1.1`. Both hosts additionally require verified advertised Knowledge Base
and their retained actual login/Admin-consent/client/staging acceptance before
activation. Registry publication closes none of those host gates.
