import { describe, expect, it } from "vitest";
import { parseErrorResponse } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  ServerError,
  TemporarilyUnavailableError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import {
  createAgentAccessHttp,
  createProtectedResourceAuthenticator,
  type AgentAccessConfiguration,
  type TokenResult,
} from "@pegma/agent-access";
import { createMemoryStore } from "@pegma/storage-core";
import {
  CLIENT,
  READ,
  REDIRECT,
  RESOURCE,
  SCOPES,
  WRITE,
  configuration,
  fixture,
  pkce,
} from "../test/fixtures.js";

type HttpOptions = Parameters<typeof createAgentAccessHttp>[0];

function httpFixture(
  overrides: {
    configuration?: AgentAccessConfiguration;
    authenticateBrowser?: HttpOptions["authenticateBrowser"];
    limit?: HttpOptions["limit"];
  } = {},
) {
  const configured = overrides.configuration ?? configuration();
  const base = fixture(createMemoryStore(), configured);
  const http = createAgentAccessHttp({
    service: base.service,
    configuration: configured,
    authenticateBrowser:
      overrides.authenticateBrowser ?? (async () => base.browser),
    limit: overrides.limit ?? (async () => true),
  });
  const resource = createProtectedResourceAuthenticator({
    service: base.service,
    configuration: configured,
  });
  return { ...base, configured, http, resource };
}

async function handled(
  http: ReturnType<typeof createAgentAccessHttp>,
  request: Request,
) {
  const response = await http.handle(request);
  if (response === null)
    throw new Error("Expected a configured OAuth endpoint");
  return response;
}

function post(url: string, body: string, headers: HeadersInit = {}) {
  const requestHeaders = new Headers(headers);
  if (!requestHeaders.has("content-type"))
    requestHeaders.set("content-type", "application/x-www-form-urlencoded");
  return new Request(url, {
    method: "POST",
    headers: requestHeaders,
    body,
  });
}

function deviceBody(extra: Record<string, string> = {}) {
  return new URLSearchParams({
    client_id: CLIENT,
    resource: RESOURCE,
    scope: READ,
    ...extra,
  }).toString();
}

async function expectPrivateError(
  response: Response,
  status: number,
  code?: string,
) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
  expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  const body = (await response.json()) as {
    error: string;
    error_description: string;
  };
  if (code !== undefined) expect(body.error).toBe(code);
  expect(typeof body.error_description).toBe("string");
  expect(Object.keys(body).sort()).toEqual(["error", "error_description"]);
  expect(JSON.stringify(body)).not.toContain("sentinel-secret");
  return body;
}

describe("OAuth HTTP discovery and host composition", () => {
  it("advertises only implemented protocol capabilities and the selected registry", async () => {
    const configured = {
      ...configuration(),
      issuer: "https://login.workshop.example/tenant",
    };
    const f = httpFixture({ configuration: configured });
    const response = await handled(
      f.http,
      new Request(
        "https://login.workshop.example/.well-known/oauth-authorization-server/tenant",
      ),
    );
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      issuer: configured.issuer,
      authorization_endpoint: configured.endpoints.authorize,
      device_authorization_endpoint: configured.endpoints.deviceAuthorization,
      token_endpoint: configured.endpoints.token,
      revocation_endpoint: configured.endpoints.revocation,
      response_types_supported: ["code"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
    });
    expect(metadata.grant_types_supported).toEqual(
      expect.arrayContaining([
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:device_code",
      ]),
    );
    expect(metadata.scopes_supported).toEqual(expect.arrayContaining(SCOPES));
    for (const absent of [
      "registration_endpoint",
      "jwks_uri",
      "introspection_endpoint",
      "userinfo_endpoint",
      "client_id_metadata_document_supported",
    ])
      expect(metadata).not.toHaveProperty(absent);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();

    const protectedResponse = await handled(
      f.http,
      new Request(configured.endpoints.resourceMetadata),
    );
    expect(protectedResponse.status).toBe(200);
    expect(await protectedResponse.json()).toMatchObject({
      resource: RESOURCE,
      authorization_servers: [configured.issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: expect.arrayContaining(SCOPES),
    });
  });

  it("leaves existing host verification, approval, and unrelated routes to the host", async () => {
    const f = httpFixture();
    for (const url of [
      f.configured.endpoints.verification,
      f.configured.endpoints.approval,
      "https://login.workshop.example/existing-login",
    ])
      expect(await f.http.handle(new Request(url))).toBeNull();
  });

  it("does not advertise authorization code or PKCE when no client can use them", async () => {
    const original = configuration();
    const configured: AgentAccessConfiguration = {
      ...original,
      clients: original.clients.map((client) => ({
        ...client,
        grantTypes: ["device_code"] as const,
      })),
    };
    const f = httpFixture({ configuration: configured });
    const response = await handled(
      f.http,
      new Request(
        "https://login.workshop.example/.well-known/oauth-authorization-server",
      ),
    );
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata.grant_types_supported).toEqual([
      "urn:ietf:params:oauth:grant-type:device_code",
      "refresh_token",
    ]);
    for (const absent of [
      "authorization_endpoint",
      "response_types_supported",
      "code_challenge_methods_supported",
      "authorization_response_iss_parameter_supported",
    ])
      expect(metadata).not.toHaveProperty(absent);
  });

  it("calls only the host browser trust seam and preserves its login handoff", async () => {
    let called = false;
    const f = httpFixture({
      authenticateBrowser: async (_request, context) => {
        called = true;
        expect(context).toEqual({ mutation: false });
        return new Response(null, {
          status: 303,
          headers: { location: "/existing-login" },
        });
      },
    });
    const proof = await pkce();
    const query = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      resource: RESOURCE,
      scope: READ,
      code_challenge: proof.challenge,
      code_challenge_method: "S256",
    });
    const response = await handled(
      f.http,
      new Request(`${f.configured.endpoints.authorize}?${query}`),
    );
    expect(called).toBe(true);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/existing-login");
  });
});

