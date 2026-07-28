// BM25 retrieval — the ranking that decides what the librarian actually reads,
// and (in process-messages) which open question an incoming answer closes.
// A silent regression here degrades answers without ever throwing.

import test from "node:test";
import assert from "node:assert/strict";
import { loadFunction } from "./harness.mjs";

const { bm25, tok } = await loadFunction("ask", ["bm25", "tok"]);
const docs = (...pairs) => pairs.map(([id, text]) => ({ id, text, meta: {} }));

test("tokeniser lowercases and splits on non-word characters", () => {
  assert.deepEqual(tok("Book THE Flights, now!"), ["book", "flights", "now"]);
});

test("tokeniser drops stopwords and single characters", () => {
  assert.deepEqual(tok("we are in a of on it"), []);
  assert.deepEqual(tok("a b c goa"), ["goa"]);
});

test("tokeniser keeps apostrophes inside words", () => {
  assert.deepEqual(tok("don't book"), ["don't", "book"]);
});

test("tokeniser survives null and undefined", () => {
  assert.deepEqual(tok(null), []);
  assert.deepEqual(tok(undefined), []);
});

test("empty query or empty corpus ranks nothing", () => {
  assert.deepEqual(bm25("", docs(["a", "goa flights"])), []);
  assert.deepEqual(bm25("the of a", docs(["a", "goa flights"])), []); // all stopwords
  assert.deepEqual(bm25("goa", []), []);
});

test("ranks the matching document first", () => {
  const r = bm25("flights to goa", docs(
    ["d1", "we should paint the kitchen ceiling"],
    ["d2", "book the goa flights before friday"],
  ));
  assert.equal(r[0].id, "d2");
});

test("documents with no query term are dropped, not returned at zero", () => {
  const r = bm25("goa", docs(["d1", "kitchen ceiling"], ["d2", "goa trip"]));
  assert.equal(r.length, 1);
  assert.equal(r[0].id, "d2");
  assert.ok(r[0].score > 0);
});

test("a rarer term carries more weight than a common one (IDF)", () => {
  const corpus = docs(
    ["common1", "budget meeting"], ["common2", "budget review"],
    ["common3", "budget notes"],   ["common4", "budget plan"],
    ["rare", "budget kayak"],
  );
  const r = bm25("budget kayak", corpus);
  assert.equal(r[0].id, "rare", "the doc with the rare term must win");
});

test("shorter documents outrank padded ones for the same term (length norm)", () => {
  const r = bm25("goa", docs(
    ["short", "goa"],
    ["long", "goa " + "filler words about unrelated matters ".repeat(20)],
  ));
  assert.equal(r[0].id, "short");
});

test("results are sorted by descending score", () => {
  const r = bm25("goa flights budget", docs(
    ["one", "goa"], ["two", "goa flights"], ["three", "goa flights budget"],
  ));
  const scores = r.map((x) => x.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});

test("k caps the result set", () => {
  const corpus = Array.from({ length: 30 }, (_, i) => ({ id: `d${i}`, text: "goa flights", meta: {} }));
  assert.equal(bm25("goa", corpus, 5).length, 5);
  assert.equal(bm25("goa", corpus).length, 8, "default k is 8");
});

test("matching is case-insensitive", () => {
  const r = bm25("GOA", docs(["d1", "goa trip"]));
  assert.equal(r.length, 1);
});

test("carries id, text and meta through untouched", () => {
  const [hit] = bm25("goa", [{ id: "d1", text: "goa trip", meta: { type: "decision" } }]);
  assert.equal(hit.id, "d1");
  assert.equal(hit.text, "goa trip");
  assert.deepEqual(hit.meta, { type: "decision" });
});

// process-messages closes an open question only when the BM25 score clears
// 0.8. Before that floor existed, "the newest open question" always won and
// answers were attached to the wrong question.
test("answer-to-question matching clears the 0.8 floor for a real match", () => {
  const open = docs(
    ["q1", "who is booking the flights"],
    ["q2", "what should we do about the kitchen renovation"],
  );
  const [hit] = bm25("who is booking the flights", open, 1);
  assert.equal(hit.id, "q1");
  assert.ok(hit.score >= 0.8, `score ${hit.score} should clear the floor`);
});

test("an unrelated answer does not clear the floor against an open question", () => {
  const open = docs(["q1", "what should we do about the kitchen renovation"]);
  const [hit] = bm25("the flights are booked", open, 1);
  assert.ok(!hit || hit.score < 0.8, "unrelated text must not close a question");
});

test("the compiler ships the same ranking as the librarian", async () => {
  const pm = await loadFunction("process-messages", ["bm25"]);
  const corpus = docs(["d1", "book the goa flights"], ["d2", "paint the kitchen"]);
  assert.deepEqual(pm.bm25("goa flights", corpus), bm25("goa flights", corpus));
});
