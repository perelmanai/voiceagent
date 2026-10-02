import test from "node:test";
import assert from "node:assert/strict";
import { waitWithAbort } from "./agent-abort.ts";

test("stop interrupts pending memory lookup instead of waiting for the API", async () => {
  const controller = new AbortController();
  const pendingLookup = new Promise(() => {});
  const stopped = waitWithAbort(pendingLookup, controller.signal);
  controller.abort(new Error("Stopped by user"));
  await assert.rejects(stopped, /Stopped by user/);
});

test("already cancelled setup consumes a later background failure", async () => {
  const controller = new AbortController();
  controller.abort(new Error("Stopped by user"));
  let failLookup;
  const lookup = new Promise((_resolve, reject) => { failLookup = reject; });
  await assert.rejects(waitWithAbort(lookup, controller.signal), /Stopped by user/);
  failLookup(new Error("Late network failure"));
  await new Promise((resolve) => setImmediate(resolve));
});

test("normal setup and real failures retain their original results", async () => {
  const signal = new AbortController().signal;
  assert.equal(await waitWithAbort(Promise.resolve("memory"), signal), "memory");
  await assert.rejects(waitWithAbort(Promise.reject(new Error("Lookup failed")), signal), /Lookup failed/);
});
