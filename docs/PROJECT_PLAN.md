# Agent Access project plan

AUTH-01 is the scoped-credential prerequisite inserted before KB-04 in the
[Knowledge/AI plan](https://github.com/pegma-dev/support-desk/blob/main/docs/KNOWLEDGE_AI_PLAN.md).
This repository owns reusable authorization-server source; Knowledge Base
continues to own content and resource operations. The first source package is
`@pegma/agent-access@0.1.0`, unpublished. Source implementation and validation
are in progress; no host is activated by this work.

## Accepted first scope

- Reuse existing host logins. Only current administrators link and manage
  their grants; agent credentials carry scoped permissions with no Admin role.
- Support the device-code flow and authorization-code flow with mandatory
  S256 PKCE, configured public clients, exact resource binding, opaque hashed
  credentials, rotating refresh families, replay revocation, and discovery.
- Preserve explicit selected-scope consent through configuration changes and
  recheck current principal/approval authority on use and refresh.
- Compose exact released Spine, Storage Core, Audit, and Authorization Core;
  hosts retain sessions, role policy, browser protection, durable limiters,
  evidence attestation, and resource operations.
- Start KB authoring with instance-wide draft read/write and test-evidence
  submission. Other scopes and collection-specific consent are future work.

## Delivery and evidence

| Gate                     | Evidence needed                                                                                                                                                                                                        | Current state                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| AUTH-01 source           | Public-entry lifecycle/concurrency/security cases, real Azure Tables and D1 fixtures, Node 22/24 gates, exact packed-artifact imports, and clean current-head review                                                   | In progress                                                 |
| Synthetic protocol proof | Actual supported SDK client exercises discovery, PKCE, protected requests, refresh and revocation; device-flow failure and isolation cases                                                                             | In progress; synthetic proof is not host acceptance         |
| First publication        | Maintainer publishes reviewed exact artifact with 2FA, then configures trusted publishing and verifies registry integrity                                                                                              | Pending; separate operation                                 |
| KB-04 source exit        | Actual SDK exercises synthetic draft/evidence API/MCP parity and rejected credential/attestation cases; full KB source/review gates                                                                                    | Pending in KB; establishes source release readiness only    |
| KB-05 publication        | KB's reviewed artifact/release gates after KB-04 source exit, including exact artifact publication                                                                                                                     | Pending in KB; actual host proof is a later activation gate |
| Retained host acceptance | PG-01/RG-01 consume published Agent Access/KB dependencies; actual requested clients prove existing-login/Admin consent, protected API/MCP, credential failures, and exact-revision evidence attestation on both hosts | Pending; required before activation/A-01/pilots             |

Source units and synthetic protocol proof may land before publication. A
test-only clean consumer can install the reviewed local tarball to prove its
exports; production consumers must use published exact dependencies. Never
substitute a source checkout, Git reference, or unpublished tarball for a host
production dependency.

Initial client compatibility targets are **Codex, Claude Code, Grok Bot, and
T3 Code**. Grok Bot means the desktop application with its hosted agent, not
Grok Build CLI. T3 Code targets Codex-provider mode first; other providers
remain unproven. Each target remains unproven until its actual application
completes the supported credential and protected-resource flow. Record
client/version/provider mode, transport, configured issuer/resource, and outcome
separately for each target and host. A successful official SDK protocol test
establishes protocol behavior, not compatibility with all four clients; missing
clients or unsupported flows remain explicit host acceptance gaps.

The sequence is AUTH-01 source/SDK fixture, KB-04 transport source exit,
KB-05 reviewed publication, then PG-01/RG-01 existing-login and actual-client
proof using published dependencies. Agent Access publication also precedes
host assembly. KB-04 source completion may close only its source slice;
retained two-host acceptance stays open in P-00 and the host tasks until all
original draft/evidence, privacy, authority, expiry/revocation/audience, and
invalid-attestation cases pass. No source or SDK result closes host activation.

## Deferred work

No dynamic registration, arbitrary client metadata fetching, general OAuth
identity provider, shared cross-host control plane, or automatic host rollout
is included. KB collection reading/listing, evidence reading, review submission,
publication, admin commands, and private provenance are not initial agent
operations. New capabilities need explicit contracts, policy, fresh consent,
and their own source and host evidence.

Preserve the governing plan's existing merged-source ledger. AUTH-01 source
validation does not close KB-04's source or retained host acceptance, KB-05's
release/publication gates, dual-host acceptance, operations, model data-control,
or supervised-pilot gates. See [RELEASING.md](RELEASING.md) before any separately
authorized release operation.