describe("OAuth HTTP strict request boundary", () => {
  it.each([
    ["duplicate client", `${deviceBody()}&client_id=sentinel-secret`],
    [
      "duplicate resource",
      `${deviceBody()}&resource=${encodeURIComponent(RESOURCE)}`,
    ],
    ["duplicate scope", `${deviceBody()}&scope=${encodeURIComponent(READ)}`],
    ["unknown field", `${deviceBody()}&unrecognized=sentinel-secret`],
    ["client secret", `${deviceBody()}&client_secret=sentinel-secret`],
    [
      "bad percent",
      `client_id=${CLIENT}&resource=${encodeURIComponent(RESOURCE)}&scope=%GG`,
    ],
    [
      "truncated percent",
      `client_id=${CLIENT}&resource=${encodeURIComponent(RESOURCE)}&scope=%`,
    ],
    [
      "bad UTF-8 percent",
      `client_id=${CLIENT}&resource=${encodeURIComponent(RESOURCE)}&scope=%C3%28`,
    ],
  ])("rejects %s without echoing request values", async (_name, body) => {
    const f = httpFixture();
    await expectPrivateError(
      await handled(
        f.http,
        post(f.configured.endpoints.deviceAuthorization, body),
      ),
      400,
      "invalid_request",
    );
  });

  it("rejects malformed raw UTF-8 rather than replacing bytes", async () => {
    const f = httpFixture();
    const response = await handled(
      f.http,
      new Request(f.configured.endpoints.deviceAuthorization, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new Uint8Array([0xff]),
      }),
    );
    await expectPrivateError(response, 400, "invalid_request");
  });

  it("cancels a streaming body once the byte budget is exceeded", async () => {
    const f = httpFixture();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16385).fill(65));
      },
      cancel() {
        cancelled = true;
      },
    });
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      duplex: "half",
    };
    const response = await handled(
      f.http,
      new Request(f.configured.endpoints.deviceAuthorization, init),
    );
    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(cancelled).toBe(true);
  });

  it("rejects public-client Basic authentication, including otherwise valid forms", async () => {
    const f = httpFixture();
    const response = await handled(
      f.http,
      post(f.configured.endpoints.deviceAuthorization, deviceBody(), {
        authorization: "Basic c2VudGluZWwtc2VjcmV0",
      }),
    );
    await expectPrivateError(response, 400);
  });

  it("rejects unsupported methods, content types, and token endpoint query parameters", async () => {
    const f = httpFixture();
    const wrongMethod = await handled(
      f.http,
      new Request(f.configured.endpoints.token),
    );
    expect(wrongMethod.status).toBe(405);
    const wrongType = await handled(
      f.http,
      new Request(f.configured.endpoints.deviceAuthorization, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: CLIENT }),
      }),
    );
    expect(wrongType.status).toBe(415);
    const query = await handled(
      f.http,
      post(
        `${f.configured.endpoints.deviceAuthorization}?client_id=sentinel-secret`,
        deviceBody(),
      ),
    );
    await expectPrivateError(query, 400, "invalid_request");
  });

  it("matches the configured resource exactly before issuing credentials", async () => {
    const f = httpFixture();
    const response = await handled(
      f.http,
      post(
        f.configured.endpoints.deviceAuthorization,
        deviceBody({ resource: `${RESOURCE}/` }),
      ),
    );
    await expectPrivateError(response, 400, "invalid_target");
  });

  it("rejects unknown token grants and grant-specific extraneous fields", async () => {
    const f = httpFixture();
    await expectPrivateError(
      await handled(
        f.http,
        post(
          f.configured.endpoints.token,
          new URLSearchParams({
            grant_type: "password",
            client_id: CLIENT,
            resource: RESOURCE,
          }).toString(),
        ),
      ),
      400,
      "unsupported_grant_type",
    );
    await expectPrivateError(
      await handled(
        f.http,
        post(
          f.configured.endpoints.token,
          new URLSearchParams({
            grant_type: "refresh_token",
            client_id: CLIENT,
            resource: RESOURCE,
            refresh_token: "sentinel-secret",
            code_verifier: "v".repeat(64),
          }).toString(),
        ),
      ),
      400,
      "invalid_request",
    );
  });

  it("never redirects invalid callbacks or invalid duplicate authorize parameters", async () => {
    const f = httpFixture();
    const proof = await pkce();
    const base = {
      response_type: "code",
      client_id: CLIENT,
      redirect_uri: "https://sentinel-secret.example/callback",
      resource: RESOURCE,
      scope: READ,
      code_challenge: proof.challenge,
      code_challenge_method: "S256",
    };
    for (const query of [
      new URLSearchParams(base).toString(),
      `${new URLSearchParams({ ...base, redirect_uri: REDIRECT })}&state=a&state=b`,
    ]) {
      const response = await handled(
        f.http,
        new Request(`${f.configured.endpoints.authorize}?${query}`),
      );
      await expectPrivateError(response, 400, "invalid_request");
      expect(response.headers.get("location")).toBeNull();
    }
  });
});

