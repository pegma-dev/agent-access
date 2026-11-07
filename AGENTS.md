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

The user explicitly requests parallel in-harness subagents. Assign exact file
ownership, tell workers they are not alone, and never revert others' edits.
The orchestrator owns installs, builds/tests, Git, PRs, review replies, and
merges. First publication/trusted-publisher configuration and host activation
remain separate maintainer operations; no tag, release, publish or deployment
is authorized by source validation alone.
