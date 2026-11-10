import {
  OAuthError,
  type BrowserApprovalContext,
  type GrantView,
} from "@pegma/agent-access";
import type { AccessContext } from "@pegma/authorization-core";
import {
  createMemoryStore,
  defineCollection,
  type StoredRecord,
} from "@pegma/storage-core";
import { describe, expect, it } from "vitest";
import {
  access,
  admin,
  browser,
  CLIENT,
  fixture,
  OTHER_CLIENT,
  pkce,
  READ,
  REDIRECT,
  RESOURCE,
  SCOPES,
  WRITE,
} from "../test/fixtures.js";
import { storeFactories } from "../test/stores.js";
import { traceStore } from "../test/trace-store.js";

const OWNER_INDEX = "agent-access.owner-index.v1";
/** Documented listing bounds. */
const DEFAULT_GRANT_PAGE_SIZE = 20;
const MAX_GRANT_PAGE_SIZE = 100;
const VIEW_KEYS = [
  "clientId",
  "createdAt",
  "expiresAt",
  "grantId",
  "ownerId",
  "resource",
  "scopes",
  "status",
].sort();

const other = access(undefined, "staff/second-admin");
const otherBrowser: BrowserApprovalContext = {
  authentication: "browser-session",
  access: other,
};

async function rejected(work: Promise<unknown>): Promise<OAuthError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof OAuthError) return error;
    throw error;
  }
  throw new Error("Expected an OAuth error");
}

/** Approve one device grant as a specific administrator. */
async function approveDeviceAs(
  world: ReturnType<typeof fixture>,
  context: BrowserApprovalContext,
  current: AccessContext,
  clientId = CLIENT,
) {
  const previous = world.authority.current;
  world.authority.current = current;
  try {
    const device = await world.service.beginDeviceAuthorization({
      clientId,
      resource: RESOURCE,
      scopes: [READ],
    });
    const approval = await world.service.getDeviceApproval(
      context,
      device.user_code,
    );
    await world.service.approve(context, {
      requestId: approval.requestId,
      decision: "approve",
      userCode: device.user_code,
    });
    return { device, grantId: approval.requestId };
  } finally {
    world.authority.current = previous;
  }
}

