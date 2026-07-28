// The authorisation gate. These are regression tests for a real hole: the
// membership check used to run inside `if (user?.email)`, so an *unauthenticated*
// caller skipped it entirely and could read any space's compiled memory — or,
// in mark-done, close any commitment — just by supplying a space_id.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { loadFunction, stubDeno } from "./harness.mjs";

const SECRET = "s3cret-webhook-token";
stubDeno({ TG_WEBHOOK_SECRET: SECRET });

const { safeEqual, authorize } = await loadFunction("ask", ["safeEqual", "authorize"]);

const anon = { auth: { me: async () => null } };
const asUser = (email) => ({ auth: { me: async () => ({ email }) } });
const sr = (members) => ({
  entities: { Membership: { filter: async ({ space_id, user_email }) =>
    members.filter((m) => m.space_id === space_id && m.user_email === user_email) } },
});
const MEMBERS = [{ space_id: "space-1", user_email: "sushant@example.com" }];

test("safeEqual accepts an exact match", () => {
  assert.equal(safeEqual("abcdef", "abcdef"), true);
});

test("safeEqual rejects same-length mismatches", () => {
  assert.equal(safeEqual("abcdef", "abcdeg"), false);
  assert.equal(safeEqual("abcdef", "zbcdef"), false);
});

test("safeEqual rejects a correct prefix", () => {
  assert.equal(safeEqual("abcdef", "abc"), false);
  assert.equal(safeEqual("abc", "abcdef"), false);
});

test("safeEqual compares every byte, not just the first difference", () => {
  // XOR-accumulate means the loop never short-circuits on the first mismatch.
  const src = readFileSync("base44/functions/ask/entry.ts", "utf8");
  assert.match(src, /out \|= a\.charCodeAt\(i\) \^ b\.charCodeAt\(i\)/);
  assert.doesNotMatch(src, /for \(let i[^]{0,120}?return false;[^]{0,20}?\}\s*\n\s*return out === 0/);
});

test("the shared secret admits the webhook with no user session", async () => {
  assert.equal(await authorize(anon, sr(MEMBERS), "space-1", SECRET), null);
});

test("an anonymous caller with no key is rejected — the hole this closes", async () => {
  const res = await authorize(anon, sr(MEMBERS), "space-1", undefined);
  assert.ok(res, "must not return null");
  assert.equal(res.status, 401);
});

test("an anonymous caller with a wrong key is rejected", async () => {
  const res = await authorize(anon, sr(MEMBERS), "space-1", "not-the-secret");
  assert.equal(res.status, 401);
});

test("an empty key never authenticates, even against an unset secret", async () => {
  stubDeno({}); // no TG_WEBHOOK_SECRET configured
  const res = await authorize(anon, sr(MEMBERS), "space-1", "");
  assert.equal(res.status, 401, "'' must not equal ''");
  stubDeno({ TG_WEBHOOK_SECRET: SECRET });
});

test("a signed-in member of the space is admitted", async () => {
  assert.equal(await authorize(asUser("sushant@example.com"), sr(MEMBERS), "space-1"), null);
});

test("a signed-in non-member gets 403, not 401", async () => {
  const res = await authorize(asUser("stranger@example.com"), sr(MEMBERS), "space-1");
  assert.equal(res.status, 403);
});

test("membership in one space grants nothing in another", async () => {
  const res = await authorize(asUser("sushant@example.com"), sr(MEMBERS), "space-2");
  assert.equal(res.status, 403);
});

test("a thrown auth.me() is treated as anonymous, not as a bypass", async () => {
  const broken = { auth: { me: async () => { throw new Error("session service down"); } } };
  const res = await authorize(broken, sr(MEMBERS), "space-1");
  assert.equal(res.status, 401);
});

// --- the derived gate audit -------------------------------------------------
// The dangerous shape is a function that takes a space_id *from the caller* and
// then reads or writes that space. Listing those functions by hand is exactly
// the mistake this file exists to catch, so the list is derived from the source
// on every run: add a new function tomorrow that trusts a request space_id and
// this test fails until it proves membership.

const FN_DIRS = readdirSync("base44/functions").filter((d) =>
  existsSync(`base44/functions/${d}/entry.ts`)
);
const srcOf = (fn) => readFileSync(`base44/functions/${fn}/entry.ts`, "utf8");

