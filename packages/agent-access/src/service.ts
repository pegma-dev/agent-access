import { auditRecordId, defineAudit, type AuditActor } from "@pegma/audit";
import { hasPermission, type AccessContext } from "@pegma/authorization-core";
import {
  MAX_SCAN_PAGE_SIZE,
  type TransactionAction,
  type VersionedRecord,
} from "@pegma/storage-core";
import {
  createCredential,
  deviceLocator,
  generateLocator,
  generateUserCode,
  grantCursorCheck,
  hashCredential,
  normalizeUserCode,
  ownerIndexPartition,
  parseCredential,
  scopeFingerprint,
  verifyPkce,
} from "./crypto.js";
import { OAuthError, type OAuthErrorCode } from "./errors.js";
import {
  agentAccessRecords,
  MAX_OWNER_SEQUENCE,
  ownerEntryId,
  ownerIndexRecords,
  type AgentAccessRecord,
  type GrantHead,
  type OwnerIndexRecord,
} from "./records.js";
import type {
  AgentAccessOptions,
  AgentAccessServicePort,
  ApprovalView,
  ApprovalResult,
  BackfillGrantIndexInput,
  BackfillGrantIndexResult,
  BeginAuthorizationInput,
  BeginDeviceAuthorizationInput,
  BrowserApprovalContext,
  DeviceAuthorizationResult,
  ExchangeAuthorizationCodeInput,
  GrantPage,
  GrantStatus,
  GrantView,
  ListGrantsInput,
  PollDeviceTokenInput,
  RefreshInput,
  TokenResult,
  AuthenticateInput,
  DelegatedAccess,
  RevokeTokenInput,
  ScopeDefinition,
  NormalizedAgentAccessConfiguration,
} from "./types.js";
import {
  captureInput,
  getClient,
  normalizeConfiguration,
  selectScopes,
  validateCodeChallenge,
  validateRedirectUri,
  validateResource,
  validateState,
} from "./validation.js";

interface Instant {
  readonly iso: string;
  readonly milliseconds: number;
}
interface Decision<T> {
  readonly result?: T;
  readonly error?: OAuthError;
  readonly head?: GrantHead;
  readonly action?: string;
  readonly actor?: AuditActor;
  readonly consumed?: string;
  readonly notAfter?: string;
  readonly expiryError?: OAuthErrorCode;
}

const DEFAULT_GRANT_PAGE_SIZE = 20;
const MAX_GRANT_PAGE_SIZE = 100;
const DEFAULT_BACKFILL_PAGE_SIZE = 100;
/** Statuses a listed (approved) grant can hold; denied requests are never listed. */
const GRANT_STATUSES: readonly GrantStatus[] = [
  "pending",
  "active",
  "revoked",
  "expired",
];
const GRANT_CURSOR =
  /^pgc1\.([A-Za-z0-9_-]{43})\.([1-9][0-9]{0,11})\.([A-Za-z0-9_-]{22})$/;
const PRINCIPAL_CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

function plainObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new OAuthError("invalid_request");
  return value as Record<string, unknown>;
}

function onlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new OAuthError("invalid_request");
}

function pageSize(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  )
    throw new OAuthError("invalid_request");
  return value;
}

function locator(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value))
    throw new OAuthError("invalid_grant");
  return value;
}

function at(instant: Instant, seconds: number): string {
  return new Date(instant.milliseconds + seconds * 1_000).toISOString();
}

function names(scopes: readonly ScopeDefinition[]): readonly string[] {
  return scopes.map((scope) => scope.name);
}
function copyScopes(
  scopes: readonly ScopeDefinition[],
): readonly ScopeDefinition[] {
  return scopes.map((scope) => ({
    ...scope,
    permissions: [...scope.permissions],
  }));
}

class AgentAccessService implements AgentAccessServicePort {
  private readonly configuration: NormalizedAgentAccessConfiguration;
  private readonly records;
  private readonly owners;
  private readonly clock;
  private readonly resolvePrincipal;

