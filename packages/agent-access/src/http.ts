import { OAuthError } from "./errors.js";
import type {
  AgentAccessConfiguration,
  AgentAccessServicePort,
  BeginAuthorizationInput,
  BrowserApprovalContext,
  DelegatedAccess,
  NormalizedAgentAccessConfiguration,
} from "./types.js";
import {
  getClient,
  normalizeConfiguration,
  selectScopes,
  validateCodeChallenge,
  validateRedirectUri,
  validateResource,
  validateState,
} from "./validation.js";

export type AgentAccessProtocolEndpoint =
  "authorize" | "device_authorization" | "token" | "revocation";

export interface AgentAccessLimitResult {
  readonly allowed: boolean;
  readonly retryAfterSeconds?: number;
}

export interface AgentAccessHttpOptions {
  readonly service: AgentAccessServicePort;
  readonly configuration: AgentAccessConfiguration;
  /** Host session authentication only. Approval mutations still need host CSRF/origin checks. */
  readonly authenticateBrowser: (
    request: Request,
    context: { readonly mutation: false },
  ) =>
    | BrowserApprovalContext
    | Response
    | Promise<BrowserApprovalContext | Response>;
  /** Required host-owned distributed/IP limiter, invoked before protocol processing. */
  readonly limit: (
    request: Request,
    context: { readonly endpoint: AgentAccessProtocolEndpoint },
  ) =>
    | boolean
    | AgentAccessLimitResult
    | Promise<boolean | AgentAccessLimitResult>;
}

export interface AgentAccessHttp {
  /** Null leaves unmatched routes, including the host's approval/verification UI, to the host. */
  handle(request: Request): Promise<Response | null>;
}

export interface ProtectedResourceAuthenticatorOptions {
  readonly service: AgentAccessServicePort;
  readonly configuration: AgentAccessConfiguration;
}

export interface ProtectedResourceAuthenticator {
  /** The host must use the returned restricted access context for the actual operation. */
  authenticate(
    request: Request,
    requiredScopes?: readonly string[],
  ): Promise<DelegatedAccess | Response>;
}

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const MAX_BODY_BYTES = 16_384;
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const SCOPE_NAME = /^[\u0021\u0023-\u005B\u005D-\u007E]+$/;
const AUTHORIZATION_FIELDS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "resource",
  "scope",
  "code_challenge",
  "code_challenge_method",
  "state",
];
const TOKEN_FIELDS = [
  "grant_type",
  "client_id",
  "resource",
  "code",
  "redirect_uri",
  "code_verifier",
  "device_code",
  "refresh_token",
  "scope",
];

function responseHeaders(initial?: HeadersInit): Headers {
  const headers = new Headers(initial);
  headers.set("Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  return headers;
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  const safeHeaders = responseHeaders(headers);
  safeHeaders.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { status, headers: safeHeaders });
}

function errorResponse(
  error: unknown,
  tokenEndpoint = false,
  headers?: HeadersInit,
): Response {
  const safe =
    error instanceof OAuthError ? error : new OAuthError("server_error");
  // RFC 8628 reports a denied device authorization at the token endpoint as 400.
  const status =
    tokenEndpoint && safe.code === "access_denied" ? 400 : safe.status;
  return json(safe.toJSON(), status, headers);
}

function invalidRequest(status?: number): never {
  throw new OAuthError("invalid_request", status);
}

function assertByteBound(value: string, maximum: number): void {
  if (
    value.length > maximum ||
    new TextEncoder().encode(value).byteLength > maximum
  )
    invalidRequest(413);
}

function decodeComponent(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return invalidRequest();
  }
  if (CONTROL.test(decoded)) invalidRequest();
  return decoded;
}

