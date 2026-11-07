# @pegma/agent-access

Administrator-approved, scoped OAuth credentials for Pegma hosts. The initial
`0.1.0` source is unpublished. Completing validation does not activate a host
integration or publish this package.

Agent Access supports public-client device authorization and authorization-code
grants with mandatory S256 PKCE. It owns consent snapshots, opaque access
credentials, rotating refresh families, revocation, discovery, and protocol
validation. It stores credential hashes and commits each grant transition with
Audit in the same Storage Core collection partition.

Hosts supply their existing authenticated browser session, administrator-only
linking permission, CSRF and origin checks, configured clients and redirects,
current authority resolution, rate limiting, approval UI, and resource handlers.
An agent bearer never authorizes browser consent. Resource access intersects the
consented scope snapshot with current host permission; it never inherits the
administrator's roles or unrestricted permissions.

The package uses Web-standard APIs and exact released `@pegma/audit`,
`@pegma/authorization-core`, `@pegma/spine`, and `@pegma/storage-core` dependencies.
It supplies no framework, login system, session store, database, or limiter.
Refresh families and physical work are bounded; reaching a family limit requires
relinking. The repository's fictional protocol example documents the host trust
seam and exercises the public entrypoint.

MIT licensed. Built in the open by RetireGolden, LLC.
