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

Initial implementation is in progress and no package is published. Source
completion does not activate either host or establish a deployed credential
flow. See the governing [Knowledge/AI plan](https://github.com/pegma-dev/support-desk/blob/main/docs/KNOWLEDGE_AI_PLAN.md).

Built in the open by RetireGolden, LLC. MIT licensed.
