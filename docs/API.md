# Public API and host boundary

The source package is not yet published. It composes the released
`@pegma/authorization-core` AccessContext, `@pegma/spine` Clock/PrincipalId/
IsoTimestamp, `@pegma/storage-core` Store, and transactional `@pegma/audit`.
The host keeps its existing login, session, administrator policy, browser
CSRF/origin checks, distributed request limiting, and resource operations.

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

`DelegatedAccess` contains `grantId`, `clientId`, `resource`, `scopes`, and
`access`. Every authentication and refresh resolves current owner authority
and the approval permission again. The returned AccessContext intersects
current permissions with the approved scope definitions; `roles` and
`entitlements` are always empty. The host must authorize the actual resource
operation using this restricted context.

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

## Retention and activation

The first API deliberately has no list or sweep operation. A host retention
job must keep the entire partition, including consumed refresh hashes and
Audit events, until the absolute family lifetime has ended. Cleanup must use
bounded storage operations and a reviewed host retention policy. Deleting
consumed hashes early would disable reuse detection. Source validation does
not publish the package, configure a trusted publisher, or activate a host.
