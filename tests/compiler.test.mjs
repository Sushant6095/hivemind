// The compiler's concurrency and scheduling machinery: the burst settle timer,
// the ZooKeeper-style lease that admits exactly one compiler per space, and the
// retry schedule the reaper honours.

import test from "node:test";
import assert from "node:assert/strict";
import { loadFunction, fakeEntity, iso } from "./harness.mjs";

const m = await loadFunction("process-messages", [
  "settleMs", "leaseHeld", "acquireLease", "releaseLease", "backoffMs",
  "DEBOUNCE_SECONDS", "FORCE_BATCH_SIZE", "MAX_SETTLE_MS",
  "LEASE_TTL_MS", "RETRY_BASE_MS", "MAX_ATTEMPTS", "DAILY_LLM_CAP",
]);

const msgs = (n, ageSeconds) =>
  Array.from({ length: n }, (_, i) => ({ id: `m${i}`, sent_at: iso(-ageSeconds * 1000) }));

// ── burst settling ────────────────────────────────────────────────────────
test("a full batch compiles immediately regardless of age", () => {
  assert.equal(m.settleMs(msgs(m.FORCE_BATCH_SIZE, 0)), 0);
  assert.equal(m.settleMs(msgs(m.FORCE_BATCH_SIZE + 5, 0)), 0);
});

test("a settled burst compiles immediately", () => {
  assert.equal(m.settleMs(msgs(1, m.DEBOUNCE_SECONDS + 1)), 0);
});

test("a fresh small burst waits out the remainder of the debounce", () => {
  const wait = m.settleMs(msgs(1, 0));
  assert.ok(wait > 0, "must wait");
  assert.ok(wait <= m.DEBOUNCE_SECONDS * 1000, "never longer than the full debounce");
});

test("the wait shrinks as the burst ages", () => {
  assert.ok(m.settleMs(msgs(1, 10)) < m.settleMs(msgs(1, 2)));
});

test("a clock-skewed future timestamp cannot park us forever", () => {
  const future = [{ id: "m0", sent_at: iso(60 * 60 * 1000) }]; // an hour ahead
  assert.equal(m.settleMs(future), m.MAX_SETTLE_MS);
});

test("an unparseable timestamp compiles rather than stalling", () => {
  assert.equal(m.settleMs([{ id: "m0", sent_at: "not a date" }]), 0);
});

test("the debounce is short enough to demo and the batch small enough to trip", () => {
  // A judge types two or three messages and expects to see something happen.
  assert.ok(m.DEBOUNCE_SECONDS <= 20, "debounce must stay demo-sized");
  assert.ok(m.FORCE_BATCH_SIZE <= 3, "a short burst must force a compile");
  assert.ok(m.MAX_SETTLE_MS <= 30_000, "never hold an invocation longer than this");
});

// ── lease ─────────────────────────────────────────────────────────────────
const srWith = (leases) => ({ entities: { Lease: fakeEntity(leases) } });

test("leaseHeld is false with no leases", async () => {
  assert.equal(await m.leaseHeld(srWith([]), "compile:s1"), false);
});

test("leaseHeld is true while a lease is live", async () => {
  const sr = srWith([{ id: "l1", key: "compile:s1", expires_at: iso(60_000) }]);
  assert.equal(await m.leaseHeld(sr, "compile:s1"), true);
});

test("leaseHeld ignores expired leases", async () => {
  const sr = srWith([{ id: "l1", key: "compile:s1", expires_at: iso(-60_000) }]);
  assert.equal(await m.leaseHeld(sr, "compile:s1"), false);
});

test("leaseHeld ignores a lease on a different space", async () => {
  const sr = srWith([{ id: "l1", key: "compile:s2", expires_at: iso(60_000) }]);
  assert.equal(await m.leaseHeld(sr, "compile:s1"), false);
});

test("a failing store reads as not-held rather than crashing the compiler", async () => {
  const sr = { entities: { Lease: { filter: async () => { throw new Error("store down"); } } } };
  assert.equal(await m.leaseHeld(sr, "compile:s1"), false);
});

