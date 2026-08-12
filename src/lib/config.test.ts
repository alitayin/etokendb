import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "./config.js";

test("config supports ordered Chronik failover URLs and hourly discovery", () => {
  const originalUrls = process.env.CHRONIK_URLS;
  const originalUrl = process.env.CHRONIK_URL;
  const originalDiscoveryInterval = process.env.DISCOVERY_INTERVAL_MS;

  try {
    process.env.CHRONIK_URLS =
      "http://127.0.0.1:8331, https://chronik-native1.fabien.cash";
    process.env.CHRONIK_URL = "https://legacy.invalid";
    delete process.env.DISCOVERY_INTERVAL_MS;

    const config = loadConfig();

    assert.equal(config.chronikUrl, "http://127.0.0.1:8331");
    assert.deepEqual(config.chronikUrls, [
      "http://127.0.0.1:8331",
      "https://chronik-native1.fabien.cash",
    ]);
    assert.equal(config.discoveryIntervalMs, 60 * 60_000);
    assert.equal(config.discoveryPageDelayMs, 100);
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
  }
});
