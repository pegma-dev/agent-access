# Public API and host boundary

The source package is not yet published. It composes the released
`@pegma/authorization-core` AccessContext, `@pegma/spine` Clock/PrincipalId/
IsoTimestamp, `@pegma/storage-core` Store, and transactional `@pegma/audit`.
The host keeps its existing login, session, administrator policy, browser
CSRF/origin checks, distributed request limiting, and resource operations.

Custom transports that call the service directly must apply the same host
durable limiter before public authorization, token polling/exchange, refresh,
and revocation requests. Persisted device polling backoff does not replace
that admission control. The supplied Fetch adapter requires this limiter.

## Configuration

`AgentAccessOptions` supplies `configuration`, `store`, `clock`, and
`resolvePrincipal(principalId): Promise<AccessContext | null>`. The resolver
returns current host authority; inactive or missing principals return null.
Operational failure rejects. Stored roles or old access contexts never prove
current authority.

`AgentAccessConfiguration` supplies:

- Exact `issuer` and `resource` identifiers.
- Explicit `endpoints`: `authorize`, `deviceAuthorization`, `token`,
  `revocation`, `verification`, `approval`, and `resourceMetadata`.
- `approvalPermission`, normally the exported `DEFAULT_APPROVAL_PERMISSION`
  (`agent.access.link`). The host grants it only to administrators.
- Preregistered `clients`: `clientId`, display `name`, `redirectUris`,
  `allowedScopes`, and `grantTypes` (`device_code`, `authorization_code`).
- Explicit `scopes`: `name`, display `description`, definition `version`, and
  exact host `permissions`.
- Optional `limits` overrides and `allowInsecureLoopback` for local tests only.

Configuration is copied, validated, and deeply frozen at construction. Endpoint
URLs use HTTPS and the issuer's origin. Resource identifiers use HTTPS. The
explicit test flag permits HTTP only when issuer and resource are loopback;
endpoints still share the issuer origin. Client callbacks use exact registered
HTTPS URLs, or native HTTP IP loopback URLs. A native IP loopback callback may
vary only its port. Prefer IP loopback callbacks. An exact canonical
`http://localhost:PORT/callback` registration with an explicit fixed port is
also supported for clients such as Claude Code that require it; changing that
port, hostname, path, or query requires a separate registration. This callback
compatibility exception does not relax issuer, resource, or server endpoint
HTTPS requirements. No metadata URLs are fetched, and registration and scope
expansion are never implicit.

Defaults are device authorization 600 seconds; authorization request 600
seconds; authorization code 120 seconds; access token 900 seconds; refresh
family 604800 seconds; device polling interval 5 seconds; 128 refresh rotations;
300 rows per family; 16384 input bytes; 16 selected scopes; and 4 storage
conflict attempts. Overrides cannot exceed these maxima. The service reserves
control/audit capacity for terminal revocation instead of spending every row on
ordinary rotations. Hosts enforce their additional distributed/IP/account
limits before invoking this service.

Knowledge Base hosts initially register only their explicit draft-read,
draft-write, and evidence-submit mappings. The generic package does not ship a
resource-specific registry. A consent fingerprint covers only the selected
definitions, including their versions and permission mappings. Adding an
unselected scope preserves existing consent. Editing a selected definition
requires relinking; old credentials never gain its new permissions.

## Service contract

`AgentAccessServicePort` freezes these asynchronous operations. Inputs use
camelCase; OAuth token responses use the standard snake_case fields.

