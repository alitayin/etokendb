import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "./config.js";

test("config supports ordered Chronik failover URLs and hourly discovery", () => {
  const originalUrls = process.env.CHRONIK_URLS;
  const originalUrl = process.env.CHRONIK_URL;
  const originalDiscoveryInterval = process.env.DISCOVERY_INTERVAL_MS;
  const originalServerHost = process.env.SERVER_HOST;
  const originalReadinessMaxTipAge = process.env.READINESS_MAX_TIP_AGE_MS;
  const originalBlockCatchupBatchSize = process.env.BLOCK_CATCHUP_BATCH_SIZE;

  try {
    process.env.CHRONIK_URLS =
      "http://127.0.0.1:8331, https://chronik-native1.fabien.cash";
    process.env.CHRONIK_URL = "https://legacy.invalid";
    delete process.env.DISCOVERY_INTERVAL_MS;
    delete process.env.SERVER_HOST;
    delete process.env.READINESS_MAX_TIP_AGE_MS;
    delete process.env.BLOCK_CATCHUP_BATCH_SIZE;

    const config = loadConfig();

    assert.equal(config.chronikUrl, "http://127.0.0.1:8331");
    assert.deepEqual(config.chronikUrls, [
      "http://127.0.0.1:8331",
      "https://chronik-native1.fabien.cash",
    ]);
    assert.equal(config.discoveryIntervalMs, 60 * 60_000);
    assert.equal(config.discoveryPageDelayMs, 100);
    assert.equal(config.serverHost, "127.0.0.1");
    assert.equal(config.readinessMaxTipAgeMs, 5 * 60_000);
    assert.equal(config.blockCatchUpBatchSize, 100);
  } finally {
    if (originalUrls === undefined) {
      delete process.env.CHRONIK_URLS;
    } else {
      process.env.CHRONIK_URLS = originalUrls;
    }
    if (originalUrl === undefined) {
      delete process.env.CHRONIK_URL;
    } else {
      process.env.CHRONIK_URL = originalUrl;
    }
    if (originalDiscoveryInterval === undefined) {
      delete process.env.DISCOVERY_INTERVAL_MS;
    } else {
      process.env.DISCOVERY_INTERVAL_MS = originalDiscoveryInterval;
    }
    if (originalServerHost === undefined) {
      delete process.env.SERVER_HOST;
    } else {
      process.env.SERVER_HOST = originalServerHost;
    }
    if (originalReadinessMaxTipAge === undefined) {
      delete process.env.READINESS_MAX_TIP_AGE_MS;
    } else {
      process.env.READINESS_MAX_TIP_AGE_MS = originalReadinessMaxTipAge;
    }
    if (originalBlockCatchupBatchSize === undefined) {
      delete process.env.BLOCK_CATCHUP_BATCH_SIZE;
    } else {
      process.env.BLOCK_CATCHUP_BATCH_SIZE = originalBlockCatchupBatchSize;
    }
  }
});