async function everyPage(
  world: ReturnType<typeof fixture>,
  limit: number,
  context = browser,
  ownerPrincipal = admin.principalId,
) {
  const pages: (readonly GrantView[])[] = [];
  let cursor: string | undefined;
  for (let index = 0; index < 50; index += 1) {
    const page = await world.service.listGrants(context, {
      ownerPrincipal,
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    pages.push(page.grants);
    if (page.nextCursor === null) return pages;
    cursor = page.nextCursor;
  }
  throw new Error("Listing did not terminate");
}

for (const [backend, makeStore] of storeFactories) {
  describe(`${backend}: owner-scoped grant listing`, () => {
    it("pages approved grants newest first with bounded keyed reads", async () => {
      const traced = traceStore(await makeStore());
      const world = fixture(traced.store);
      const created: string[] = [];
      for (let index = 0; index < 3; index += 1)
        created.push((await world.completeDevice([READ])).approval.requestId);
      for (let index = 0; index < 2; index += 1)
        created.push(
          (await world.completeAuthorization([READ, WRITE])).approval.requestId,
        );
      traced.reads.length = 0;
      traced.transactions.length = 0;
      const pages = await everyPage(world, 2);
      // Each page: one owner head plus at most two keyed reads per examined entry.
      expect(traced.reads.length).toBeLessThanOrEqual(3 * (1 + 2 * 2));
      expect(traced.enumerations).toEqual([]);
      expect(traced.transactions).toEqual([]);
      expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
      expect(pages.flat().map((grant) => grant.grantId)).toEqual(
        [...created].reverse(),
      );
      for (const grant of pages.flat()) {
        expect(Object.keys(grant).sort()).toEqual(VIEW_KEYS);
        expect(grant.ownerId).toBe(admin.principalId);
        expect(grant.status).toBe("active");
        expect(grant).toEqual(
          await world.service.getGrant(browser, grant.grantId),
        );
      }
    });

    it("lists, revokes through the listed ID, and reflects the new status", async () => {
      const world = fixture(await makeStore());
      const first = await world.completeDevice([READ]);
      await world.completeAuthorization([READ]);
      const listed = await world.service.listGrants(browser, {
        ownerPrincipal: admin.principalId,
      });
      expect(listed.grants).toHaveLength(2);
      const target = listed.grants.find(
        (grant) => grant.grantId === first.approval.requestId,
      );
      if (target === undefined) throw new Error("Expected listed grant");
      await world.service.revokeGrant(browser, target.grantId);
      const after = await world.service.listGrants(browser, {
        ownerPrincipal: admin.principalId,
      });
      expect(
        after.grants.find((grant) => grant.grantId === target.grantId)?.status,
      ).toBe("revoked");
      const active = await world.service.listGrants(browser, {
        ownerPrincipal: admin.principalId,
        statuses: ["active"],
      });
      expect(active.grants.map((grant) => grant.grantId)).not.toContain(
        target.grantId,
      );
      expect(active.grants).toHaveLength(1);
      expect(
        (
          await rejected(
            world.service.authenticate({
              token: first.tokens.access_token,
              resource: RESOURCE,
            }),
          )
        ).code,
      ).toBe("invalid_token");
    });

    it("indexes grants stored before listing existed with a bounded idempotent backfill", async () => {
      const store = await makeStore();
      const world = fixture(store);
      const created: string[] = [];
      for (let index = 0; index < 4; index += 1)
        created.push((await world.completeDevice([READ])).approval.requestId);
      await world.service.beginDeviceAuthorization({
        clientId: CLIENT,
        resource: RESOURCE,
        scopes: [READ],
      });
      // Remove the owner index to reproduce records written by an earlier release.
      const raw = store.collection(
        defineCollection<StoredRecord>({
          name: OWNER_INDEX,
          key: (record) => ({
            partition: String(record.recordPartition),
            id: String(record.recordId),
          }),
          codec: { encode: (record) => record, decode: (record) => record },
        }),
      );
      const indexRows = await raw.scan({ limit: 1_000 });
      expect(indexRows.records).toHaveLength(9);
      for (const row of indexRows.records) await raw.delete(row.key);

      expect(
        await world.service.listGrants(browser, {
          ownerPrincipal: admin.principalId,
        }),
      ).toEqual({ grants: [], nextCursor: null });
      // Keyed inspection and revocation never depended on the index.
      expect(
        (await world.service.getGrant(browser, created[0] as string)).status,
      ).toBe("active");

      let indexed = 0;
      let scanned = 0;
      let cursor: string | undefined;
      let terminated = false;
      for (let index = 0; index < 100; index += 1) {
        const result = await world.service.backfillGrantIndex({
          limit: 3,
          ...(cursor === undefined ? {} : { cursor }),
        });
        expect(result.scanned).toBeLessThanOrEqual(3);
        indexed += result.indexed;
        scanned += result.scanned;
        if (result.nextCursor === null) {
          terminated = true;
          break;
        }
        cursor = result.nextCursor;
      }
      // The documented maintenance loop must reach a null continuation.
      expect(terminated).toBe(true);
      expect(indexed).toBe(4);
      expect(scanned).toBeGreaterThan(4);
      const rerun = await world.service.backfillGrantIndex({ limit: 1_000 });
      expect(rerun.indexed).toBe(0);
      const listed = await world.service.listGrants(browser, {
        ownerPrincipal: admin.principalId,
      });
      expect(listed.grants.map((grant) => grant.grantId).sort()).toEqual(
        [...created].sort(),
      );
      await world.service.revokeGrant(browser, created[1] as string);
      expect(
        (
          await world.service.listGrants(browser, {
            ownerPrincipal: admin.principalId,
            statuses: ["revoked"],
          })
        ).grants.map((grant) => grant.grantId),
      ).toEqual([created[1]]);
      for (const input of [
        { limit: 0 },
        { limit: 1_001 },
        { cursor: "" },
        { other: 1 },
      ])
        expect(
          (
            await rejected(
              world.service.backfillGrantIndex(
                input as Parameters<typeof world.service.backfillGrantIndex>[0],
              ),
            )
          ).code,
        ).toBe("invalid_request");
    });

    it("tolerates index entries whose grant was removed by host retention", async () => {
      const store = await makeStore();
      const world = fixture(store);
      const kept = await world.completeDevice([READ]);
      const removed = await world.completeDevice([READ]);
      const raw = store.collection(
        defineCollection<StoredRecord>({
          name: "agent-access.records.v1",
          key: (record) => ({
            partition: String(record.recordPartition),
            id: String(record.recordId),
          }),
          codec: { encode: (record) => record, decode: (record) => record },
        }),
      );
      for (const row of await raw.list(removed.approval.requestId))
        await raw.delete({
          partition: removed.approval.requestId,
          id: String(row.recordId),
        });
      const listed = await world.service.listGrants(browser, {
        ownerPrincipal: admin.principalId,
      });
      expect(listed.grants.map((grant) => grant.grantId)).toEqual([
        kept.approval.requestId,
      ]);
      const serialized = JSON.stringify(listed);
      for (const secret of [
        kept.tokens.access_token,
        kept.tokens.refresh_token,
        kept.device.device_code,
      ])
        expect(serialized).not.toContain(secret);
      expect(serialized).not.toMatch(/Hash|consentFingerprint|codeChallenge/);
    });
  });
}

describe("grant listing bounds and isolation", () => {
  it("applies a conservative default and a hard maximum page size", async () => {
    const world = fixture(createMemoryStore());
    for (let index = 0; index < DEFAULT_GRANT_PAGE_SIZE + 1; index += 1)
      await world.completeDevice([READ]);
    const first = await world.service.listGrants(browser, {
      ownerPrincipal: admin.principalId,
    });
    expect(first.grants).toHaveLength(DEFAULT_GRANT_PAGE_SIZE);
    expect(first.nextCursor).not.toBeNull();
    const all = await world.service.listGrants(browser, {
      ownerPrincipal: admin.principalId,
      limit: MAX_GRANT_PAGE_SIZE,
    });
    expect(all.grants).toHaveLength(DEFAULT_GRANT_PAGE_SIZE + 1);
    expect(all.nextCursor).toBeNull();
    for (const limit of [0, -1, 1.5, MAX_GRANT_PAGE_SIZE + 1, Number.NaN, "2"])
      expect(
        (
          await rejected(
            world.service.listGrants(browser, {
              ownerPrincipal: admin.principalId,
              limit: limit as number,
            }),
          )
        ).code,
      ).toBe("invalid_request");
  });

  it("never returns another owner's grants or accepts another owner's cursor", async () => {
    const traced = traceStore(createMemoryStore());
    const world = fixture(traced.store);
    const mine: string[] = [];
    for (let index = 0; index < 3; index += 1)
      mine.push((await world.completeDevice([READ])).approval.requestId);
    const theirs: string[] = [];
    for (let index = 0; index < 2; index += 1)
      theirs.push(
        (await approveDeviceAs(world, otherBrowser, other, OTHER_CLIENT))
          .grantId,
      );

    // An approval that fails after its write-ahead index entry leaves a dangling entry.
    const contested = await world.service.beginDeviceAuthorization({
      clientId: CLIENT,
      resource: RESOURCE,
      scopes: [READ],
    });
    const approval = await world.service.getDeviceApproval(
      browser,
      contested.user_code,
    );
    traced.intercept(async (trace, commit) =>
      trace.collection === "agent-access.records.v1" &&
      trace.partition === approval.requestId
        ? { committed: false, reason: "changed" }
        : commit(),
    );
    expect(
      (
        await rejected(
          world.service.approve(browser, {
            requestId: approval.requestId,
            decision: "approve",
            userCode: contested.user_code,
          }),
        )
      ).code,
    ).toBe("server_error");
    traced.intercept(undefined);
    world.authority.current = other;
    await world.service.approve(otherBrowser, {
      requestId: approval.requestId,
      decision: "approve",
      userCode: contested.user_code,
    });
    theirs.push(approval.requestId);
    world.authority.current = admin;

    const minePages = (await everyPage(world, 2, browser)).flat();
    world.authority.current = other;
    const theirPages = (
      await everyPage(world, 2, otherBrowser, other.principalId)
    ).flat();
    world.authority.current = admin;
    // The dangling first-owner entry is filtered by the authoritative head owner.
    expect(minePages.map((grant) => grant.grantId).sort()).toEqual(
      [...mine].sort(),
    );
    expect(theirPages.map((grant) => grant.grantId).sort()).toEqual(
      [...theirs].sort(),
    );
    expect(
      minePages.every((grant) => grant.ownerId === admin.principalId),
    ).toBe(true);

    // A trusted session cannot list a different owner.
    expect(
      (
        await rejected(
          world.service.listGrants(browser, {
            ownerPrincipal: other.principalId,
          }),
        )
      ).code,
    ).toBe("access_denied");

    const myCursor = (
      await world.service.listGrants(browser, {
        ownerPrincipal: admin.principalId,
        limit: 1,
      })
    ).nextCursor;
    if (myCursor === null) throw new Error("Expected a continuation");
    world.authority.current = other;
    expect(
      (
        await rejected(
          world.service.listGrants(otherBrowser, {
            ownerPrincipal: other.principalId,
            cursor: myCursor,
          }),
        )
      ).code,
    ).toBe("invalid_request");
  });

  it("rejects malformed and tampered cursors cleanly", async () => {
    const world = fixture(createMemoryStore());
    for (let index = 0; index < 3; index += 1)
      await world.completeDevice([READ]);
    const page = await world.service.listGrants(browser, {
      ownerPrincipal: admin.principalId,
      limit: 1,
    });
    const cursor = page.nextCursor;
    if (cursor === null) throw new Error("Expected a continuation");
    const [prefix, partition, position, check] = cursor.split(".");
    const tampered = [
      "",
      "garbage",
      `${prefix}.${partition}.${Number(position) + 1}.${check}`,
      `${prefix}.${partition}.${position}.${"A".repeat(22)}`,
      `${prefix}.${"A".repeat(43)}.${position}.${check}`,
      `pgc2.${partition}.${position}.${check}`,
      `${prefix}.${partition}.0${position}.${check}`,
      `${cursor} `,
      cursor + "x".repeat(200),
      42,
      null,
    ];
    for (const value of tampered) {
      const error = await rejected(
        world.service.listGrants(browser, {
          ownerPrincipal: admin.principalId,
          cursor: value as string,
        }),
      );
      expect(error.code).toBe("invalid_request");
      expect(JSON.stringify(error.toJSON())).not.toContain(partition);
    }
    const next = await world.service.listGrants(browser, {
      ownerPrincipal: admin.principalId,
      cursor,
    });
    expect(next.grants).toHaveLength(2);
    expect(next.nextCursor).toBeNull();
  });

  it("validates the owner principal, input shape, filter, and browser authority", async () => {
    const world = fixture(createMemoryStore());
    await world.completeDevice([READ]);
    for (const input of [
      { ownerPrincipal: "" },
      { ownerPrincipal: "staff/\u0000admin" },
      { ownerPrincipal: "x".repeat(513) },
      { ownerPrincipal: 7 },
      { ownerPrincipal: admin.principalId, unknown: true },
      { ownerPrincipal: admin.principalId, statuses: [] },
      { ownerPrincipal: admin.principalId, statuses: ["active", "active"] },
      { ownerPrincipal: admin.principalId, statuses: ["approved"] },
      // Denied requests are never listed, so filtering for them is rejected.
      { ownerPrincipal: admin.principalId, statuses: ["denied"] },
      { ownerPrincipal: admin.principalId, statuses: "active" },
      null,
      [],
    ])
      expect(
        (
          await rejected(
            world.service.listGrants(
              browser,
              input as Parameters<typeof world.service.listGrants>[1],
            ),
          )
        ).code,
      ).toBe("invalid_request");
    const unprivileged = access([...SCOPES]);
    expect(
      (
        await rejected(
          world.service.listGrants(
            { authentication: "browser-session", access: unprivileged },
            { ownerPrincipal: admin.principalId },
          ),
        )
      ).code,
    ).toBe("access_denied");
    world.authority.unavailable = true;
    expect(
      (
        await rejected(
          world.service.listGrants(browser, {
            ownerPrincipal: admin.principalId,
          }),
        )
      ).code,
    ).toBe("server_error");
  });

  it("lists an approved but unredeemed grant as pending, then active once redeemed", async () => {
    const world = fixture(createMemoryStore());
    const device = await world.service.beginDeviceAuthorization({
      clientId: CLIENT,
      resource: RESOURCE,
      scopes: [READ],
    });
    const approval = await world.service.getDeviceApproval(
      browser,
      device.user_code,
    );
    await world.service.approve(browser, {
      requestId: approval.requestId,
      decision: "approve",
      userCode: device.user_code,
    });
    const before = await world.service.listGrants(browser, {
      ownerPrincipal: admin.principalId,
      statuses: ["pending"],
    });
    expect(before.grants.map((grant) => [grant.grantId, grant.status])).toEqual(
      [[approval.requestId, "pending"]],
    );
    expect(before.grants[0]?.scopes.map((scope) => scope.name)).toEqual([READ]);
    world.advance(device.interval);
    await world.service.pollDeviceToken({
      clientId: CLIENT,
      resource: RESOURCE,
      deviceCode: device.device_code,
    });
    const after = await world.service.listGrants(browser, {
      ownerPrincipal: admin.principalId,
    });
    expect(after.grants.map((grant) => grant.status)).toEqual(["active"]);
  });

  it("reports revoked and expired grants with status and omits unapproved or denied requests", async () => {
    const world = fixture(createMemoryStore());
    const revoked = await world.completeDevice([READ]);
    await world.service.revokeGrant(browser, revoked.approval.requestId);
    const active = await world.completeDevice([READ]);
    // An authorization request that was never approved is owned but not linked.
    const proof = await pkce();
    await world.service.beginAuthorization(browser, {
      clientId: CLIENT,
      resource: RESOURCE,
      scopes: [READ],
      redirectUri: REDIRECT,
      codeChallenge: proof.challenge,
      codeChallengeMethod: "S256",
    });
    const denied = await world.service.beginDeviceAuthorization({
      clientId: CLIENT,
      resource: RESOURCE,
      scopes: [READ],
    });
    const deniedView = await world.service.getDeviceApproval(
      browser,
      denied.user_code,
    );
    await world.service.approve(browser, {
      requestId: deniedView.requestId,
      decision: "deny",
      userCode: denied.user_code,
    });
    const listed = await world.service.listGrants(browser, {
      ownerPrincipal: admin.principalId,
    });
    expect(listed.grants.map((grant) => [grant.grantId, grant.status])).toEqual(
      [
        [active.approval.requestId, "active"],
        [revoked.approval.requestId, "revoked"],
      ],
    );
    world.advance(604_800);
    const later = await world.service.listGrants(browser, {
      ownerPrincipal: admin.principalId,
    });
    expect(later.grants.map((grant) => grant.status)).toEqual([
      "expired",
      "revoked",
    ]);
    expect(
      (
        await world.service.listGrants(browser, {
          ownerPrincipal: admin.principalId,
          statuses: ["active"],
        })
      ).grants,
    ).toEqual([]);
  });
});