| Operation                   | Input                                                                                                              | Result                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| `beginDeviceAuthorization`  | `{ clientId, resource, scopes }`                                                                                   | OAuth `DeviceAuthorizationResult` |
| `beginAuthorization`        | browser context, `{ clientId, resource, scopes, redirectUri, codeChallenge, codeChallengeMethod: "S256", state? }` | `ApprovalView`                    |
| `getDeviceApproval`         | browser context, human `userCode`                                                                                  | `ApprovalView`                    |
| `getAuthorizationApproval`  | browser context, `requestId`                                                                                       | `ApprovalView`                    |
| `approve`                   | browser context, `{ requestId, decision: "approve" \| "deny", approvedScopes?, userCode? }`                        | `ApprovalResult`                  |
| `exchangeAuthorizationCode` | `{ clientId, resource, code, redirectUri, codeVerifier }`                                                          | `TokenResult`                     |
| `pollDeviceToken`           | `{ clientId, resource, deviceCode }`                                                                               | `TokenResult`                     |
| `refresh`                   | `{ clientId, resource, refreshToken, scopes? }`                                                                    | `TokenResult`                     |
| `authenticate`              | `{ token, resource, requiredScopes? }`                                                                             | `DelegatedAccess`                 |
| `revokeToken`               | `{ clientId, token, tokenTypeHint? }`                                                                              | void; unknown tokens are harmless |
| `getGrant`                  | browser context, `grantId`                                                                                         | `GrantView`                       |
| `revokeGrant`               | browser context, `grantId`                                                                                         | void                              |
| `listGrants`                | browser context, `{ ownerPrincipal, cursor?, limit?, statuses? }`                                                  | `GrantPage`                       |
| `backfillGrantIndex`        | `{ cursor?, limit? }` (host maintenance, no browser context)                                                       | `BackfillGrantIndexResult`        |

`BrowserApprovalContext` is exactly
`{ authentication: "browser-session", access: AccessContext }`. It comes from
the trusted host's authenticated browser session after CSRF/origin validation.
It cannot come from a request body, desktop bearer token, or this component's
own delegated credentials. Both the supplied current browser access and a
fresh resolver result must hold the configured approval permission. Ownership
checks additionally protect grant inspection and revocation.

An `ApprovalView` contains `requestId`, `flow`, `status`, `clientId`, trusted
`clientName`, `resource`, `requestedScopes` definitions, and `expiresAt`. It
contains no credentials or authorization URL. Device approval requires the
human `userCode` again. A device `ApprovalResult` is
`{ flow: "device_code", approved: boolean }`. Authorization-code approval
returns `{ flow: "authorization_code", redirectUri }`; that URI is constructed
from the registered redirect and carries `code`, optional `state`, and `iss`
only once. Hosts must never log it. Denial uses an OAuth error response at the
same validated redirect. UI rendering must escape all display strings.

`TokenResult` is `{ access_token, token_type: "Bearer", expires_in,
refresh_token, scope }`. Every exchange binds the registered client and exact
resource; authorization-code exchange also binds the actual redirect and S256
verifier. Refresh rotates the credential, retains all consumed hashes during
the family's active lifetime, and detects known reuse. Random invalid input
never revokes a family merely because its locator matches. Optional refresh
`scopes` narrow only the new access token; family consent remains unchanged.
Returned `expires_in` values are always positive; at the absolute family expiry
or within its final fractional second, the client must link again.

`DelegatedAccess` contains `grantId`, `clientId`, `resource`, `scopes`, and
`access`. Every authentication and refresh resolves current owner authority
and the approval permission again. The returned AccessContext intersects
current permissions with the approved scope definitions; `roles` and
`entitlements` are always empty. The host must authorize the actual resource
operation using this restricted context.

## Owner grant listing

Hosts that render a connected-agents page call `listGrants` from the trusted
browser session instead of keeping their own owner-to-grant index:

```ts
const page = await service.listGrants(browserContext, {
  ownerPrincipal: browserContext.access.principalId,
  limit: 20,
});
for (const grant of page.grants) render(grant); // escape display strings
// Next page: pass page.nextCursor back unchanged; null means no older entries.
// Revoke from a CSRF/origin-checked host mutation using a listed grantId:
await service.revokeGrant(browserContext, selectedGrantId);
```

- **Owner-only.** The context must pass the same approval-permission and
  current-resolver checks as `getGrant`, and `ownerPrincipal` must equal the
  trusted session principal; otherwise the call fails with `access_denied`.
  A non-string, empty, control-character, or over-512-character principal and
  unknown input fields are `invalid_request`.