// `const { space_id } = await req.json()` and its variants.
const TAKES_CALLER_SPACE_ID = /\{[^}]*space_id[^}]*\}\s*=\s*(await\s+)?(req\.json|payload|body)/;
// Three legitimate proofs of membership: the shared authorize() helper, a direct
// Membership lookup, or an ApiKey whose owner is checked.
const PROVES_MEMBERSHIP = /authorize\(|Membership\.filter\(|ApiKey\.filter\(/;

const spaceScoped = FN_DIRS.filter((d) => TAKES_CALLER_SPACE_ID.test(srcOf(d))).sort();

test("the set of caller-space_id functions is exactly the audited set", () => {
  // Pinned so that *adding* one is a deliberate act with a test change attached,
  // not something that slips in under a green suite.
  assert.deepEqual(spaceScoped, [
    "api",
    "ask",
    "get-signed-url",
    "import-history",
    "mark-done",
    "research",
  ]);
});

test("every function that trusts a caller space_id proves membership first", () => {
  for (const fn of spaceScoped) {
    assert.match(srcOf(fn), PROVES_MEMBERSHIP, `${fn} reads a caller space_id without proving membership`);
  }
});

test("the three webhook-reachable functions carry the shared gate", () => {
  // These are the ones Telegram can invoke, so they need the secret path too,
  // not just a session path.
  for (const fn of ["ask", "mark-done", "research"]) {
    const src = srcOf(fn);
    assert.match(src, /async function authorize\(/, `${fn} is missing authorize()`);
    assert.match(src, /const denied = await authorize\(/, `${fn} never calls authorize()`);
  }
});

// --- the one deliberate exception -------------------------------------------
// `demo` is public on purpose. That is only safe while all three of its
// self-imposed limits hold, so each one is asserted rather than trusted.

test("demo never lets a caller choose the space", () => {
  const src = srcOf("demo");
  assert.doesNotMatch(src, TAKES_CALLER_SPACE_ID, "demo would be pointable at a real group");
  assert.match(src, /DEMO_SPACE_ID/, "demo must resolve its own space");
});

test("demo is read-only", () => {
  const code = srcOf("demo").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\.(create|update|delete|bulkCreate)\(/, "demo mutates something");
});

test("demo returns an allow-list, never a raw row", () => {
  const code = srcOf("demo").replace(/^\s*\/\/.*$/gm, "");
  // A blocklist would pass a "no member_emails" grep today and leak on the next
  // schema change; the only durable check is that rows are rebuilt field by field.
  assert.match(code, /function pick\(/, "demo must project rows through pick()");
  assert.doesNotMatch(code, /payload\[k\] = rows\[i\];/, "demo is assigning raw rows again");
  for (const field of ["member_emails", "invite_code", "who_tg_id", "media_file_uri", "receipt_file_uri", "tg_file_id", "sender_tg_id"]) {
    assert.doesNotMatch(code, new RegExp(`["']?${field}["']?\\s*[,:\\]]`), `demo names ${field}`);
  }
});

test("no function still gates membership behind `if (user?.email)`", () => {
  for (const dir of readdirSync("base44/functions")) {
    // Strip line comments first: the hole this replaced is *quoted* in the
    // header comments of ask and mark-done so the next reader knows what the
    // gate is defending against. Quoting it must not trip the guard.
    const code = readFileSync(`base44/functions/${dir}/entry.ts`, "utf8").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /if \(user\?\.email\) \{/, `${dir} has the optional-membership antipattern`);
  }
});

test("the webhook presents the shared secret on every self-invoke", () => {
  const src = readFileSync("base44/functions/telegram-webhook/entry.ts", "utf8");
  assert.match(src, /invoke\(fn, \{ \.\.\.args, internal_key: secret \}\)/);
});

test("no secret value is hardcoded anywhere in the function tree", () => {
  for (const dir of readdirSync("base44/functions")) {
    const src = readFileSync(`base44/functions/${dir}/entry.ts`, "utf8");
    assert.doesNotMatch(src, /(?:TOKEN|SECRET|KEY)\s*=\s*["'][A-Za-z0-9_-]{16,}["']/, `${dir} looks like it hardcodes a secret`);
  }
});
