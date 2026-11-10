import { OAuthError } from "./errors.js";
import type { ScopeDefinition } from "./types.js";

export type CredentialKind = "device" | "authorization" | "access" | "refresh";

const PREFIXES: Readonly<Record<CredentialKind, string>> = Object.freeze({
  device: "pgd1",
  authorization: "pga1",
  access: "pgt1",
  refresh: "pgr1",
});

const SEGMENT = /^[A-Za-z0-9_-]{43}$/;
const USER_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const NORMAL_USER_CODE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return base64Url(new Uint8Array(digest));
}

/** 256 random bits; this value alone never authorizes a state transition. */
export function generateLocator(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** Eight uniform base32 symbols, grouped for human entry. Never persist this value. */
export function generateUserCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let value = "";
  for (const byte of bytes) value += USER_ALPHABET[byte & 31];
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

/** Accepts case-insensitive entry with the optional central hyphen only. */
export function normalizeUserCode(value: string): string {
  if (typeof value !== "string" || value.length > 16)
    throw new OAuthError("invalid_request");
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/^(.{4})-(.{4})$/, "$1$2");
  if (!NORMAL_USER_CODE.test(normalized))
    throw new OAuthError("invalid_request");
  return normalized;
}

/** Human entry and device credentials locate one partition without a secondary index. */
export async function deviceLocator(userCode: string): Promise<string> {
  return sha256(`agent-access:user-code:v1:${normalizeUserCode(userCode)}`);
}

/** Raw credentials are returned once and must never be stored or logged. */
export function createCredential(
  kind: CredentialKind,
  locator: string,
): string {
  if (!Object.hasOwn(PREFIXES, kind) || !SEGMENT.test(locator))
    throw new OAuthError("invalid_request");
  return `${PREFIXES[kind]}.${locator}.${generateLocator()}`;
}

export interface ParsedCredential {
  readonly kind: CredentialKind;
  readonly locator: string;
  readonly secret: string;
}

export function parseCredential(value: string): ParsedCredential | null {
  if (typeof value !== "string" || value.length !== 92) return null;
  const [prefix, locator, secret] = value.split(".");
  if (
    locator === undefined ||
    secret === undefined ||
    !SEGMENT.test(locator) ||
    !SEGMENT.test(secret)
  )
    return null;
  const kind = (Object.keys(PREFIXES) as CredentialKind[]).find(
    (candidate) => PREFIXES[candidate] === prefix,
  );
  return kind === undefined ? null : Object.freeze({ kind, locator, secret });
}

export function hashCredential(credential: string): Promise<string> {
  return sha256(`agent-access:credential:v1:${credential}`);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  if (typeof verifier !== "string" || !VERIFIER.test(verifier))
    throw new OAuthError("invalid_request");
  return sha256(verifier);
}

export async function verifyPkce(
  verifier: string,
  challenge: string,
): Promise<boolean> {
  if (
    typeof verifier !== "string" ||
    !VERIFIER.test(verifier) ||
    typeof challenge !== "string" ||
    !SEGMENT.test(challenge)
  )
    return false;
  const actual = await pkceChallenge(verifier);
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1)
    difference |= actual.charCodeAt(index) ^ challenge.charCodeAt(index);
  return difference === 0;
}

/** Fingerprints only the selected definitions, independent of registry ordering. */
export function scopeFingerprint(
  scopes: readonly ScopeDefinition[],
): Promise<string> {
  const selected = [...scopes]
    .sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )
    .map((scope) => ({
      name: scope.name,
      description: scope.description,
      version: scope.version,
      permissions: [...scope.permissions].sort(),
    }));
  return sha256(`agent-access:scopes:v1:${JSON.stringify(selected)}`);
}

/** Owner-index partition; unambiguous JSON framing separates the bound identifiers. */
export function ownerIndexPartition(
  issuer: string,
  resource: string,
  ownerId: string,
): Promise<string> {
  return sha256(
    `agent-access:owner-index:v1:${JSON.stringify([issuer, resource, ownerId])}`,
  );
}

/** Integrity check for a public listing cursor. It is not a secret and never authorizes. */
export async function grantCursorCheck(
  ownerPartition: string,
  position: number,
): Promise<string> {
  return (
    await sha256(`agent-access:grant-cursor:v1:${ownerPartition}.${position}`)
  ).slice(0, 22);
}