- **Bounded pages.** `limit` defaults to 20 and
  may not exceed 100. A page performs one owner-index
  head read plus at most `limit` index reads and `limit` grant-head reads; it
  never scans storage. Results are newest indexed first. Because inactive,
  filtered, or removed grants still consume their slot, a page may hold fewer
  than `limit` grants, even none, while `nextCursor` is non-null. Approvals
  made while paging appear on a fresh first page and never duplicate entries.
- **Owner-bound cursor.** `nextCursor` is an opaque `pgc1.` string bound to
  the owner's index partition. It carries a public, unkeyed checksum that
  detects inconsistent or accidental edits; it is not tamper-proof, because a
  caller can recompute the checksum. A cursor from another owner, an edit that
  does not match its checksum, or any malformed value fails with
  `invalid_request` and reveals nothing. Safety never depends on the cursor:
  every page re-verifies the session and owner, a cursor for another owner's
  partition is always rejected, and a position past the owner's current head
  is clamped. A deliberately recomputed position only repositions the caller
  within their own grants.
- **Safe views.** Each item is exactly the `GrantView` that `getGrant` returns.
  Credential hashes, consent fingerprints, PKCE challenges, redirects, and raw
  storage records are never included.
- **Statuses.** Listing covers grants the owner approved. Each item carries
  its current status: `pending` (approved, credentials not yet issued),
  `active`, `revoked`, or `expired` (derived from the absolute expiry as in
  `getGrant`). Unapproved authorization requests and denied requests are not
  linked agents and are not listed; `getGrant` still reads them by ID. Pass
  `statuses`, a non-empty set of distinct values from `pending`, `active`,
  `revoked`, and `expired`, to keep only matching items, for example
  `statuses: ["active"]`. Because denied requests are never listed, a
  `denied` filter value is rejected with `invalid_request` instead of
  silently returning empty pages.

The owner index is a separate Storage Core collection,
`agent-access.owner-index.v1`, with one partition per hashed
(issuer, resource, owner). Storage Core transactions are single-partition, so
the index cannot share the grant partition's transaction and no cross-partition
atomicity is claimed. Instead, approval commits the owner's index entry (head
counter, membership, and entry in one owner-partition transaction) _before_ the
grant's approval transition. A committed approval therefore always has an
entry. If the approval is then refused, conflicts, or has an unknown outcome,
the leftover entry is harmless: listing re-reads each authoritative grant head
and returns it only when its issuer, resource, and owner match. Revocation and
expiry change only the grant head, which listing reads, so they need no index
write. Membership records make indexing idempotent.

**Upgrade provisioning.** After this change every approval also reads and
writes `agent-access.owner-index.v1`. Storage Core adapters that keep all
collections in one table or database need no action. A host whose store
provisions collections, tables, or roles explicitly must provision this
collection with the same read/write/transaction rights as
`agent-access.records.v1` before deploying; otherwise approvals fail closed
with `server_error` while existing grants, tokens, and resource access keep
working.

Grants approved before this index existed have no entries. They remain fully
usable through `getGrant`, `revokeGrant`, and every token operation, but do not
appear in `listGrants` until the host runs the bounded, idempotent backfill:

```ts
let cursor: string | null = null;
do {
  const step = await service.backfillGrantIndex({
    limit: 100,
    ...(cursor === null ? {} : { cursor }),
  });
  cursor = step.nextCursor;
} while (cursor !== null);
```

Each call scans at most `limit` physical grant rows (default 100, maximum 1000) through Storage Core's authoritative scan and indexes approved, owned
heads for this issuer and resource. Reruns and concurrent approvals add nothing
twice. The scan cursor is the storage adapter's own continuation and is passed
through unchanged. A non-string or empty cursor, or one exceeding the
configured input bound, fails as `invalid_request`; a cursor the adapter
itself rejects fails as `server_error`. Run it from a host maintenance job
behind host rate limits, never from an agent-facing route.

## Internal credential and validation helpers

These implementation helpers are not exported from the package entry point;
hosts use the service and HTTP adapters. They use Web Crypto random bytes and
SHA-256, without JWTs or custom ciphers. `createCredential(kind, locator)` returns a fresh opaque string;
`parseCredential(value)` returns frozen `{ kind, locator, secret }` or null.
Kinds are `device`, `authorization`, `access`, and `refresh`; their distinct
versioned prefixes are `pgd1`, `pga1`, `pgt1`, and `pgr1`. The format is
`prefix.locator.secret`, where both suffix segments are 43-character base64url
encodings of 32 bytes. Only the full credential hash authorizes a transition.
Raw returned credentials must never be persisted, logged, or audited.

