# Working in this repository

Agent Access is a small MIT Pegma component. Optimize for a fresh agent
context: explicit ports, bounded physical work, small public contracts, and
meaningful public-entry conformance tests.

## Ownership and boundaries

- Own OAuth device-code and authorization-code grants with mandatory S256
  PKCE, scoped opaque access credentials, rotating refresh families, consent
  and revocation records, discovery, and protocol validation.
- Reuse released Storage Core, Audit, Authorization Core, Spine, and host
  limiters. Never implement a database, role model, identity login, session
  store, mailer, general limiter, or cryptographic primitive.
- Hosts supply current authenticated browser-session access and Admin-only
  linking permission, CSRF/same-origin protection, configured clients and
  redirects, current principal/access resolution, and resource operations.
  Never accept a client-submitted access context or treat a desktop bearer as
  browser consent. Human cookies never become agent credentials.
- Approved scope snapshots bound the resulting credential. Intersect current
  host permission with that snapshot on resource requests and refresh. New
  registry scopes never silently expand existing grants. Recheck current
  approval authority and fail closed on missing/unavailable authority.
- Store only credential hashes; never log or audit codes, verifiers, tokens,
  cookie values, complete authorization URLs, or credential-bearing bodies.
  A locator enables a keyed read and never authorizes mutation by itself.
- One grant's head, consumed-credential records and Audit transitions share
  one collection/partition transaction. No cross-partition/role atomicity or
  authorization lease may be claimed. Unknown storage outcomes fail closed.
- Retain all consumed refresh hashes while a family is active. Bound absolute
  lifetime, row/rotation counts, polling, input bytes, attempts, and cleanup.
  Require relinking at the cap. Known reuse revokes; random invalid input
  must never revoke another grant.
- Only configured public clients/resources/scopes initially. No dynamic
  client registration, metadata URL fetching, wildcard redirects, or generic
  identity provider. Explicit HTTPS issuer/resource, with loopback exceptions
  restricted to local test harnesses/native callback rules.
- Keep host internals, actual credentials and customer content out of this
  public repository. Examples are wholly fictional and label their trust seam.
- Public packages use exact released dependencies, package-local README and
  LICENSE, build-on-prepack, and compiled-test exclusion. Unpublished source
  is never a production dependency substitute. No empty packages.
- Never write literal control bytes into source; use escaped forms and verify
  the edited bytes.

## Workflow

Work on a `claude/*` branch from fetched `origin/main`. Required gates are
`pnpm run format:check`, `pnpm run check`, `pnpm test`, and
`pnpm run release:check`, on Node 22 and 24. Run the synthetic protocol example
when present. Current-head code/security review must finish clean; never
bypass missing, skipped, pending, or failing gates. Use squash PR merges.

`pnpm test` includes the explicit `test:release` Node test files for release
identity, arguments, manifest integrity, fresh outputs, and registry failure and
recovery cases. Both Node lanes must execute them. The original AUTH-01 source
result is historical evidence; changed release source requires current-head
validation and review.

Strict release preparation requires a clean checkout at an approved SSH-signed
annotated `vX.Y.Z` tag matching the package version, exact event commit, and
protected `origin/main` ancestry. Verify that identity before executing release
source. The schema-2 manifest binds the sole `@pegma/agent-access` tarball;
retain its SHA-256 independently of the uploaded immutable artifact. Publish
only that artifact ID with the independent digest, tag, and expected commit.
The protected `npm-publish` job receives OIDC only for exact-byte publication;
it installs no project dependencies, rebuilds no package, runs no consumer, and
has no token fallback. A separate unprivileged job checks registry bytes,
signatures, source-bound provenance, and a clean exact-version consumer with
scripts disabled. Manual workflow dispatch prepares only.

See [release operations](docs/RELEASING.md) and the
[first-publication handoff](docs/BOOTSTRAP.md). The source remains unpublished
at `0.1.0`. Maintainer 2FA bootstrap creates the name under `bootstrap` without
advertising it; a later separately reviewed version must pass trusted
publication and verification before advertisement. This source change chooses
no future version. Package ownership, approved signers, immutable tag rules,
environment approval, and direct-publish trusted-publisher settings remain
external maintainer gates. Source, SDK, registry, and provenance results do not
close actual existing-login/Admin-consent or per-client two-host acceptance.

The user explicitly requests parallel in-harness subagents. Assign exact file
ownership, tell workers they are not alone, and never revert others' edits.
The orchestrator owns installs, builds/tests, Git, PRs, review replies, and
merges. First publication/trusted-publisher configuration and host activation
remain separate maintainer operations; no tag, release, publish or deployment
is authorized by source validation alone.
