import assert from "node:assert/strict";
import type { Server } from "node:http";
import test from "node:test";

import type { AppConfig } from "../lib/config.js";
import { startApplication, toApiDataService } from "./runtime.js";

function requireResolver(value: (() => void) | null): () => void {
  if (value === null) {
    throw new Error("resolver was not assigned");
  }
  return value;
}

const BASE_CONFIG: AppConfig = {
  chronikUrl: "https://example.invalid",
  sqlitePath: ":memory:",
  serverPort: 8787,
  activeGroupPageSize: 50,
  historyPageSize: 50,
  tailPageCount: 2,
  pollIntervalMs: 60_000,
  discoveryIntervalMs: 60_000,
  tipRefreshIntervalMs: 60_000,
  bootstrapConcurrency: 1,
  apiPageSizeDefault: 50,
  apiPageSizeMax: 200,
  requestTimeoutMs: 5_000,
  requestRetryCount: 2,
  wsConnectTimeoutMs: 5_000,
};

function makeService() {
  return {
    start: async () => {},
    stop: () => {},
    isReady: () => true,
    getStatus: () => ({
      ready: true,
      phase: "ready" as const,
      wsConnected: true,
      chronikUrl: BASE_CONFIG.chronikUrl,
      dbPath: BASE_CONFIG.sqlitePath,
      dbSizeBytes: null,
      startedAt: "2026-04-15T00:00:00.000Z",
      statusDate: "2026-04-15",
      statusTimezone: "Asia/Shanghai",
      tipHeight: 900_000,
      totalTrackedTokenCount: 1,
      activeTokenCount: 1,
      readyTokenCount: 1,
      tradedTokenCount: 1,
      discoveredTodayCount: 1,
      activeDiscoveredTodayCount: 1,
      bootstrapTokenCount: 1,
      bootstrapReadyCount: 1,
      discoveryPageCount: 1,
      lastDiscoveryAt: null,
      lastTipUpdateAt: null,
      lastError: null,
    }),
    listTokens: () => ({ page: 1, pageSize: 50, total: 0, items: [] }),
    getToken: () => null,
    listTokenTrades: (_tokenId: string, query: { page: number; pageSize: number }) => ({
      page: query.page,
      pageSize: query.pageSize,
      total: 0,
      items: [],
    }),
    listTrades: (query: { page: number; pageSize: number }) => ({
      page: query.page,
      pageSize: query.pageSize,
      total: 0,
      items: [],
    }),
  };
}

test("startApplication waits for bootstrap before listening", async () => {
  const steps: string[] = [];
  let releaseStart: (() => void) | null = null;
  const waitForStart = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  const service = {
    ...makeService(),
    start: async () => {
      steps.push("start-begin");
      await waitForStart;
      steps.push("start-end");
    },
  };
  const fakeServer = {} as Server;

  const runtimePromise = startApplication(
    service as never,
    BASE_CONFIG,
    {
      logger: { info: () => {}, error: () => {} },
      createServer: () => {
        steps.push("create-server");
        return fakeServer;
      },
      listen: async () => {
        steps.push("listen");
      },
      closeServer: async () => {},
    },
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(steps, ["start-begin"]);

  requireResolver(releaseStart)();
  const runtime = await runtimePromise;

  assert.deepEqual(steps, ["start-begin", "start-end", "create-server", "listen"]);
  await runtime.close();
});

test("startApplication stops the service when listen fails", async () => {
  let stopped = false;
  let closed = false;
  const service = {
    ...makeService(),
    stop: () => {
      stopped = true;
    },
  };

  await assert.rejects(
    startApplication(service as never, BASE_CONFIG, {
      logger: { info: () => {}, error: () => {} },
      createServer: () => ({}) as Server,
      listen: async () => {
        throw new Error("listen failed");
      },
      closeServer: async () => {
        closed = true;
      },
    }),
    /listen failed/,
  );

  assert.equal(stopped, true);
  assert.equal(closed, true);
});

test("toApiDataService exposes the service read surface", () => {
  const service = makeService();
  const api = toApiDataService(service as never);

  assert.equal(api.isHealthy?.(), true);
  assert.equal(api.isReady(), true);
  assert.equal(api.getStatus().readyTokenCount, 1);
  assert.deepEqual(api.listTokens({ page: 1, pageSize: 50 }).items, []);
});
