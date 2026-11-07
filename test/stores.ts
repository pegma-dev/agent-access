import { TableClient } from "@azure/data-tables";
import { createAzureTablesStore } from "@pegma/storage-azure-tables";
import { createMemoryStore, type Store } from "@pegma/storage-core";
import { randomUUID } from "node:crypto";
import { TABLE_PORT } from "./azurite.js";
import { createD1Store } from "./d1.js";

function azureStore(): Store {
  const connection = `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;TableEndpoint=http://127.0.0.1:${TABLE_PORT}/devstoreaccount1;`;
  return createAzureTablesStore({
    client: TableClient.fromConnectionString(
      connection,
      `agentaccess${randomUUID().replaceAll("-", "")}`,
      { allowInsecureConnection: true },
    ),
  });
}

/** The same public lifecycle contracts run against three released adapters. */
export const storeFactories = [
  ["memory", createMemoryStore],
  ["Azurite", azureStore],
  ["Miniflare D1", createD1Store],
] as const;
