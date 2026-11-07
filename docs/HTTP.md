# Fetch protocol adapter

`createAgentAccessHttp({ service, configuration, authenticateBrowser, limit })`
returns `{ handle(request): Promise<Response | null> }`. Pass the same
configuration to the service and adapter. A null result leaves routing to the
host. There are no runtime dependencies or framework bindings.

The adapter serves GET authorization-server metadata at the RFC 8414 issuer
discovery URL, GET protected-resource metadata at the exact configured
`resourceMetadata` endpoint, GET `authorize`, and form POST
`deviceAuthorization`, `token`, and `revocation`. An issuer path follows the
RFC 8414 insertion rule, for example issuer `https://example.test/tenant`
uses `https://example.test/.well-known/oauth-authorization-server/tenant`.
Metadata advertises only configured grants, public client authentication, S256
PKCE, query authorization responses with `iss`, and header bearer transport.

`limit(request, { endpoint })` is required and calls the existing host limiter
before protocol processing. Endpoint names are `authorize`,
`device_authorization`, `token`, and `revocation`. Return a Promise of a boolean
or `{ allowed, retryAfterSeconds? }`. Denial returns HTTP 429 with an optional
`Retry-After`; limiter failure or an invalid result fails closed with HTTP 503.
The service's device polling interval is a separate grant-level control.

Every protocol field is a singleton. Unknown fields, malformed encoding,
unsupported content types, query credentials, client secrets, and HTTP client
authentication are rejected. Grant forms require the exact `resource` on every
device authorization, code exchange, device poll, and refresh. Revocation
binds the registered `client_id` to the supplied opaque credential; it accepts
only `token` and optional `token_type_hint` alongside that client identifier.
Unknown hint values are ignored as RFC 7009 requires; hints never authorize or
prevent revocation.
POST reads count actual streamed bytes, use at most 16 KiB (or the lower
configured input limit), and cancel oversized streams. Replies never include
submitted values or internal error causes and set `no-store`, `nosniff`, and
`no-referrer`. Disable host request/body/URL tracing for credential-bearing
endpoints and approval redirects.

## Browser trust seam

`authenticateBrowser(request, { mutation: false })` returns a Promise of a
trusted `BrowserApprovalContext`, or a `Response` for the host's login handoff.
The callback must use the host's existing browser session and protection
policy. A desktop bearer or client-submitted access context cannot satisfy it.
An authorization request is fully validated before calling the callback.
Successful creation redirects with HTTP 303 to the configured approval URL,
carrying only `request_id`. Submitted client redirect URLs are never returned
as approval links. Validation errors return JSON at the authorization endpoint.

The host owns `approval` and `verification` routes, login, UI rendering,
same-origin/CSRF checks, and all approval and revocation mutations. These routes
are not handled by this adapter. Fetch an authorization view using
`service.getAuthorizationApproval(context, requestId)` or a device view using
`service.getDeviceApproval(context, humanEnteredCode)`. Escape the returned
display strings and render the selected scopes and configured client name.
Before calling `service.approve` or `service.revokeGrant`, require the trusted
current browser session, exact host origin and existing host CSRF validation.
Device approval must also carry the human-entered code. Redirect only to the
service's resulting validated `redirectUri`, and never log that URI. Do not
attach permissive CORS headers to browser consent endpoints.

## Protected resources

`createProtectedResourceAuthenticator({ service, configuration })` returns
`{ authenticate(request, requiredScopes?) }`. Its Promise resolves to
`DelegatedAccess` or an error `Response`. It accepts one `Authorization: Bearer`
credential, rejects query `access_token`, and emits a `WWW-Authenticate`
challenge with `resource_metadata` on authentication errors. An insufficient
scope returns HTTP 403 and the required scope in the challenge. Unavailable
authority returns HTTP 503.

The helper never consumes the host's resource body. It rejects form and
multipart content types, so credentials cannot arrive simultaneously in form
and header transports. Hosts requiring form resource operations must implement
their own bounded check for forbidden body credentials around the service's
`authenticate` method. The host still authorizes the actual operation using
the returned restricted `access`; accepting a token alone does not authorize
an operation. Resource transport CORS, routing, body limits, and host limiter
remain host responsibilities.

Protocol references: [authorization-server metadata (RFC 8414)](https://www.rfc-editor.org/rfc/rfc8414.html),
[protected-resource metadata (RFC 9728)](https://www.rfc-editor.org/rfc/rfc9728.html),
[device authorization (RFC 8628)](https://www.rfc-editor.org/rfc/rfc8628.html),
[token revocation (RFC 7009)](https://www.rfc-editor.org/rfc/rfc7009.html),
and [bearer errors (RFC 6750)](https://www.rfc-editor.org/rfc/rfc6750.html).
