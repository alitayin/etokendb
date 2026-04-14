import assert from "node:assert/strict";
import test from "node:test";

import { parseServerCliOptions } from "./serverOptions.js";

test("parseServerCliOptions supports zero-trade bootstrap skip flag", () => {
  assert.deepEqual(parseServerCliOptions([]), {
    skipKnownZeroTradeBootstrap: false,
  });

  assert.deepEqual(
    parseServerCliOptions(["--skip-known-zero-trade-bootstrap"]),
    {
      skipKnownZeroTradeBootstrap: true,
    },
  );
});

test("parseServerCliOptions rejects unknown arguments", () => {
  assert.throws(
    () => parseServerCliOptions(["--wat"]),
    /Unknown argument: --wat/,
  );
});
