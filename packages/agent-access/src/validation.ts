import { OAuthError } from "./errors.js";
import type {
  AgentAccessConfiguration,
  AgentAccessLimits,
  GrantType,
  NormalizedAgentAccessConfiguration,
  PublicClient,
  ScopeDefinition,
} from "./types.js";

export const DEFAULT_APPROVAL_PERMISSION = "agent.access.link";

export const DEFAULT_LIMITS: AgentAccessLimits = Object.freeze({
  deviceLifetimeSeconds: 600,
  authRequestLifetimeSeconds: 600,
  codeLifetimeSeconds: 120,
  accessLifetimeSeconds: 900,
  refreshFamilyLifetimeSeconds: 604800,
  pollIntervalSeconds: 5,
  maxRotations: 128,
  maxRows: 300,
  maxInputBytes: 16384,
  maxScopes: 16,
  maxConflictAttempts: 4,
});

const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const SCOPE_NAME = /^[\u0021\u0023-\u005B\u005D-\u007E]+$/;
const ENDPOINT_NAMES = [
  "authorize",
  "deviceAuthorization",
  "token",
  "revocation",
  "verification",
  "approval",
  "resourceMetadata",
] as const;

function fail(): never {
  throw new OAuthError("invalid_request");
}

function object(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail();
}

function own(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) fail();
  return descriptor.value;
}

function text(value: unknown, maxLength = 256): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value ||
    CONTROL.test(value)
  )
    fail();
  return value;
}

function array(value: unknown, maxLength: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maxLength) fail();
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1)
    result.push(own(value, String(index)));
  return result;
}

function uniqueStrings(
  value: unknown,
  maxLength: number,
  scopeNames = false,
): readonly string[] {
  const result = array(value, maxLength).map((item) => text(item));
  if (
    new Set(result).size !== result.length ||
    (scopeNames &&
      result.some((name) => name.length > 128 || !SCOPE_NAME.test(name)))
  )
    fail();
  return Object.freeze(result);
}

function parseUrl(value: unknown): URL {
  const candidate = text(value, 2048);
  // URL parsing otherwise silently removes certain whitespace and normalizes backslashes.
  if (/\s|\\/.test(candidate)) fail();
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return fail();
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") fail();
  return url;
}

function isLoopback(url: URL): boolean {
  return (
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" ||
    url.hostname === "localhost"
  );
}

function isNativeLoopback(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "[::1]")
  );
}

function isFixedLocalhostCallback(url: URL): boolean {
  return (
    url.protocol === "http:" && url.hostname === "localhost" && url.port !== ""
  );
}

function requireSecureUrl(value: unknown, testLoopback: boolean): URL {
  const url = parseUrl(value);
  if (
    url.protocol !== "https:" &&
    !(testLoopback && url.protocol === "http:" && isLoopback(url))
  )
    fail();
  return url;
}

function normalizeScope(value: unknown): ScopeDefinition {
  object(value);
  const name = text(own(value, "name"), 128);
  if (!SCOPE_NAME.test(name)) fail();
  const permissions = uniqueStrings(own(value, "permissions"), 64);
  if (permissions.length === 0) fail();
  return Object.freeze({
    name,
    description: text(own(value, "description"), 1024),
    version: text(own(value, "version"), 128),
    permissions,
  });
}

function normalizeClient(
  value: unknown,
  scopeNames: ReadonlySet<string>,
): PublicClient {
  object(value);
  const allowedScopes = uniqueStrings(own(value, "allowedScopes"), 256, true);
  if (
    allowedScopes.length === 0 ||
    allowedScopes.some((name) => !scopeNames.has(name))
  )
    fail();
  const redirectUris = uniqueStrings(own(value, "redirectUris"), 32);
  for (const redirect of redirectUris) {
    const url = parseUrl(redirect);
    if (
      url.protocol !== "https:" &&
      !isNativeLoopback(url) &&
      !isFixedLocalhostCallback(url)
    )
      fail();
    if (
      redirect.includes("*") ||
      ((isNativeLoopback(url) || isFixedLocalhostCallback(url)) &&
        url.href !== redirect)
    )
      fail();
    if (
      [...url.searchParams.keys()].some(
        (key) =>
          key === "code" ||
          key === "state" ||
          key === "iss" ||
          key === "error" ||
          key === "error_description",
      )
    )
      fail();
  }
  const grantTypes = uniqueStrings(own(value, "grantTypes"), 2);
  if (
    grantTypes.length === 0 ||
    grantTypes.some(
      (grant) => grant !== "device_code" && grant !== "authorization_code",
    )
  )
    fail();
  if (grantTypes.includes("authorization_code") && redirectUris.length === 0)
    fail();
  return Object.freeze({
    clientId: text(own(value, "clientId"), 128),
    name: text(own(value, "name")),
    redirectUris,
    allowedScopes,
    grantTypes: Object.freeze(grantTypes as GrantType[]),
  });
}

