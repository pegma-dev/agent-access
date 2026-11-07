# Release operations

`@pegma/agent-access@0.1.0` is the first source version and is unpublished.
Source validation, a merged PR, and a synthetic client proof authorize no tag,
release, npm publication, trusted-publisher change, or host deployment. Those
are separate maintainer operations.

## Source and artifact gate

Run the repository gate on Node 22 and 24:

```sh
pnpm run format:check
pnpm run check
pnpm test
pnpm run release:check
pnpm run example
```

Current-head code/security review and CI must finish clean. Real Azure Tables
and D1 conformance and the synthetic SDK protocol example are source evidence;
they do not establish host login, production storage, or two-host acceptance.

The published package must have its own README and LICENSE, exact released
dependencies, a build-on-prepack hook, public exports, and no compiled tests.
Pack/import validation must check the actual artifact in a clean consumer,
including its package inventory and integrity. Test-only local artifacts may
establish source compatibility before publication. Hosts install published
exact versions for production; no Git, source-copy, workspace-path, or
unpublished-tarball substitute is permitted.

The first runtime pins are `@pegma/audit@0.2.0`,
`@pegma/authorization-core@0.4.0`, `@pegma/spine@0.1.2`, and
`@pegma/storage-core@0.4.0`. `pnpm run release:check` packs and imports in a
temporary clean consumer. `pnpm run release:pack` retains the sole tarball and
hashes in `.release/package-manifest.json`; publish that reviewed tarball.

## First publication

A new package name needs a one-time maintainer bootstrap before trusted
publishing can be configured. After a separately authorized reviewed release:

1. Prepare and retain the exact approved tarball and its integrity manifest
   from the release commit already on `origin/main`; do not rebuild between
   review and publication.
2. The maintainer signs in to npm and manually publishes that exact public
   tarball using interactive 2FA. Never add an npm token to the repository or
   workflow.
3. Verify the registry artifact integrity against the approved tarball. An
   existing version with a different integrity is an error, never an overwrite.
4. Configure the package's GitHub Actions trusted publisher for organization
   `pegma-dev`, repository `agent-access`, workflow `publish.yml`, and environment
   `npm-publish`. Protect that environment with maintainer approval, configure
   `RELEASE_ALLOWED_SIGNERS` with the reviewed signer entry, and protect `v*`
   tags against update/deletion and unauthorized creation.
5. Verify the bootstrap and later OIDC paths separately. A manual bootstrap
   does not prove a successful trusted-publisher publication.

No bootstrap or external configuration is claimed complete in this source PR.

## Later trusted-publisher releases

Prepare version/pin/lockfile and release-note changes through a reviewed PR.
The maintainer creates a protected signed annotated `vX.Y.Z` tag at the exact
release commit already contained in `origin/main`, pushes that tag, and creates
the GitHub release with `gh release create vX.Y.Z --verify-tag`.

The unprivileged preparation job verifies tag/signature/main ancestry, runs
the complete gate, and packs the exact reviewed artifacts. Only the minimal
environment-protected publication job receives OIDC authority. It publishes
those artifacts with provenance and does not install project dependencies.
There is no token fallback and merging alone never publishes.

On partial failure, rerun against the unchanged protected tag: verify and skip
an identical already-published version, publish an absent version, and stop on
any integrity mismatch or unexplained registry failure. Never reuse a version
or retarget a release tag. Activation of either host remains a separate task
even after registry publication succeeds.