- `generateLocator(): string` creates 256 random bits.
- `generateUserCode(): string` creates eight uniform readable base32 symbols,
  displayed as `XXXX-XXXX`.
- `normalizeUserCode(value): string` accepts case-insensitive entry and an
  optional central hyphen; `deviceLocator(userCode): Promise<string>` hashes
  the normalized code into its partition locator.
- `hashCredential(value): Promise<string>` hashes the complete credential.
- `pkceChallenge(verifier): Promise<string>` validates and hashes an RFC 7636
  verifier; `verifyPkce(verifier, challenge): Promise<boolean>` verifies S256.
- `scopeFingerprint(selectedDefinitions): Promise<string>` returns the
  ordering-independent selected-definition fingerprint.
- `normalizeConfiguration`, `getClient`, `validateResource`, `selectScopes`,
  `validateRedirectUri`, `assertInputBounds`, `validateCodeChallenge`, and
  `validateState` provide the service's deterministic internal validation.
  `captureInput` snapshots bounded plain data before awaiting host or storage
  work, rejecting accessors and serialization hooks without invoking them.

`OAuthError` exposes `code`, `status`, and static content-free `description`.
`toJSON()` returns `{ error, error_description }`. Invalid credentials and
storage failures never include supplied values or underlying causes. Storage
unavailability uses `server_error` with HTTP 503; unknown outcomes fail closed.
The HTTP adapter distinguishes host limiter denial as HTTP 429 with
`temporarily_unavailable` and optional `Retry-After`, while limiter failure uses
HTTP 503 with `server_error`. `temporarily_unavailable` defaults to HTTP 503
when constructed without a status override.

## Retention and activation

The API deliberately has no sweep operation; `listGrants` is owner-scoped
discovery, not a retention enumerator. A host retention job must keep the
entire partition, including consumed refresh hashes and
Audit events, until the absolute family lifetime has ended. Cleanup must use
bounded storage operations and a reviewed host retention policy. Deleting
consumed hashes early would disable reuse detection. Source validation does
not publish the package, configure a trusted publisher, or activate a host.

Owner-index rows hold only a grant ID and a sequence number. Listing skips
an entry whose grant head is missing (removed by retention), owned by another
principal, or never approved. Such entries arise only from host retention or
from an approval that failed or lost its outcome after its write-ahead index
commit, so they are rare, but each still occupies a slot on its page. A host
maintenance job may prune them with bounded keyed work. Owner-index and grant
partitions cannot be updated atomically together, so pruning can never be made
strictly race-free against an approval. `approve` commits the index entry
first, and its grant transaction can still commit shortly after the request
deadline, because the deadline is checked before the transaction is sent.
Treat a pending head as possibly in flight well past its expiry:

1. Read an owner's `entry:` row and the referenced grant head.
2. Skip the entry if the head is owned by that principal and approved, or if
   the head is `pending` and the current time is earlier than its request
   expiry plus a grace period longer than the host's longest approval request
   or storage timeout (for example, at least ten minutes).
3. Otherwise (the head is missing, terminal, approved for another principal,
   or pending beyond that grace period), delete the `entry:` and matching
   `grant:` rows.
4. Run `backfillGrantIndex` to completion on a recurring schedule, not only
   once after pruning. It is idempotent and restores any entry that a residual
   race removed for a grant that is now approved for its owner, for example an
   approval whose transaction outlived the grace period or a device request
   that reused a retained locator. Until that repair runs, such a grant stays
   fully usable and revocable by ID but is missing from `listGrants`.

Hosts that cannot schedule recurring backfill should not prune: dangling
entries are only skipped page slots, never a disclosure or authorization path.

Never delete an owner-index `head` row while the owner has entries, because
the head orders new entries; a reset head makes later approvals for that owner
fail closed.