  constructor(options: AgentAccessOptions) {
    this.configuration = normalizeConfiguration(options.configuration);
    this.records = options.store.collection(agentAccessRecords);
    this.owners = options.store.collection(ownerIndexRecords);
    this.clock = options.clock;
    this.resolvePrincipal = options.resolvePrincipal;
  }

  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof OAuthError) throw error;
      throw new OAuthError("server_error");
    }
  }

  private instant(): Instant {
    const iso = this.clock.now();
    const milliseconds = Date.parse(iso);
    if (!Number.isFinite(milliseconds)) throw new OAuthError("server_error");
    return { iso: new Date(milliseconds).toISOString(), milliseconds };
  }

  private input<T>(value: T): T {
    return captureInput(value, this.configuration.limits.maxInputBytes);
  }

  private async current(
    principalId: string,
    failure: OAuthErrorCode,
  ): Promise<AccessContext> {
    const resolved = await this.resolvePrincipal(principalId);
    if (resolved === null) throw new OAuthError(failure);
    let access: AccessContext;
    try {
      access = this.input(resolved);
    } catch {
      throw new OAuthError("server_error");
    }
    if (
      access.principalId !== principalId ||
      !hasPermission(access, this.configuration.approvalPermission)
    )
      throw new OAuthError(failure);
    return access;
  }

  private async browser(
    context: BrowserApprovalContext,
  ): Promise<AccessContext> {
    if (
      context === null ||
      typeof context !== "object" ||
      context.authentication !== "browser-session" ||
      typeof context.access?.principalId !== "string" ||
      context.access.principalId.length === 0 ||
      !Array.isArray(context.access.permissions) ||
      !hasPermission(context.access, this.configuration.approvalPermission)
    )
      throw new OAuthError("access_denied");
    return this.current(context.access.principalId, "access_denied");
  }

  private async read(
    id: string,
    failure: OAuthErrorCode = "invalid_grant",
  ): Promise<
    VersionedRecord<AgentAccessRecord> & {
      readonly value: Extract<AgentAccessRecord, { kind: "head" }>;
    }
  > {
    const row = await this.records.getVersioned({
      partition: locator(id),
      id: "head",
    });
    if (
      row === null ||
      row.value.kind !== "head" ||
      row.value.partition !== id ||
      row.value.data.locator !== id ||
      row.value.data.issuer !== this.configuration.issuer ||
      row.value.data.resource !== this.configuration.resource
    )
      throw new OAuthError(failure);
    return row as VersionedRecord<AgentAccessRecord> & {
      readonly value: Extract<AgentAccessRecord, { kind: "head" }>;
    };
  }

  private async change<T>(
    id: string,
    decide: (head: GrantHead, instant: Instant) => Promise<Decision<T>>,
    failure: OAuthErrorCode = "invalid_grant",
  ): Promise<T> {
    for (
      let attempt = 0;
      attempt < this.configuration.limits.maxConflictAttempts;
      attempt += 1
    ) {
      const row = await this.read(id, failure);
      const decision = await decide(row.value.data, this.instant());
      const committedAt = this.instant();
      if (
        decision.notAfter !== undefined &&
        committedAt.milliseconds >= Date.parse(decision.notAfter)
      )
        throw new OAuthError(decision.expiryError ?? failure);
      if (decision.head !== undefined) {
        const additions = decision.action === undefined ? 0 : 1;
        const next: GrantHead = {
          ...decision.head,
          generation: row.value.data.generation + 1,
          rows:
            row.value.data.rows +
            additions +
            (decision.consumed === undefined ? 0 : 1),
        };
        const terminal = ["revoked", "expired", "denied"].includes(next.status);
        // Lowering an operational limit must never remove the reserved revocation path.
        if (
          next.rows > (terminal ? 300 : this.configuration.limits.maxRows - 1)
        )
          throw new OAuthError("invalid_grant");
        const actions = [
          {
            action: "putIfUnchanged" as const,
            value: {
              partition: id,
              id: "head" as const,
              kind: "head" as const,
              data: next,
            },
            version: row.version,
          },
        ];
        const extra: TransactionAction<AgentAccessRecord>[] = [];
        if (decision.consumed !== undefined)
          extra.push({
            action: "insert",
            value: {
              partition: id,
              id: `consumed:${decision.consumed}`,
              kind: "consumed",
              data: { hash: decision.consumed },
            },
          });
        if (decision.action !== undefined) {
          const audit = defineAudit<AgentAccessRecord>({
            collection: agentAccessRecords,
            toRecord: (event) => ({
              partition: id,
              id: auditRecordId(event.id),
              kind: "audit",
              data: event,
            }),
            toEvent: (record) => (record.kind === "audit" ? record.data : null),
          });
          extra.push(
            audit.action({
              id: String(next.generation),
              occurredAt: committedAt.iso,
              actor: decision.actor ?? {
                kind: "system",
                systemId: "agent-access",
              },
              action: `agent_access.${decision.action}`,
              subject: id,
              sequence: next.generation,
              details: { clientId: next.clientId, flow: next.flow },
            }),
          );
        }
        // A thrown transaction may already have committed. Never retry it or return a token.
        const outcome = await this.records.transact(id, [...actions, ...extra]);
        if (!outcome.committed) continue;
      }
      if (decision.error !== undefined) throw decision.error;
      return decision.result as T;
    }
    throw new OAuthError("server_error");
  }

  private terminal<T>(
    head: GrantHead,
    status: "revoked" | "expired",
    code: OAuthErrorCode,
    action: string,
  ): Decision<T> {
    return { head: { ...head, status }, action, error: new OAuthError(code) };
  }

  private view(head: GrantHead): ApprovalView {
    if (!["pending", "approved", "denied"].includes(head.status))
      throw new OAuthError("invalid_grant");
    return {
      requestId: head.locator,
      flow: head.flow,
      status: head.status as ApprovalView["status"],
      clientId: head.clientId,
      clientName: head.clientName,
      resource: head.resource,
      requestedScopes: copyScopes(head.requestedScopes),
      expiresAt: head.requestExpiresAt,
    };
  }

  private pending(head: GrantHead, instant: Instant): void {
    if (instant.milliseconds >= Date.parse(head.requestExpiresAt))
      throw new OAuthError("expired_token");
    if (head.status !== "pending") throw new OAuthError("invalid_grant");
  }

  private async validConsent(
    head: GrantHead,
    failure: OAuthErrorCode,
  ): Promise<readonly ScopeDefinition[]> {
    try {
      if (
        head.issuer !== this.configuration.issuer ||
        head.resource !== this.configuration.resource ||
        head.approvedScopes === undefined ||
        head.consentFingerprint === undefined
      )
        throw new OAuthError(failure);
      const client = getClient(this.configuration, head.clientId, head.flow);
      if (head.redirectUri !== undefined)
        validateRedirectUri(this.configuration, client, head.redirectUri);
      const scopes = selectScopes(
        this.configuration,
        client,
        head.approvedScopes,
      );
      if ((await scopeFingerprint(scopes)) !== head.consentFingerprint)
        throw new OAuthError(failure);
      return scopes;
    } catch (error) {
      if (error instanceof OAuthError) throw new OAuthError(failure);
      throw error;
    }
  }

  private owner(head: GrantHead, access: AccessContext): void {
    if (head.ownerId !== access.principalId)
      throw new OAuthError("access_denied");
  }

  private ownerPartition(ownerId: string): Promise<string> {
    return ownerIndexPartition(
      this.configuration.issuer,
      this.configuration.resource,
      ownerId,
    );
  }

  /**
   * Write-ahead owner index. It commits in the owner's partition before the
   * grant approval commits in the grant's partition; the two are never claimed
   * to be atomic. A dangling entry (approval later refused or lost) is harmless
   * because listing re-reads the authoritative grant head and its owner.
   * Returns true when this call added the entry.
   */
  private async indexGrant(ownerId: string, grantId: string): Promise<boolean> {
    const partition = await this.ownerPartition(ownerId);
    for (
      let attempt = 0;
      attempt < this.configuration.limits.maxConflictAttempts;
      attempt += 1
    ) {
      const member = await this.owners.get({
        partition,
        id: `grant:${grantId}`,
      });
      if (member !== null) {
        if (member.kind !== "member" || member.data.locator !== grantId)
          throw new OAuthError("server_error");
        return false;
      }
      const head = await this.owners.getVersioned({ partition, id: "head" });
      if (head !== null && head.value.kind !== "owner-head")
        throw new OAuthError("server_error");
      const previous =
        head === null || head.value.kind !== "owner-head"
          ? 0
          : head.value.data.next;
      const sequence = previous + 1;
      if (sequence > MAX_OWNER_SEQUENCE) throw new OAuthError("server_error");
      const ownerHead: OwnerIndexRecord = {
        partition,
        id: "head",
        kind: "owner-head",
        data: { next: sequence },
      };
      // One owner-partition transaction: the head, membership, and entry agree.
      const outcome = await this.owners.transact(partition, [
        head === null
          ? { action: "insert", value: ownerHead }
          : {
              action: "putIfUnchanged",
              value: ownerHead,
              version: head.version,
            },
        {
          action: "insert",
          value: {
            partition,
            id: `grant:${grantId}`,
            kind: "member",
            data: { locator: grantId, sequence },
          },
        },
        {
          action: "insert",
          value: {
            partition,
            id: ownerEntryId(sequence),
            kind: "entry",
            data: { locator: grantId, sequence },
          },
        },
      ]);
      if (outcome.committed) return true;
    }
    throw new OAuthError("server_error");
  }

  /** The single safe public projection of a grant head; never credential hashes. */
  private grantView(head: GrantHead, instant: Instant): GrantView {
    const expired = instant.milliseconds >= Date.parse(head.expiresAt);
    return {
      grantId: head.locator,
      clientId: head.clientId,
      ownerId: head.ownerId as string,
      resource: head.resource,
      scopes: copyScopes(
        head.requestedScopes.filter((scope) =>
          head.approvedScopes?.includes(scope.name),
        ),
      ),
      status:
        head.status === "revoked" ||
        head.status === "denied" ||
        head.status === "expired"
          ? head.status
          : expired
            ? "expired"
            : head.status === "active"
              ? "active"
              : "pending",
      createdAt: head.createdAt,
      expiresAt: head.expiresAt,
    };
  }

  private async cursor(partition: string, position: number): Promise<string> {
    return `pgc1.${partition}.${position}.${await grantCursorCheck(partition, position)}`;
  }

  private async position(partition: string, value: unknown): Promise<number> {
    if (typeof value !== "string" || value.length > 128)
      throw new OAuthError("invalid_request");
    const match = GRANT_CURSOR.exec(value);
    if (
      match === null ||
      match[1] !== partition ||
      match[3] !== (await grantCursorCheck(partition, Number(match[2])))
    )
      throw new OAuthError("invalid_request");
    return Number(match[2]);
  }

  private currentlyPermitted(
    scopes: readonly ScopeDefinition[],
    current: AccessContext,
  ): readonly string[] {
    const selected = scopes.filter((scope) =>
      scope.permissions.every(
        (permission) =>
          permission !== this.configuration.approvalPermission &&
          hasPermission(current, permission),
      ),
    );
    if (selected.length === 0) throw new OAuthError("invalid_scope");
    return names(selected);
  }

  private async create(head: GrantHead, instant: Instant): Promise<boolean> {
    const audit = defineAudit<AgentAccessRecord>({
      collection: agentAccessRecords,
      toRecord: (event) => ({
        partition: head.locator,
        id: auditRecordId(event.id),
        kind: "audit",
        data: event,
      }),
      toEvent: (record) => (record.kind === "audit" ? record.data : null),
    });
    const outcome = await this.records.transact(head.locator, [
      {
        action: "insert",
        value: {
          partition: head.locator,
          id: "head",
          kind: "head",
          data: head,
        },
      },
      audit.action({
        id: "1",
        occurredAt: instant.iso,
        actor:
          head.ownerId === undefined
            ? { kind: "system", systemId: "agent-access" }
            : { kind: "principal", principalId: head.ownerId },
        action: "agent_access.requested",
        subject: head.locator,
        sequence: 1,
        details: { clientId: head.clientId, flow: head.flow },
      }),
    ]);
    return outcome.committed;
  }

  beginDeviceAuthorization(
    input: BeginDeviceAuthorizationInput,
  ): Promise<DeviceAuthorizationResult> {
    return this.guarded(async () => {
      const request = this.input(input);
      const instant = this.instant();
      const client = getClient(
        this.configuration,
        request.clientId,
        "device_code",
      );
      const resource = validateResource(this.configuration, request.resource);
      const scopes = selectScopes(this.configuration, client, request.scopes);
      for (
        let attempt = 0;
        attempt < this.configuration.limits.maxConflictAttempts;
        attempt += 1
      ) {
        const userCode = generateUserCode();
        const id = await deviceLocator(userCode);
        const deviceCode = createCredential("device", id);
        const expiresAt = at(
          instant,
          this.configuration.limits.deviceLifetimeSeconds,
        );
        const head: GrantHead = {
          locator: id,
          flow: "device_code",
          status: "pending",
          generation: 1,
          rows: 2,
          createdAt: instant.iso,
          requestExpiresAt: expiresAt,
          expiresAt,
          clientId: client.clientId,
          clientName: client.name,
          issuer: this.configuration.issuer,
          resource,
          requestedScopes: scopes,
          deviceHash: await hashCredential(deviceCode),
          intervalSeconds: this.configuration.limits.pollIntervalSeconds,
          nextPollAt: instant.iso,
          rotations: 0,
        };
        if (!(await this.create(head, instant))) continue;
        const complete = new URL(this.configuration.endpoints.verification);
        complete.searchParams.set("user_code", userCode);
        return {
          device_code: deviceCode,
          user_code: userCode,
          verification_uri: this.configuration.endpoints.verification,
          verification_uri_complete: complete.href,
          expires_in: this.configuration.limits.deviceLifetimeSeconds,
          interval: head.intervalSeconds,
        };
      }
      throw new OAuthError("server_error");
    });
  }

  beginAuthorization(
    context: BrowserApprovalContext,
    input: BeginAuthorizationInput,
  ): Promise<ApprovalView> {
    return this.guarded(async () => {
      const browser = this.input(context);
      const request = this.input(input);
      const client = getClient(
        this.configuration,
        request.clientId,
        "authorization_code",
      );
      const resource = validateResource(this.configuration, request.resource);
      const scopes = selectScopes(this.configuration, client, request.scopes);
      const redirectUri = validateRedirectUri(
        this.configuration,
        client,
        request.redirectUri,
      );
      const codeChallenge = validateCodeChallenge(
        request.codeChallenge,
        request.codeChallengeMethod,
      );
      const state = validateState(request.state);
      const access = await this.browser(browser);
      for (
        let attempt = 0;
        attempt < this.configuration.limits.maxConflictAttempts;
        attempt += 1
      ) {
        const createdAt = this.instant();
        const expiresAt = at(
          createdAt,
          this.configuration.limits.authRequestLifetimeSeconds,
        );
        const head: GrantHead = {
          locator: generateLocator(),
          flow: "authorization_code",
          status: "pending",
          generation: 1,
          rows: 2,
          createdAt: createdAt.iso,
          requestExpiresAt: expiresAt,
          expiresAt,
          clientId: client.clientId,
          clientName: client.name,
          issuer: this.configuration.issuer,
          resource,
          requestedScopes: scopes,
          ownerId: access.principalId,
          redirectUri,
          codeChallenge,
          ...(state === undefined ? {} : { state }),
          intervalSeconds: 0,
          nextPollAt: createdAt.iso,
          rotations: 0,
        };
        if (await this.create(head, createdAt)) return this.view(head);
      }
      throw new OAuthError("server_error");
    });
  }

  getDeviceApproval(
    context: BrowserApprovalContext,
    userCode: string,
  ): Promise<ApprovalView> {
    return this.guarded(async () => {
      const browser = this.input(context);
      const code = this.input(userCode);
      const id = await deviceLocator(code);
      await this.browser(browser);
      const head = (await this.read(id)).value.data;
      if (head.flow !== "device_code") throw new OAuthError("invalid_grant");
      if (this.instant().milliseconds >= Date.parse(head.requestExpiresAt))
        throw new OAuthError("expired_token");
      return this.view(head);
    });
  }

  getAuthorizationApproval(
    context: BrowserApprovalContext,
    requestId: string,
  ): Promise<ApprovalView> {
    return this.guarded(async () => {
      const browser = this.input(context);
      const id = locator(this.input(requestId));
      const access = await this.browser(browser);
      const head = (await this.read(id)).value.data;
      if (head.flow !== "authorization_code")
        throw new OAuthError("invalid_grant");
      this.owner(head, access);
      if (this.instant().milliseconds >= Date.parse(head.requestExpiresAt))
        throw new OAuthError("expired_token");
      return this.view(head);
    });
  }

  approve(
    context: BrowserApprovalContext,
    input: import("./types.js").ApproveInput,
  ): Promise<ApprovalResult> {
    return this.guarded(async () => {
      const browser = this.input(context);
      const request = this.input(input);
      const id = locator(request.requestId);
      if (request.decision !== "approve" && request.decision !== "deny")
        throw new OAuthError("invalid_request");
      // Hash the human entry before reads; the grant ID alone cannot approve a device.
      const humanId =
        request.userCode === undefined
          ? undefined
          : await deviceLocator(normalizeUserCode(request.userCode));
      return this.change(
        id,
        async (head): Promise<Decision<ApprovalResult>> => {
          const access = await this.browser(browser);
          if (head.flow === "authorization_code") this.owner(head, access);
          else if (humanId !== id) throw new OAuthError("invalid_grant");
          this.pending(head, this.instant());
          const client = getClient(
            this.configuration,
            head.clientId,
            head.flow,
          );
          const currentRequested = selectScopes(
            this.configuration,
            client,
            names(head.requestedScopes),
          );
          if (
            (await scopeFingerprint(currentRequested)) !==
            (await scopeFingerprint(head.requestedScopes))
          )
            throw new OAuthError("invalid_scope");
          if (head.redirectUri !== undefined)
            validateRedirectUri(this.configuration, client, head.redirectUri);
          validateResource(this.configuration, head.resource);
          const actor: AuditActor = {
            kind: "principal",
            principalId: access.principalId,
          };
          if (request.decision === "deny") {
            if (head.flow === "device_code")
              return {
                head: {
                  ...head,
                  ownerId: access.principalId,
                  status: "denied",
                },
                actor,
                action: "denied",
                notAfter: head.requestExpiresAt,
                expiryError: "expired_token",
                result: { flow: "device_code", approved: false },
              };
            const redirect = new URL(head.redirectUri as string);
            redirect.searchParams.set("error", "access_denied");
            redirect.searchParams.set("iss", this.configuration.issuer);
            if (head.state !== undefined)
              redirect.searchParams.set("state", head.state);
            return {
              head: { ...head, status: "denied" },
              actor,
              action: "denied",
              notAfter: head.requestExpiresAt,
              expiryError: "expired_token",
              result: {
                flow: "authorization_code",
                redirectUri: redirect.href,
              },
            };
          }
          const approved = selectScopes(
            this.configuration,
            client,
            request.approvedScopes ?? names(head.requestedScopes),
          );
          if (
            approved.some(
              (scope) =>
                !head.requestedScopes.some(
                  (requested) => requested.name === scope.name,
                ),
            )
          )
            throw new OAuthError("invalid_scope");
          const next: GrantHead = {
            ...head,
            ownerId: access.principalId,
            status: "approved",
            approvedScopes: names(approved),
            consentFingerprint: await scopeFingerprint(approved),
          };
          // Index first: a committed approval always has its owner entry.
          await this.indexGrant(access.principalId, id);
          if (head.flow === "device_code")
            return {
              head: next,
              actor,
              action: "approved",
              notAfter: head.requestExpiresAt,
              expiryError: "expired_token",
              result: { flow: "device_code", approved: true },
            };
          const code = createCredential("authorization", id);
          const redirect = new URL(head.redirectUri as string);
          redirect.searchParams.set("code", code);
          redirect.searchParams.set("iss", this.configuration.issuer);
          if (head.state !== undefined)
            redirect.searchParams.set("state", head.state);
          const codeExpiresAt = at(
            this.instant(),
            this.configuration.limits.codeLifetimeSeconds,
          );
          return {
            head: {
              ...next,
              codeHash: await hashCredential(code),
              codeExpiresAt,
              expiresAt: codeExpiresAt,
            },
            actor,
            action: "approved",
            notAfter: head.requestExpiresAt,
            expiryError: "expired_token",
            result: { flow: "authorization_code", redirectUri: redirect.href },
          };
        },
      );
    });
  }

  private async mint(
    head: GrantHead,
    instant: Instant,
    selected: readonly string[],
    refresh = false,
  ): Promise<{ readonly head: GrantHead; readonly result: TokenResult }> {
    const expiresAt = refresh
      ? head.expiresAt
      : at(instant, this.configuration.limits.refreshFamilyLifetimeSeconds);
    const accessExpiresAt = new Date(
      Math.min(
        Date.parse(expiresAt),
        instant.milliseconds +
          this.configuration.limits.accessLifetimeSeconds * 1_000,
      ),
    ).toISOString();
    const expiresIn = Math.floor(
      (Date.parse(accessExpiresAt) - instant.milliseconds) / 1_000,
    );
    // An absolute family deadline never permits a zero-lifetime successor.
    if (expiresIn < 1) throw new OAuthError("invalid_grant");
    const accessToken = createCredential("access", head.locator);
    const refreshToken = createCredential("refresh", head.locator);
    return {
      head: {
        ...head,
        status: "active",
        expiresAt,
        accessHash: await hashCredential(accessToken),
        accessScopes: [...selected],
        accessExpiresAt,
        refreshHash: await hashCredential(refreshToken),
        rotations: refresh ? head.rotations + 1 : 0,
      },
      result: {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: expiresIn,
        refresh_token: refreshToken,
        scope: selected.join(" "),
      },
    };
  }

  exchangeAuthorizationCode(
    input: ExchangeAuthorizationCodeInput,
  ): Promise<TokenResult> {
    return this.guarded(async () => {
      const request = this.input(input);
      getClient(this.configuration, request.clientId, "authorization_code");
      validateResource(this.configuration, request.resource);
      const parsed = parseCredential(request.code);
      if (parsed?.kind !== "authorization")
        throw new OAuthError("invalid_grant");
      const hash = await hashCredential(request.code);
      return this.change(
        parsed.locator,
        async (head, attemptAt): Promise<Decision<TokenResult>> => {
          if (
            head.flow !== "authorization_code" ||
            head.codeHash !== hash ||
            head.clientId !== request.clientId ||
            head.resource !== request.resource ||
            head.redirectUri !== request.redirectUri ||
            head.status !== "approved"
          )
            throw new OAuthError("invalid_grant");
          if (
            head.codeExpiresAt === undefined ||
            attemptAt.milliseconds >= Date.parse(head.codeExpiresAt)
          )
            return this.terminal(head, "expired", "invalid_grant", "expired");
          if (
            !(await verifyPkce(
              request.codeVerifier,
              head.codeChallenge as string,
            ))
          )
            throw new OAuthError("invalid_grant");
          const consent = await this.validConsent(head, "invalid_grant");
          const current = await this.current(
            head.ownerId as string,
            "invalid_grant",
          );
          const issuedAt = this.instant();
          if (issuedAt.milliseconds >= Date.parse(head.codeExpiresAt))
            return this.terminal(head, "expired", "invalid_grant", "expired");
          return {
            ...(await this.mint(
              head,
              issuedAt,
              this.currentlyPermitted(consent, current),
            )),
            action: "issued",
            notAfter: head.codeExpiresAt,
          };
        },
      );
    });
  }

  pollDeviceToken(input: PollDeviceTokenInput): Promise<TokenResult> {
    return this.guarded(async () => {
      const request = this.input(input);
      getClient(this.configuration, request.clientId, "device_code");
      validateResource(this.configuration, request.resource);
      const parsed = parseCredential(request.deviceCode);
      if (parsed?.kind !== "device") throw new OAuthError("invalid_grant");
      const hash = await hashCredential(request.deviceCode);
      return this.change(
        parsed.locator,
        async (head, attemptAt): Promise<Decision<TokenResult>> => {
          if (
            head.flow !== "device_code" ||
            head.deviceHash !== hash ||
            head.clientId !== request.clientId ||
            head.resource !== request.resource
          )
            throw new OAuthError("invalid_grant");
          if (head.status === "expired") throw new OAuthError("expired_token");
          if (!["pending", "approved", "denied"].includes(head.status))
            throw new OAuthError("invalid_grant");
          if (attemptAt.milliseconds >= Date.parse(head.requestExpiresAt))
            return this.terminal(head, "expired", "expired_token", "expired");
          if (head.status === "denied") throw new OAuthError("access_denied");
          if (attemptAt.milliseconds < Date.parse(head.nextPollAt)) {
            // Lifetime bounds this counter; every early poll permanently increases the interval.
            const intervalSeconds = Math.min(
              this.configuration.limits.deviceLifetimeSeconds + 5,
              head.intervalSeconds + 5,
            );
            return {
              head: {
                ...head,
                intervalSeconds,
                nextPollAt: at(attemptAt, intervalSeconds),
              },
              notAfter: head.requestExpiresAt,
              expiryError: "expired_token",
              error: new OAuthError("slow_down"),
            };
          }
          if (head.status === "pending")
            return {
              head: {
                ...head,
                nextPollAt: at(attemptAt, head.intervalSeconds),
              },
              notAfter: head.requestExpiresAt,
              expiryError: "expired_token",
              error: new OAuthError("authorization_pending"),
            };
          const consent = await this.validConsent(head, "invalid_grant");
          const current = await this.current(
            head.ownerId as string,
            "invalid_grant",
          );
          const issuedAt = this.instant();
          if (issuedAt.milliseconds >= Date.parse(head.requestExpiresAt))
            return this.terminal(head, "expired", "expired_token", "expired");
          return {
            ...(await this.mint(
              head,
              issuedAt,
              this.currentlyPermitted(consent, current),
            )),
            action: "issued",
            notAfter: head.requestExpiresAt,
            expiryError: "expired_token",
          };
        },
      );
    });
  }

  refresh(input: RefreshInput): Promise<TokenResult> {
    return this.guarded(async () => {
      const request = this.input(input);
      getClient(this.configuration, request.clientId);
      validateResource(this.configuration, request.resource);
      const parsed = parseCredential(request.refreshToken);
      if (parsed?.kind !== "refresh") throw new OAuthError("invalid_grant");
      const hash = await hashCredential(request.refreshToken);
      return this.change(
        parsed.locator,
        async (head, attemptAt): Promise<Decision<TokenResult>> => {
          if (
            head.clientId !== request.clientId ||
            head.resource !== request.resource ||
            head.status !== "active"
          )
            throw new OAuthError("invalid_grant");
          if (head.refreshHash !== hash) {
            const consumed = await this.records.get({
              partition: parsed.locator,
              id: `consumed:${hash}`,
            });
            if (consumed?.kind === "consumed" && consumed.data.hash === hash)
              return this.terminal(
                head,
                "revoked",
                "invalid_grant",
                "refresh_reuse_revoked",
              );
            throw new OAuthError("invalid_grant");
          }
          if (attemptAt.milliseconds >= Date.parse(head.expiresAt))
            return this.terminal(head, "expired", "invalid_grant", "expired");
          const consent = await this.validConsent(head, "invalid_grant");
          const current = await this.current(
            head.ownerId as string,
            "invalid_grant",
          );
          const selected =
            request.scopes === undefined
              ? names(consent)
              : names(
                  selectScopes(
                    this.configuration,
                    getClient(this.configuration, head.clientId),
                    request.scopes,
                  ),
                );
          if (selected.some((scope) => !head.approvedScopes?.includes(scope)))
            throw new OAuthError("invalid_scope");
          if (
            head.rotations >= this.configuration.limits.maxRotations ||
            head.rows + 2 > this.configuration.limits.maxRows - 1
          )
            return this.terminal(
              head,
              "revoked",
              "invalid_grant",
              "capacity_revoked",
            );
          const usable = this.currentlyPermitted(
            consent.filter((scope) => selected.includes(scope.name)),
            current,
          );
          const issuedAt = this.instant();
          if (issuedAt.milliseconds >= Date.parse(head.expiresAt))
            return this.terminal(head, "expired", "invalid_grant", "expired");
          return {
            ...(await this.mint(head, issuedAt, usable, true)),
            consumed: hash,
            action: "refreshed",
            notAfter: head.expiresAt,
          };
        },
      );
    });
  }

  authenticate(input: AuthenticateInput): Promise<DelegatedAccess> {
    return this.guarded(async () => {
      const request = this.input(input);
      const instant = this.instant();
      validateResource(this.configuration, request.resource);
      const parsed = parseCredential(request.token);
      if (parsed?.kind !== "access") throw new OAuthError("invalid_token");
      const hash = await hashCredential(request.token);
      const row = await this.read(parsed.locator, "invalid_token");
      const head = row.value.data;
      if (
        head.status !== "active" ||
        head.accessHash !== hash ||
        head.resource !== request.resource ||
        head.accessExpiresAt === undefined ||
        instant.milliseconds >= Date.parse(head.accessExpiresAt) ||
        instant.milliseconds >= Date.parse(head.expiresAt)
      )
        throw new OAuthError("invalid_token");
      const consent = await this.validConsent(head, "invalid_token");
      const current = await this.current(
        head.ownerId as string,
        "invalid_token",
      );
      const accessScopes = head.accessScopes as readonly string[];
      const selected = consent.filter((scope) =>
        accessScopes.includes(scope.name),
      );
      const permitted = new Set(
        selected.flatMap((scope) => [...scope.permissions]),
      );
      const permissions = current.permissions.filter(
        (permission) =>
          permission !== this.configuration.approvalPermission &&
          permitted.has(permission),
      );
      if (request.requiredScopes !== undefined) {
        if (
          !Array.isArray(request.requiredScopes) ||
          new Set(request.requiredScopes).size !==
            request.requiredScopes.length ||
          request.requiredScopes.length > this.configuration.limits.maxScopes ||
          request.requiredScopes.some(
            (name) =>
              typeof name !== "string" ||
              !accessScopes.includes(name) ||
              !selected
                .find((scope) => scope.name === name)
                ?.permissions.every((permission) =>
                  permissions.includes(permission),
                ),
          )
        )
          throw new OAuthError("insufficient_scope");
      }
      // Fence an overlapping token rotation/revocation after the external authority read.
      const latest = await this.read(parsed.locator, "invalid_token");
      if (latest.version !== row.version) throw new OAuthError("invalid_token");
      const completedAt = this.instant();
      if (
        completedAt.milliseconds >= Date.parse(head.accessExpiresAt) ||
        completedAt.milliseconds >= Date.parse(head.expiresAt)
      )
        throw new OAuthError("invalid_token");
      return {
        grantId: head.locator,
        clientId: head.clientId,
        resource: head.resource,
        scopes: [...accessScopes],
        access: {
          principalId: current.principalId,
          policyVersion: current.policyVersion,
          roles: [],
          entitlements: [],
          permissions,
        },
      };
    });
  }

  revokeToken(input: RevokeTokenInput): Promise<void> {
    return this.guarded(async () => {
      const request = this.input(input);
      getClient(this.configuration, request.clientId);
      if (
        request.tokenTypeHint !== undefined &&
        request.tokenTypeHint !== "access_token" &&
        request.tokenTypeHint !== "refresh_token"
      )
        throw new OAuthError("invalid_request");
      const parsed = parseCredential(request.token);
      if (
        parsed === null ||
        (parsed.kind !== "access" && parsed.kind !== "refresh")
      )
        return;
      const hash = await hashCredential(request.token);
      const existing = await this.records.get({
        partition: parsed.locator,
        id: "head",
      });
      if (
        existing?.kind !== "head" ||
        existing.data.issuer !== this.configuration.issuer ||
        existing.data.resource !== this.configuration.resource
      )
        return;
      await this.change(
        parsed.locator,
        async (head): Promise<Decision<void>> => {
          if (
            head.clientId !== request.clientId ||
            ["revoked", "expired", "denied"].includes(head.status)
          )
            return {};
          let recognized =
            parsed.kind === "access"
              ? head.accessHash === hash
              : head.refreshHash === hash;
          if (!recognized && parsed.kind === "refresh") {
            const consumed = await this.records.get({
              partition: parsed.locator,
              id: `consumed:${hash}`,
            });
            recognized =
              consumed?.kind === "consumed" && consumed.data.hash === hash;
          }
          if (!recognized) return {};
          return {
            head: { ...head, status: "revoked" },
            action: "token_revoked",
          };
        },
      );
    });
  }

  getGrant(
    context: BrowserApprovalContext,
    grantId: string,
  ): Promise<GrantView> {
    return this.guarded(async () => {
      const browser = this.input(context);
      const id = locator(this.input(grantId));
      const access = await this.browser(browser);
      const head = (await this.read(id)).value.data;
      this.owner(head, access);
      return this.grantView(head, this.instant());
    });
  }

  listGrants(
    context: BrowserApprovalContext,
    input: ListGrantsInput,
  ): Promise<GrantPage> {
    return this.guarded(async () => {
      const browser = this.input(context);
      const request = plainObject(this.input(input));
      onlyKeys(request, ["ownerPrincipal", "cursor", "limit", "statuses"]);
      const ownerId = request.ownerPrincipal;
      if (
        typeof ownerId !== "string" ||
        ownerId.length === 0 ||
        ownerId.length > 512 ||
        PRINCIPAL_CONTROL.test(ownerId)
      )
        throw new OAuthError("invalid_request");
      const limit = pageSize(
        request.limit,
        DEFAULT_GRANT_PAGE_SIZE,
        MAX_GRANT_PAGE_SIZE,
      );
      let statuses: ReadonlySet<GrantStatus> | undefined;
      if (request.statuses !== undefined) {
        const selected: unknown = request.statuses;
        if (
          !Array.isArray(selected) ||
          selected.length === 0 ||
          selected.length > GRANT_STATUSES.length ||
          new Set(selected).size !== selected.length ||
          selected.some((status) => !GRANT_STATUSES.includes(status))
        )
          throw new OAuthError("invalid_request");
        statuses = new Set(selected as GrantStatus[]);
      }
      const access = await this.browser(browser);
      // Strictly owner-scoped: the trusted session must be the listed owner.
      if (access.principalId !== ownerId) throw new OAuthError("access_denied");
      const partition = await this.ownerPartition(ownerId);
      const requested =
        request.cursor === undefined
          ? undefined
          : await this.position(partition, request.cursor);
      const head = await this.owners.get({ partition, id: "head" });
      if (head === null) return { grants: [], nextCursor: null };
      if (head.kind !== "owner-head") throw new OAuthError("server_error");
      // Newest first; a cursor never reaches past the current owner head.
      const upper = Math.min(requested ?? head.data.next, head.data.next);
      const lowest = Math.max(1, upper - limit + 1);
      const sequences: number[] = [];
      for (let sequence = upper; sequence >= lowest; sequence -= 1)
        sequences.push(sequence);
      const entries = await Promise.all(
        sequences.map((sequence) =>
          this.owners.get({ partition, id: ownerEntryId(sequence) }),
        ),
      );
      const located = [
        ...new Set(
          entries.flatMap((entry) =>
            entry?.kind === "entry" ? [entry.data.locator] : [],
          ),
        ),
      ];
      const heads = await Promise.all(
        located.map((grantId) =>
          this.records.get({ partition: grantId, id: "head" }),
        ),
      );
      const instant = this.instant();
      const grants: GrantView[] = [];
      for (const [index, record] of heads.entries()) {
        const grantId = located[index];
        // Missing (removed by retention) or foreign heads are skipped, never surfaced.
        if (
          record === null ||
          record.kind !== "head" ||
          record.partition !== grantId ||
          record.data.locator !== grantId ||
          record.data.issuer !== this.configuration.issuer ||
          record.data.resource !== this.configuration.resource ||
          record.data.ownerId !== ownerId ||
          record.data.approvedScopes === undefined
        )
          continue;
        const view = this.grantView(record.data, instant);
        if (statuses === undefined || statuses.has(view.status))
          grants.push(view);
      }
      return {
        grants,
        nextCursor:
          lowest > 1 ? await this.cursor(partition, lowest - 1) : null,
      };
    });
  }

  backfillGrantIndex(
    input: BackfillGrantIndexInput = {},
  ): Promise<BackfillGrantIndexResult> {
    return this.guarded(async () => {
      const request = plainObject(this.input(input));
      onlyKeys(request, ["cursor", "limit"]);
      const limit = pageSize(
        request.limit,
        DEFAULT_BACKFILL_PAGE_SIZE,
        MAX_SCAN_PAGE_SIZE,
      );
      const cursor = request.cursor;
      // Adapter continuations are opaque; captureInput already bounds their size.
      if (
        cursor !== undefined &&
        (typeof cursor !== "string" || cursor.length === 0)
      )
        throw new OAuthError("invalid_request");
      const page = await this.records.scan({
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      });
      let indexed = 0;
      for (const { key, value } of page.records) {
        if (
          value.kind !== "head" ||
          key.id !== "head" ||
          key.partition !== value.partition ||
          value.data.locator !== value.partition ||
          value.data.issuer !== this.configuration.issuer ||
          value.data.resource !== this.configuration.resource ||
          value.data.ownerId === undefined ||
          value.data.approvedScopes === undefined
        )
          continue;
        // Sequential and idempotent: reruns and concurrent approvals never duplicate.
        if (await this.indexGrant(value.data.ownerId, value.partition))
          indexed += 1;
      }
      return {
        scanned: page.records.length,
        indexed,
        nextCursor: page.nextCursor,
      };
    });
  }

  revokeGrant(context: BrowserApprovalContext, grantId: string): Promise<void> {
    return this.guarded(async () => {
      const browser = this.input(context);
      const id = locator(this.input(grantId));
      await this.change(id, async (head): Promise<Decision<void>> => {
        const access = await this.browser(browser);
        this.owner(head, access);
        if (
          head.status === "revoked" ||
          head.status === "denied" ||
          head.status === "expired"
        )
          return {};
        return {
          head: { ...head, status: "revoked" },
          action: "owner_revoked",
          actor: { kind: "principal", principalId: access.principalId },
        };
      });
    });
  }
}

export function createAgentAccess(
  options: AgentAccessOptions,
): AgentAccessServicePort {
  return new AgentAccessService(options);
}
