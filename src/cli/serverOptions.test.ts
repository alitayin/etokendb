import assert from "node:assert/strict";
import test from "node:test";

import { parseServerCliOptions } from "./serverOptions.js";

test("parseServerCliOptions supports zero-trade bootstrap skip flag", () => {
  assert.deepEqual(parseServerCliOptions([]), {
    deferKnownTradeCountLte: null,
  });

  assert.deepEqual(
    parseServerCliOptions(["--skip-known-zero-trade-bootstrap"]),
    {
      deferKnownTradeCountLte: 0,
    },
  );

  assert.deepEqual(
    parseServerCliOptions(["--defer-known-trade-count-lte", "1"]),
    {
      deferKnownTradeCountLte: 1,
    },
  );

  assert.deepEqual(
    parseServerCliOptions(["--defer-known-trade-count-lte=3"]),
    {
      deferKnownTradeCountLte: 3,
    },
  );
});

test("parseServerCliOptions rejects unknown arguments", () => {
  assert.throws(
    () => parseServerCliOptions(["--wat"]),
    /Unknown argument: --wat/,
  );

  assert.throws(
    () => parseServerCliOptions(["--defer-known-trade-count-lte", "-1"]),
    /must be a non-negative integer/,
  );
});
