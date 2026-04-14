import assert from "node:assert/strict";
import test from "node:test";

import { DirtyTokenQueue } from "./dirtyTokenQueue.js";

test("DirtyTokenQueue coalesces duplicate dirty marks", () => {
  const queue = new DirtyTokenQueue();

  queue.markDirty("token-a");
  queue.markDirty("token-a");

  assert.equal(queue.pendingCount(), 1);
  assert.deepEqual(queue.takeNext(), ["token-a"]);
  queue.markCompleted("token-a");
  assert.equal(queue.hasPending(), false);
});

test("DirtyTokenQueue reruns token dirtied during in-flight sync", () => {
  const queue = new DirtyTokenQueue();

  queue.markDirty("token-a");
  assert.deepEqual(queue.takeNext(), ["token-a"]);

  queue.markDirty("token-a");
  assert.equal(queue.hasPending(), false);

  queue.markCompleted("token-a");
  assert.equal(queue.hasPending(), true);
  assert.deepEqual(queue.takeNext(), ["token-a"]);
  queue.markCompleted("token-a");

  assert.equal(queue.hasPending(), false);
});
