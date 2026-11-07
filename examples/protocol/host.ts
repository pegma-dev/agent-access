/**
 * NON-PRODUCTION synthetic host. This starts with an already authenticated
 * fictional Admin browser session; it implements no login or identity provider.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { hasPermission, resolveAccess } from "@pegma/authorization-core";
import { createSessionStore } from "@pegma/sessions";
import { createMemoryStore } from "@pegma/storage-core";
import {
  createAgentAccess,
  createAgentAccessHttp,
  createProtectedResourceAuthenticator,
  type AgentAccessConfiguration,
  type BrowserApprovalContext,
} from "@pegma/agent-access";

export const CLIENT_ID = "synthetic-pre-registered-client";
export const SCOPE = "fixture.read";
const PRINCIPAL = "fictional-admin";
const LINK = "agent.access.link";
const COOKIE = "synthetic_browser";
const MAX_BODY_BYTES = 16_384;
const SAFE_RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function response(status: number): Response {
  return new Response(null, {
    status,
    headers: SAFE_RESPONSE_HEADERS,
  });
}

function html(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? "",
  );
}

async function toRequest(
  message: IncomingMessage,
  origin: string,
): Promise<Request | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of message) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(bytes);
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (value !== undefined)
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const method = message.method ?? "GET";
  return new Request(new URL(message.url ?? "/", origin), {
    method,
    headers,
    ...(method === "GET" || method === "HEAD"
      ? {}
      : { body: Buffer.concat(chunks) }),
  });
}

async function writeResponse(
  result: Response,
  target: ServerResponse,
): Promise<void> {
  target.writeHead(result.status, Object.fromEntries(result.headers));
  target.end(Buffer.from(await result.arrayBuffer()));
}

export async function createSyntheticHost(
  options: {
    /** Test-only fault input for this fictional host; Sessions still owns storage. */
    readonly initialSessionData?: string;
  } = {},
) {
  const store = createMemoryStore();
  let now = Date.now();
  const clock = { now: () => new Date(now).toISOString() };
  let isAdmin = true;
  const currentAccess = () =>
    resolveAccess(
      { principalId: PRINCIPAL, roles: isAdmin ? ["Admin"] : ["Reader"] },
      {
        version: "synthetic-1",
        roles: { Admin: [LINK, "fixture.read"], Reader: ["fixture.read"] },
      },
    );
  // This is the explicit trust seam: pretend an existing host login has already
  // authenticated this fictional principal. Sessions owns the session records.
  const sessions = createSessionStore(store, { clock });
  const sessionId = crypto.randomUUID();
  const csrf = crypto.randomUUID();
  const initialSessionData =
    options.initialSessionData ?? JSON.stringify({ csrf });
  if (
    typeof initialSessionData !== "string" ||
    new TextEncoder().encode(initialSessionData).byteLength > MAX_BODY_BYTES
  )
    throw new Error("Synthetic session fixture data exceeds its limit");
  await sessions.create(sessionId, {
    principalId: PRINCIPAL,
    data: initialSessionData,
  });
  const browserCookie = `${COOKIE}=${sessionId}`;
  let route: (request: Request) => Promise<Response> = async () =>
    response(503);
  let origin = "";
  const server = createServer((message, target) => {
    void (async () => {
      const request = await toRequest(message, origin);
      await writeResponse(
        request === null ? response(413) : await route(request),
        target,
      );
    })().catch(() => {
      // Do not print errors: network exceptions can embed credential-bearing URLs.
      if (!target.headersSent) target.writeHead(503, SAFE_RESPONSE_HEADERS);
      target.end();
    });
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Synthetic listener unavailable");
  origin = `http://127.0.0.1:${address.port}`;
  const configuration: AgentAccessConfiguration = {
    issuer: origin,
    resource: `${origin}/fixture`,
    allowInsecureLoopback: true,
    approvalPermission: LINK,
    endpoints: {
      authorize: `${origin}/authorize`,
      deviceAuthorization: `${origin}/device_authorization`,
      token: `${origin}/token`,
      revocation: `${origin}/revoke`,
      verification: `${origin}/host/device`,
      approval: `${origin}/host/consent`,
      resourceMetadata: `${origin}/.well-known/oauth-protected-resource/fixture`,
    },
    clients: [
      {
        clientId: CLIENT_ID,
        name: "Fictional SDK client",
        redirectUris: ["http://127.0.0.1/native/callback"],
        allowedScopes: [SCOPE],
        grantTypes: ["authorization_code", "device_code"],
      },
    ],
    scopes: [
      {
        name: SCOPE,
        description: "Read a fictional protocol fixture",
        version: "1",
        permissions: ["fixture.read"],
      },
    ],
    limits: { deviceLifetimeSeconds: 60, accessLifetimeSeconds: 30 },
  };
  const service = createAgentAccess({
    configuration,
    store,
    clock,
    resolvePrincipal: async (principalId) =>
      principalId === PRINCIPAL ? currentAccess() : null,
  });

  async function authenticateBrowser(
    request: Request,
    options: { readonly mutation: boolean },
  ): Promise<BrowserApprovalContext | Response> {
    // A desktop Authorization bearer is never a source of browser identity.
    const cookies =
      request.headers
        .get("Cookie")
        ?.split(";")
        .map((part) => part.trim()) ?? [];
    const candidates = cookies.filter((part) => part.startsWith(`${COOKIE}=`));
    if (candidates.length !== 1) return response(401);
    const credential = candidates[0]?.slice(COOKIE.length + 1) ?? "";
    const session = await sessions.get(credential);
    if (session === null || session.principalId !== PRINCIPAL)
      return response(401);
    const access = currentAccess();
    if (!hasPermission(access, LINK)) return response(403);
    if (options.mutation) {
      let saved: unknown;
      try {
        saved = JSON.parse(session.data);
      } catch {
        return response(503);
      }
      if (
        typeof saved !== "object" ||
        saved === null ||
        Array.isArray(saved) ||
        !("csrf" in saved) ||
        typeof saved.csrf !== "string" ||
        saved.csrf.length === 0 ||
        saved.csrf.length > 128
      )
        return response(503);
      if (
        request.headers.get("Origin") !== origin ||
        request.headers.get("X-CSRF-Token") !== saved.csrf
      )
        return response(403);
    }
    return { authentication: "browser-session", access };
  }

  const protocol = createAgentAccessHttp({
    service,
    configuration,
    authenticateBrowser,
    // Test-only seam. Real hosts inject their existing request limiter here.
    limit: async () => true,
  });
  const protectedResource = createProtectedResourceAuthenticator({
    service,
    configuration,
  });
  route = async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/fixture") {
      const delegated = await protectedResource.authenticate(request, [SCOPE]);
      if (delegated instanceof Response) return delegated;
      return Response.json({
        fixture: "synthetic-only",
        scopes: delegated.scopes,
      });
    }
    if (url.pathname === "/native/callback" && request.method === "GET")
      return response(200);
    if (url.pathname === "/host/consent" && request.method === "GET") {
      const browser = await authenticateBrowser(request, { mutation: false });
      if (browser instanceof Response) return browser;
      const view = await service.getAuthorizationApproval(
        browser,
        url.searchParams.get("request_id") ?? "",
      );
      const page = `<h1>Synthetic Admin consent</h1><p>${html(view.clientName)}</p><p>${view.requestedScopes.map((scope) => html(scope.description)).join("; ")}</p><form method="post" action="/host/approve"><input name="request_id" type="hidden" value="${html(view.requestId)}"><input name="csrf" type="hidden" value="${html(csrf)}"><button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></form><p>This fixture has no real host login.</p>`;
      return new Response(page, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy":
            "default-src 'none'; form-action 'self'; frame-ancestors 'none'",
        },
      });
    }
    if (url.pathname === "/host/device" && request.method === "GET") {
      const browser = await authenticateBrowser(request, { mutation: false });
      if (browser instanceof Response) return browser;
      const userCode = url.searchParams.get("user_code");
      const view =
        userCode === null
          ? null
          : await service.getDeviceApproval(browser, userCode);
      const page =
        view === null
          ? '<h1>Synthetic device code entry</h1><form method="get" action="/host/device"><label>Enter the code displayed by your device<input name="user_code" required></label><button>Review request</button></form>'
          : `<h1>Synthetic device approval</h1><p>${html(view.clientName)}</p><p>${view.requestedScopes.map((scope) => html(scope.description)).join("; ")}</p><p>Displayed device code: ${html(userCode ?? "")}</p><form method="post" action="/host/approve"><input name="user_code" type="hidden" value="${html(userCode ?? "")}"><input name="csrf" type="hidden" value="${html(csrf)}"><button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></form>`;
      return new Response(page, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy":
            "default-src 'none'; form-action 'self'; frame-ancestors 'none'",
        },
      });
    }
    if (url.pathname === "/host/approve" && request.method === "POST") {
      const form = new URLSearchParams(await request.text());
      // Support a standard HTML form without accepting a cross-origin POST.
      const verifiedRequest = new Request(request.url, {
        method: request.method,
        headers: new Headers(request.headers),
      });
      verifiedRequest.headers.set("X-CSRF-Token", form.get("csrf") ?? "");
      const browser = await authenticateBrowser(verifiedRequest, {
        mutation: true,
      });
      if (browser instanceof Response) return browser;
      if (
        [...new Set(form.keys())].some((key) => form.getAll(key).length !== 1)
      )
        return response(400);
      const decision = form.get("decision");
      if (decision !== "approve" && decision !== "deny") return response(400);
      const userCode = form.get("user_code");
      const view =
        userCode === null
          ? await service.getAuthorizationApproval(
              browser,
              form.get("request_id") ?? "",
            )
          : await service.getDeviceApproval(browser, userCode);
      const result = await service.approve(browser, {
        requestId: view.requestId,
        decision,
        approvedScopes: view.requestedScopes.map((scope) => scope.name),
        ...(userCode === null ? {} : { userCode }),
      });
      return result.flow === "authorization_code"
        ? new Response(null, {
            status: 303,
            headers: {
              Location: result.redirectUri,
              "Cache-Control": "no-store",
            },
          })
        : response(200);
    }
    return (await protocol.handle(request)) ?? response(404);
  };

  return {
    configuration,
    origin,
    redirectUri: `${origin}/native/callback`,
    // Credentials remain inside this fixture; callers never print this object.
    browser: { cookie: browserCookie, csrf },
    advance(seconds: number) {
      now += seconds * 1_000;
    },
    demoteAdmin() {
      isAdmin = false;
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export type SyntheticHost = Awaited<ReturnType<typeof createSyntheticHost>>;