describe("OAuth HTTP lifecycle over actual grants", () => {
  it("binds PKCE, preserves state/issuer once, and returns private standard token results", async () => {
    const f = httpFixture();
    const proof = await pkce();
    const state = "opaque + / ? & state";
    const query = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      resource: RESOURCE,
      scope: READ,
      code_challenge: proof.challenge,
      code_challenge_method: "S256",
      state,
    });
    const initiated = await handled(
      f.http,
      new Request(`${f.configured.endpoints.authorize}?${query}`),
    );
    expect(initiated.status).toBe(303);
    const approvalUrl = new URL(initiated.headers.get("location")!);
    expect(`${approvalUrl.origin}${approvalUrl.pathname}`).toBe(
      f.configured.endpoints.approval,
    );
    expect([...approvalUrl.searchParams.keys()]).toEqual(["request_id"]);
    const requestId = approvalUrl.searchParams.get("request_id")!;
    const approval = await f.service.getAuthorizationApproval(
      f.browser,
      requestId,
    );
    const approved = await f.service.approve(f.browser, {
      requestId: approval.requestId,
      decision: "approve",
      approvedScopes: [READ],
    });
    if (approved.flow !== "authorization_code")
      throw new Error("Expected authorization callback");
    const callback = new URL(approved.redirectUri);
    expect(callback.searchParams.getAll("state")).toEqual([state]);
    expect(callback.searchParams.getAll("iss")).toEqual([f.configured.issuer]);
    expect(callback.searchParams.getAll("code")).toHaveLength(1);
    expect([...callback.searchParams.keys()].sort()).toEqual([
      "code",
      "iss",
      "state",
    ]);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT,
      resource: RESOURCE,
      code: callback.searchParams.get("code")!,
      redirect_uri: REDIRECT,
      code_verifier: proof.verifier,
    }).toString();
    const tokenResponse = await handled(
      f.http,
      post(f.configured.endpoints.token, body),
    );
    expect(tokenResponse.status).toBe(200);
    expect(tokenResponse.headers.get("cache-control")).toContain("no-store");
    expect(tokenResponse.headers.get("access-control-allow-origin")).toBeNull();
    const tokens = (await tokenResponse.json()) as TokenResult;
    expect(tokens).toMatchObject({
      token_type: "Bearer",
      expires_in: 900,
      scope: READ,
    });
    expect(typeof tokens.access_token).toBe("string");
    expect(typeof tokens.refresh_token).toBe("string");
    await expectPrivateError(
      await handled(f.http, post(f.configured.endpoints.token, body)),
      400,
      "invalid_grant",
    );
  });

  it("uses browser-independent header bearer access with current scoped authority", async () => {
    const f = httpFixture();
    const { tokens } = await f.completeDevice([READ]);
    const result = await f.resource.authenticate(
      new Request(RESOURCE, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      }),
      [READ],
    );
    if (result instanceof Response)
      throw new Error("Expected delegated context");
    expect(result.scopes).toEqual([READ]);
    expect(result.access.roles).toEqual([]);
    expect(result.access.entitlements).toEqual([]);
    expect(result.access.permissions).toEqual([READ]);
    const insufficient = await f.resource.authenticate(
      new Request(RESOURCE, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      }),
      [WRITE],
    );
    expect(insufficient).toBeInstanceOf(Response);
    if (!(insufficient instanceof Response))
      throw new Error("Expected scope challenge");
    expect(insufficient.status).toBe(403);
    const challenge = insufficient.headers.get("www-authenticate");
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain(WRITE);
    expect(challenge).toContain(f.configured.endpoints.resourceMetadata);
    expect(insufficient.headers.get("cache-control")).toContain("no-store");
  });

  it("does not treat cookies, URL credentials, or malformed Authorization as bearer proof", async () => {
    const f = httpFixture();
    const missing = await f.resource.authenticate(
      new Request(RESOURCE, {
        headers: { cookie: "host-session=sentinel-secret" },
      }),
      [READ],
    );
    if (!(missing instanceof Response))
      throw new Error("Expected missing bearer challenge");
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain(
      f.configured.endpoints.resourceMetadata,
    );
    expect(missing.headers.get("www-authenticate")).not.toContain("error=");
    for (const request of [
      new Request(`${RESOURCE}?access_token=sentinel-secret`),
      new Request(RESOURCE, {
        headers: { authorization: "Basic sentinel-secret" },
      }),
      new Request(RESOURCE, {
        headers: { authorization: "Bearer first, Bearer sentinel-secret" },
      }),
      new Request(RESOURCE, { headers: { authorization: "Bearer" } }),
      new Request(RESOURCE, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: "Bearer sentinel-secret",
        },
        body: "access_token=sentinel-secret",
      }),
    ]) {
      const response = await f.resource.authenticate(request, [READ]);
      if (!(response instanceof Response))
        throw new Error("Expected rejected credential transport");
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(await response.text()).not.toContain("sentinel-secret");
      expect(request.bodyUsed).toBe(false);
    }
    const invalid = await f.resource.authenticate(
      new Request(RESOURCE, {
        headers: { authorization: "Bearer sentinel-secret" },
      }),
    );
    if (!(invalid instanceof Response))
      throw new Error("Expected invalid bearer challenge");
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("www-authenticate")).toContain(
      'error="invalid_token"',
    );
  });

  it("makes unknown token revocation private, idempotent, and free of content leaks", async () => {
    const f = httpFixture();
    for (const hint of ["access_token", "future-unsupported-token-kind"]) {
      const body = new URLSearchParams({
        client_id: CLIENT,
        token: "sentinel-secret",
        token_type_hint: hint,
      }).toString();
      const response = await handled(
        f.http,
        post(f.configured.endpoints.revocation, body),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(await response.text()).not.toContain("sentinel-secret");
    }
  });
});

