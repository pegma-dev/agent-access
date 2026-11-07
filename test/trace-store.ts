import type {
  CollectionDefinition,
  CollectionStore,
  EntityKey,
  Store,
  StoredRecord,
  TransactionAction,
  TransactionOutcome,
} from "@pegma/storage-core";

export interface TransactionTrace {
  readonly collection: string;
  readonly partition: string;
  readonly actions: readonly {
    readonly action: TransactionAction<unknown>["action"];
    readonly key: EntityKey;
    readonly record?: StoredRecord;
  }[];
}

export interface ReadTrace {
  readonly collection: string;
  readonly method: "get" | "getVersioned";
  readonly key: EntityKey;
}

/** Instrument the real adapter, including native transactions and persisted bytes. */
export function traceStore(backing: Store) {
  const transactions: TransactionTrace[] = [];
  const reads: ReadTrace[] = [];
  const enumerations: {
    collection: string;
    method: "list" | "listVersioned" | "scan";
  }[] = [];
  const snapshots = new Map<
    string,
    () => Promise<readonly { key: EntityKey; record: StoredRecord }[]>
  >();
  let intercept:
    | ((
        trace: TransactionTrace,
        commit: () => Promise<TransactionOutcome>,
      ) => Promise<TransactionOutcome>)
    | undefined;
  let beforeRead: ((trace: ReadTrace) => Promise<void>) | undefined;
  const store: Store = {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      const target = backing.collection(definition);
      snapshots.set(definition.name, async () => {
        const rows: { key: EntityKey; record: StoredRecord }[] = [];
        let cursor: string | undefined;
        for (let pageNumber = 0; pageNumber < 8; pageNumber += 1) {
          const page = await target.scan({
            limit: 1_000,
            ...(cursor === undefined ? {} : { cursor }),
          });
          rows.push(
            ...page.records.map(({ key, value }) => ({
              key,
              record: definition.codec.encode(value),
            })),
          );
          if (page.nextCursor === null) return rows;
          cursor = page.nextCursor;
        }
        throw new Error(
          "Synthetic persisted-byte observation exceeded its bound",
        );
      });
      return {
        async get(key) {
          const trace: ReadTrace = {
            collection: definition.name,
            method: "get",
            key: structuredClone(key),
          };
          reads.push(trace);
          await beforeRead?.(trace);
          return target.get(key);
        },
        async getVersioned(key) {
          const trace: ReadTrace = {
            collection: definition.name,
            method: "getVersioned",
            key: structuredClone(key),
          };
          reads.push(trace);
          await beforeRead?.(trace);
          return target.getVersioned(key);
        },
        insertIfAbsent: (value) => target.insertIfAbsent(value),
        put: (value) => target.put(value),
        putIfUnchanged: (value, version) =>
          target.putIfUnchanged(value, version),
        update: (key, decide, options) => target.update(key, decide, options),
        list(partition) {
          enumerations.push({ collection: definition.name, method: "list" });
          return target.list(partition);
        },
        listVersioned(partition) {
          enumerations.push({
            collection: definition.name,
            method: "listVersioned",
          });
          return target.listVersioned(partition);
        },
        scan(options) {
          enumerations.push({ collection: definition.name, method: "scan" });
          return target.scan(options);
        },
        delete: (key) => target.delete(key),
        deleteIfUnchanged: (key, version) =>
          target.deleteIfUnchanged(key, version),
        async transact(partition, actions) {
          const trace: TransactionTrace = {
            collection: definition.name,
            partition,
            actions: actions.map((action) =>
              action.action === "delete"
                ? { action: action.action, key: structuredClone(action.key) }
                : {
                    action: action.action,
                    key: definition.key(action.value),
                    record: definition.codec.encode(action.value),
                  },
            ),
          };
          transactions.push(structuredClone(trace));
          const commit = () => target.transact(partition, actions);
          return intercept === undefined ? commit() : intercept(trace, commit);
        },
      };
    },
  };
  return {
    store,
    transactions,
    reads,
    enumerations,
    intercept: (handler: typeof intercept) => {
      intercept = handler;
    },
    beforeRead: (handler: typeof beforeRead) => {
      beforeRead = handler;
    },
    snapshot: async () =>
      await Promise.all(
        [...snapshots].map(async ([collection, scan]) => ({
          collection,
          rows: await scan(),
        })),
      ),
  };
}

/** A manual barrier prevents timing-dependent concurrency tests. */
export function barrier() {
  let release = () => {};
  let announce = () => {};
  const reached = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    reached,
    wait: () => {
      announce();
      return waiting;
    },
    release: () => release(),
  };
}
