import type { AccessContext } from "@pegma/authorization-core";
import type { Clock, IsoTimestamp, PrincipalId } from "@pegma/spine";
import type { Store } from "@pegma/storage-core";

export type GrantType = "device_code" | "authorization_code";

/** Host-owned versioned mapping. A changed selected definition needs consent again. */
export interface ScopeDefinition {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly permissions: readonly string[];
}

/** Public clients never possess or submit client secrets. */
export interface PublicClient {
  readonly clientId: string;
  readonly name: string;
  readonly redirectUris: readonly string[];
  readonly allowedScopes: readonly string[];
  readonly grantTypes: readonly GrantType[];
}

export interface AgentAccessEndpoints {
  readonly authorize: string;
  readonly deviceAuthorization: string;
  readonly token: string;
  readonly revocation: string;
  readonly verification: string;
  readonly approval: string;
  readonly resourceMetadata: string;
}

export interface AgentAccessLimits {
  readonly deviceLifetimeSeconds: number;
  readonly authRequestLifetimeSeconds: number;
  readonly codeLifetimeSeconds: number;
  readonly accessLifetimeSeconds: number;
  readonly refreshFamilyLifetimeSeconds: number;
  readonly pollIntervalSeconds: number;
  readonly maxRotations: number;
  readonly maxRows: number;
  readonly maxInputBytes: number;
  readonly maxScopes: number;
  readonly maxConflictAttempts: number;
}

export interface AgentAccessConfiguration {
  readonly issuer: string;
  readonly resource: string;
  readonly endpoints: AgentAccessEndpoints;
  /** Normally agent.access.link; the host maps this exclusively to administrators. */
  readonly approvalPermission: string;
  readonly clients: readonly PublicClient[];
  readonly scopes: readonly ScopeDefinition[];
  readonly limits?: Partial<AgentAccessLimits>;
  /** Enables HTTP only for loopback hosts in a local test harness. */
  readonly allowInsecureLoopback?: boolean;
}

export interface NormalizedAgentAccessConfiguration extends AgentAccessConfiguration {
  readonly limits: AgentAccessLimits;
  readonly allowInsecureLoopback: boolean;
}

/** Only a trusted host browser session plus CSRF/origin validation can produce this. */
export interface BrowserApprovalContext {
  readonly authentication: "browser-session";
  readonly access: AccessContext;
}

export interface AgentAccessOptions {
  readonly configuration: AgentAccessConfiguration;
  readonly store: Store;
  readonly clock: Clock;
  /** Current authority only; inactive principals return null and failures reject. */
  readonly resolvePrincipal: (
    principalId: PrincipalId,
  ) => Promise<AccessContext | null>;
}

export interface BeginDeviceAuthorizationInput {
  readonly clientId: string;
  readonly resource: string;
  readonly scopes: readonly string[];
}

export interface DeviceAuthorizationResult {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete: string;
  readonly expires_in: number;
  readonly interval: number;
}

export interface BeginAuthorizationInput extends BeginDeviceAuthorizationInput {
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: "S256";
  readonly state?: string;
}

/** Credential-free, safe approval UI model. Never render submitted URLs as links. */
export interface ApprovalView {
  readonly requestId: string;
  readonly flow: GrantType;
  readonly status: "pending" | "approved" | "denied";
  readonly clientId: string;
  readonly clientName: string;
  readonly resource: string;
  readonly requestedScopes: readonly ScopeDefinition[];
  readonly expiresAt: IsoTimestamp;
}

export interface ApproveInput {
  readonly requestId: string;
  readonly decision: "approve" | "deny";
  readonly approvedScopes?: readonly string[];
  /** Required for a device request, proving the human entered the displayed code. */
  readonly userCode?: string;
}

export type ApprovalResult =
  | { readonly flow: "authorization_code"; readonly redirectUri: string }
  | { readonly flow: "device_code"; readonly approved: boolean };

export interface ExchangeAuthorizationCodeInput {
  readonly clientId: string;
  readonly resource: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
}

export interface PollDeviceTokenInput {
  readonly clientId: string;
  readonly resource: string;
  readonly deviceCode: string;
}

export interface RefreshInput {
  readonly clientId: string;
  readonly resource: string;
  readonly refreshToken: string;
  /** Narrows this access token only; never changes the family's consent snapshot. */
  readonly scopes?: readonly string[];
}

export interface TokenResult {
  readonly access_token: string;
  readonly token_type: "Bearer";
  readonly expires_in: number;
  readonly refresh_token: string;
  readonly scope: string;
}

export interface AuthenticateInput {
  readonly token: string;
  readonly resource: string;
  readonly requiredScopes?: readonly string[];
}

/** AccessContext contains current intersected permissions and empty roles/entitlements. */
export interface DelegatedAccess {
  readonly grantId: string;
  readonly clientId: string;
  readonly resource: string;
  readonly scopes: readonly string[];
  readonly access: AccessContext;
}

export interface RevokeTokenInput {
  readonly clientId: string;
  readonly token: string;
  readonly tokenTypeHint?: "access_token" | "refresh_token";
}

export interface GrantView {
  readonly grantId: string;
  readonly clientId: string;
  readonly ownerId: PrincipalId;
  readonly resource: string;
  readonly scopes: readonly ScopeDefinition[];
  readonly status: "pending" | "active" | "denied" | "revoked" | "expired";
  readonly createdAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

export interface AgentAccessServicePort {
  beginDeviceAuthorization(
    input: BeginDeviceAuthorizationInput,
  ): Promise<DeviceAuthorizationResult>;
  beginAuthorization(
    context: BrowserApprovalContext,
    input: BeginAuthorizationInput,
  ): Promise<ApprovalView>;
  getDeviceApproval(
    context: BrowserApprovalContext,
    userCode: string,
  ): Promise<ApprovalView>;
  getAuthorizationApproval(
    context: BrowserApprovalContext,
    requestId: string,
  ): Promise<ApprovalView>;
  approve(
    context: BrowserApprovalContext,
    input: ApproveInput,
  ): Promise<ApprovalResult>;
  exchangeAuthorizationCode(
    input: ExchangeAuthorizationCodeInput,
  ): Promise<TokenResult>;
  pollDeviceToken(input: PollDeviceTokenInput): Promise<TokenResult>;
  refresh(input: RefreshInput): Promise<TokenResult>;
  authenticate(input: AuthenticateInput): Promise<DelegatedAccess>;
  revokeToken(input: RevokeTokenInput): Promise<void>;
  getGrant(
    context: BrowserApprovalContext,
    grantId: string,
  ): Promise<GrantView>;
  revokeGrant(context: BrowserApprovalContext, grantId: string): Promise<void>;
}