describe("fixed localhost callback interoperability", () => {
  const callbackUri = "http://localhost:48019/callback";

  function localhostConfiguration(): AgentAccessConfiguration {
    const original = configuration();
    return {
      ...original,
      clients: original.clients.map((client) => ({
        ...client,
        redirectUris: [callbackUri],
      })),
    };
  }

  it("accepts an exact preregistered fixed-port callback through code redemption", async () => {
    const f = httpFixture({ configuration: localhostConfiguration() });
    const proof = await pkce();
    const query = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT,
      redirect_uri: callbackUri,
      resource: RESOURCE,
      scope: READ,
      code_challenge: proof.challenge,
      code_challenge_method: "S256",
      state: "localhost-client",
    });
    const initiation = await handled(
      f.http,
      new Request(`${f.configured.endpoints.authorize}?${query}`),
    );
    expect(initiation.status).toBe(303);
    const approvalUrl = new URL(initiation.headers.get("location")!);
    const approval = await f.service.approve(f.browser, {
      requestId: approvalUrl.searchParams.get("request_id")!,
      decision: "approve",
      approvedScopes: [READ],
    });
    if (approval.flow !== "authorization_code")
      throw new Error("Expected localhost callback");
    const callback = new URL(approval.redirectUri);
    expect(`${callback.origin}${callback.pathname}`).toBe(callbackUri);
    expect(callback.searchParams.get("state")).toBe("localhost-client");
    expect(callback.searchParams.get("iss")).toBe(f.configured.issuer);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT,
      resource: RESOURCE,
      code: callback.searchParams.get("code")!,
      redirect_uri: callbackUri,
      code_verifier: proof.verifier,
    }).toString();
    const response = await handled(
      f.http,
      post(f.configured.endpoints.token, body),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      token_type: "Bearer",
      scope: READ,
    });
  });

  it.each([
    "http://localhost:48020/callback",
    "http://127.0.0.1:48019/callback",
    "http://[::1]:48019/callback",
    "http://localhost.example:48019/callback",
    "http://sub.localhost:48019/callback",
    "http://localhost.:48019/callback",
    "http://localhost:48019\\callback",
    "http://localhost:48019/another-callback",
    "http://localhost:48019/callback?extra=1",
    "http://user@localhost:48019/callback",
    "http://localhost:48019/callback#fragment",
  ])(
    "rejects a changed localhost redirect %s without redirecting",
    async (redirectUri) => {
      const f = httpFixture({ configuration: localhostConfiguration() });
      const proof = await pkce();
      const query = new URLSearchParams({
        response_type: "code",
        client_id: CLIENT,
        redirect_uri: redirectUri,
        resource: RESOURCE,
        scope: READ,
        code_challenge: proof.challenge,
        code_challenge_method: "S256",
      });
      const response = await handled(
        f.http,
        new Request(`${f.configured.endpoints.authorize}?${query}`),
      );
      await expectPrivateError(response, 400, "invalid_request");
      expect(response.headers.get("location")).toBeNull();
      expect(f.authority.calls).toBe(0);
    },
  );

  it.each([
    "http://localhost/callback",
    "http://LOCALHOST:48019/callback",
    "http://localhost:48019\\callback",
    "http://user@localhost:48019/callback",
    "http://localhost:48019/callback#fragment",
    "http://localhost:48019/callback?code=preexisting",
    "http://localhost:48019/callback?state=preexisting",
    "http://localhost:48019/callback?iss=preexisting",
    "http://localhost.example:48019/callback",
    "http://sub.localhost:48019/callback",
  ])(
    "rejects an unsafe or noncanonical localhost registration %s",
    (redirectUri) => {
      const original = localhostConfiguration();
      const configured = {
        ...original,
        clients: original.clients.map((client) => ({
          ...client,
          redirectUris: [redirectUri],
        })),
      };
      expect(() => httpFixture({ configuration: configured })).toThrow(
        "The request is invalid.",
      );
    },
  );

  it("does not permit HTTP issuer or resource identifiers outside explicit loopback test mode", () => {
    const original = localhostConfiguration();
    for (const configured of [
      { ...original, issuer: "http://localhost:48019" },
      { ...original, resource: "http://localhost:48019/mcp" },
    ])
      expect(() => httpFixture({ configuration: configured })).toThrow(
        "The request is invalid.",
      );
  });
});

