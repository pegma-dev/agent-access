import {
  createAgentAccess,
  OAuthError,
  type TokenResult,
} from "@pegma/agent-access";
import { StorageError } from "@pegma/storage-core";
import { describe, expect, it } from "vitest";
import {
  browser,
  CLIENT,
  configuration,
  EVIDENCE,
  fixture,
  HIDDEN,
  pkce,
  READ,
  REDIRECT,
  RESOURCE,
  SCOPES,
  WRITE,
} from "../test/fixtures.js";
import { storeFactories } from "../test/stores.js";
import { barrier, traceStore } from "../test/trace-store.js";

for (const [backend, makeStore] of storeFactories) {
  describe(`${backend}: transactional grant persistence`, () => {
    it("persists hashes and atomic audit transitions without credential material", async () => {
      const traced = traceStore(await makeStore());
      const world = fixture(traced.store);
      const device = await world.completeDevice();
      const code = await world.completeAuthorization([READ]);
      const refreshed = await world.service.refresh({
        clientId: CLIENT,
        resource: RESOURCE,
        refreshToken: device.tokens.refresh_token,
      });
      const delegated = await world.service.authenticate({
        token: refreshed.access_token,
        resource: RESOURCE,
      });
      await world.service.revokeGrant(browser, delegated.grantId);
      const snapshot = await traced.snapshot();
      const serialized = JSON.stringify(snapshot);
      const submittedSecrets = [
        device.device.device_code,
        device.device.user_code,
        device.device.user_code.replace("-", ""),
        device.device.verification_uri_complete,
        device.tokens.access_token,
        device.tokens.refresh_token,
        code.exchange.code,
        code.exchange.codeVerifier,
        code.result.redirectUri,
        code.tokens.access_token,
        code.tokens.refresh_token,
        refreshed.access_token,
        refreshed.refresh_token,
      ];
      for (const secret of submittedSecrets) {
        expect(serialized).not.toContain(secret);
        expect(JSON.stringify(traced.transactions)).not.toContain(secret);
      }
      expect(snapshot).toHaveLength(1);
      expect(
        snapshot[0]?.rows.some(({ record }) => record.kind === "consumed"),
      ).toBe(true);
      expect(
        snapshot[0]?.rows.filter(({ record }) => record.kind === "audit")
          .length,
      ).toBeGreaterThanOrEqual(8);
      expect(traced.transactions.length).toBeGreaterThanOrEqual(8);
      for (const transaction of traced.transactions) {
        expect(
          new Set(transaction.actions.map(({ key }) => key.partition)),
        ).toEqual(new Set([transaction.partition]));
        expect(
          transaction.actions.some(({ record }) => record?.kind === "head"),
        ).toBe(true);
        expect(
          transaction.actions.some(({ record }) => record?.kind === "audit"),
        ).toBe(true);
        expect(new Set(transaction.actions.map(({ key }) => key.id)).size).toBe(
          transaction.actions.length,
        );
      }
    });

    it("authenticates and rejects random secrets with bounded keyed reads and no enumeration or mutation", async () => {
      const traced = traceStore(await makeStore());
      const world = fixture(traced.store);
      const { tokens } = await world.completeDevice([READ]);
      // Unrelated partitions make a hidden scan materially observable.
      for (let index = 0; index < 6; index += 1) {
        await world.service.beginDeviceAuthorization({
          clientId: CLIENT,
          resource: RESOURCE,
          scopes: [READ],
        });
      }
      traced.reads.length = 0;
      traced.enumerations.length = 0;
      traced.transactions.length = 0;
      await world.service.authenticate({
        token: tokens.access_token,
        resource: RESOURCE,
      });
      expect(traced.reads.length).toBeGreaterThanOrEqual(1);
      expect(traced.reads.length).toBeLessThanOrEqual(2);
      expect(traced.enumerations).toEqual([]);
      expect(traced.transactions).toEqual([]);
      const expectedPartition = traced.reads[0]?.key.partition;
      expect(
        traced.reads.every(({ key }) => key.partition === expectedPartition),
      ).toBe(true);

      traced.reads.length = 0;
      const wrongRefresh =
        tokens.refresh_token.slice(
          0,
          tokens.refresh_token.lastIndexOf(".") + 1,
        ) + "Q".repeat(43);
      const wrongAccess =
        tokens.access_token.slice(0, tokens.access_token.lastIndexOf(".") + 1) +
        "P".repeat(43);
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await expect(
          world.service.refresh({
            clientId: CLIENT,
            resource: RESOURCE,
            refreshToken: wrongRefresh,
          }),
        ).rejects.toMatchObject({ code: "invalid_grant" });
        await expect(
          world.service.authenticate({
            token: wrongAccess,
            resource: RESOURCE,
          }),
        ).rejects.toMatchObject({ code: "invalid_token" });
        await world.service.revokeToken({
          clientId: CLIENT,
          token: wrongRefresh,
        });
      }
      expect(traced.reads.length).toBeLessThanOrEqual(42);
      expect(traced.enumerations).toEqual([]);
      expect(traced.transactions).toEqual([]);
      await expect(
        world.service.authenticate({
          token: tokens.access_token,
          resource: RESOURCE,
        }),
      ).resolves.toMatchObject({ clientId: CLIENT });

      traced.reads.length = 0;
      await expect(
        world.service.authenticate({
          token: "x".repeat(20_000),
          resource: RESOURCE,
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      await expect(
        world.service.beginDeviceAuthorization({
          clientId: CLIENT,
          resource: RESOURCE,
          scopes: ["x".repeat(20_000)],
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(traced.reads).toEqual([]);
      expect(traced.enumerations).toEqual([]);
      expect(traced.transactions).toEqual([]);
    });

    it("fails closed after a real commit whose acknowledgement is lost without minting a second successor", async () => {
      const traced = traceStore(await makeStore());
      const world = fixture(traced.store);
      const { tokens } = await world.completeDevice([READ]);
      const delegated = await world.service.authenticate({
        token: tokens.access_token,
        resource: RESOURCE,
      });
      const before = traced.transactions.length;
      let injected = false;
      traced.intercept(async (_trace, commit) => {
        const outcome = await commit();
        if (outcome.committed && !injected) {
          injected = true;
          throw new StorageError(
            `Synthetic lost acknowledgement: ${tokens.refresh_token}`,
          );
        }
        return outcome;
      });
      const failed = world.service.refresh({
        clientId: CLIENT,
        resource: RESOURCE,
        refreshToken: tokens.refresh_token,
      });
      await expect(failed).rejects.toMatchObject({
        code: "server_error",
        status: 503,
      });
      await expect(failed).rejects.toMatchObject({
        message: "The service is temporarily unavailable.",
      });
      await expect(failed).rejects.not.toHaveProperty("cause");
      expect(traced.transactions.length - before).toBe(1);
      expect(injected).toBe(true);
      traced.intercept(undefined);
      await expect(
        world.service.authenticate({
          token: tokens.access_token,
          resource: RESOURCE,
        }),
      ).rejects.toMatchObject({ code: "invalid_token" });
      await expect(
        world.service.refresh({
          clientId: CLIENT,
          resource: RESOURCE,
          refreshToken: tokens.refresh_token,
        }),
      ).rejects.toMatchObject({ code: "invalid_grant" });
      expect(
        await world.service.getGrant(browser, delegated.grantId),
      ).toMatchObject({ status: "revoked" });
      const rows = (await traced.snapshot()).flatMap(
        ({ rows: collectionRows }) => collectionRows,
      );
      expect(
        rows.filter(
          ({ key, record }) =>
            key.partition === delegated.grantId && record.kind === "consumed",
        ),
      ).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(tokens.refresh_token);
    });

    it("caps physical rows and rotations, retains consumed hashes, and enforces absolute family expiry", async () => {
      const traced = traceStore(await makeStore());
      const bounded = configuration();
      const world = fixture(traced.store, {
        ...bounded,
        limits: { maxRows: 8 },
      });
      const initial = await world.completeDevice([READ]);
      const delegated = await world.service.authenticate({
        token: initial.tokens.access_token,
        resource: RESOURCE,
      });
      let current = initial.tokens;
      let rotations = 0;
      let capped = false;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          current = await world.service.refresh({
            clientId: CLIENT,
            resource: RESOURCE,
            refreshToken: current.refresh_token,
          });
          rotations += 1;
        } catch (error) {
          expect(error).toBeInstanceOf(OAuthError);
          expect(error).toMatchObject({ code: "invalid_grant" });
          capped = true;
          break;
        }
      }
      expect(capped).toBe(true);
      expect(rotations).toBeGreaterThan(0);
      const rows = (await traced.snapshot())
        .flatMap(({ rows: collectionRows }) => collectionRows)
        .filter(({ key }) => key.partition === delegated.grantId);
      expect(rows.length).toBeLessThanOrEqual(8);
      expect(
        rows.filter(({ record }) => record.kind === "consumed"),
      ).toHaveLength(rotations);
      expect(
        await world.service.getGrant(browser, delegated.grantId),
      ).toMatchObject({ status: "revoked" });
      await expect(
        world.service.authenticate({
          token: current.access_token,
          resource: RESOURCE,
        }),
      ).rejects.toMatchObject({ code: "invalid_token" });

      const rotationWorld = fixture(traced.store, {
        ...configuration(),
        limits: { maxRotations: 2 },
      });
      let rotating = (await rotationWorld.completeDevice([READ])).tokens;
      for (let index = 0; index < 2; index += 1)
        rotating = await rotationWorld.service.refresh({
          clientId: CLIENT,
          resource: RESOURCE,
          refreshToken: rotating.refresh_token,
        });
      await expect(
        rotationWorld.service.refresh({
          clientId: CLIENT,
          resource: RESOURCE,
          refreshToken: rotating.refresh_token,
        }),
      ).rejects.toMatchObject({ code: "invalid_grant" });
      await expect(
        rotationWorld.service.authenticate({
          token: rotating.access_token,
          resource: RESOURCE,
        }),
      ).rejects.toMatchObject({ code: "invalid_token" });

      const expiring = fixture(traced.store, {
        ...configuration(),
        limits: { refreshFamilyLifetimeSeconds: 30, accessLifetimeSeconds: 20 },
      });
      const linked = await expiring.completeDevice([READ]);
      expiring.advance(15);
      const successor = await expiring.service.refresh({
        clientId: CLIENT,
        resource: RESOURCE,
        refreshToken: linked.tokens.refresh_token,
      });
      expect(successor.expires_in).toBe(15);
      expiring.advance(16);
      await expect(
        expiring.service.refresh({
          clientId: CLIENT,
          resource: RESOURCE,
          refreshToken: successor.refresh_token,
        }),
      ).rejects.toMatchObject({ code: "invalid_grant" });
      await expect(
        expiring.service.authenticate({
          token: successor.access_token,
          resource: RESOURCE,
        }),
      ).rejects.toMatchObject({ code: "invalid_token" });
    });

    it("requires integral access lifetimes and refuses a refresh with less than one whole family second remaining", async () => {
      const traced = traceStore(await makeStore());
      expect(() =>
        fixture(traced.store, {
          ...configuration(),
          limits: { accessLifetimeSeconds: 0.5 },
        }),
      ).toThrowError(expect.objectContaining({ code: "invalid_request" }));
      const world = fixture(traced.store, {
        ...configuration(),
        limits: {
          accessLifetimeSeconds: 1,
          refreshFamilyLifetimeSeconds: 2,
        },
      });
      const { tokens } = await world.completeDevice([READ]);
      expect(tokens.expires_in).toBe(1);
      await expect(
        world.service.authenticate({
          token: tokens.access_token,
          resource: RESOURCE,
        }),
      ).resolves.toMatchObject({ clientId: CLIENT });
      const before = await traced.snapshot();
      const transactionsBefore = traced.transactions.length;
      world.advance(1.5);
      const refresh = {
        clientId: CLIENT,
        resource: RESOURCE,
        refreshToken: tokens.refresh_token,
      };
      await expect(world.service.refresh(refresh)).rejects.toMatchObject({
        code: "invalid_grant",
      });
      const after = await traced.snapshot();
      expect(traced.transactions).toHaveLength(transactionsBefore);
      expect(after).toEqual(before);
      expect(
        after.flatMap(({ rows }) =>
          rows.filter(({ record }) => record.kind === "consumed"),
        ),
      ).toEqual([]);
      expect(JSON.stringify(after)).not.toContain("agent_access.refreshed");
      world.advance(0.5);
      await expect(
        world.service.authenticate({
          token: tokens.access_token,
          resource: RESOURCE,
        }),
      ).rejects.toMatchObject({ code: "invalid_token" });
      await expect(world.service.refresh(refresh)).rejects.toMatchObject({
        code: "invalid_grant",
      });
    });

    it("keeps terminal revocation available after a host lowers its configured row cap", async () => {
      const traced = traceStore(await makeStore());
      for (const transition of [
        "owner",
        "token",
        "reuse",
        "capacity",
      ] as const) {
        const world = fixture(traced.store);
        const original = await world.completeDevice([READ]);
        let current = original.tokens;
        for (let rotation = 0; rotation < 3; rotation += 1) {
          current = await world.service.refresh({
            clientId: CLIENT,
            resource: RESOURCE,
            refreshToken: current.refresh_token,
          });
        }
        const delegated = await world.service.authenticate({
          token: current.access_token,
          resource: RESOURCE,
        });
        const lowered = createAgentAccess({
          ...world.options,
          configuration: { ...configuration(), limits: { maxRows: 8 } },
        });
        if (transition === "owner")
          await lowered.revokeGrant(browser, delegated.grantId);
        else if (transition === "token")
          await lowered.revokeToken({
            clientId: CLIENT,
            token: current.refresh_token,
          });
        else
          await expect(
            lowered.refresh({
              clientId: CLIENT,
              resource: RESOURCE,
              refreshToken:
                transition === "reuse"
                  ? original.tokens.refresh_token
                  : current.refresh_token,
            }),
          ).rejects.toMatchObject({ code: "invalid_grant" });
        expect(
          await lowered.getGrant(browser, delegated.grantId),
        ).toMatchObject({ status: "revoked" });
        await expect(
          lowered.authenticate({
            token: current.access_token,
            resource: RESOURCE,
          }),
        ).rejects.toMatchObject({ code: "invalid_token" });
        const rows = (await traced.snapshot())
          .flatMap(({ rows: collectionRows }) => collectionRows)
          .filter(({ key }) => key.partition === delegated.grantId);
        expect(rows.length).toBeGreaterThan(8);
        expect(rows.length).toBeLessThanOrEqual(300);
        expect(
          rows.filter(({ record }) => record.kind === "consumed"),
        ).toHaveLength(3);
      }
    });

    it("snapshots mutable configuration, request and consent inputs before asynchronous work", async () => {
      const definitions = configuration().scopes.map((scope) => ({
        ...scope,
        permissions: [...scope.permissions],
      }));
      const configured = { ...configuration(), scopes: definitions };
      const world = fixture(await makeStore(), configured);
      const readDefinition = definitions.find(({ name }) => name === READ);
      if (readDefinition === undefined)
        throw new Error("Expected synthetic read definition");
      readDefinition.permissions.push(HIDDEN);
      readDefinition.version = "mutated-after-construction";
      const scopes = [READ];
      const deviceInput = { clientId: CLIENT, resource: RESOURCE, scopes };
      const started = world.service.beginDeviceAuthorization(deviceInput);
      scopes.push(WRITE);
      deviceInput.clientId = "mutated-client";
      const device = await started;
      const view = await world.service.getDeviceApproval(
        browser,
        device.user_code,
      );
      expect(view.requestedScopes.map(({ name }) => name)).toEqual([READ]);
      const selected = [READ];
      const approving = world.service.approve(browser, {
        requestId: view.requestId,
        decision: "approve",
        userCode: device.user_code,
        approvedScopes: selected,
      });
      selected.push(EVIDENCE);
      await approving;
      world.advance(device.interval);
      const tokens = await world.service.pollDeviceToken({
        clientId: CLIENT,
        resource: RESOURCE,
        deviceCode: device.device_code,
      });
      expect(tokens.scope).toBe(READ);
      const delegated = await world.service.authenticate({
        token: tokens.access_token,
        resource: RESOURCE,
      });
      expect(delegated.access.permissions).toEqual([READ]);

      const wide = await world.completeAuthorization(SCOPES);
      const narrowed = [READ];
      const refreshing = world.service.refresh({
        clientId: CLIENT,
        resource: RESOURCE,
        refreshToken: wide.tokens.refresh_token,
        scopes: narrowed,
      });
      narrowed.push(WRITE);
      expect((await refreshing).scope).toBe(READ);

      const proof = await pkce();
      const request = {
        clientId: CLIENT,
        resource: RESOURCE,
        scopes: [READ],
        redirectUri: REDIRECT,
        codeChallenge: proof.challenge,
        codeChallengeMethod: "S256" as const,
      };
      const pending = world.service.beginAuthorization(browser, request);
      request.redirectUri = "https://untrusted.workshop.example/steal";
      request.scopes.push(WRITE);
      const authorization = await pending;
      const approved = await world.service.approve(browser, {
        requestId: authorization.requestId,
        decision: "approve",
      });
      if (approved.flow !== "authorization_code")
        throw new Error("Expected authorization redirect");
      expect(
        new URL(approved.redirectUri).origin +
          new URL(approved.redirectUri).pathname,
      ).toBe(REDIRECT);
      expect(authorization.requestedScopes.map(({ name }) => name)).toEqual([
        READ,
      ]);
    });

    it("rejects hostile and oversized public inputs before invoking getters, serializers or storage", async () => {
      const traced = traceStore(await makeStore());
      const world = fixture(traced.store);
      let getterCalls = 0;
      let serializerCalls = 0;
      const hostileGetter = {
        clientId: CLIENT,
        resource: RESOURCE,
        scopes: [READ],
      };
      Object.defineProperty(hostileGetter, "scopes", {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return [READ];
        },
      });
      await expect(
        world.service.beginDeviceAuthorization(hostileGetter),
      ).rejects.toMatchObject({ code: "invalid_request" });
      const hostileSerializer = {
        clientId: CLIENT,
        resource: RESOURCE,
        scopes: [READ],
        toJSON: () => {
          serializerCalls += 1;
          return { clientId: CLIENT, resource: RESOURCE, scopes: [READ] };
        },
      };
      await expect(
        world.service.beginDeviceAuthorization(hostileSerializer),
      ).rejects.toMatchObject({ code: "invalid_request" });
      const inherited = {
        clientId: CLIENT,
        resource: RESOURCE,
        scopes: [READ],
      };
      Object.setPrototypeOf(inherited, { unexpectedHostObject: true });
      await expect(
        world.service.beginDeviceAuthorization(inherited),
      ).rejects.toMatchObject({ code: "invalid_request" });
      const sparse: string[] = [];
      sparse.length = 2;
      sparse[1] = READ;
      await expect(
        world.service.beginDeviceAuthorization({
          clientId: CLIENT,
          resource: RESOURCE,
          scopes: sparse,
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      await expect(
        world.service.beginDeviceAuthorization({
          clientId: CLIENT,
          resource: RESOURCE,
          scopes: ["\u{1F9EA}".repeat(5_000)],
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(getterCalls).toBe(0);
      expect(serializerCalls).toBe(0);
      expect(traced.reads).toEqual([]);
      expect(traced.enumerations).toEqual([]);
      expect(traced.transactions).toEqual([]);
    });

    it("fences resource access against overlapping revocation and fails closed on concurrent refresh replay", async () => {
      const backing = await makeStore();
      const world = fixture(backing);
      const { tokens } = await world.completeDevice([READ]);
      const delegated = await world.service.authenticate({
        token: tokens.access_token,
        resource: RESOURCE,
      });
      const pause = barrier();
      const overlapping = createAgentAccess({
        ...world.options,
        resolvePrincipal: async (principalId) => {
          await pause.wait();
          return world.options.resolvePrincipal(principalId);
        },
      });
      const authenticating = overlapping.authenticate({
        token: tokens.access_token,
        resource: RESOURCE,
      });
      await pause.reached;
      try {
        await world.service.revokeGrant(browser, delegated.grantId);
      } finally {
        pause.release();
      }
      await expect(authenticating).rejects.toMatchObject({
        code: "invalid_token",
      });

      const fresh = await world.completeDevice([READ]);
      const input = {
        clientId: CLIENT,
        resource: RESOURCE,
        refreshToken: fresh.tokens.refresh_token,
      };
      const results = await Promise.allSettled([
        world.service.refresh(input),
        world.service.refresh(input),
      ]);
      const successes: TokenResult[] = [];
      for (const result of results) {
        if (result.status === "fulfilled") successes.push(result.value);
        else expect(result.reason).toMatchObject({ code: "invalid_grant" });
      }
      expect(successes).toHaveLength(1);
      const winner = successes[0];
      if (winner === undefined)
        throw new Error("Expected one transaction winner");
      await expect(
        world.service.authenticate({
          token: winner.access_token,
          resource: RESOURCE,
        }),
      ).rejects.toMatchObject({ code: "invalid_token" });
      await expect(
        world.service.refresh({
          clientId: CLIENT,
          resource: RESOURCE,
          refreshToken: winner.refresh_token,
        }),
      ).rejects.toMatchObject({ code: "invalid_grant" });
    });

    it("binds persisted grants and pending requests to the issuer and resource even when the backing store is shared", async () => {
      const traced = traceStore(await makeStore());
      const world = fixture(traced.store);
      const family = await world.completeDevice([READ]);
      const delegated = await world.service.authenticate({
        token: family.tokens.access_token,
        resource: RESOURCE,
      });
      const pendingDevice = await world.service.beginDeviceAuthorization({
        clientId: CLIENT,
        resource: RESOURCE,
        scopes: [READ],
      });
      const deviceView = await world.service.getDeviceApproval(
        browser,
        pendingDevice.user_code,
      );
      const proof = await pkce();
      const authorizationInput = {
        clientId: CLIENT,
        resource: RESOURCE,
        scopes: [READ],
        redirectUri: REDIRECT,
        codeChallenge: proof.challenge,
        codeChallengeMethod: "S256" as const,
      };
      const codeRequest = await world.service.beginAuthorization(
        browser,
        authorizationInput,
      );
      const approved = await world.service.approve(browser, {
        requestId: codeRequest.requestId,
        decision: "approve",
      });
      if (approved.flow !== "authorization_code")
        throw new Error("Expected authorization redirect");
      const code = new URL(approved.redirectUri).searchParams.get("code");
      if (code === null) throw new Error("Expected authorization code");
      const exchange = {
        clientId: CLIENT,
        resource: RESOURCE,
        code,
        redirectUri: REDIRECT,
        codeVerifier: proof.verifier,
      };
      const pendingCode = await world.service.beginAuthorization(
        browser,
        authorizationInput,
      );
      for (const namespace of [
        {
          issuer: "https://other-login.workshop.example",
          resource: RESOURCE,
        },
        {
          issuer: configuration().issuer,
          resource: "https://other-api.workshop.example/mcp",
        },
      ]) {
        const alternate = createAgentAccess({
          ...world.options,
          configuration: {
            ...configuration(),
            issuer: namespace.issuer,
            resource: namespace.resource,
            endpoints: {
              authorize: `${namespace.issuer}/authorize`,
              deviceAuthorization: `${namespace.issuer}/device_authorization`,
              token: `${namespace.issuer}/token`,
              revocation: `${namespace.issuer}/revoke`,
              verification: `${namespace.issuer}/verify`,
              approval: `${namespace.issuer}/approve`,
              resourceMetadata: `${namespace.issuer}/.well-known/oauth-protected-resource`,
            },
          },
        });
        const before = traced.transactions.length;
        await expect(
          alternate.authenticate({
            token: family.tokens.access_token,
            resource: namespace.resource,
          }),
        ).rejects.toMatchObject({ code: "invalid_token" });
        await expect(
          alternate.refresh({
            clientId: CLIENT,
            resource: namespace.resource,
            refreshToken: family.tokens.refresh_token,
          }),
        ).rejects.toMatchObject({ code: "invalid_grant" });
        await expect(
          alternate.exchangeAuthorizationCode({
            ...exchange,
            resource: namespace.resource,
          }),
        ).rejects.toMatchObject({ code: "invalid_grant" });
        await expect(
          alternate.pollDeviceToken({
            clientId: CLIENT,
            resource: namespace.resource,
            deviceCode: pendingDevice.device_code,
          }),
        ).rejects.toMatchObject({ code: "invalid_grant" });
        await expect(
          alternate.getDeviceApproval(browser, pendingDevice.user_code),
        ).rejects.toMatchObject({ code: "invalid_grant" });
        await expect(
          alternate.approve(browser, {
            requestId: deviceView.requestId,
            userCode: pendingDevice.user_code,
            decision: "approve",
          }),
        ).rejects.toMatchObject({ code: "invalid_grant" });
        await expect(
          alternate.getAuthorizationApproval(browser, codeRequest.requestId),
        ).rejects.toMatchObject({ code: "invalid_grant" });
        await expect(
          alternate.approve(browser, {
            requestId: pendingCode.requestId,
            decision: "approve",
          }),
        ).rejects.toMatchObject({ code: "invalid_grant" });
        await expect(
          alternate.getGrant(browser, delegated.grantId),
        ).rejects.toMatchObject({ code: "invalid_grant" });
        await expect(
          alternate.revokeGrant(browser, delegated.grantId),
        ).rejects.toMatchObject({ code: "invalid_grant" });
        await alternate.revokeToken({
          clientId: CLIENT,
          token: family.tokens.access_token,
        });
        await alternate.revokeToken({
          clientId: CLIENT,
          token: family.tokens.refresh_token,
        });
        expect(traced.transactions).toHaveLength(before);
      }

      // Foreign namespaces cannot consume or revoke the rightful server's data.
      await expect(
        world.service.authenticate({
          token: family.tokens.access_token,
          resource: RESOURCE,
        }),
      ).resolves.toMatchObject({ grantId: delegated.grantId });
      await expect(
        world.service.exchangeAuthorizationCode(exchange),
      ).resolves.toMatchObject({ token_type: "Bearer", scope: READ });
      await world.service.approve(browser, {
        requestId: deviceView.requestId,
        userCode: pendingDevice.user_code,
        decision: "approve",
      });
      world.advance(pendingDevice.interval);
      await expect(
        world.service.pollDeviceToken({
          clientId: CLIENT,
          resource: RESOURCE,
          deviceCode: pendingDevice.device_code,
        }),
      ).resolves.toMatchObject({ token_type: "Bearer", scope: READ });
      expect(
        await world.service.getAuthorizationApproval(
          browser,
          pendingCode.requestId,
        ),
      ).toMatchObject({ status: "pending" });
      await expect(
        world.service.refresh({
          clientId: CLIENT,
          resource: RESOURCE,
          refreshToken: family.tokens.refresh_token,
        }),
      ).resolves.toMatchObject({ token_type: "Bearer", scope: READ });
    });

    it("rechecks expiry when authority resolution crosses access, family, request or code deadlines", async () => {
      const backing = await makeStore();
      const accessWorld = fixture(backing);
      const accessLink = await accessWorld.completeDevice([READ]);
      const accessDelayed = createAgentAccess({
        ...accessWorld.options,
        resolvePrincipal: async (principalId) => {
          accessWorld.advance(901);
          return accessWorld.options.resolvePrincipal(principalId);
        },
      });
      await expect(
        accessDelayed.authenticate({
          token: accessLink.tokens.access_token,
          resource: RESOURCE,
        }),
      ).rejects.toMatchObject({ code: "invalid_token" });

      const refreshWorld = fixture(backing);
      const refreshLink = await refreshWorld.completeDevice([READ]);
      const refreshDelayed = createAgentAccess({
        ...refreshWorld.options,
        resolvePrincipal: async (principalId) => {
          refreshWorld.advance(604_801);
          return refreshWorld.options.resolvePrincipal(principalId);
        },
      });
      await expect(
        refreshDelayed.refresh({
          clientId: CLIENT,
          resource: RESOURCE,
          refreshToken: refreshLink.tokens.refresh_token,
        }),
      ).rejects.toMatchObject({ code: "invalid_grant" });

      const approvalWorld = fixture(backing);
      const pending = await approvalWorld.service.beginDeviceAuthorization({
        clientId: CLIENT,
        resource: RESOURCE,
        scopes: [READ],
      });
      const pendingView = await approvalWorld.service.getDeviceApproval(
        browser,
        pending.user_code,
      );
      const approvalDelayed = createAgentAccess({
        ...approvalWorld.options,
        resolvePrincipal: async (principalId) => {
          approvalWorld.advance(pending.expires_in + 1);
          return approvalWorld.options.resolvePrincipal(principalId);
        },
      });
      await expect(
        approvalDelayed.approve(browser, {
          requestId: pendingView.requestId,
          userCode: pending.user_code,
          decision: "approve",
        }),
      ).rejects.toMatchObject({ code: "expired_token" });

      const pollWorld = fixture(backing);
      const pollRequest = await pollWorld.service.beginDeviceAuthorization({
        clientId: CLIENT,
        resource: RESOURCE,
        scopes: [READ],
      });
      const pollView = await pollWorld.service.getDeviceApproval(
        browser,
        pollRequest.user_code,
      );
      await pollWorld.service.approve(browser, {
        requestId: pollView.requestId,
        userCode: pollRequest.user_code,
        decision: "approve",
      });
      pollWorld.advance(pollRequest.interval);
      const pollDelayed = createAgentAccess({
        ...pollWorld.options,
        resolvePrincipal: async (principalId) => {
          pollWorld.advance(pollRequest.expires_in + 1);
          return pollWorld.options.resolvePrincipal(principalId);
        },
      });
      await expect(
        pollDelayed.pollDeviceToken({
          clientId: CLIENT,
          resource: RESOURCE,
          deviceCode: pollRequest.device_code,
        }),
      ).rejects.toMatchObject({ code: "expired_token" });

      const codeWorld = fixture(backing);
      const proof = await pkce();
      const request = await codeWorld.service.beginAuthorization(browser, {
        clientId: CLIENT,
        resource: RESOURCE,
        scopes: [READ],
        redirectUri: REDIRECT,
        codeChallenge: proof.challenge,
        codeChallengeMethod: "S256",
      });
      const approved = await codeWorld.service.approve(browser, {
        requestId: request.requestId,
        decision: "approve",
      });
      if (approved.flow !== "authorization_code")
        throw new Error("Expected authorization redirect");
      const code = new URL(approved.redirectUri).searchParams.get("code");
      if (code === null) throw new Error("Expected code");
      const codeDelayed = createAgentAccess({
        ...codeWorld.options,
        resolvePrincipal: async (principalId) => {
          codeWorld.advance(121);
          return codeWorld.options.resolvePrincipal(principalId);
        },
      });
      await expect(
        codeDelayed.exchangeAuthorizationCode({
          clientId: CLIENT,
          resource: RESOURCE,
          code,
          redirectUri: REDIRECT,
          codeVerifier: proof.verifier,
        }),
      ).rejects.toMatchObject({ code: "invalid_grant" });
    });
  });
}
