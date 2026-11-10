# Fetch protocol adapter

`createAgentAccessHttp({ service, configuration, authenticateBrowser, limit })`
returns `{ handle(request): Promise<Response | null> }`. Pass the same
configuration to the service and adapter. A null result leaves routing to the
host. The adapter adds no framework or HTTP runtime dependency.

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
or `{ allowed, retryAfterSeconds? }`. Denial returns HTTP 429 with OAuth
`temporarily_unavailable` and an optional `Retry-After`. Limiter failure or an
invalid result fails closed with HTTP 503 and OAuth `server_error`.
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

`createProtectedResourceAuthenticator({ service, configuration, multipart? })`
returns `{ authenticate(request, requiredScopes?) }`. Its Promise resolves to
`ProtectedResourceAccess` (a `DelegatedAccess`, plus `form` for an opted-in
multipart request) or an error `Response`. It accepts one `Authorization: Bearer`
credential, rejects query `access_token`, and emits a `WWW-Authenticate`
challenge with `resource_metadata` on authentication errors. An insufficient
scope returns HTTP 403 and the required scope in the challenge. Unavailable
authority returns HTTP 503.

By default the helper never consumes the host's resource body. It rejects form
and multipart content types, so credentials cannot arrive simultaneously in
form and header transports. URL-encoded form resource operations remain
unsupported; hosts requiring them must implement their own bounded check for
forbidden body credentials around the service's `authenticate` method.

### Opt-in multipart uploads

File-upload endpoints can opt in per authenticator:

```ts
const uploads = createProtectedResourceAuthenticator({
  service,
  configuration,
  multipart: { maxBytes: 4 * 1024 * 1024 }, // omit maxBytes for the 1 MiB default
});
const result = await uploads.authenticate(request, ["files.write"]);
if (result instanceof Response) return result;
const file = result.form?.get("file"); // already parsed and inspected
```

Only an authenticator created with `multipart` accepts `multipart/form-data`;
every other authenticator keeps rejecting it. `maxBytes` defaults to
1 MiB (1048576 bytes) and must be a positive integer no larger
than 16 MiB (16777216 bytes); an invalid bound throws `OAuthError` at
construction. Larger uploads need a separate host transport, such as a
pre-authorized direct upload.

The order is fixed. Header checks run first: Content-Type parameters are
parsed quote-aware (RFC 9110, so quoted values may contain `;`), there must
be exactly one valid RFC 2046 `boundary` parameter (a token, or a quoted
string when it uses spaces or other separators), and a declared
`Content-Length` must be well formed and no larger than the bound. A declared oversize body returns HTTP 413 before any byte
is read. The `Authorization: Bearer` header is then authenticated exactly as
for other requests, so a missing or invalid bearer returns its 401 challenge
without reading the body. Only after the bearer is accepted is the body parsed. Because an upload can
take arbitrarily long, the bearer is authenticated again after parsing, and
the returned access reflects that second check: revocation, expiry, or an
authority change during the upload fails closed.

Credentials still come only from the header. The body is read from
`request.clone()` through a byte counter, so the host's original `Request`
stays unread on success. An oversized or unbounded stream is stopped at the
bound with HTTP 413. On every rejection after the multipart headers are
examined, both tee branches are cancelled so the upload source itself closes;
the host must not read the body of a rejected request. The parsed form is returned as `result.form` so the host need
not parse twice; the host may instead read its untouched original body. For simple file
uploads, budget about twice `maxBytes` per in-flight upload: the tee retains
the unread original while the clone is parsed. This is not a general memory
bound. The bound limits streamed bytes only; the runtime's parsed `FormData`
adds per-part objects and string representations, so bodies with many small
parts or large text fields can cost more. Keep `maxBytes` small for
endpoints that accept many fields, and apply host request concurrency limits. The authenticator rejects with HTTP
400 `invalid_request` any part named `access_token`, `refresh_token`,
`id_token`, `client_secret`, `client_assertion`, `client_assertion_type`,
`device_code`, or `code_verifier` (case-insensitive), and any part name, text value,
or filename containing an issued Agent Access credential. Query `access_token` is
still rejected. File contents are not scanned. Missing, duplicate, or invalid
boundaries, an empty body, and a malformed multipart body are HTTP 400
`invalid_request`. Every 4xx rejection carries the usual `WWW-Authenticate`
challenge; a 503 `server_error` (for example, unavailable current authority)
carries none, as for other resource requests. No rejection includes submitted
values. Non-multipart requests through an opted-in
authenticator behave exactly as before and carry no `form`.

The host still authorizes the actual operation using
the returned restricted `access`; accepting a token alone does not authorize
an operation. Resource transport CORS, routing, body limits, and host limiter
remain host responsibilities.

Protocol references: [authorization-server metadata (RFC 8414)](https://www.rfc-editor.org/rfc/rfc8414.html),
[protected-resource metadata (RFC 9728)](https://www.rfc-editor.org/rfc/rfc9728.html),
[device authorization (RFC 8628)](https://www.rfc-editor.org/rfc/rfc8628.html),
[token revocation (RFC 7009)](https://www.rfc-editor.org/rfc/rfc7009.html),
and [bearer errors (RFC 6750)](https://www.rfc-editor.org/rfc/rfc6750.html).
