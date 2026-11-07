import { afterEach, describe, expect, it } from "vitest";
import {
  auth,
  extractWWWAuthenticateParams,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { createAgentAccess } from "@pegma/agent-access";
import { createMemoryStore } from "@pegma/storage-core";
import {
  CLIENT_ID,
  SCOPE,
  createSyntheticHost,
  type SyntheticHost,
} from "../examples/protocol/host.ts";
import {
  approveInSyntheticBrowser,
  createSdkProvider,
  formPost,
  runAuthorizationCodeProof,
  runDeviceProof,
} from "../examples/protocol/run.ts";

let host: SyntheticHost | undefined;
afterEach(async () => {
  await host?.close();
  host = undefined;
});

async function fixture() {
  host = await createSyntheticHost();
  return host;
}

async function beginSdk(current: SyntheticHost) {
  const challenge = extractWWWAuthenticateParams(
    await fetch(current.configuration.resource),
  );
  const client = createSdkProvider(current);
  const options = {
    serverUrl: current.configuration.resource,
    ...(challenge.resourceMetadataUrl
      ? { resourceMetadataUrl: challenge.resourceMetadataUrl }
      : {}),
  };
  expect(await auth(client.provider, options)).toBe("REDIRECT");
  return { client, options };
}

describe("published MCP SDK client against a synthetic HTTP host", () => {
  it("discovers, authorizes with S256, reads, refreshes and revokes through real HTTP", async () => {
    const result = await runAuthorizationCodeProof(await fixture());
    expect(result).toEqual({
      client: "official MCP TypeScript SDK 1.32.2",
      discovery: true,
      pkce: "S256",
      protectedStatus: 200,
      refreshRotated: true,
      revokedStatus: 401,
    });
  });

  it("completes device consent over HTTP and enforces pending/slow-down polling", async () => {
    expect(await runDeviceProof(await fixture())).toEqual({
      flow: "device_code",
      pending: true,
      slowDown: true,
      protectedStatus: 200,
    });
  });

  it("requires an existing browser cookie and rejects a desktop bearer as browser consent", async () => {
    const current = await fixture();
    const { client } = await beginSdk(current);
    const unauthorized = await fetch(client.authorizationUrl(), {
      redirect: "manual",
    });
    expect(unauthorized.status).toBe(401);
    const bearer = await fetch(client.authorizationUrl(), {
      headers: {
        Authorization: "Bearer synthetic-desktop-is-not-browser-identity",
      },
      redirect: "manual",
    });
    expect(bearer.status).toBe(400);
    expect(await bearer.json()).toEqual({
      error: "invalid_request",
      error_description: "The request is invalid.",
    });
  });

  it("requires same-origin and per-session CSRF proof for host approval", async () => {
    const current = await fixture();
    const { client } = await beginSdk(current);
    const started = await fetch(client.authorizationUrl(), {
      headers: { Cookie: current.browser.cookie },
      redirect: "manual",
    });
    const consent = new URL(
      started.headers.get("Location") ?? "/missing",
      current.origin,
    );
    const requestId = consent.searchParams.get("request_id") ?? "";
    const approve = (origin: string, csrf: string) =>
      fetch(`${current.origin}/host/approve`, {
        method: "POST",
        redirect: "manual",
        headers: {
          Cookie: current.browser.cookie,
          Origin: origin,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          request_id: requestId,
          decision: "approve",
          csrf,
        }),
      });
    expect(
      (await approve("https://attacker.example.test", current.browser.csrf))
        .status,
    ).toBe(403);
    expect((await approve(current.origin, "incorrect-csrf")).status).toBe(403);
    expect((await approve(current.origin, current.browser.csrf)).status).toBe(
      303,
    );
  });

  it("rechecks current Admin linking authority after the browser request began", async () => {
    const current = await fixture();
    const { client } = await beginSdk(current);
    const started = await fetch(client.authorizationUrl(), {
      headers: { Cookie: current.browser.cookie },
      redirect: "manual",
    });
    const consent = new URL(
      started.headers.get("Location") ?? "/missing",
      current.origin,
    );
    current.demoteAdmin();
    expect(
      (
        await fetch(`${current.origin}/host/approve`, {
          method: "POST",
          redirect: "manual",
          headers: {
            Cookie: current.browser.cookie,
            Origin: current.origin,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            request_id: consent.searchParams.get("request_id") ?? "",
            decision: "approve",
            csrf: current.browser.csrf,
          }),
        })
      ).status,
    ).toBe(403);
  });

  it("does not exchange an authorization code with the wrong SDK verifier", async () => {
    const current = await fixture();
    const { client } = await beginSdk(current);
    const callback = await approveInSyntheticBrowser(
      current,
      client.authorizationUrl(),
    );
    const code = client.validateCallback(callback);
    const rejected = await formPost(current.configuration.endpoints.token, {
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      resource: current.configuration.resource,
      redirect_uri: current.redirectUri,
      code,
      code_verifier: "Z".repeat(43),
    });
    expect(rejected.status).toBe(400);
    expect(((await rejected.json()) as { error?: string }).error).toBe(
      "invalid_grant",
    );
  });

  it("denies a device request and expires a separate unapproved device request", async () => {
    const current = await fixture();
    const issue = async () => {
      const response = await formPost(
        current.configuration.endpoints.deviceAuthorization,
        {
          client_id: CLIENT_ID,
          resource: current.configuration.resource,
          scope: SCOPE,
        },
      );
      expect(response.status).toBe(200);
      return response.json() as Promise<{
        device_code: string;
        user_code: string;
      }>;
    };
    const poll = (deviceCode: string) =>
      formPost(current.configuration.endpoints.token, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: CLIENT_ID,
        resource: current.configuration.resource,
        device_code: deviceCode,
      });
    const denied = await issue();
    const denial = await fetch(`${current.origin}/host/approve`, {
      method: "POST",
      headers: {
        Cookie: current.browser.cookie,
        Origin: current.origin,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        user_code: denied.user_code,
        decision: "deny",
        csrf: current.browser.csrf,
      }),
    });
    expect(denial.status).toBe(200);
    expect(
      ((await (await poll(denied.device_code)).json()) as { error?: string })
        .error,
    ).toBe("access_denied");
    const expired = await issue();
    current.advance(61);
    expect(
      ((await (await poll(expired.device_code)).json()) as { error?: string })
        .error,
    ).toBe("expired_token");
  });

  it("never enables insecure HTTP for a non-loopback resource", async () => {
    const current = await fixture();
    let rejected = false;
    try {
      createAgentAccess({
        configuration: {
          ...current.configuration,
          resource: "http://example.test/fixture",
        },
        store: createMemoryStore(),
        clock: { now: () => new Date().toISOString() },
        resolvePrincipal: async () => null,
      });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
});