/** URLSearchParams tolerates malformed percent escapes/UTF-8; protocol input does not. */
function parameters(
  encoded: string,
  fields: readonly string[],
  maximum: number,
): ReadonlyMap<string, string> {
  assertByteBound(encoded, maximum);
  const result = new Map<string, string>();
  if (encoded === "") return result;
  for (const pair of encoded.split("&")) {
    if (pair === "") invalidRequest();
    const separator = pair.indexOf("=");
    if (separator < 1) invalidRequest();
    const key = decodeComponent(pair.slice(0, separator));
    const value = decodeComponent(pair.slice(separator + 1));
    if (!fields.includes(key) || result.has(key)) invalidRequest();
    result.set(key, value);
  }
  return result;
}

function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined || value === "") invalidRequest();
  return value;
}

function only(
  values: ReadonlyMap<string, string>,
  fields: readonly string[],
): void {
  for (const key of values.keys()) if (!fields.includes(key)) invalidRequest();
}

function scopes(value: string, maximum: number): readonly string[] {
  const names = value.split(" ");
  if (
    names.length === 0 ||
    names.length > maximum ||
    new Set(names).size !== names.length ||
    names.some(
      (name) =>
        name.length === 0 || name.length > 128 || !SCOPE_NAME.test(name),
    )
  ) {
    throw new OAuthError("invalid_scope");
  }
  return names;
}

async function cancelBody(request: Request): Promise<void> {
  try {
    await request.body?.cancel();
  } catch {
    // Cancellation failure cannot turn a rejected input into accepted input.
  }
}

async function formBody(
  request: Request,
  fields: readonly string[],
  maximum: number,
): Promise<ReadonlyMap<string, string>> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (
    !/^application\/x-www-form-urlencoded(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(
      contentType,
    )
  )
    invalidRequest(415);
  const declaredLength = request.headers.get("Content-Length");
  if (
    declaredLength !== null &&
    (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength) ||
      Number(declaredLength) > maximum)
  ) {
    await cancelBody(request);
    invalidRequest(413);
  }
  if (request.body === null) return parameters("", fields, maximum);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let reads = 0;
  try {
    while (true) {
      reads += 1;
      if (reads > maximum + 1) invalidRequest(413);
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximum) invalidRequest(413);
      chunks.push(part.value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Fail closed even when the incoming stream fails cancellation.
    }
    if (error instanceof OAuthError) throw error;
    return invalidRequest();
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let encoded: string;
  try {
    encoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return invalidRequest();
  }
  return parameters(encoded, fields, maximum);
}

function route(url: URL): string {
  return url.origin + url.pathname;
}

/** RFC 8414 inserts the well-known suffix before an issuer path. */
function authorizationMetadataUrl(issuer: string): string {
  const url = new URL(issuer);
  url.pathname =
    "/.well-known/oauth-authorization-server" + url.pathname.replace(/\/$/, "");
  return url.href;
}

function authorizationMetadata(
  configuration: NormalizedAgentAccessConfiguration,
): unknown {
  const device = configuration.clients.some((client) =>
    client.grantTypes.includes("device_code"),
  );
  const authorization = configuration.clients.some((client) =>
    client.grantTypes.includes("authorization_code"),
  );
  return {
    issuer: configuration.issuer,
    ...(authorization
      ? { authorization_endpoint: configuration.endpoints.authorize }
      : {}),
    ...(device
      ? {
          device_authorization_endpoint:
            configuration.endpoints.deviceAuthorization,
        }
      : {}),
    token_endpoint: configuration.endpoints.token,
    revocation_endpoint: configuration.endpoints.revocation,
    scopes_supported: configuration.scopes.map((scope) => scope.name),
    ...(authorization
      ? {
          response_types_supported: ["code"],
          response_modes_supported: ["query"],
          code_challenge_methods_supported: ["S256"],
          authorization_response_iss_parameter_supported: true,
        }
      : {}),
    grant_types_supported: [
      ...(authorization ? ["authorization_code"] : []),
      ...(device ? [DEVICE_GRANT] : []),
      "refresh_token",
    ],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
  };
}

