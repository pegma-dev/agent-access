/** Actual published MCP SDK OAuth client; fictional host and HTTP browser simulation. */
import { pathToFileURL } from "node:url";
import {
  auth,
  extractWWWAuthenticateParams,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  CLIENT_ID,
  SCOPE,
  createSyntheticHost,
  type SyntheticHost,
} from "./host.ts";

function requireProof(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export function createSdkProvider(host: SyntheticHost) {
  let tokens: OAuthTokens | undefined;
  let verifier: string | undefined;
  let authorizationUrl: URL | undefined;
  let discovery: OAuthDiscoveryState | undefined;
  const state = crypto.randomUUID();
  const provider: OAuthClientProvider = {
    redirectUrl: host.redirectUri,
    clientMetadata: {
      client_name: "Synthetic SDK proof",
      redirect_uris: [host.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    },
    clientInformation: () => ({
      client_id: CLIENT_ID,
      issuer: host.configuration.issuer,
    }),
    state: () => state,
    tokens: () => tokens,
    saveTokens: (value) => {
      tokens = value;
    },
    saveCodeVerifier: (value) => {
      verifier = value;
    },
    codeVerifier: () => {
      requireProof(verifier, "SDK did not save its verifier");
      return verifier;
    },
    redirectToAuthorization: (url) => {
      authorizationUrl = url;
    },
    saveDiscoveryState: (value) => {
      discovery = value;
    },
    discoveryState: () => discovery,
    invalidateCredentials: (kind) => {
      if (kind === "all" || kind === "tokens") tokens = undefined;
    },
  };
  return {
    provider,
    authorizationUrl() {
      requireProof(authorizationUrl, "SDK did not request authorization");
      return authorizationUrl;
    },
    tokens() {
      requireProof(tokens, "SDK did not save tokens");
      return tokens;
    },
    discovery() {
      requireProof(discovery, "SDK did not save discovery");
      return discovery;
    },
    validateCallback(callback: URL) {
      requireProof(
        callback.origin === host.origin &&
          callback.pathname === "/native/callback",
        "Unexpected callback endpoint",
      );
      requireProof(
        ["state", "iss", "code"].every(
          (name) => callback.searchParams.getAll(name).length === 1,
        ) &&
          !callback.searchParams.has("error") &&
          callback.searchParams.get("state") === state &&
          callback.searchParams.get("iss") === host.configuration.issuer,
        "Callback issuer/state rejected",
      );
      const code = callback.searchParams.get("code");
      requireProof(code, "Callback did not contain an authorization code");
      return code;
    },
  };
}

/** Simulates an existing browser sending only its host cookie and consent form. */
export async function approveInSyntheticBrowser(
  host: SyntheticHost,
  authorizationUrl: URL,
): Promise<URL> {
  const headers = { Cookie: host.browser.cookie };
  const authorization = await fetch(authorizationUrl, {
    headers,
    redirect: "manual",
  });
  requireProof(authorization.status === 303, "Host did not open consent");
  const location = authorization.headers.get("Location");
  requireProof(location, "Consent location missing");
  const consent = new URL(location, host.origin);
  requireProof(
    consent.origin === host.origin && consent.pathname === "/host/consent",
    "Unexpected consent destination",
  );
  const page = await fetch(consent, { headers });
  requireProof(
    page.status === 200 &&
      (await page.text()).includes("Synthetic Admin consent"),
    "Consent UI unavailable",
  );
  const requestId = consent.searchParams.get("request_id");
  requireProof(requestId, "Consent request missing");
  const approved = await fetch(`${host.origin}/host/approve`, {
    method: "POST",
    redirect: "manual",
    headers: {
      ...headers,
      Origin: host.origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      request_id: requestId,
      decision: "approve",
      csrf: host.browser.csrf,
    }),
  });
  requireProof(approved.status === 303, "Synthetic browser approval failed");
  const callbackLocation = approved.headers.get("Location");
  requireProof(callbackLocation, "Callback location missing");
  const callback = new URL(callbackLocation);
  // Exercise the native loopback callback HTTP hop, without a browser cookie.
  requireProof(
    (await fetch(callback)).status === 200,
    "Native callback listener failed",
  );
  return callback;
}

export async function runAuthorizationCodeProof(host: SyntheticHost) {
  const challenge = await fetch(host.configuration.resource);
  requireProof(challenge.status === 401, "Missing bearer was not challenged");
  const discovered = extractWWWAuthenticateParams(challenge);
  requireProof(
    discovered.resourceMetadataUrl,
    "Resource metadata challenge missing",
  );
  const client = createSdkProvider(host);
  const options = {
    serverUrl: host.configuration.resource,
    resourceMetadataUrl: discovered.resourceMetadataUrl,
  };
  requireProof(
    (await auth(client.provider, options)) === "REDIRECT",
    "SDK did not start authorization",
  );
  const authorization = client.authorizationUrl();
  requireProof(
    authorization.searchParams.get("code_challenge_method") === "S256" &&
      /^[A-Za-z0-9_-]{43}$/.test(
        authorization.searchParams.get("code_challenge") ?? "",
      ),
    "SDK did not use S256",
  );
  requireProof(
    authorization.searchParams.get("resource") === host.configuration.resource,
    "SDK resource binding missing",
  );
  const callback = await approveInSyntheticBrowser(host, authorization);
  requireProof(
    (await auth(client.provider, {
      ...options,
      authorizationCode: client.validateCallback(callback),
    })) === "AUTHORIZED",
    "SDK code exchange failed",
  );
  const initial = client.tokens();
  const firstRead = await fetch(host.configuration.resource, {
    headers: { Authorization: `Bearer ${initial.access_token}` },
  });
  requireProof(
    firstRead.status === 200,
    "Protected fixture rejected SDK bearer",
  );
  requireProof(
    (await auth(client.provider, options)) === "AUTHORIZED",
    "SDK refresh failed",
  );
  const rotated = client.tokens();
  requireProof(
    initial.access_token !== rotated.access_token &&
      initial.refresh_token !== rotated.refresh_token,
    "Refresh did not rotate credentials",
  );
  const afterRefresh = await fetch(host.configuration.resource, {
    headers: { Authorization: `Bearer ${rotated.access_token}` },
  });
  requireProof(afterRefresh.status === 200, "Refreshed bearer rejected");
  const metadata = client.discovery().authorizationServerMetadata;
  const revocationEndpoint =
    metadata && "revocation_endpoint" in metadata
      ? metadata.revocation_endpoint
      : undefined;
  requireProof(
    typeof revocationEndpoint === "string" && rotated.refresh_token,
    "Revocation discovery or refresh missing",
  );
  const revoked = await fetch(revocationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      token: rotated.refresh_token,
      token_type_hint: "refresh_token",
    }),
  });
  requireProof(revoked.status === 200, "RFC 7009 revocation failed");
  const afterRevocation = await fetch(host.configuration.resource, {
    headers: { Authorization: `Bearer ${rotated.access_token}` },
  });
  requireProof(
    afterRevocation.status === 401,
    "Revoked credential still accepted",
  );
  return {
    client: "official MCP TypeScript SDK 1.32.2",
    discovery: true,
    pkce: "S256",
    protectedStatus: firstRead.status,
    refreshRotated: true,
    revokedStatus: afterRevocation.status,
  } as const;
}

