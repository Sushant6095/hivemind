// The demo reader. A judge's first frame is served entirely by this code path,
// and it has no server to correct it: if the filter is loose the board shows
// another space's rows, if the sort is backwards the "live feed" reads oldest-
// first, and nothing visibly breaks. These are the tests that catch that.

import test from "node:test";
import assert from "node:assert/strict";
import { matches, sortRows, demoSource } from "../src/api/demoSource.js";

const SNAP = {
  Decision: [
    { id: "d1", space_id: "s1", title: "Goa Aug 14", created_date: "2026-07-20T10:00:00Z" },
    { id: "d2", space_id: "s1", title: "Villa over hotel", created_date: "2026-07-22T10:00:00Z" },
    { id: "d3", space_id: "s2", title: "Somebody else's space", created_date: "2026-07-23T10:00:00Z" },
  ],
  RawMessage: [
    { id: "m1", space_id: "s1", tg_message_id: 7, sent_at: "2026-07-20T09:00:00Z" },
    { id: "m2", space_id: "s1", tg_message_id: 9, sent_at: "2026-07-21T09:00:00Z" },
  ],
};

test("matches is an AND across every key the caller asked for", () => {
  assert.equal(matches({ a: 1, b: 2 }, { a: 1 }), true);
  assert.equal(matches({ a: 1, b: 2 }, { a: 1, b: 2 }), true);
  assert.equal(matches({ a: 1, b: 2 }, { a: 1, b: 3 }), false);
});

test("an empty or absent query matches everything", () => {
  // filter(name) with no `where` is how LiveFeed backfills; it must not return [].
  assert.equal(matches({ a: 1 }, {}), true);
  assert.equal(matches({ a: 1 }, undefined), true);
});

test("a key the row does not have never matches", () => {
  // The safe direction: an unsupported query returns nothing, not everything.
  assert.equal(matches({ a: 1 }, { nope: "x" }), false);
});

test("matching is string-coerced, because message ids arrive both ways", () => {
  // source_msg_ids holds strings; RawMessage.tg_message_id is stored as a number.
  // Provenance joins those two, so 7 and "7" must be the same key.
  assert.equal(matches({ tg_message_id: 7 }, { tg_message_id: "7" }), true);
  assert.equal(matches({ tg_message_id: "7" }, { tg_message_id: 7 }), true);
  assert.equal(matches({ tg_message_id: 7 }, { tg_message_id: "70" }), false);
});

test("`-field` sorts newest first and `field` oldest first", () => {
  const rows = SNAP.RawMessage;
  assert.deepEqual(sortRows(rows, "-sent_at").map((r) => r.id), ["m2", "m1"]);
  assert.deepEqual(sortRows(rows, "sent_at").map((r) => r.id), ["m1", "m2"]);
});

test("sorting never mutates the caller's array", () => {
  // The snapshot is shared by every panel; an in-place sort in one would
  // silently reorder the others.
  const rows = [...SNAP.RawMessage];
  sortRows(rows, "-sent_at");
  assert.deepEqual(rows.map((r) => r.id), ["m1", "m2"]);
});

test("no sort argument leaves the order exactly as stored", () => {
  assert.deepEqual(sortRows(SNAP.RawMessage, undefined).map((r) => r.id), ["m1", "m2"]);
  assert.deepEqual(sortRows(SNAP.RawMessage, "").map((r) => r.id), ["m1", "m2"]);
});

test("the demo source scopes reads to the space it was asked for", async () => {
  const src = demoSource(SNAP);
  const rows = await src.filter("Decision", { space_id: "s1" });
  assert.deepEqual(rows.map((r) => r.id).sort(), ["d1", "d2"]);
});

test("filter, sort and limit compose the way the panels call them", async () => {
  const src = demoSource(SNAP);
  const rows = await src.filter("Decision", { space_id: "s1" }, "-created_date", 1);
  assert.deepEqual(rows.map((r) => r.id), ["d2"]);
});

test("an entity absent from the snapshot reads as empty, not as a crash", async () => {
  // The `demo` function only sends the five compiled kinds plus RawMessage.
  // A panel asking for anything else must render its empty state, not throw.
  const src = demoSource(SNAP);
  assert.deepEqual(await src.filter("ImportJob", { space_id: "s1" }), []);
  assert.deepEqual(await demoSource(null).filter("Decision", {}), []);
});

test("the demo source announces itself so components can be honest about it", () => {
  // Board refuses writes and LiveFeed drops its "live" wording off this flag.
  assert.equal(demoSource(SNAP).demo, true);
});

test("subscribe is a no-op that still returns a real unsubscribe", () => {
  // Every panel calls the returned function on unmount. Returning undefined
  // here would throw on teardown — in the demo, on the judge's screen.
  const off = demoSource(SNAP).subscribe("Decision", () => {});
  assert.equal(typeof off, "function");
  assert.doesNotThrow(() => off());
});
