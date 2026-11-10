import type { AuditEvent } from "@pegma/audit";
import { defineCollection, type StoredRecord } from "@pegma/storage-core";
import type { ScopeDefinition, GrantType } from "./types.js";

/** One head is the CAS fence for every credential in a grant's partition. */
export interface GrantHead {
  readonly locator: string;
  readonly flow: GrantType;
  readonly status:
    "pending" | "approved" | "active" | "denied" | "revoked" | "expired";
  readonly generation: number;
  readonly rows: number;
  readonly createdAt: string;
  readonly requestExpiresAt: string;
  readonly expiresAt: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly issuer: string;
  readonly resource: string;
  readonly requestedScopes: readonly ScopeDefinition[];
  readonly ownerId?: string;
  readonly approvedScopes?: readonly string[];
  readonly consentFingerprint?: string;
  readonly redirectUri?: string;
  readonly codeChallenge?: string;
  readonly state?: string;
  readonly deviceHash?: string;
  readonly codeHash?: string;
  readonly codeExpiresAt?: string;
  readonly intervalSeconds: number;
  readonly nextPollAt: string;
  readonly accessHash?: string;
  readonly accessScopes?: readonly string[];
  readonly accessExpiresAt?: string;
  readonly refreshHash?: string;
  readonly rotations: number;
}

export type AgentAccessRecord =
  | {
      readonly partition: string;
      readonly id: "head";
      readonly kind: "head";
      readonly data: GrantHead;
    }
  | {
      readonly partition: string;
      readonly id: string;
      readonly kind: "consumed";
      readonly data: { readonly hash: string };
    }
  | {
      readonly partition: string;
      readonly id: string;
      readonly kind: "audit";
      readonly data: AuditEvent;
    };

const SEGMENT = /^[A-Za-z0-9_-]{43}$/;
const MAX_PARTS = 15;
const PART_SIZE = 30_000;

function validate(record: AgentAccessRecord): void {
  if (
    !SEGMENT.test(record.partition) ||
    typeof record.id !== "string" ||
    record.id.length > 128 ||
    !/^[A-Za-z0-9_|:-]+$/.test(record.id)
  )
    throw new Error("Invalid stored grant");
  if (record.kind === "head") {
    const head = record.data;
    if (
      record.id !== "head" ||
      head.locator !== record.partition ||
      !["device_code", "authorization_code"].includes(head.flow) ||
      ![
        "pending",
        "approved",
        "active",
        "denied",
        "revoked",
        "expired",
      ].includes(head.status) ||
      !Number.isSafeInteger(head.rows) ||
      head.rows < 2 ||
      head.rows > 300 ||
      !Number.isSafeInteger(head.generation) ||
      head.generation < 1 ||
      !Number.isSafeInteger(head.rotations) ||
      head.rotations < 0 ||
      head.rotations > 128 ||
      !Array.isArray(head.requestedScopes) ||
      head.requestedScopes.length === 0 ||
      head.requestedScopes.length > 16
    )
      throw new Error("Invalid stored grant");
    for (const time of [
      head.createdAt,
      head.requestExpiresAt,
      head.expiresAt,
      head.nextPollAt,
    ])
      if (typeof time !== "string" || !Number.isFinite(Date.parse(time)))
        throw new Error("Invalid stored grant");
    for (const text of [
      head.clientId,
      head.clientName,
      head.issuer,
      head.resource,
    ])
      if (typeof text !== "string" || text.length === 0)
        throw new Error("Invalid stored grant");
  } else if (record.kind === "consumed") {
    if (
      !SEGMENT.test(record.data.hash) ||
      record.id !== `consumed:${record.data.hash}`
    )
      throw new Error("Invalid stored grant");
  } else if (record.kind !== "audit") throw new Error("Invalid stored grant");
}

function encode(record: AgentAccessRecord): StoredRecord {
  validate(record);
  const json = JSON.stringify(record.data);
  if (json.length > MAX_PARTS * PART_SIZE)
    throw new Error("Stored grant exceeds limit");
  const parts: string[] = [];
  for (let offset = 0; offset < json.length;) {
    let end = Math.min(json.length, offset + PART_SIZE);
    const unit = json.charCodeAt(end - 1);
    if (end < json.length && unit >= 0xd800 && unit <= 0xdbff) end -= 1;
    parts.push(json.slice(offset, end));
    offset = end;
  }
  const result: Record<string, string | number> = {
    schemaVersion: 1,
    recordPartition: record.partition,
    recordId: record.id,
    kind: record.kind,
    partCount: parts.length,
  };
  for (const [index, part] of parts.entries()) result[`part${index}`] = part;
  return result;
}