describe("required host limiter boundary", () => {
  it("rejects denied issuance with bounded retry information", async () => {
    let calls = 0;
    const f = httpFixture({
      limit: async (_request, context) => {
        calls += 1;
        expect(context.endpoint).toBe("device_authorization");
        return { allowed: false, retryAfterSeconds: 7 };
      },
    });
    const response = await handled(
      f.http,
      post(f.configured.endpoints.deviceAuthorization, deviceBody()),
    );
    expect(await parseErrorResponse(response.clone())).toBeInstanceOf(
      TemporarilyUnavailableError,
    );
    await expectPrivateError(response, 429, "temporarily_unavailable");
    expect(response.headers.get("retry-after")).toBe("7");
    expect(calls).toBe(1);
    expect(f.authority.calls).toBe(0);
  });

  it("fails closed when host limiting is unavailable", async () => {
    const f = httpFixture({
      limit: async () => {
        throw new Error("sentinel-secret limiter failure");
      },
    });
    const response = await handled(
      f.http,
      post(f.configured.endpoints.deviceAuthorization, deviceBody()),
    );
    expect(await parseErrorResponse(response.clone())).toBeInstanceOf(
      ServerError,
    );
    await expectPrivateError(response, 503, "server_error");
    expect(f.authority.calls).toBe(0);
  });

  it.each([0, -1, 86401, Number.POSITIVE_INFINITY])(
    "fails closed on an invalid limiter retry value %s",
    async (retryAfterSeconds) => {
      const f = httpFixture({
        limit: async () => ({ allowed: true, retryAfterSeconds }),
      });
      await expectPrivateError(
        await handled(
          f.http,
          post(f.configured.endpoints.deviceAuthorization, deviceBody()),
        ),
        503,
        "server_error",
      );
    },
  );
});