/** Validates and snapshots every nested configuration value before use. */
export function normalizeConfiguration(
  value: AgentAccessConfiguration,
): NormalizedAgentAccessConfiguration {
  object(value);
  const insecure = Object.hasOwn(value, "allowInsecureLoopback")
    ? own(value, "allowInsecureLoopback")
    : false;
  if (typeof insecure !== "boolean") fail();
  const issuer = text(own(value, "issuer"), 2048);
  const resource = text(own(value, "resource"), 2048);
  const issuerUrl = requireSecureUrl(issuer, insecure);
  const resourceUrl = requireSecureUrl(resource, insecure);
  if (issuerUrl.search !== "" || resourceUrl.search !== "") fail();
  // A test-mode configuration must describe only the local harness.
  if (insecure && (!isLoopback(issuerUrl) || !isLoopback(resourceUrl))) fail();
  const endpointInput = own(value, "endpoints");
  object(endpointInput);
  const endpoints = {} as Record<(typeof ENDPOINT_NAMES)[number], string>;
  for (const name of ENDPOINT_NAMES) {
    const endpoint = text(own(endpointInput, name), 2048);
    const url = requireSecureUrl(endpoint, insecure);
    if (url.origin !== issuerUrl.origin || url.search !== "") fail();
    endpoints[name] = endpoint;
  }
  const scopes = array(own(value, "scopes"), 256).map(normalizeScope);
  const approvalPermission = text(own(value, "approvalPermission"));
  if (scopes.some((scope) => scope.permissions.includes(approvalPermission)))
    fail();
  const scopeNames = new Set(scopes.map((scope) => scope.name));
  if (scopes.length === 0 || scopeNames.size !== scopes.length) fail();
  const clients = array(own(value, "clients"), 256).map((client) =>
    normalizeClient(client, scopeNames),
  );
  if (
    clients.length === 0 ||
    new Set(clients.map((client) => client.clientId)).size !== clients.length
  )
    fail();
  const limits: Record<string, number> = { ...DEFAULT_LIMITS };
  if (Object.hasOwn(value, "limits")) {
    const supplied = own(value, "limits");
    object(supplied);
    for (const key of Object.keys(supplied)) {
      if (!Object.hasOwn(DEFAULT_LIMITS, key)) fail();
      const candidate = own(supplied, key);
      if (
        typeof candidate !== "number" ||
        !Number.isSafeInteger(candidate) ||
        candidate <= 0 ||
        candidate > DEFAULT_LIMITS[key as keyof AgentAccessLimits]
      )
        fail();
      limits[key] = candidate;
    }
  }
  if ((limits.maxRows ?? 0) < 8 || (limits.maxInputBytes ?? 0) < 512) fail();
  return Object.freeze({
    issuer,
    resource,
    endpoints: Object.freeze(endpoints),
    approvalPermission,
    clients: Object.freeze(clients),
    scopes: Object.freeze(scopes),
    limits: Object.freeze(limits) as unknown as AgentAccessLimits,
    allowInsecureLoopback: insecure,
  });
}

export function getClient(
  configuration: NormalizedAgentAccessConfiguration,
  clientId: string,
  grantType?: GrantType,
): PublicClient {
  const client = configuration.clients.find(
    (candidate) => candidate.clientId === clientId,
  );
  if (client === undefined) throw new OAuthError("invalid_client");
  if (grantType !== undefined && !client.grantTypes.includes(grantType))
    throw new OAuthError("unauthorized_client");
  return client;
}

export function validateResource(
  configuration: NormalizedAgentAccessConfiguration,
  resource: string,
): string {
  if (resource !== configuration.resource)
    throw new OAuthError("invalid_target");
  return resource;
}

export function selectScopes(
  configuration: NormalizedAgentAccessConfiguration,
  client: PublicClient,
  requested: readonly string[],
): readonly ScopeDefinition[] {
  const names = uniqueStrings(requested, configuration.limits.maxScopes, true);
  if (
    names.length === 0 ||
    names.some((name) => !client.allowedScopes.includes(name))
  )
    throw new OAuthError("invalid_scope");
  const selected = names.map((name) =>
    configuration.scopes.find((scope) => scope.name === name),
  );
  if (selected.some((scope) => scope === undefined))
    throw new OAuthError("invalid_scope");
  return Object.freeze(
    (selected as ScopeDefinition[]).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    ),
  );
}