function resourceMetadata(
  configuration: NormalizedAgentAccessConfiguration,
): unknown {
  return {
    resource: configuration.resource,
    authorization_servers: [configuration.issuer],
    scopes_supported: configuration.scopes.map((scope) => scope.name),
    bearer_methods_supported: ["header"],
  };
}

async function limited(
  options: AgentAccessHttpOptions,
  request: Request,
  endpoint: AgentAccessProtocolEndpoint,
): Promise<Response | null> {
  let result: boolean | AgentAccessLimitResult;
  try {
    result = await options.limit(request, { endpoint });
    if (
      typeof result !== "boolean" &&
      (result === null ||
        typeof result !== "object" ||
        typeof result.allowed !== "boolean" ||
        (result.retryAfterSeconds !== undefined &&
          (!Number.isSafeInteger(result.retryAfterSeconds) ||
            result.retryAfterSeconds <= 0 ||
            result.retryAfterSeconds > 86_400)))
    ) {
      throw new OAuthError("server_error");
    }
  } catch {
    return errorResponse(new OAuthError("server_error"));
  }
  if (result === true || (typeof result === "object" && result.allowed))
    return null;
  const retry =
    typeof result === "object" ? result.retryAfterSeconds : undefined;
  return errorResponse(
    new OAuthError("temporarily_unavailable", 429),
    false,
    retry === undefined ? undefined : { "Retry-After": String(retry) },
  );
}

function authorizationInput(
  values: ReadonlyMap<string, string>,
  configuration: NormalizedAgentAccessConfiguration,
): BeginAuthorizationInput {
  if (required(values, "response_type") !== "code") invalidRequest();
  const clientId = required(values, "client_id");
  const client = getClient(configuration, clientId, "authorization_code");
  const resource = validateResource(
    configuration,
    required(values, "resource"),
  );
  const selected = selectScopes(
    configuration,
    client,
    scopes(required(values, "scope"), configuration.limits.maxScopes),
  );
  const redirectUri = validateRedirectUri(
    configuration,
    client,
    required(values, "redirect_uri"),
  );
  const codeChallenge = validateCodeChallenge(
    required(values, "code_challenge"),
    required(values, "code_challenge_method"),
  );
  const state = validateState(values.get("state"));
  return {
    clientId,
    resource,
    scopes: selected.map((scope) => scope.name),
    redirectUri,
    codeChallenge,
    codeChallengeMethod: "S256",
    ...(state === undefined ? {} : { state }),
  };
}

async function exchange(
  service: AgentAccessServicePort,
  configuration: NormalizedAgentAccessConfiguration,
  values: ReadonlyMap<string, string>,
): Promise<unknown> {
  const grantType = required(values, "grant_type");
  const clientId = required(values, "client_id");
  const resource = validateResource(
    configuration,
    required(values, "resource"),
  );
  if (grantType === "authorization_code") {
    only(values, [
      "grant_type",
      "client_id",
      "resource",
      "code",
      "redirect_uri",
      "code_verifier",
    ]);
    const client = getClient(configuration, clientId, "authorization_code");
    return service.exchangeAuthorizationCode({
      clientId,
      resource,
      code: required(values, "code"),
      redirectUri: validateRedirectUri(
        configuration,
        client,
        required(values, "redirect_uri"),
      ),
      codeVerifier: required(values, "code_verifier"),
    });
  }
  if (grantType === DEVICE_GRANT) {
    only(values, ["grant_type", "client_id", "resource", "device_code"]);
    getClient(configuration, clientId, "device_code");
    return service.pollDeviceToken({
      clientId,
      resource,
      deviceCode: required(values, "device_code"),
    });
  }
  if (grantType === "refresh_token") {
    only(values, [
      "grant_type",
      "client_id",
      "resource",
      "refresh_token",
      "scope",
    ]);
    const client = getClient(configuration, clientId);
    const requested = values.get("scope");
    const selected =
      requested === undefined
        ? undefined
        : selectScopes(
            configuration,
            client,
            scopes(requested, configuration.limits.maxScopes),
          ).map((scope) => scope.name);
    return service.refresh({
      clientId,
      resource,
      refreshToken: required(values, "refresh_token"),
      ...(selected === undefined ? {} : { scopes: selected }),
    });
  }
  throw new OAuthError("unsupported_grant_type");
}

