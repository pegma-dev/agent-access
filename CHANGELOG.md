# Changelog

## 0.2.0

- Add `listGrants(browserContext, { ownerPrincipal, cursor?, limit?, statuses? })` for
  owner-scoped grant discovery. Pages return safe grant views, default to 20
  entries, allow at most 100 entries, and use owner-bound opaque cursors. Each
  call rechecks the trusted browser session and current owner authority. The optional
  `statuses` filter accepts `pending`, `active`, `revoked`, and `expired`; filtering
  can return fewer items than the page limit while a continuation cursor remains.
- Maintain the new `agent-access.owner-index.v1` Storage Core collection during
  approval. The owner index uses a separate partition from each grant; listing
  re-reads authoritative grant heads and claims no cross-partition atomicity.
- Add the bounded, idempotent `backfillGrantIndex({ cursor, limit })` maintenance
  API to index approved grants created before 0.2.0. Each call scans at most
  `limit` physical grant rows (default 100, maximum 1000).
- Add opt-in `multipart: { maxBytes }` mode to
  `createProtectedResourceAuthenticator`. `maxBytes` defaults to 1 MiB
  (1048576 bytes) and must be a positive integer no greater than 16 MiB
  (16777216 bytes). Bearers remain header-only; credential fields in parts are
  rejected, parsed form data is returned as `result.form`, and authorization is
  rechecked after parsing.

### Host upgrade

Before deploying, provision `agent-access.owner-index.v1` with the same
read/write/transaction rights as `agent-access.records.v1` if the host explicitly
provisions collections, tables, or roles. Run `backfillGrantIndex` once to
completion for each configured issuer/resource: pass each returned `nextCursor`
to the next call until it is null. Run this through host maintenance, never an
agent-facing route. Existing grants remain usable and revocable by ID before
backfill, but do not appear in owner listings until indexed. Hosts that prune
index entries also need recurring backfill as described in [the API
guide](docs/API.md#owner-grant-listing).

Multipart remains off by default. Enable it explicitly only on authenticators
that accept uploads and select an appropriate body limit; omitting `maxBytes`
within the option uses the 1 MiB default.

## 0.1.1

- Published package baseline preceding the owner-listing and opt-in multipart
  additions in 0.2.0.
