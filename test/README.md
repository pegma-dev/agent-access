# Public lifecycle conformance fixtures

`tests/lifecycle.test.ts` and `tests/storage.test.ts` exercise the same public
factory and service methods against released Memory, Azure Tables and
Cloudflare D1 adapters. Azurite and Miniflare run locally with fictional
principals, clients, resources and permissions. No cloud account, customer data
or deployed service participates.

- `stores.ts` creates one isolated backing collection/database per test. Memory
  and Azurite use the released adapters directly. `d1.ts` supplies the released
  D1 adapter with Miniflare's native D1 database, without type casts or a SQL
  compatibility shim.
- `azurite.ts` owns the table emulator on loopback port **10312**. Startup fails
  when that port is occupied. Teardown waits for process exit before deleting a
  verified temporary directory. The port is distinct from the other Pegma
  repositories' test emulators.
- `d1.ts` registers bounded test cleanup before creating a native runtime. Its
  compatibility date is fixed to a date supported by the pinned local workerd.
- `fixtures.ts` resolves current fictional Admin permissions with the released
  Authorization Core. Its mutable clock and current-authority switches model
  expiry, demotion, account removal and identity-service failure. Browser
  authentication and current identity remain explicit host trust inputs.
- `trace-store.ts` delegates storage operations to the actual adapter. It
  observes keyed reads, enumerations, physical encoded records and transactions.
  Its commit interceptor is used only to inject a lost acknowledgement after an
  actual successful transaction. Snapshot scans are bounded observations of the
  backing store and do not participate in the application path.

The suites verify explicit browser consent, mandatory PKCE and callback/client/
resource binding, polling and denial, single use under concurrency, immutable
family consent, current permission intersections, replay handling, revocation,
scope-definition changes, alias isolation, credential-free persistence and
audit records, physical row limits and absolute lifetimes. Deadline tests
advance the clock during awaited authority resolution. Storage failure tests
prove that an ambiguous successful rotation returns no replacement credential,
does not retry minting, and treats a retry of the consumed input as reuse.

HTTP boundary and actual SDK-client interoperability proofs live separately in
`tests/http.test.ts` and `tests/protocol-client.test.ts` so that service semantics
and transport behavior are independently observable.
