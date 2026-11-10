# Agent Access

A composable Pegma component for administrator-approved local-agent access.
Existing host logins authorize OAuth device-code and authorization-code/PKCE
grants. Issued credentials carry explicitly consented scopes, never the
administrator's role or unrestricted access.

The component owns the grant lifecycle over Storage Core, current host
authority checks, and transactional Audit. Hosts own their existing login,
browser sessions, admin policy, CSRF/origin checks, rate limiting, approval UI,
HTTP composition, and resource operations. Knowledge Base remains a resource
server and does not issue credentials.

Only current host administrators may link an agent. The agent receives the
selected scope permissions intersected with current host authority, with no
Admin role or session cookie. Initial Knowledge Base scopes cover draft
reading, draft writing, and test-evidence submission. Future capabilities
require explicit registration and fresh consent; changing the registry cannot
silently widen an existing grant.

The source is the `@pegma/agent-access@0.2.0` release candidate.
`@pegma/agent-access@0.1.1` is already published as npm `latest`, and its
`v0.1.1` tag exists; this does not establish provenance for the new candidate.
Maintainer 2FA bootstrap of all five
`0.1.0` packages, the four Knowledge Base packages and Agent Access, is complete
with exact registry bytes confirmed and no OIDC provenance. The
[bootstrap receipt](docs/BOOTSTRAP.md#bootstrap-receipt-2026-11-07) records the
Agent Access artifact identity and distribution-tag verification requirement.
AUTH-01 source, official SDK proof, and the separate release preparation are merged;
the [dated source evidence](docs/PROJECT_PLAN.md#delivery-and-evidence) records
the reviewed heads, squash merges, primary CI, and historical per-lane results.
The governing [Knowledge/AI plan](https://github.com/pegma-dev/support-desk/blob/main/docs/KNOWLEDGE_AI_PLAN.md)
tracks the remaining work. Source tests and a synthetic client example do not
establish real host login, two-host client acceptance, publication, or deployment.
Initial compatibility targets are Codex, Claude Code, Grok Bot, and T3 Code.
Grok Bot is the desktop application with its hosted agent; T3 Code initially
targets Codex-provider mode. Their compatibility remains unproven until actual
per-client runs; other T3 providers are also unproven. An official SDK protocol
test does not establish support for those applications.

Hosts can list the signed-in owner's linked agents with the owner-scoped,
paginated `listGrants` ([owner grant listing](docs/API.md#owner-grant-listing))
and can opt individual protected-resource authenticators in to bounded
multipart uploads with header-only bearer credentials
([opt-in multipart uploads](docs/HTTP.md#opt-in-multipart-uploads)). Both are
additions in the `0.2.0` candidate. Hosts upgrading grants created before 0.2.0 must run
the bounded `backfillGrantIndex` maintenance call as a one-time upgrade step; multipart remains off by default.
See the [changelog](CHANGELOG.md) for the upgrade notes.

Read the [architecture](docs/ARCHITECTURE.md), [API](docs/API.md), and
[HTTP composition](docs/HTTP.md) before wiring a host. The
[project plan](docs/PROJECT_PLAN.md) distinguishes source work from host gates;
[release operations](docs/RELEASING.md) describes the separate first publication
and later trusted-publisher path. The [maintainer bootstrap handoff](docs/BOOTSTRAP.md)
records the initial 2FA publication under the requested `bootstrap` tag. Operators
must verify actual distribution tags and investigate unexpected defaults.
The `0.2.0` candidate still needs fresh gates and review, verified publisher
configuration, an approved signed tag and release, and successful exact registry
consumer and trusted-provenance verification. Release preparation preserves
exact tarball bytes, an independently retained manifest digest, and the
verified signed-tag identity. External protection, signer, environment, and
trusted-publisher/direct-publish configuration remain maintainer gates.
Knowledge Base's advertised release waits for verified Agent Access `0.2.0`.
SD-02 requires verified advertised Knowledge Base dependencies; real host
assembly requires verified advertised dependencies from both components. Merged source
and release preparation authorize no tags, releases, publication,
configuration, or deployment; manual workflow dispatch prepares only.

Built in the open by RetireGolden, LLC. MIT licensed.
