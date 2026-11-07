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

As of 2026-11-07, all five new packages, the four Knowledge Base packages and
`@pegma/agent-access`, remain unpublished at source version `0.1.0`. AUTH-01
source, official SDK proof, and the separate release preparation are merged;
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

Read the [architecture](docs/ARCHITECTURE.md), [API](docs/API.md), and
[HTTP composition](docs/HTTP.md) before wiring a host. The
[project plan](docs/PROJECT_PLAN.md) distinguishes source work from host gates;
[release operations](docs/RELEASING.md) describes the separate first publication
and later trusted-publisher path. The [maintainer bootstrap handoff](docs/BOOTSTRAP.md)
keeps the initial 2FA-published `bootstrap` version unadvertised. The first
advertised version needs a separate reviewed change and successful registry
consumer and trusted-provenance verification. Release preparation preserves
exact tarball bytes, an independently retained manifest digest, and the
verified signed-tag identity. Maintainer bootstrap and external protection,
signer, environment, and trusted-publisher/direct-publish configuration remain
pending. SD-02 requires published Knowledge Base dependencies; real host
assembly requires published dependencies from both components. Merged source
and release preparation authorize no tags, releases, publication,
configuration, or deployment; manual workflow dispatch prepares only.

Built in the open by RetireGolden, LLC. MIT licensed.