function decode(stored: StoredRecord): AgentAccessRecord {
  if (
    stored.schemaVersion !== 1 ||
    typeof stored.partCount !== "number" ||
    !Number.isSafeInteger(stored.partCount) ||
    stored.partCount < 1 ||
    stored.partCount > MAX_PARTS
  )
    throw new Error("Invalid stored grant");
  const expected = new Set([
    "schemaVersion",
    "recordPartition",
    "recordId",
    "kind",
    "partCount",
    ...Array.from({ length: stored.partCount }, (_, index) => `part${index}`),
  ]);
  if (
    Object.keys(stored).length !== expected.size ||
    Object.keys(stored).some((key) => !expected.has(key))
  )
    throw new Error("Invalid stored grant");
  const parts: string[] = [];
  for (let index = 0; index < stored.partCount; index += 1) {
    const part = stored[`part${index}`];
    if (typeof part !== "string" || part.length > PART_SIZE)
      throw new Error("Invalid stored grant");
    parts.push(part);
  }
  const record = {
    partition: stored.recordPartition,
    id: stored.recordId,
    kind: stored.kind,
    data: JSON.parse(parts.join("")) as unknown,
  } as AgentAccessRecord;
  validate(record);
  return record;
}

export const agentAccessRecords = defineCollection<AgentAccessRecord>({
  name: "agent-access.records.v1",
  key: (record) => ({ partition: record.partition, id: record.id }),
  codec: { encode, decode },
});

/**
 * Owner index: one partition per (issuer, resource, owner) hash. Entries only
 * locate grant heads; the grant head stays authoritative for ownership and
 * status, so a stale or dangling entry can never reveal another owner's grant.
 */
export type OwnerIndexRecord =
  | {
      readonly partition: string;
      readonly id: "head";
      readonly kind: "owner-head";
      readonly data: { readonly next: number };
    }
  | {
      readonly partition: string;
      readonly id: string;
      readonly kind: "member" | "entry";
      readonly data: { readonly locator: string; readonly sequence: number };
    };

/** Sequences fit twelve decimal digits so entry IDs sort and stay bounded. */
export const MAX_OWNER_SEQUENCE = 999_999_999_999;

export function ownerEntryId(sequence: number): string {
  return `entry:${String(sequence).padStart(12, "0")}`;
}

function validSequence(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_OWNER_SEQUENCE
  );
}

function validateOwner(record: OwnerIndexRecord): void {
  if (!SEGMENT.test(record.partition)) throw new Error("Invalid owner index");
  if (record.kind === "owner-head") {
    if (record.id !== "head" || !validSequence(record.data.next))
      throw new Error("Invalid owner index");
    return;
  }
  if (
    (record.kind !== "member" && record.kind !== "entry") ||
    !SEGMENT.test(record.data.locator) ||
    !validSequence(record.data.sequence) ||
    record.id !==
      (record.kind === "member"
        ? `grant:${record.data.locator}`
        : ownerEntryId(record.data.sequence))
  )
    throw new Error("Invalid owner index");
}

function encodeOwner(record: OwnerIndexRecord): StoredRecord {
  validateOwner(record);
  return record.kind === "owner-head"
    ? {
        schemaVersion: 1,
        recordPartition: record.partition,
        recordId: record.id,
        kind: record.kind,
        next: record.data.next,
      }
    : {
        schemaVersion: 1,
        recordPartition: record.partition,
        recordId: record.id,
        kind: record.kind,
        locator: record.data.locator,
        sequence: record.data.sequence,
      };
}

function decodeOwner(stored: StoredRecord): OwnerIndexRecord {
  const base = ["schemaVersion", "recordPartition", "recordId", "kind"];
  const fields =
    stored.kind === "owner-head"
      ? [...base, "next"]
      : [...base, "locator", "sequence"];
  if (
    stored.schemaVersion !== 1 ||
    typeof stored.recordPartition !== "string" ||
    typeof stored.recordId !== "string" ||
    Object.keys(stored).length !== fields.length ||
    Object.keys(stored).some((key) => !fields.includes(key))
  )
    throw new Error("Invalid owner index");
  const record = (
    stored.kind === "owner-head"
      ? {
          partition: stored.recordPartition,
          id: stored.recordId,
          kind: stored.kind,
          data: { next: stored.next },
        }
      : {
          partition: stored.recordPartition,
          id: stored.recordId,
          kind: stored.kind,
          data: { locator: stored.locator, sequence: stored.sequence },
        }
  ) as OwnerIndexRecord;
  validateOwner(record);
  return record;
}

export const ownerIndexRecords = defineCollection<OwnerIndexRecord>({
  name: "agent-access.owner-index.v1",
  key: (record) => ({ partition: record.partition, id: record.id }),
  codec: { encode: encodeOwner, decode: decodeOwner },
});
