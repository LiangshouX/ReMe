import assert from "node:assert/strict";
import test from "node:test";

import { createNodeRunner } from "../dist/environment/host/runner.js";

test("a timeout settles with an explicit error instead of hanging", async () => {
  // The child ignores SIGTERM, so the grace path must force it and settle.
  const run = createNodeRunner({ PATH: process.env.PATH });
  const started = Date.now();
  const result = await run(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { timeoutMs: 200 },
  );
  assert.match(result.error, /timed out after 200 ms/);
  assert.ok(
    Date.now() - started < 5_000,
    "the probe must not wait for a process that never closes",
  );
});

test("a child that exits on SIGTERM is still reported as a timeout", async () => {
  const run = createNodeRunner({ PATH: process.env.PATH });
  const result = await run(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { timeoutMs: 200 },
  );
  assert.match(result.error ?? "", /timed out after 200 ms/);
});
