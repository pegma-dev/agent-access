# Agent Access project plan

AUTH-01 is the scoped-credential prerequisite inserted before KB-04 in the
[Knowledge/AI plan](https://github.com/pegma-dev/support-desk/blob/main/docs/KNOWLEDGE_AI_PLAN.md).
This repository owns reusable authorization-server source; Knowledge Base
continues to own content and resource operations. The current source is the
`@pegma/agent-access@0.1.1` candidate for the first advertised trusted release.
AUTH-01 source and the original release preparation are merged. As of
2026-11-07, maintainer 2FA bootstrap of all five `0.1.0` packages, the four
Knowledge Base packages and Agent Access, is complete with exact registry bytes
confirmed and no OIDC provenance; no host is activated by this work.

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

This canonical evidence snapshot retains the reviewed `0.1.0` source history.
CI totals are historical results for the linked reviewed source heads,
distinct from the recorded squash merge commits. They are not fixed test-count
requirements or publication guards. The
[2026-11-07 bootstrap receipt](BOOTSTRAP.md#bootstrap-receipt-2026-11-07)
records completion of all five `0.1.0` uploads and exact-byte confirmation,
without OIDC provenance. The `0.1.1` candidate still needs fresh current-head
review, validation, publisher configuration, a signed tag and release, and
strict registry/provenance verification in [release operations](RELEASING.md).

| Gate                                  | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                     | Current state                                                                                                                                                                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AUTH-01 source and official SDK proof | Reviewed head [1ba5286](https://github.com/pegma-dev/agent-access/commit/1ba52860e80bc3ec6692f9dd112dd02f0616aebd); [primary Node 22/24 CI](https://github.com/pegma-dev/agent-access/actions/runs/42382637167). Original 123 runtime tests and official SDK proof.                                                                                                                                                                          | Merged via [Agent Access #1](https://github.com/pegma-dev/agent-access/pull/1) as [a444e21](https://github.com/pegma-dev/agent-access/commit/a444e2113db98455b638b2ef8aa7c2faccb16b62); historical source evidence.                  |
| Agent Access release preparation      | Reviewed head [165e56a](https://github.com/pegma-dev/agent-access/commit/165e56ab19e9860d6c0bd17f419052b751394b9c); [primary Node 22/24 CI](https://github.com/pegma-dev/agent-access/actions/runs/42399414623). Each lane passed 123 runtime tests plus 136 release regressions (259 per lane), with zero skips, the synthetic example, and packed public API/type checks.                                                                  | Merged via [Agent Access #2](https://github.com/pegma-dev/agent-access/pull/2) as [eddddd5](https://github.com/pegma-dev/agent-access/commit/eddddd5e333ce16b6a4a8233b84656b3ac784947); historical release-preparation source.       |
| KB-04 transport source exit           | Reviewed head [c897626](https://github.com/pegma-dev/knowledge-base/commit/c897626de6c7b2ea574f4154b0bc7a7731ee106e); [primary Node 22/24 CI](https://github.com/pegma-dev/knowledge-base/actions/runs/42390433045). 372 runtime tests and official SDK proof of all five initial tools.                                                                                                                                                     | Merged via [Knowledge Base #5](https://github.com/pegma-dev/knowledge-base/pull/5) as [b61fc77](https://github.com/pegma-dev/knowledge-base/commit/b61fc77aedd22e888ac7292c3597f93e54fcda8e); retained host acceptance open.         |
| KB-05 release preparation             | Reviewed head [c8ef14a](https://github.com/pegma-dev/knowledge-base/commit/c8ef14af0ec32e3903b9399543b7a9f2e48df2f9); [primary Node 22/24 CI](https://github.com/pegma-dev/knowledge-base/actions/runs/42398508042). Each lane passed 372 runtime tests plus 128 release regressions (500 per lane), with zero skips. Packaging checks cover four KB packages; the packed protocol proof uses all five packages (four KB plus Agent Access). | Merged via [Knowledge Base #6](https://github.com/pegma-dev/knowledge-base/pull/6) as [7f5eee6](https://github.com/pegma-dev/knowledge-base/commit/7f5eee68be692b5489de3965f3f5ede7ef7a812d); historical release-preparation source. |
| First-publication bootstrap           | Maintainer 2FA uploads of all five `0.1.0` packages (four KB plus Agent Access) were accepted; exact registry bytes match the prepared artifacts. See the [bootstrap receipt](BOOTSTRAP.md#bootstrap-receipt-2026-11-07).                                                                                                                                                                                                                    | Complete; OIDC provenance absent. Operators must verify distribution tags and investigate unexpected defaults.                                                                                                                       |
| First advertised publication          | Agent Access `0.1.1` requires [full current-head Node 22/24 CI and code/security review](RELEASING.md#repository-and-development-artifact-gates), the [external release checklist](RELEASING.md#external-release-checklist), an approved signed tag and release, and [strict exact-version registry/provenance verification](RELEASING.md#registry-verification-and-availability).                                                           | Pending. Knowledge Base advertisement waits for verified Agent Access `0.1.1`.                                                                                                                                                       |
| SD-02 AI coordinator                  | Requires verified advertised Knowledge Base dependencies.                                                                                                                                                                                                                                                                                                                                                                                    | Pending.                                                                                                                                                                                                                             |
| Retained host acceptance              | PG-01/RG-01 require exact verified advertised Agent Access and Knowledge Base dependencies, real existing-login/current-Admin consent, and actual per-client protected API/MCP, credential-failure, and exact-revision evidence-attestation proof on both hosts.                                                                                                                                                                             | Pending; required before activation/A-01/pilots.                                                                                                                                                                                     |

At the Agent Access #2 reviewed head, round-3
[OpenRouter code review](https://github.com/pegma-dev/agent-access/pull/2#pullrequestreview-5814178148)
and the [security receipt](https://github.com/pegma-dev/agent-access/pull/2#issuecomment-6711125916)
were clean with zero open findings. Knowledge Base #6 likewise had clean
round-3 [OpenRouter code review](https://github.com/pegma-dev/knowledge-base/pull/6#pullrequestreview-5814111477)
and a [security receipt](https://github.com/pegma-dev/knowledge-base/pull/6#issuecomment-6710997171)
at its reviewed head. Agent Access #2's
[2026-11-07 bounded-wait receipt](https://github.com/pegma-dev/agent-access/pull/2#issuecomment-6711152931)
records that no actual Copilot review or work-start event arrived during that
source PR's wait; the absence is not a completed review.

Source units and synthetic protocol proof may land before publication. A
test-only clean consumer can install the reviewed local tarball to prove its
exports; production consumers must use exact verified advertised registry
releases. The manual `0.1.0` bootstraps do not satisfy that prerequisite. Never
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

The source prerequisites, original release preparation, and `0.1.0` bootstrap
are complete. The remaining sequence is fresh review and gates for Agent Access
`0.1.1`, verified external publisher configuration, its approved signed tag and
release, and strict registry/provenance verification before advertisement.
Knowledge Base's advertised release waits for verified Agent Access `0.1.1`.
SD-02 follows verified advertised Knowledge Base dependencies; PG-01/RG-01 host
assembly follows verified advertised dependencies from both components.
Real existing-login/current-Admin consent and actual-client proof then remain
required on both hosts. Retained two-host acceptance stays open in P-00 and
the host tasks until all original draft/evidence, privacy, authority,
expiry/revocation/audience, and invalid-attestation cases pass. No source, SDK,
registry, or provenance result closes host activation.

## Deferred work

No dynamic registration, arbitrary client metadata fetching, general OAuth
identity provider, shared cross-host control plane, or automatic host rollout
is included. KB collection reading/listing, evidence reading, review submission,
publication, admin commands, and private provenance are not initial agent
operations. New capabilities need explicit contracts, policy, fresh consent,
and their own source and host evidence.

The governing plan's future collection-specific delegation, new scopes,
retention, and operations work remains deferred. Merged source and release
preparation do not close trusted publication, dual-host acceptance, model data-control,
or supervised-pilot gates. No source work authorizes tags, releases,
publication, external configuration, or deployment. See
[RELEASING.md](RELEASING.md) before any separately authorized release operation.