/** Portable Fetch adapter. It provides protocol endpoints; the host owns browser UI and login. */
export function createAgentAccessHttp(
  options: AgentAccessHttpOptions,
): AgentAccessHttp {
  const configuration = normalizeConfiguration(options.configuration);
  if (
    typeof options.limit !== "function" ||
    typeof options.authenticateBrowser !== "function"
  )
    invalidRequest();
  const maximum = Math.min(MAX_BODY_BYTES, configuration.limits.maxInputBytes);
  const routes = new Map<
    string,
    AgentAccessProtocolEndpoint | "authorization_metadata" | "resource_metadata"
  >([
    [
      route(new URL(authorizationMetadataUrl(configuration.issuer))),
      "authorization_metadata",
    ],
    [
      route(new URL(configuration.endpoints.resourceMetadata)),
      "resource_metadata",
    ],
    [route(new URL(configuration.endpoints.authorize)), "authorize"],
    [
      route(new URL(configuration.endpoints.deviceAuthorization)),
      "device_authorization",
    ],
    [route(new URL(configuration.endpoints.token)), "token"],
    [route(new URL(configuration.endpoints.revocation)), "revocation"],
  ]);
  if (routes.size !== 6) invalidRequest();
  return Object.freeze({
    async handle(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      const endpoint = routes.get(route(url));
      if (endpoint === undefined) return null;
      const method =
        endpoint === "authorize" ||
        endpoint === "authorization_metadata" ||
        endpoint === "resource_metadata"
          ? "GET"
          : "POST";
      if (request.method !== method)
        return errorResponse(new OAuthError("invalid_request", 405), false, {
          Allow: method,
        });
      if (
        endpoint !== "authorization_metadata" &&
        endpoint !== "resource_metadata"
      ) {
        const denial = await limited(options, request, endpoint);
        if (denial !== null) return denial;
      }
      try {
        if (
          endpoint === "authorization_metadata" ||
          endpoint === "resource_metadata"
        ) {
          if (url.search !== "") invalidRequest();
          return json(
            endpoint === "authorization_metadata"
              ? authorizationMetadata(configuration)
              : resourceMetadata(configuration),
          );
        }
        if (request.headers.has("Authorization"))
          throw new OAuthError(
            endpoint === "authorize" ? "invalid_request" : "invalid_client",
          );
        if (endpoint === "authorize") {
          const input = authorizationInput(
            parameters(url.search.slice(1), AUTHORIZATION_FIELDS, maximum),
            configuration,
          );
          const context = await options.authenticateBrowser(request, {
            mutation: false,
          });
          if (context instanceof Response)
            return new Response(context.body, {
              status: context.status,
              statusText: context.statusText,
              headers: responseHeaders(context.headers),
            });
          const view = await options.service.beginAuthorization(context, input);
          const approval = new URL(configuration.endpoints.approval);
          approval.searchParams.set("request_id", view.requestId);
          return new Response(null, {
            status: 303,
            headers: responseHeaders({ Location: approval.href }),
          });
        }
        // Credentials and protocol parameters never come from a query string.
        if (url.search !== "") invalidRequest();
        if (endpoint === "device_authorization") {
          const values = await formBody(
            request,
            ["client_id", "resource", "scope"],
            maximum,
          );
          const clientId = required(values, "client_id");
          const client = getClient(configuration, clientId, "device_code");
          const resource = validateResource(
            configuration,
            required(values, "resource"),
          );
          const selected = selectScopes(
            configuration,
            client,
            scopes(required(values, "scope"), configuration.limits.maxScopes),
          );
          return json(
            await options.service.beginDeviceAuthorization({
              clientId,
              resource,
              scopes: selected.map((scope) => scope.name),
            }),
          );
        }
        if (endpoint === "token")
          return json(
            await exchange(
              options.service,
              configuration,
              await formBody(request, TOKEN_FIELDS, maximum),
            ),
          );
        const values = await formBody(
          request,
          ["client_id", "token", "token_type_hint"],
          maximum,
        );
        const clientId = required(values, "client_id");
        getClient(configuration, clientId);
        const suppliedHint = values.get("token_type_hint");
        // RFC 7009 hints optimize lookup only; unknown hints must not block revocation.
        const hint =
          suppliedHint === "access_token" || suppliedHint === "refresh_token"
            ? suppliedHint
            : undefined;
        await options.service.revokeToken({
          clientId,
          token: required(values, "token"),
          ...(hint === undefined ? {} : { tokenTypeHint: hint }),
        });
        return new Response(null, { status: 200, headers: responseHeaders() });
      } catch (error) {
        return errorResponse(error, endpoint === "token");
      }
    },
  });
}

