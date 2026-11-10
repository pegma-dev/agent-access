# Architecture and trust boundaries

Agent Access owns delegated machine access after a person signs in through
the host's existing login. It is a small OAuth authorization server and grant
validator, not an identity provider or session implementation. It supports the
device authorization grant and authorization-code grant with mandatory S256
PKCE for configured public clients. See [API.md](API.md) for the source
contract and [HTTP.md](HTTP.md) for protocol composition.

## Composition

| Owner                          | Responsibility                                                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Agent Access                   | Protocol validation, consent snapshot, credential issue/rotation, revocation, discovery metadata, and delegated access validation |
| Host identity and sessions     | Existing human login and trusted current browser-session access                                                                   |
| Host Authorization Core policy | Current active principal, Admin-only linking permission, resource permissions, and current authority resolution                   |
| Storage Core and Audit         | Declared records, optimistic concurrency, and atomic grant-transition audit actions                                               |
| Host HTTP and UI               | Browser consent UI, CSRF and same-origin checks, HTTPS configuration, protected routes, and durable request limits                |
| Resource component             | Its operation-level permissions, resource checks, DTOs, and evidence policy                                                       |

The exact released foundations are dependencies, not copied implementations.
Identity refuses OAuth/OIDC, Sessions refuses authentication/token logic, and
Authorization Core's short-lived consume-on-verify access grants are not
reusable OAuth credentials. This separate component preserves those boundaries.
No database adapter, role model, identity login, general limiter, or custom
cryptographic primitive belongs here.

## Consent and effective authority

A configured public client requests one configured resource and explicit
scopes. The browser approval context comes only from the host's existing
authenticated session after CSRF/origin validation. A desktop bearer cannot
approve itself. Approval and grant management require current Admin authority;
inspection and revocation also check grant ownership. The host maps the
linking permission exclusively to its administrators.

Consent binds the owner, client, resource, selected scope definitions and their
fingerprint. The fingerprint includes only selected definitions: adding an
unrelated registry scope preserves existing grants, while changing an approved
definition requires relinking. New capabilities require a new approval; a
scope name is never an instruction to inherit the owner's role.

Each resource authentication and refresh resolves the owner's current status,
linking authority, and permissions. Effective permissions are the intersection
of current permissions, approved definitions, and access-token scopes. Returned
access has empty roles and entitlements. The resource still performs its own
authorization and ownership checks. Missing or unavailable current authority
fails closed. These are current checks, not an atomic authorization lease
across another component's policy store.

The initial KB integration selects only draft read/write and test-evidence
submission. Authoring is instance-wide initially; collection-specific grants
are a future extension that requires explicit policy and consent. The initial
agent transport exposes only `getDraft`, `createDraft`, `updateDraft`,
`getValidationRequirements`, and `submitEvidence`. Collection reads/listing,
evidence reads, review submission, publication, administration, and private
provenance are outside that transport.

## Durable lifecycle

One grant's head, consumed-credential records, and transactional Audit actions
share one Storage Core collection/partition. Transitions use optimistic
conditions so a credential cannot successfully mint two successors. A locator
enables a keyed read; only a matching complete credential hash authorizes its
transition. No cross-partition, cross-collection, or role-change transaction is
claimed. Required lifecycle work never depends on the lossy Spine event bus.

Owner discovery uses a separate owner-index collection with one partition per
hashed issuer, resource, and owner. Because the index lives in another
partition, it is a write-ahead locator rather than part of the grant
transaction: approval commits the owner entry first, then the grant
transition. Listing re-reads every authoritative grant head and returns it only
when the owner, issuer, and resource still match, so a leftover entry from a
failed approval never surfaces another principal's grant. Status changes touch
only the grant head. Pages are bounded keyed reads, not scans; a bounded,
idempotent backfill indexes grants approved before the index existed. See
[API.md](API.md#owner-grant-listing).

Credentials use Web Crypto randomness and hashing. Raw device, authorization,
access, and refresh credentials are returned to the client and never persisted,
logged, or included in Audit. This also excludes user codes, PKCE verifiers,
cookies, credential-bearing bodies, and complete authorization redirects from
operational output. Approval views contain trusted display data without secrets.

Refresh rotates one family. All consumed refresh hashes remain until the
family's absolute lifetime ends, enabling known-reuse detection. Recognized
reuse revokes the family; random invalid input cannot revoke a family through
its locator. A narrowed refresh request narrows the resulting access token,
not the family's original consent. Refresh also replaces the current access
credential; the previous access token stops working. Concurrent or lost-response
refreshes do not recover raw credentials from hashes: clients serialize refresh and relink
when the outcome cannot be resolved. Unknown storage outcomes fail closed.

Explicit lifetimes, input size, scope count, polling interval, conflict
attempts, family rotations, and physical row limits bound work. Capacity is
reserved for terminal revocation. Reaching a family cap requires relinking.
Hosts additionally enforce durable limits on issue, token, approval, and
resource routes, and implement bounded retention cleanup only after a family's
expiry. Deleting active-family replay hashes defeats reuse detection.

## Resource and host activation

Knowledge Base remains the resource server. An authenticated agent submitting
`passed` has proved its identity, not that a test ran. A trusted host attester
must verify submitting actor, runner, exact article revision/hash, target
build, and execution receipt before constructing accepted evidence. Missing or
unverifiable proof fails closed; staff review remains necessary for publication.

The synthetic example exercises public protocol entry points with fictional
host data. Real existing-login composition, actual client support, protected
evidence attestation, released dependency installation, and deployment must
still be verified independently on both hosts. Neither source completion nor
publication activates either host.