test("acquireLease takes an uncontended lease and stamps a TTL", async () => {
  const sr = srWith([]);
  const lease = await m.acquireLease(sr, "compile:s1");
  assert.ok(lease, "should acquire");
  assert.equal(lease.key, "compile:s1");
  assert.ok(lease.token, "must carry a fencing token");
  const ttl = new Date(lease.expires_at) - new Date(lease.acquired_at);
  assert.equal(ttl, m.LEASE_TTL_MS);
});

test("acquireLease refuses while another holder is live", async () => {
  const sr = srWith([{ id: "l1", key: "compile:s1", expires_at: iso(60_000) }]);
  assert.equal(await m.acquireLease(sr, "compile:s1"), null);
  assert.equal(sr.entities.Lease.rows.length, 1, "must not have created a second lease");
});

test("acquireLease reaps an expired lease and takes over", async () => {
  const sr = srWith([{ id: "dead", key: "compile:s1", expires_at: iso(-60_000) }]);
  const lease = await m.acquireLease(sr, "compile:s1");
  assert.ok(lease, "a crashed holder must not block forever");
  assert.ok(!sr.entities.Lease.rows.some((l) => l.id === "dead"), "stale lease should be deleted");
});

test("acquireLease loses the create-then-verify race and cleans up after itself", async () => {
  // Base44 entities have no unique index, so two writers can both create.
  // Oldest-wins is settled on the read-back; the loser must delete its row.
  const rows = [];
  let reads = 0;
  const sr = { entities: { Lease: {
    async filter() {
      reads++;
      return reads === 1 ? [] : [{ id: "rival", key: "compile:s1", expires_at: iso(60_000) }, ...rows];
    },
    async create(doc) { const r = { id: "mine", ...doc }; rows.push(r); return r; },
    async delete(id) { const i = rows.findIndex((r) => r.id === id); if (i >= 0) rows.splice(i, 1); return true; },
  } } };
  assert.equal(await m.acquireLease(sr, "compile:s1"), null, "the younger writer must yield");
  assert.equal(rows.length, 0, "and must delete the lease it created");
});

test("releaseLease removes the row and tolerates a missing lease", async () => {
  const sr = srWith([]);
  const lease = await m.acquireLease(sr, "compile:s1");
  await m.releaseLease(sr, lease);
  assert.equal(sr.entities.Lease.rows.length, 0);
  await m.releaseLease(sr, null);       // must not throw
  await m.releaseLease(sr, undefined);  // must not throw
});

test("the lease outlives a worst-case LLM round trip and the settle wait", () => {
  assert.ok(m.LEASE_TTL_MS > m.MAX_SETTLE_MS);
  assert.ok(m.LEASE_TTL_MS >= 120_000);
});

// ── retry schedule ────────────────────────────────────────────────────────
test("backoff doubles from the base delay", () => {
  assert.equal(m.backoffMs(1), m.RETRY_BASE_MS);
  assert.equal(m.backoffMs(2), m.RETRY_BASE_MS * 2);
  assert.equal(m.backoffMs(3), m.RETRY_BASE_MS * 4);
  assert.equal(m.backoffMs(4), m.RETRY_BASE_MS * 8);
});

test("backoff is monotonic and never negative", () => {
  let prev = 0;
  for (let n = 1; n <= m.MAX_ATTEMPTS; n++) {
    const d = m.backoffMs(n);
    assert.ok(d > prev, `attempt ${n} must wait longer than ${n - 1}`);
    prev = d;
  }
  assert.equal(m.backoffMs(0), m.RETRY_BASE_MS, "a bad attempt count must not produce a sub-base delay");
});

test("the queue gives up rather than retrying forever", () => {
  assert.ok(m.MAX_ATTEMPTS >= 3 && m.MAX_ATTEMPTS <= 8);
  assert.ok(m.backoffMs(m.MAX_ATTEMPTS) <= 60 * 60 * 1000, "the last retry must land within the hour");
});

test("the reaper waits longer than the lease before resurrecting a job", async () => {
  const reaper = await loadFunction("compile-reaper", ["STUCK_MS"]);
  assert.ok(reaper.STUCK_MS > m.LEASE_TTL_MS, "resurrecting a job whose lease is still live would double-compile");
});

test("the daily spend cap is a real bound", () => {
  assert.ok(m.DAILY_LLM_CAP > 0 && m.DAILY_LLM_CAP <= 1000);
});
