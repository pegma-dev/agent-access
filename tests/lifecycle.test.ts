import {
  createAgentAccess,
  type BrowserApprovalContext,
} from "@pegma/agent-access";
import { describe, expect, it } from "vitest";
import {
  access,
  browser,
  CLIENT,
  configuration,
  EVIDENCE,
  fixture,
  HIDDEN,
  LINK,
  OTHER_CLIENT,
  pkce,
  READ,
  REDIRECT,
  RESOURCE,
  SCOPES,
  WRITE,
} from "../test/fixtures.js";
import { storeFactories } from "../test/stores.js";

for (const [backend, makeStore] of storeFactories) {
  describe(`${backend}: public Agent Access lifecycle`, () => {
    it("links a device with explicit reduced consent and delegates only scoped current permissions", async () => {
      const world = fixture(await makeStore());
      const { device, approval, tokens } = await world.completeDevice(SCOPES, [
        READ,
        WRITE,
      ]);
      expect(device).toMatchObject({ expires_in: 600, interval: 5 });
      expect(device.user_code).toMatch(
        /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/,
      );
      expect(new URL(device.verification_uri_complete).origin).toBe(
        new URL(device.verification_uri).origin,
      );
      expect(approval).toMatchObject({
        clientId: CLIENT,
        clientName: "Workshop Agent",
        resource: RESOURCE,
        status: "pending",
      });
      expect(approval.requestedScopes.map(({ name }) => name).sort()).toEqual(
        [...SCOPES].sort(),
      );
      expect(JSON.stringify(approval)).not.toContain(device.device_code);
      expect(JSON.stringify(approval)).not.toContain(device.user_code);
      expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 900 });
      expect(tokens.scope.split(" ").sort()).toEqual([READ, WRITE]);
      expect(tokens.access_token).not.toBe(tokens.refresh_token);
      const delegated = await world.service.authenticate({
        token: tokens.access_token,
        resource: RESOURCE,
        requiredScopes: [READ],
      });
      expect(delegated).toMatchObject({ clientId: CLIENT, resource: RESOURCE });
      expect(delegated.access.principalId).toBe(browser.access.principalId);
      expect(delegated.access.permissions).toEqual([READ, WRITE]);
      expect(delegated.access.roles).toEqual([]);
      expect(delegated.access.entitlements).toEqual([]);
      expect(delegated.access.permissions).not.toContain(LINK);
      expect(delegated.access.permissions).not.toContain(HIDDEN);
      await expect(
        world.service.authenticate({
          token: tokens.access_token,
          resource: RESOURCE,
          requiredScopes: [EVIDENCE],
        }),
      ).rejects.toMatchObject({ code: "insufficient_scope" });
      const view = await world.service.getGrant(browser, delegated.grantId);
      expect(view).toMatchObject({
        status: "active",
        ownerId: browser.access.principalId,
      });
      expect(view.scopes.map(({ name }) => name)).toEqual([READ, WRITE]);
      await world.service.revokeGrant(browser, delegated.grantId);
      await expect(
        world.service.authenticate({
          token: tokens.access_token,
          resource: RESOURCE,
        }),
      ).rejects.toMatchObject({ code: "invalid_token" });
    });

    it("binds PKCE codes to client, resource and actual redirect and consumes both flows once under concurrency", async () => {
      const world = fixture(await makeStore());
      const proof = await pkce();
      const actualRedirect = "http://127.0.0.1:54983/callback";
      const request = await world.service.beginAuthorization(browser, {
        clientId: CLIENT,
        resource: RESOURCE,
        scopes: [READ],
        redirectUri: actualRedirect,
        codeChallenge: proof.challenge,
        codeChallengeMethod: "S256",
        state: "state:exact/+% punctuation",
      });
      expect(
        await world.service.getAuthorizationApproval(
          browser,
          request.requestId,
        ),
      ).toMatchObject({ requestId: request.requestId, status: "pending" });
      const approval = await world.service.approve(browser, {
        requestId: request.requestId,
        decision: "approve",
        approvedScopes: [READ],
      });
      expect(approval.flow).toBe("authorization_code");
      if (approval.flow !== "authorization_code")
        throw new Error("Expected code redirect");
      const redirect = new URL(approval.redirectUri);
      expect(redirect.origin + redirect.pathname).toBe(actualRedirect);
      expect(redirect.searchParams.get("state")).toBe(
        "state:exact/+% punctuation",
      );
      expect(redirect.searchParams.get("iss")).toBe(configuration().issuer);
      const code = redirect.searchParams.get("code");
      if (code === null) throw new Error("Expected code");
      const exchange = {
        clientId: CLIENT,
        resource: RESOURCE,
        code,
        redirectUri: actualRedirect,
        codeVerifier: proof.verifier,
      };
      await expect(
        world.service.exchangeAuthorizationCode({
          ...exchange,
          clientId: OTHER_CLIENT,
        }),
      ).rejects.toMatchObject({ code: "invalid_grant" });
      await expect(
        world.service.exchangeAuthorizationCode({
          ...exchange,
          resource: "https://wrong.workshop.example/mcp",
        }),
      ).rejects.toMatchObject({ code: "invalid_target" });
      await expect(
        world.service.exchangeAuthorizationCode({
          ...exchange,
          redirectUri: REDIRECT,
        }),
      ).rejects.toMatchObject({ code: "invalid_grant" });
      await expect(
        world.service.exchangeAuthorizationCode({
          ...exchange,
          codeVerifier: "x".repeat(64),
        }),
      ).rejects.toMatchObject({ code: "invalid_grant" });
      const codes = await Promise.allSettled([
        world.service.exchangeAuthorizationCode(exchange),
        world.service.exchangeAuthorizationCode(exchange),
      ]);
      expect(codes.filter(({ status }) => status === "fulfilled")).toHaveLength(
        1,
      );
      expect(codes.filter(({ status }) => status === "rejected")).toHaveLength(
        1,
      );
      await expect(
        world.service.exchangeAuthorizationCode(exchange),
      ).rejects.toMatchObject({ code: "invalid_grant" });

      const device = await world.service.beginDeviceAuthorization({
        clientId: CLIENT,
        resource: RESOURCE,
        scopes: [READ],
      });
      const deviceView = await world.service.getDeviceApproval(
        browser,
        device.user_code.toLowerCase().replace("-", ""),
      );
      await world.service.approve(browser, {
        requestId: deviceView.requestId,
        decision: "approve",
        userCode: device.user_code,
      });
      world.advance(device.interval);
      const poll = {
        clientId: CLIENT,
        resource: RESOURCE,
        deviceCode: device.device_code,
      };
      await expect(
        world.service.pollDeviceToken({ ...poll, clientId: OTHER_CLIENT }),
      ).rejects.toMatchObject({ code: "invalid_grant" });
      const devices = await Promise.allSettled([
        world.service.pollDeviceToken(poll),
        world.service.pollDeviceToken(poll),
      ]);
      expect(
        devices.filter(({ status }) => status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        devices.filter(({ status }) => status === "rejected"),
      ).toHaveLength(1);
    });

    it("persists polling backoff and distinguishes pending, denied and expired requests", async () => {
      const world = fixture(await makeStore());
      const pending = await world.service.beginDeviceAuthorization({
        clientId: CLIENT,
        resource: RESOURCE,
        scopes: [READ],
      });
      const poll = {
        clientId: CLIENT,
        resource: RESOURCE,
        deviceCode: pending.device_code,
      };
      await expect(world.service.pollDeviceToken(poll)).rejects.toMatchObject({
        code: "authorization_pending",
      });
      await expect(world.service.pollDeviceToken(poll)).rejects.toMatchObject({
        code: "slow_down",
      });
      world.advance(pending.interval);
      await expect(world.service.pollDeviceToken(poll)).rejects.toMatchObject({
        code: "slow_down",
      });
      world.advance(pending.interval + 10);
      // A fresh service must observe the increased interval, rather than reset it.
      const restarted = createAgentAccess(world.options);
      await expect(restarted.pollDeviceToken(poll)).rejects.toMatchObject({
        code: "authorization_pending",
      });
      world.advance(pending.interval);
      await expect(restarted.pollDeviceToken(poll)).rejects.toMatchObject({
        code: "slow_down",
      });

      const denied = await world.service.beginDeviceAuthorization({
        clientId: CLIENT,
        resource: RESOURCE,
        scopes: [WRITE],
      });
      const view = await world.service.getDeviceApproval(
        browser,
        denied.user_code,
      );
      expect(
        await world.service.approve(browser, {
          requestId: view.requestId,
          decision: "deny",
          userCode: denied.user_code,
        }),
      ).toEqual({ flow: "device_code", approved: false });
      world.advance(denied.interval);
      await expect(
        world.service.pollDeviceToken({
          clientId: CLIENT,
          resource: RESOURCE,
          deviceCode: denied.device_code,
        }),
      ).rejects.toMatchObject({ code: "access_denied" });

      const expired = await world.service.beginDeviceAuthorization({
        clientId: CLIENT,
        resource: RESOURCE,
        scopes: [READ],
      });
      world.advance(expired.expires_in + 1);
      await expect(
        world.service.pollDeviceToken({
          clientId: CLIENT,
          resource: RESOURCE,
          deviceCode: expired.device_code,
        }),
      ).rejects.toMatchObject({ code: "expired_token" });
      await expect(
        world.service.getDeviceApproval(browser, expired.user_code),
      ).rejects.toMatchObject({ code: "expired_token" });

      const proof = await pkce();
      const codeRequest = await world.service.beginAuthorization(browser, {
        clientId: CLIENT,
        resource: RESOURCE,
        scopes: [READ],
        redirectUri: REDIRECT,
        codeChallenge: proof.challenge,
        codeChallengeMethod: "S256",
      });
      const deniedCode = await world.service.approve(browser, {
        requestId: codeRequest.requestId,
        decision: "deny",
      });
      if (deniedCode.flow !== "authorization_code")
        throw new Error("Expected denial redirect");
      expect(new URL(deniedCode.redirectUri).searchParams.get("error")).toBe(
        "access_denied",
      );
      expect(new URL(deniedCode.redirectUri).searchParams.has("code")).toBe(
        false,
      );

      const expiringCode = await world.service.beginAuthorization(browser, {
        clientId: CLIENT,
        resource: RESOURCE,
        scopes: [READ],
        redirectUri: REDIRECT,
        codeChallenge: proof.challenge,
        codeChallengeMethod: "S256",
      });
      const issuedCode = await world.service.approve(browser, {
        requestId: expiringCode.requestId,
        decision: "approve",
      });
      if (issuedCode.flow !== "authorization_code")
        throw new Error("Expected code redirect");
      const expiredCode = new URL(issuedCode.redirectUri).searchParams.get(
        "code",
      );
      if (expiredCode === null) throw new Error("Expected code");
      world.advance(121);
      await expect(
        world.service.exchangeAuthorizationCode({
          clientId: CLIENT,
          resource: RESOURCE,
          code: expiredCode,
          redirectUri: REDIRECT,
          codeVerifier: proof.verifier,
        }),
      ).rejects.toMatchObject({ code: "invalid_grant" });
      expect(
        await world.service.getGrant(browser, expiringCode.requestId),
      ).toMatchObject({ status: "expired" });

      const expiringRequest = await world.service.beginAuthorization(browser, {
        clientId: CLIENT,
        resource: RESOURCE,
        scopes: [READ],
        redirectUri: REDIRECT,
        codeChallenge: proof.challenge,
        codeChallengeMethod: "S256",
      });
      world.advance(601);
      await expect(
        world.service.getAuthorizationApproval(
          browser,
          expiringRequest.requestId,
        ),
      ).rejects.toMatchObject({ code: "expired_token" });
    });

    it("allows only a current privileged browser principal to inspect and approve a human-confirmed device link", async () => {
      const world = fixture(await makeStore());
      const device = await world.service.beginDeviceAuthorization({
        clientId: CLIENT,
        resource: RESOURCE,
        scopes: [READ],
      });
      const unprivileged: BrowserApprovalContext = {
        authentication: "browser-session",
        access: access([READ, WRITE, EVIDENCE]),
      };
      await expect(
        world.service.getDeviceApproval(unprivileged, device.user_code),
      ).rejects.toMatchObject({ code: "access_denied" });
      const bearer = { ...browser };
      Reflect.set(bearer, "authentication", "bearer");
      await expect(
        world.service.getDeviceApproval(bearer, device.user_code),
      ).rejects.toMatchObject({ code: "access_denied" });
      const view = await world.service.getDeviceApproval(
        browser,
        device.user_code,
      );
      await expect(
        world.service.approve(browser, {
          requestId: view.requestId,
          decision: "approve",
        }),
      ).rejects.toMatchObject({ code: "invalid_grant" });
      const otherDevice = await world.service.beginDeviceAuthorization({
        clientId: CLIENT,
        resource: RESOURCE,
        scopes: [READ],
      });
      await expect(
        world.service.approve(browser, {
          requestId: view.requestId,
          decision: "approve",
          userCode: otherDevice.user_code,
        }),
      ).rejects.toMatchObject({ code: "invalid_grant" });
      world.authority.current = access([READ, WRITE, EVIDENCE]);
      await expect(
        world.service.approve(browser, {
          requestId: view.requestId,
          decision: "approve",
          userCode: device.user_code,
        }),
      ).rejects.toMatchObject({ code: "access_denied" });
      world.authority.current = null;
      await expect(
        world.service.getDeviceApproval(browser, device.user_code),
      ).rejects.toMatchObject({ code: "access_denied" });
      world.authority.unavailable = true;
      await expect(
        world.service.getDeviceApproval(browser, device.user_code),
      ).rejects.toMatchObject({ code: "server_error" });
    });

    it("rechecks current account and linking authority and intersects current permissions on resource calls and refresh", async () => {
      const world = fixture(await makeStore());
      const { tokens } = await world.completeDevice();
      world.authority.current = access([READ, EVIDENCE, LINK]);
      const delegated = await world.service.authenticate({
        token: tokens.access_token,
        resource: RESOURCE,
      });
      expect(delegated.access.permissions).toEqual([READ, EVIDENCE].sort());
      await expect(
        world.service.authenticate({
          token: tokens.access_token,
          resource: RESOURCE,
          requiredScopes: [WRITE],
        }),
      ).rejects.toMatchObject({ code: "insufficient_scope" });
      const refreshed = await world.service.refresh({
        clientId: CLIENT,
        resource: RESOURCE,
        refreshToken: tokens.refresh_token,
      });
      expect(refreshed.scope.split(" ").sort()).toEqual(
        [READ, EVIDENCE].sort(),
      );
      world.authority.current = access([READ, EVIDENCE]);
      await expect(
        world.service.authenticate({
          token: refreshed.access_token,
          resource: RESOURCE,
        }),
      ).rejects.toMatchObject({ code: "invalid_token" });
      await expect(
        world.service.refresh({
          clientId: CLIENT,
          resource: RESOURCE,
          refreshToken: refreshed.refresh_token,
        }),
      ).rejects.toMatchObject({ code: "invalid_grant" });
      world.authority.current = null;
      await expect(
        world.service.authenticate({
          token: refreshed.access_token,
          resource: RESOURCE,
        }),
      ).rejects.toMatchObject({ code: "invalid_token" });
      world.authority.unavailable = true;
      await expect(
        world.service.authenticate({
          token: refreshed.access_token,
          resource: RESOURCE,
        }),
      ).rejects.toMatchObject({ code: "server_error" });
      await expect(
        world.service.refresh({
          clientId: CLIENT,
          resource: RESOURCE,
          refreshToken: refreshed.refresh_token,
        }),
      ).rejects.toMatchObject({ code: "server_error" });
    });

    it("keeps family consent immutable while narrowing individual access tokens and distinguishes random failures from consumed-token reuse", async () => {
      const world = fixture(await makeStore());
      const { tokens } = await world.completeAuthorization();
      const first = await world.service.refresh({
        clientId: CLIENT,
        resource: RESOURCE,
        refreshToken: tokens.refresh_token,
        scopes: [READ],
      });
      expect(first.scope).toBe(READ);
      await expect(
        world.service.authenticate({
          token: first.access_token,
          resource: RESOURCE,
          requiredScopes: [WRITE],
        }),
      ).rejects.toMatchObject({ code: "insufficient_scope" });
      await expect(
        world.service.refresh({
          clientId: CLIENT,
          resource: RESOURCE,
          refreshToken: first.refresh_token,
          scopes: [HIDDEN],
        }),
      ).rejects.toMatchObject({ code: "invalid_scope" });
      const randomSecret = (token: string) =>
        token.slice(0, token.lastIndexOf(".") + 1) + "Z".repeat(43);
      for (const knownLocator of [tokens.refresh_token, first.refresh_token]) {
        await expect(
          world.service.refresh({
            clientId: CLIENT,
            resource: RESOURCE,
            refreshToken: randomSecret(knownLocator),
          }),
        ).rejects.toMatchObject({ code: "invalid_grant" });
      }
      const restored = await world.service.refresh({
        clientId: CLIENT,
        resource: RESOURCE,
        refreshToken: first.refresh_token,
      });
      expect(restored.scope.split(" ").sort()).toEqual([...SCOPES].sort());
      await expect(
        world.service.authenticate({
          token: restored.access_token,
          resource: RESOURCE,
          requiredScopes: [EVIDENCE],
        }),
      ).resolves.toMatchObject({ clientId: CLIENT });
      await expect(
        world.service.refresh({
          clientId: CLIENT,
          resource: RESOURCE,
          refreshToken: tokens.refresh_token,
        }),
      ).rejects.toMatchObject({ code: "invalid_grant" });
      await expect(
        world.service.authenticate({
          token: restored.access_token,
          resource: RESOURCE,
        }),
      ).rejects.toMatchObject({ code: "invalid_token" });
      await expect(
        world.service.refresh({
          clientId: CLIENT,
          resource: RESOURCE,
          refreshToken: restored.refresh_token,
        }),
      ).rejects.toMatchObject({ code: "invalid_grant" });
    });

    it("ignores unrelated new scopes but invalidates consent when a selected definition changes", async () => {
      const world = fixture(await makeStore());
      const { tokens } = await world.completeDevice([READ]);
      const original = configuration();
      const expanded = {
        ...original,
        scopes: [
          ...original.scopes,
          {
            name: HIDDEN,
            description: "New unconsented privilege",
            version: "1",
            permissions: [HIDDEN],
          },
        ],
        clients: original.clients.map((client) => ({
          ...client,
          allowedScopes: [...client.allowedScopes, HIDDEN],
        })),
      };
      const unrelated = createAgentAccess({
        ...world.options,
        configuration: expanded,
      });
      const delegated = await unrelated.authenticate({
        token: tokens.access_token,
        resource: RESOURCE,
      });
      expect(delegated.access.permissions).toEqual([READ]);
      const refreshed = await unrelated.refresh({
        clientId: CLIENT,
        resource: RESOURCE,
        refreshToken: tokens.refresh_token,
      });
      expect(refreshed.scope).toBe(READ);
      await expect(
        unrelated.refresh({
          clientId: CLIENT,
          resource: RESOURCE,
          refreshToken: refreshed.refresh_token,
          scopes: [HIDDEN],
        }),
      ).rejects.toMatchObject({ code: "invalid_scope" });
      const changed = createAgentAccess({
        ...world.options,
        configuration: {
          ...expanded,
          scopes: expanded.scopes.map((scope) =>
            scope.name === READ
              ? { ...scope, version: "2", permissions: [READ, HIDDEN] }
              : scope,
          ),
        },
      });
      await expect(
        changed.authenticate({
          token: refreshed.access_token,
          resource: RESOURCE,
        }),
      ).rejects.toMatchObject({ code: "invalid_token" });
      await expect(
        changed.refresh({
          clientId: CLIENT,
          resource: RESOURCE,
          refreshToken: refreshed.refresh_token,
        }),
      ).rejects.toMatchObject({ code: "invalid_grant" });
    });

    it("revokes both credential kinds idempotently without letting another client or a locator alone revoke a grant", async () => {
      const world = fixture(await makeStore());
      const { tokens } = await world.completeDevice([READ]);
      await world.service.revokeToken({ clientId: CLIENT, token: "unknown" });
      await world.service.revokeToken({
        clientId: CLIENT,
        token: "unknown",
        tokenTypeHint: "access_token",
      });
      await world.service.revokeToken({
        clientId: OTHER_CLIENT,
        token: tokens.refresh_token,
      });
      await expect(
        world.service.authenticate({
          token: tokens.access_token,
          resource: RESOURCE,
        }),
      ).resolves.toMatchObject({ clientId: CLIENT });
      const wrongSecret =
        tokens.access_token.slice(0, tokens.access_token.lastIndexOf(".") + 1) +
        "Y".repeat(43);
      await world.service.revokeToken({ clientId: CLIENT, token: wrongSecret });
      await expect(
        world.service.authenticate({
          token: tokens.access_token,
          resource: RESOURCE,
        }),
      ).resolves.toMatchObject({ clientId: CLIENT });
      // An unhelpful hint cannot suppress revocation of a supported credential.
      await world.service.revokeToken({
        clientId: CLIENT,
        token: tokens.access_token,
        tokenTypeHint: "refresh_token",
      });
      await world.service.revokeToken({
        clientId: CLIENT,
        token: tokens.access_token,
      });
      await expect(
        world.service.refresh({
          clientId: CLIENT,
          resource: RESOURCE,
          refreshToken: tokens.refresh_token,
        }),
      ).rejects.toMatchObject({ code: "invalid_grant" });
      const next = await world.completeAuthorization([READ]);
      await world.service.revokeToken({
        clientId: CLIENT,
        token: next.tokens.refresh_token,
      });
      await expect(
        world.service.authenticate({
          token: next.tokens.access_token,
          resource: RESOURCE,
        }),
      ).rejects.toMatchObject({ code: "invalid_token" });
    });
  });
}
