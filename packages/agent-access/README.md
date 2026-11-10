# @pegma/agent-access

Administrator-approved, scoped OAuth credentials for Pegma hosts.

Install an exact version after verifying its release. Replace `<verified-version>`
with that version:

```sh
pnpm add --save-exact @pegma/agent-access@<verified-version>
```

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

Use `createAgentAccess` with a Storage Core store, clock, current principal
resolver, and explicit client/resource/scope configuration. Compose protocol
routes with `createAgentAccessHttp` and protect resource handlers with
`createProtectedResourceAuthenticator`, using its returned restricted access
context for the actual operation. Keep browser approval and its CSRF/origin
checks in the host.

Hosts that render a connected-agents page list the signed-in owner's approved
grants with `listGrants(browserContext, { ownerPrincipal, cursor?, limit?, statuses? })`.
Pages are owner-only, bounded (default 20, maximum 100), and continue with an
owner-bound opaque cursor. The optional `statuses` filter accepts `pending`,
`active`, `revoked`, and `expired`; filtered pages can contain fewer items than
the limit while still returning `nextCursor`. Each item is the same safe `GrantView` that
`getGrant` returns, including its current status, and can be revoked with
`revokeGrant`. Grants approved before listing existed appear after the host
runs the bounded, idempotent `backfillGrantIndex({ cursor, limit })` maintenance
call. On upgrade to 0.2.0, run it once to completion, passing `nextCursor` to the
next call until it is null (default 100 physical grant rows per call, maximum
1000). Hosts that explicitly provision storage collections or roles must first
provision `agent-access.owner-index.v1` with the same read/write/transaction
rights as `agent-access.records.v1`. The owner index is maintained by the
package in a separate collection; it has no cross-partition atomicity with
grant records.

File-upload endpoints may opt in to multipart bodies per authenticator with
`createProtectedResourceAuthenticator({ service, configuration, multipart: { maxBytes } })`.
`maxBytes` defaults to 1 MiB (1048576 bytes) and must be a positive integer no
greater than 16 MiB (16777216 bytes). Multipart remains off by default.
The bearer still comes only from the `Authorization` header. The body is bounded
before and during streaming, parsed from a clone so the original request stays
readable on success, rejected (with the upload source cancelled) when any part
carries credential fields, and returned as `result.form`. The bearer is
authenticated again after parsing, so revocation during a slow upload fails
closed. Without the option, multipart bodies are rejected as before.

Actual existing-login/Admin-consent integration and per-client acceptance remain
open for each host. The fictional protocol example does not establish those
results.

MIT licensed. Built in the open by RetireGolden, LLC.