export async function formPost(
  url: string,
  values: Record<string, string>,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
  });
}

export async function runDeviceProof(host: SyntheticHost) {
  const issued = await formPost(
    host.configuration.endpoints.deviceAuthorization,
    {
      client_id: CLIENT_ID,
      resource: host.configuration.resource,
      scope: SCOPE,
    },
  );
  requireProof(issued.status === 200, "Device issuance failed");
  const device = (await issued.json()) as {
    device_code: string;
    user_code: string;
    interval: number;
    verification_uri: string;
  };
  requireProof(
    (
      await fetch(device.verification_uri, {
        headers: { Cookie: host.browser.cookie },
      })
    ).status === 200,
    "Device browser UI unavailable",
  );
  const verification = new URL(device.verification_uri);
  verification.searchParams.set("user_code", device.user_code);
  const consent = await fetch(verification, {
    headers: { Cookie: host.browser.cookie },
  });
  requireProof(
    consent.status === 200 &&
      (await consent.text()).includes("Read a fictional protocol fixture"),
    "Device consent details unavailable",
  );
  const poll = () =>
    formPost(host.configuration.endpoints.token, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: CLIENT_ID,
      resource: host.configuration.resource,
      device_code: device.device_code,
    });
  const pending = await poll();
  requireProof(
    ((await pending.json()) as { error?: string }).error ===
      "authorization_pending",
    "Device did not remain pending before consent",
  );
  const premature = await poll();
  requireProof(
    ((await premature.json()) as { error?: string }).error === "slow_down",
    "Premature polling was not slowed",
  );
  const approved = await fetch(`${host.origin}/host/approve`, {
    method: "POST",
    headers: {
      Cookie: host.browser.cookie,
      Origin: host.origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      user_code: device.user_code,
      csrf: host.browser.csrf,
      decision: "approve",
    }),
  });
  requireProof(approved.status === 200, "Device browser approval failed");
  host.advance(device.interval + 5);
  const redemption = await poll();
  requireProof(redemption.status === 200, "Approved device redemption failed");
  const tokens = (await redemption.json()) as { access_token: string };
  const resource = await fetch(host.configuration.resource, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  requireProof(resource.status === 200, "Device bearer rejected");
  return {
    flow: "device_code",
    pending: true,
    slowDown: true,
    protectedStatus: resource.status,
  } as const;
}

export async function runProtocolProof() {
  const host = await createSyntheticHost();
  try {
    return {
      fixture: "synthetic-only; no real host login or activation",
      authorizationCode: await runAuthorizationCodeProof(host),
      device: await runDeviceProof(host),
    };
  } finally {
    await host.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(JSON.stringify(await runProtocolProof(), null, 2));
  } catch {
    console.error(
      "Synthetic protocol proof failed; credentials and request details suppressed.",
    );
    process.exitCode = 1;
  }
}