/** Exact callbacks, including fixed-port localhost; only IP loopback may vary its port. */
export function validateRedirectUri(
  configuration: NormalizedAgentAccessConfiguration,
  client: PublicClient,
  redirectUri: string,
): string {
  void configuration;
  const actual = parseUrl(redirectUri);
  if (client.redirectUris.includes(redirectUri)) return redirectUri;
  if (!isNativeLoopback(actual)) fail();
  const allowed = client.redirectUris.some((registered) => {
    const expected = parseUrl(registered);
    if (!isNativeLoopback(expected)) return false;
    // Compare the original registration exactly after substituting the actual port.
    expected.port = actual.port;
    return expected.href === actual.href && actual.href === redirectUri;
  });
  if (!allowed) fail();
  return redirectUri;
}

/**
 * Capture bounded plain data before the first await, without invoking getters,
 * toJSON, or input-supplied coercion. Byte accounting follows JSON UTF-8 output
 * incrementally, before allocating a detached copy of any container.
 */
export function captureInput<T>(value: T, maxInputBytes: number): T {
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes <= 0) fail();
  let bytes = 0;
  let nodes = 0;
  const maxNodes = Math.min(maxInputBytes, 2048);
  const ancestors = new Set<object>();

  const charge = (amount: number): void => {
    bytes += amount;
    if (bytes > maxInputBytes) fail();
  };

  const chargeString = (candidate: string): void => {
    if (candidate.length > maxInputBytes - bytes) fail();
    charge(2);
    for (let index = 0; index < candidate.length; index += 1) {
      const unit = candidate.charCodeAt(index);
      if (
        unit === 0x22 ||
        unit === 0x5c ||
        unit === 0x08 ||
        unit === 0x09 ||
        unit === 0x0a ||
        unit === 0x0c ||
        unit === 0x0d
      )
        charge(2);
      else if (unit < 0x20) charge(6);
      else if (unit < 0x80) charge(1);
      else if (unit < 0x800) charge(2);
      else if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = candidate.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          charge(4);
          index += 1;
        } else charge(6);
      } else if (unit >= 0xdc00 && unit <= 0xdfff) charge(6);
      else charge(3);
    }
  };

  const copy = (item: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > maxNodes || depth > 16) fail();
    if (typeof item === "string") {
      chargeString(item);
      return item;
    }
    if (item === null || item === undefined) {
      charge(4);
      return item;
    }
    if (typeof item === "boolean") {
      charge(item ? 4 : 5);
      return item;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) fail();
      charge(String(item).length);
      return item;
    }
    if (typeof item !== "object" || ancestors.has(item)) fail();
    const isArray = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (
      prototype !== null &&
      prototype !== (isArray ? Array.prototype : Object.prototype)
    )
      fail();
    const keys = Reflect.ownKeys(item);
    if (
      keys.length > maxNodes ||
      keys.some((key) => typeof key !== "string" || key === "toJSON")
    )
      fail();
    const read = (key: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      )
        fail();
      return descriptor.value;
    };
    ancestors.add(item);
    try {
      charge(2);
      if (isArray) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(
          item,
          "length",
        );
        if (lengthDescriptor === undefined || !("value" in lengthDescriptor))
          fail();
        const length: unknown = lengthDescriptor.value;
        if (
          typeof length !== "number" ||
          !Number.isSafeInteger(length) ||
          length < 0 ||
          length > Math.min(maxInputBytes, 1024) ||
          keys.length !== length + 1
        )
          fail();
        const result: unknown[] = [];
        for (let index = 0; index < length; index += 1) {
          if (index > 0) charge(1);
          result.push(copy(read(String(index)), depth + 1));
        }
        return Object.freeze(result);
      }
      const result = Object.create(null) as Record<string, unknown>;
      for (const [index, candidate] of keys.entries()) {
        if (typeof candidate !== "string") fail();
        if (index > 0) charge(1);
        chargeString(candidate);
        charge(1);
        result[candidate] = copy(read(candidate), depth + 1);
      }
      return Object.freeze(result);
    } finally {
      ancestors.delete(item);
    }
  };

  try {
    return copy(value, 0) as T;
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    return fail();
  }
}

/** Validate using the same bounded plain-data traversal as service snapshots. */
export function assertInputBounds(value: unknown, maxInputBytes: number): void {
  captureInput(value, maxInputBytes);
}

export function validateCodeChallenge(value: string, method: string): string {
  if (
    method !== "S256" ||
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value)
  )
    fail();
  return value;
}

export function validateState(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 1024 || CONTROL.test(value))
    fail();
  return value;
}
