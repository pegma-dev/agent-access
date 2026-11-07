export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "unauthorized_client"
  | "invalid_grant"
  | "invalid_scope"
  | "invalid_target"
  | "access_denied"
  | "authorization_pending"
  | "slow_down"
  | "expired_token"
  | "unsupported_grant_type"
  | "invalid_token"
  | "insufficient_scope"
  | "temporarily_unavailable"
  | "server_error";

const DESCRIPTIONS: Readonly<Record<OAuthErrorCode, string>> = Object.freeze({
  invalid_request: "The request is invalid.",
  invalid_client: "The client is invalid.",
  unauthorized_client: "The client cannot use this grant.",
  invalid_grant: "The grant is invalid or unavailable.",
  invalid_scope: "The requested scope is invalid.",
  invalid_target: "The requested resource is invalid.",
  access_denied: "Access was denied.",
  authorization_pending: "Authorization is pending.",
  slow_down: "Polling is too frequent.",
  expired_token: "The credential has expired.",
  unsupported_grant_type: "The grant type is unsupported.",
  invalid_token: "The access credential is invalid.",
  insufficient_scope: "The credential does not grant the required scope.",
  temporarily_unavailable: "The service is temporarily busy. Try again later.",
  server_error: "The service is temporarily unavailable.",
});

/** Content-free protocol error; submitted values and storage causes are never included. */
export class OAuthError extends Error {
  readonly code: OAuthErrorCode;
  readonly status: number;
  readonly description: string;

  constructor(code: OAuthErrorCode, status?: number) {
    const description = DESCRIPTIONS[code];
    super(description);
    this.name = "OAuthError";
    this.code = code;
    this.status =
      status ??
      (code === "server_error" || code === "temporarily_unavailable"
        ? 503
        : code === "invalid_token"
          ? 401
          : code === "insufficient_scope" || code === "access_denied"
            ? 403
            : 400);
    this.description = description;
  }

  toJSON(): {
    readonly error: OAuthErrorCode;
    readonly error_description: string;
  } {
    return { error: this.code, error_description: this.description };
  }
}
