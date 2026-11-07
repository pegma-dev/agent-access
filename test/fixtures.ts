import {
  createAgentAccess,
  type AgentAccessConfiguration,
  type BrowserApprovalContext,
} from "@pegma/agent-access";
import { resolveAccess, type AccessContext } from "@pegma/authorization-core";
import type { Store } from "@pegma/storage-core";

export const RESOURCE = "https://api.workshop.example/mcp";
export const CLIENT = "workshop-agent";
export const OTHER_CLIENT = "other-agent";
export const REDIRECT = "http://127.0.0.1:48018/callback";
export const READ = "knowledge.draft.read";
export const WRITE = "knowledge.draft.write";
export const EVIDENCE = "knowledge.evidence.submit";
export const LINK = "agent.access.link";
export const HIDDEN = "workshop.future.hidden";
export const SCOPES = [READ, WRITE, EVIDENCE];

export function configuration(): AgentAccessConfiguration {
  return {
    issuer: "https://login.workshop.example",
    resource: RESOURCE,
    approvalPermission: LINK,
    endpoints: {
      authorize: "https://login.workshop.example/authorize",
      deviceAuthorization:
        "https://login.workshop.example/device_authorization",
      token: "https://login.workshop.example/token",
      revocation: "https://login.workshop.example/revoke",
      verification: "https://login.workshop.example/verify",
      approval: "https://login.workshop.example/approve",
      resourceMetadata:
        "https://login.workshop.example/.well-known/oauth-protected-resource",
    },
    clients: [CLIENT, OTHER_CLIENT].map((clientId) => ({
      clientId,
      name: clientId === CLIENT ? "Workshop Agent" : "Other Agent",
      redirectUris: [REDIRECT],
      allowedScopes: [...SCOPES],
      grantTypes: ["device_code", "authorization_code"],
    })),
    scopes: SCOPES.map((name) => ({
      name,
      description: `Synthetic permission: ${name}`,
      version: "1",
      permissions: [name],
    })),
  };
}

/** Resolve a real host policy; roles and entitlements must not cross delegation. */
export function access(
  permissions: readonly string[] = [...SCOPES, LINK, HIDDEN],
  principalId = "staff/workshop-admin",
): AccessContext {
  return resolveAccess(
    { principalId, roles: ["Admin"], entitlements: ["Enterprise"] },
    {
      version: "synthetic-1",
      roles: { Admin: permissions },
      entitlements: { Enterprise: ["workshop.billing.manage"] },
    },
  );
}

export const admin = access();
export const browser: BrowserApprovalContext = {
  authentication: "browser-session",
  access: admin,
};

export async function pkce(verifier = "v".repeat(64)) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: Buffer.from(digest).toString("base64url") };
}

/** Only current identity resolution is scripted; every grant lives in Store. */
export function fixture(store: Store, configured = configuration()) {
  let elapsedMilliseconds = 0;
  const epoch = Date.parse("2026-11-07T15:00:00.000Z");
  const clock = {
    now: () => new Date(epoch + elapsedMilliseconds).toISOString(),
  };
  const authority: {
    current: AccessContext | null;
    unavailable: boolean;
    calls: number;
  } = {
    current: admin,
    unavailable: false,
    calls: 0,
  };
  const options = {
    store,
    clock,
    configuration: configured,
    resolvePrincipal: async (principalId: string) => {
      authority.calls += 1;
      if (authority.unavailable)
        throw new Error("Synthetic current authority outage");
      return authority.current?.principalId === principalId
        ? authority.current
        : null;
    },
  };
  const service = createAgentAccess(options);
  const advance = (seconds: number) => {
    elapsedMilliseconds += seconds * 1_000;
  };

  async function completeDevice(
    scopes: readonly string[] = SCOPES,
    approvedScopes: readonly string[] = scopes,
  ) {
    const device = await service.beginDeviceAuthorization({
      clientId: CLIENT,
      resource: RESOURCE,
      scopes,
    });
    const approval = await service.getDeviceApproval(browser, device.user_code);
    await service.approve(browser, {
      requestId: approval.requestId,
      decision: "approve",
      userCode: device.user_code,
      approvedScopes,
    });
    advance(device.interval);
    const tokens = await service.pollDeviceToken({
      clientId: CLIENT,
      resource: RESOURCE,
      deviceCode: device.device_code,
    });
    return { device, approval, tokens };
  }

  async function completeAuthorization(scopes: readonly string[] = SCOPES) {
    const proof = await pkce();
    const approval = await service.beginAuthorization(browser, {
      clientId: CLIENT,
      resource: RESOURCE,
      scopes,
      redirectUri: REDIRECT,
      codeChallenge: proof.challenge,
      codeChallengeMethod: "S256",
      state: "synthetic-state",
    });
    const result = await service.approve(browser, {
      requestId: approval.requestId,
      decision: "approve",
      approvedScopes: scopes,
    });
    if (result.flow !== "authorization_code")
      throw new Error("Expected authorization-code result");
    const redirect = new URL(result.redirectUri);
    const code = redirect.searchParams.get("code");
    if (code === null) throw new Error("Expected one-time authorization code");
    const exchange = {
      clientId: CLIENT,
      resource: RESOURCE,
      code,
      redirectUri: REDIRECT,
      codeVerifier: proof.verifier,
    };
    return {
      approval,
      result,
      redirect,
      exchange,
      tokens: await service.exchangeAuthorizationCode(exchange),
    };
  }

  return {
    service,
    store,
    options,
    clock,
    advance,
    authority,
    browser,
    completeDevice,
    completeAuthorization,
  };
}
