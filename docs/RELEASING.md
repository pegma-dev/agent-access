# Release operations

## Status and release boundary

This repository releases only `@pegma/agent-access`. Its source is the `0.2.0`
release candidate. Version `0.1.1` is already published as npm `latest`, and
`v0.1.1` exists; do not reuse that version or tag. See the
[dated public metadata pointers](BOOTSTRAP.md#observed-011-publication-pointers-2026-11-10)
for the prior release and the limits of that observation. Maintainer
2FA bootstrap of all five `0.1.0` packages, the four Knowledge Base packages
and Agent Access, is complete with exact registry bytes confirmed and no OIDC
provenance. The [bootstrap receipt](BOOTSTRAP.md#bootstrap-receipt-2026-11-07)
records both producers' exact artifact identities and timestamped manual
postflight commands/results. The canonical
[dated source evidence](PROJECT_PLAN.md#delivery-and-evidence) records the
reviewed source heads, separate squash merge commits, exact primary CI runs,
historical per-lane results, and review receipts. Those observations do not
replace any current-head review, validation, or release preflight below.

The `0.2.0` candidate still requires fresh current-head gates and review,
verified release protection and publisher configuration, an approved signed tag
and release, and strict exact-version registry/provenance verification.
Operators must verify actual npm distribution tags after bootstrap and
investigate unexpected defaults; a requested `bootstrap` tag does not prove
that another tag is absent. Source validation alone does not authorize tags,
GitHub releases, publication, external configuration, or deployment. Follow the
[maintainer handoff](BOOTSTRAP.md) for the completed bootstrap procedure and
remaining trusted-release gates.

Knowledge Base retains its own release process; its advertised release waits
for verified Agent Access `0.2.0`. SD-02 requires verified advertised Knowledge
Base dependencies. Production host assembly requires exact verified advertised
dependencies from both components. Source tests, local adapter conformance, and the official SDK
protocol fixture establish source behavior; they do not establish real host
login, production storage, or actual requested client acceptance on either host.

## Repository and development artifact gates

Use Node 22.6.0+ or 24 with `pnpm@10.34.5`. The published package engine remains
`>=22`; the development floor supports the example's type stripping. Run the
complete gate on current Node 22 and 24:

```sh
pnpm install --frozen-lockfile
pnpm run format:check
pnpm run check
pnpm test
pnpm run release:check
pnpm run example
```

Require clean current-head code/security review and all required CI. Absent,
skipped, pending, or failing gates do not authorize release. `pnpm test`
includes `pnpm run test:release`, whose explicit Node test files cover release
identity, strict arguments, independent manifest integrity, fresh build outputs,
and registry failure/recovery. Both Node lanes must execute these regressions.

`release:check` cleans fixed generated outputs, forces a fresh build, and packs
those outputs with lifecycle scripts disabled. It validates the package's
build-on-prepack hook, then checks the actual artifact: stable version, exact
released dependency pins, ESM exports,
package-local README/MIT LICENSE, compiled-test exclusion, safe file inventory,
runtime/type entry points, SHA-1, and SHA-512 integrity. An isolated consumer
outside the workspaces installs the tarball with scripts disabled, resolves
released dependencies, and imports the public package.

The runtime pins remain `@pegma/audit@0.2.0`,
`@pegma/authorization-core@0.4.0`, `@pegma/spine@0.1.2`, and
`@pegma/storage-core@0.4.0`. This candidate changes the package version to
`0.2.0` for the additive owner-scoped grant-listing API, package-maintained
owner index, and opt-in multipart bearer transport, without changing dependency
pins. Hosts with pre-0.2.0 grants must run `backfillGrantIndex` as a one-time
upgrade step; multipart remains
off by default. See the [changelog](../CHANGELOG.md).
`pnpm run release:pack` preserves development artifacts and a schema-1 manifest
in a new `.release/agent-access-*` directory. It requires no tag and supplies no
release identity or provenance. Publication rejects that development manifest;
use strict `prepare` for a releasable artifact.

## Strict release preparation

Before merging release source, ensure the changelog has a version-only heading
for the target version (for example, `## 0.2.0`), with no `Unreleased` label.
A publication date need not be predicted; retain actual publication timing in
the release record after publication.

Merge reviewed release source and exact version/pin changes to protected
`origin/main` first. Configure immutable protected `v*` tags and approved SSH
release signers outside this source change. A stable `vX.Y.Z` must be a signed
annotated tag whose target matches the package version and exact expected
commit. The checkout must be clean, at that commit, in
`pegma-dev/agent-access`, with complete ancestry and the commit contained in
`origin/main`. Signature verification uses independently approved signer
configuration. Lightweight tags and unmerged commits fail the gate.

After the full gate, prepare from that exact clean checkout. In the current
release commands below, replace `vX.Y.Z` with the approved signed tag matching
the package version and `FULL_COMMIT_SHA` with its full approved source commit.
Use the same tag and commit throughout preparation, preflight, publication,
and verification. The historical bootstrap procedures retain literal `v0.1.0`.

Strict `prepare` requires both `RELEASE_NPM_CLI` and
`RELEASE_NPM_VERSION=11.18.0`. The CLI path must be canonical, absolute, and name
a regular `npm-cli.js` file; linked paths are rejected. Extract the reviewed npm
tarball after checking the SHA-256 pinned in the
[npm setup action](../.github/actions/setup-release-npm/action.yml), then set
both variables before standalone preparation. The workflow configures them
automatically. Development `check` and `pack` continue to use ambient npm.

```sh
node scripts/release-packages.mjs prepare --tag vX.Y.Z --expected-commit FULL_COMMIT_SHA
```

An optional `--out EMPTY_DIRECTORY` selects a new empty output directory.
Preparation repeats strict source identity checks before and after building
and packing, then retains the exact tarball and schema-2 `manifest.json`:

- `identity`: fixed repository, tag, exact commit, and package version;
- `artifacts`: exactly one package with name, version, safe filename, byte size,
  SHA-1, SHA-512 integrity, exact dependencies, and bounded file inventory.

The producer emits `prepared-dir`, `manifest-path`, and `manifest-sha256`.
Retain that SHA-256 independently with the approved source identity and job
outputs. A digest copied only from a downloaded artifact supplies no independent
binding. Downstream commands require the digest, tag, and expected commit and
rehash the tarball. They reject extra or malformed manifest data, unsafe paths,
symlinks, missing files, wrong package/pins, and changed bytes. Preparation
establishes neither registry availability nor provenance.

## Protected trusted-publisher workflow

[Publish](../.github/workflows/publish.yml) prepares from a stable published
GitHub release. First create the protected signed annotated tag on
`origin/main`, then use `gh release create vX.Y.Z --verify-tag`. Its manual
`workflow_dispatch` accepts `tag` and `expected_commit` for preparation and
inspection only; it cannot enter publication or registry verification.

The workflow verifies tag/event identity, complete main ancestry, and the
approved SSH signature before executing project source or installing project
dependencies. Node 22/24 jobs run the full gate. The unprivileged preparation
job repeats strict verification, packs once, uploads an immutable artifact,
and exposes its artifact ID and independently computed manifest SHA-256.
Only the protected `npm-publish` job has `id-token: write`. It downloads that
exact artifact ID and checks the independent digest/tag/commit before npm
writes. It installs no project dependencies, runs no package lifecycle scripts
or consumer, and does not rebuild or repack.

A separate unprivileged `verify` job has `id-token: none`. It installs the
exact registry package in a temporary consumer with scripts disabled, checks
registry bytes and cryptographic signatures/provenance, then imports the public
package. It uses the same immutable artifact ID and independent digest.
No `setup-node` registry configuration or npm token fallback is used.

### External release checklist

Before trusted publication, verify these external maintainer settings:

- npm ownership and organization publishing permission for
  `@pegma/agent-access`;
- protected `origin/main`, immutable protected signed annotated release tags,
  and approved SSH signer entries in the reviewed `RELEASE_ALLOWED_SIGNERS`
  repository variable;
- the GitHub `npm-publish` environment with required approval and release-ref
  restrictions;
- the npm trusted publisher bound to `pegma-dev/agent-access`, `publish.yml`,
  and `npm-publish`, with explicit permission for direct `npm publish`;
- npm publication policy requiring 2FA and disallowing token-based publication.
  No repository npm token or token fallback exists.

The workflow uses Node `24.18.0` and npm `11.18.0` for release operations. It
uses the local [npm setup action](../.github/actions/setup-release-npm/action.yml)
to download npm's tarball and check the committed SHA-256 before extracting the
CLI. Review the
[official npm trusted-publisher guidance](https://docs.npmjs.com/trusted-publishers/)
when configuring direct publishing and first-use timing; source validation does
not configure or prove those external settings.

## Preflight, publication, and interrupted-release recovery

Read-only preflight inspects the exact candidate before publication:

```sh
node scripts/release-packages.mjs preflight --prepared-dir PREPARED_DIRECTORY --manifest-sha256 INDEPENDENT_SHA256 --tag vX.Y.Z --expected-commit FULL_COMMIT_SHA
```

It validates the schema-2 artifact and queries the exact version in the public
npm registry before any publication. Only HTTP 404 means absent. Authentication,
network/server errors, invalid metadata, wrong name/version/dependencies, or
changed registry tarball bytes stop the release. An existing version must match
the prepared SHA-1, SHA-512 integrity, and downloaded bytes.

The protected OIDC job runs:

```sh
node scripts/release-packages.mjs publish --prepared-dir PREPARED_DIRECTORY --manifest-sha256 INDEPENDENT_SHA256 --tag vX.Y.Z --expected-commit FULL_COMMIT_SHA
```

The workflow supplies `RELEASE_NPM_CLI` as an absolute path to the reviewed npm
`11.18.0` `npm-cli.js` and `RELEASE_NPM_VERSION=11.18.0`. Standalone `prepare`
and `verify` also need both variables and the canonical regular CLI path; use
the npm artifact and SHA-256 pinned in the
[npm setup action](../.github/actions/setup-release-npm/action.yml).
Read-only `preflight` needs no npm authentication. `publish`
requires the matching GitHub release OIDC environment; interactive bootstrap is
a separate maintainer procedure. npm runs with isolated configuration and the
explicit public registry. `publish` rejects ambient npm authentication and
configuration.

`publish` repeats preflight before its npm write. It skips only an identical
existing version and publishes an absent version from the prepared tarball.
After interruption, preserve the original source identity, independent digest,
and artifact bytes; retry only after preflight accepts that same artifact.
Never overwrite a version, rebuild from another checkout, move a tag, or treat
an npm error as proof of absence. A conflict requires maintainer investigation
and a separately reviewed release decision.

npm accepts uploads before its
[publish-time malware scan](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/)
makes the version available. This normally takes about five minutes and can take
15 minutes or longer; these are typical timings, not service guarantees.
After one accepted upload, publication polls only exact
version reads, at most 41 times, with up to 30 seconds between checks and a
20-minute monotonic elapsed-time budget. The final scheduled sleep is followed
by one bounded lookup, whose metadata and tarball verification can take up to
60 additional seconds.
Unknown registry states and conflicting bytes still fail immediately. The
30-minute job timeout remains the outer bound and can interrupt publication or
byte verification; it does not guarantee enough time for every worst-case step.
An unavailable version at the
deadline is not proof that the upload failed: check npm scanning or review status
and preserve the original artifact rather than uploading again blindly. Once
the exact version is visible, download the original immutable workflow artifact
by its artifact ID into a fresh prepared directory. Run the read-only `preflight`
command above with `--prepared-dir` pointing to those downloaded files and the
original independent manifest digest, tag, and commit. The artifact ID selects
the workflow download; it is not a `preflight` argument. If it matches, rerun
only the failed jobs in the original Publish run; publication skips the matching
existing version and the separate registry/provenance verification must pass.

## Registry verification and availability

After publication, the separate unprivileged job runs strict verification. The
same command is available independently:

```sh
node scripts/release-packages.mjs verify --prepared-dir PREPARED_DIRECTORY --manifest-sha256 INDEPENDENT_SHA256 --tag vX.Y.Z --expected-commit FULL_COMMIT_SHA
```

The exact registry version must exist and match approved metadata and downloaded
bytes. A fresh consumer installs the exact version from the public registry
without workspace links, local tarballs, or lifecycle scripts. Before importing
it, the pinned npm CLI verifies registry signatures and provenance attestations;
the verifier requires the attested source repository, workflow, tag, and commit
to match the prepared identity. Availability requires all these results.
Preserve the artifact, independent digest, source identity, workflow run, and
verification results in the release record.

Manual first publication cannot satisfy trusted provenance. The
[bootstrap handoff](BOOTSTRAP.md) specifies the two separate release steps;
bootstrap integrity evidence must never be reported as OIDC provenance.

## Observed npm audit shape: 2026-11-07

A real isolated registry consumer used the installed npm `11.18.0` CLI and exact
`@pegma/spine@0.1.2`, with its known integrity checked and lifecycle scripts
disabled. No package runtime was imported. The command
`npm audit signatures --json --include-attestations` succeeded; the
[official npm audit documentation](https://docs.npmjs.com/cli/v11/commands/npm-audit/#audit-signatures)
documents that flag and its attestation output.

The sanitized observed shape was:

```text
top-level keys: invalid, missing, verified
counts: invalid=0, missing=0, verified=1
verified entry keys: attestationBundles, attestations, location, name, registry, version
attestationBundles: 2 bundles, including one SLSA v1 provenance bundle
bundle keys: dsseEnvelope, mediaType, verificationMaterial
verificationMaterial: certificate.rawBytes, timestampVerificationData, tlogEntries
```

A second isolated run installed all seven exact external runtime pins used by
the two components, resolving 102 packages. Root lock versions and public
registry URLs matched; the real audit reported `invalid=0`, `missing=0`,
and `verified=21`. Lifecycle scripts and runtime imports remained disabled.
This historical check covered the existing external dependency graph without
publishing either new component at that time.

The observed public source was [pegma-dev/spine](https://github.com/pegma-dev/spine)
at `refs/tags/v0.1.2`. This records the pinned CLI's working flag, output, and
certificate shape. It proves no provenance for KB or Agent Access bootstrap
packages and performed no publisher operation. Their own exact repository,
workflow, tag, and source-commit post-release verification remains mandatory.
Raw bundles and certificate bytes are intentionally omitted.

## Consumers and retained host gates

Verified advertised Agent Access and Knowledge Base releases both precede real
host assembly. The manual `0.1.0` bootstraps do not satisfy this prerequisite.
Git references, copied source, workspace paths, and unpublished production
tarballs do not substitute for exact verified registry releases.

P-00 and PG-01/RG-01 still require actual existing-login/current-Admin consent,
Codex, Claude Code, Grok Bot's desktop application with its hosted agent, and
T3 Code in Codex-provider mode, host-attested staging evidence, and
credential/evidence failure cases on both hosts. Other T3 providers remain
unproven. Source, emulator, SDK, registry, and provenance results cannot close
those gates. Preserve staff approval/publication, privacy, isolation, bounded
work, and full human workflows before activation, A-01, or supervised pilots.
Future collection-specific delegation, new scopes, retention, and operations
work remains deferred to its governing tasks. Private host configuration and
operational evidence remain in their owning private systems.