function quoted(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function resourceError(
  error: unknown,
  configuration: NormalizedAgentAccessConfiguration,
  requiredScopes: readonly string[],
  missing = false,
): Response {
  const safe =
    error instanceof OAuthError ? error : new OAuthError("server_error");
  if (safe.code === "server_error") return errorResponse(safe);
  const challenge = [
    "resource_metadata=" +
      quoted(new URL(configuration.endpoints.resourceMetadata).href),
  ];
  if (!missing) challenge.push("error=" + quoted(safe.code));
  if (safe.code === "insufficient_scope" && requiredScopes.length > 0)
    challenge.push("scope=" + quoted(requiredScopes.join(" ")));
  return errorResponse(safe, false, {
    "WWW-Authenticate": "Bearer " + challenge.join(", "),
  });
}

/** Header-only bearer authentication. The host retains resource routing and body handling. */
export function createProtectedResourceAuthenticator(
  options: ProtectedResourceAuthenticatorOptions,
): ProtectedResourceAuthenticator {
  const configuration = normalizeConfiguration(options.configuration);
  return Object.freeze({
    async authenticate(
      request: Request,
      requiredScopes: readonly string[] = [],
    ): Promise<DelegatedAccess | Response> {
      let selected: readonly string[] = [];
      try {
        if (
          !Array.isArray(requiredScopes) ||
          requiredScopes.length > configuration.limits.maxScopes ||
          new Set(requiredScopes).size !== requiredScopes.length ||
          requiredScopes.some(
            (scope) =>
              typeof scope !== "string" ||
              scope.length === 0 ||
              scope.length > 128 ||
              !SCOPE_NAME.test(scope) ||
              !configuration.scopes.some(
                (configured) => configured.name === scope,
              ),
          )
        ) {
          throw new OAuthError("server_error");
        }
        selected = [...requiredScopes];
        const url = new URL(request.url);
        assertByteBound(url.search, MAX_BODY_BYTES);
        if (url.searchParams.has("access_token")) invalidRequest();
        // Do not read/clone the host's body. Form transports must reject token fields themselves.
        const contentType = request.headers.get("Content-Type") ?? "";
        if (
          /^(?:application\/x-www-form-urlencoded|multipart\/form-data)(?:\s*;|\s*$)/i.test(
            contentType,
          )
        )
          invalidRequest();
        const authorization = request.headers.get("Authorization");
        if (authorization === null)
          return resourceError(
            new OAuthError("invalid_token"),
            configuration,
            selected,
            true,
          );
        assertByteBound(
          authorization,
          Math.min(MAX_BODY_BYTES, configuration.limits.maxInputBytes),
        );
        const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(authorization);
        if (match === null || match[1] === undefined) invalidRequest();
        return await options.service.authenticate({
          token: match[1],
          resource: configuration.resource,
          requiredScopes: selected,
        });
      } catch (error) {
        return resourceError(error, configuration, selected);
      }
    },
  });
}
