# Synthetic protocol proof

Run `pnpm example` after installing the pinned dependencies. The runner binds
only `127.0.0.1` on an ephemeral port, uses fresh in-memory Storage Core records,
and closes its listener when finished. It prints only a short pass receipt with
protocol names, booleans, and HTTP statuses. It never prints cookies, CSRF
values, authorization URLs, codes, verifiers, or bearer/refresh credentials.

This is a **fictional host with a simulated HTTP browser**, not a real host
login, real host activation, production receipt, or a complete MCP tool server.
The protected resource returns one synthetic fixture. A real knowledge-base
tool connection is a separate integration phase.

The client is the actual released `@modelcontextprotocol/sdk` **1.32.2** OAuth
client (`auth` and `OAuthClientProvider`), rather than a locally reimplemented
client or the SDK's development branch. The provider supplies pre-registered
public-client information bound to this issuer; dynamic registration and
client-metadata-document fetching are intentionally absent. The SDK performs
resource and authorization-server discovery, generates S256 PKCE, exchanges the
authorization code, and rotates the refresh token through real HTTP requests.
The runner validates callback state and issuer before handing its code to the
SDK, accesses the protected fixture, revokes the family through RFC 7009, and
checks that the bearer is rejected. Device issuance, manual code-entry consent,
pending/slow-down responses, and redemption use separate HTTP requests.

`host.ts` labels the trust seam where an existing host login would already have
authenticated a fictional Admin. Released `@pegma/sessions` 0.2.0 owns the
browser session; released `@pegma/authorization-core` 0.4.0 resolves current
Admin-only linking permission. There is no new session store or identity login.
The host consent form checks an exact Origin and a CSRF value from that
session. Only host routes call approval; desktop bearer credentials never
establish browser identity. The fixture advances an injected clock for polling
and expiry tests, so it does not wait in real time. Its limiter callback allows
all requests solely for the fixture; actual hosts must inject their existing
abuse controls. HTTP issuer/resource mode is enabled only for this loopback
harness. Actual deployments require HTTPS.

The HTTP bridge and native callback listener share a process and port for this
small fixture. A desktop application must use its own native loopback listener
and the system browser, validate callback state/issuer, isolate OAuth sessions,
and protect saved credentials with its platform facilities. The provider's
in-memory credentials exist only for this short proof.

Codex and Claude interoperability remains **unproven** until their actual
client configurations connect to an activated real host. This SDK proof must
not be reported as validation of either desktop product or production login.
