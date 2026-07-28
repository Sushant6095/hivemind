// api — Hivemind's keyed headless read API + owner-only key management.
//
// Public HTTP function. Two shapes, one endpoint:
//   GET  ?key=<apikey>&resource=decisions|commitments|expenses|events|ledger
//        → validates the key (service-role lookup), returns clean JSON for the
//          key's space. 404 on unknown key, 400 on unknown resource.
//   POST { action: "generate" | "revoke", space_id, label?, key_id? }
//        → owner-only (Membership.role === "owner"), mints/revokes a key.
//
// v1 is READ-ONLY over app data: the public key path never writes entities.
// Writes here are limited to ApiKey rows and gated by space ownership.

import { createClientFromRequest } from "npm:@base44/sdk";

// resource name → entity + the fields we expose (drops member_emails, tg ids,
// private receipt URIs, created_by_id, etc. — clean public JSON only).
const RESOURCES: Record<string, { entity: string; pick: string[] }> = {
  decisions: { entity: "Decision", pick: ["id", "title", "detail", "status", "confidence", "decided_at", "source_msg_ids", "created_date"] },
  commitments: { entity: "Commitment", pick: ["id", "who_name", "what", "due_at", "status", "confidence", "source_msg_ids", "created_date"] },
  expenses: { entity: "Expense", pick: ["id", "payer_name", "amount", "currency", "description", "items", "split", "source_msg_ids", "created_date"] },
  events: { entity: "Event", pick: ["id", "title", "starts_at", "location", "attendees", "confidence", "source_msg_ids", "created_date"] },
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });

const pick = (row: Record<string, any>, fields: string[]) =>
  Object.fromEntries(fields.map((f) => [f, row[f]]).filter(([, v]) => v !== undefined));

// Net positions across compiled Expenses — mirrors src/components/Ledger.jsx:
// payer is credited the full amount; everyone in the split is debited their
// share (equal split when the pipeline produced no explicit split array).
function computeLedger(expenses: any[], members: any[]) {
  const names = [
    ...new Set([...members.map((m) => m.tg_display_name || m.user_email), ...expenses.map((x) => x.payer_name)]),
  ].filter(Boolean);
  const net: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]));

  for (const x of expenses) {
    const split = x.split?.length ? x.split : names.map((n) => ({ name: n, share: (x.amount ?? 0) / (names.length || 1) }));
    net[x.payer_name] = (net[x.payer_name] ?? 0) + (x.amount ?? 0);
    for (const s of split) net[s.name] = (net[s.name] ?? 0) - (s.share ?? 0);
  }

  return {
    currency: expenses[0]?.currency ?? "INR",
    total: Math.round(expenses.reduce((s, x) => s + (x.amount ?? 0), 0)),
    positions: Object.entries(net)
      .map(([name, v]) => ({ name, net: Math.round(v) }))
      .sort((a, b) => b.net - a.net),
  };
}

Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const sr = base44.asServiceRole;
  const url = new URL(req.url);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  // --- owner-only key management ------------------------------------------
  if (req.method === "POST") {
    const user = await base44.auth.me().catch(() => null);
    if (!user?.email) return json({ error: "auth required" }, 401);

    const { action, space_id, label, key_id } = await req.json().catch(() => ({}));
    if (!space_id) return json({ error: "space_id required" }, 400);

    const [membership] = await sr.entities.Membership.filter({ space_id, user_email: user.email }, undefined, 1);
    if (!membership || membership.role !== "owner") return json({ error: "owner only" }, 403);

    if (action === "generate") {
      const space = await sr.entities.Space.get(space_id).catch(() => null);
      const key = "hmk_" + crypto.randomUUID().replace(/-/g, "");
      const created = await sr.entities.ApiKey.create({
        space_id,
        key,
        label: (label ?? "").trim() || "API key",
        member_emails: space?.member_emails ?? membership.member_emails ?? [],
      });
      return json({ ok: true, id: created.id, key: created.key, label: created.label });
    }

    if (action === "revoke") {
      if (!key_id) return json({ error: "key_id required" }, 400);
      const target = await sr.entities.ApiKey.get(key_id).catch(() => null);
      if (!target || target.space_id !== space_id) return json({ error: "key not found in this space" }, 404);
      await sr.entities.ApiKey.delete(key_id);
      return json({ ok: true, revoked: key_id });
    }

    return json({ error: "unknown action" }, 400);
  }

  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);

  // --- keyed public read ---------------------------------------------------
  const key = url.searchParams.get("key");
  const resource = url.searchParams.get("resource");
  if (!key) return json({ error: "key query param required" }, 400);

  const [apiKey] = await sr.entities.ApiKey.filter({ key }, undefined, 1);
  if (!apiKey) return json({ error: "unknown key" }, 404);
  const space_id = apiKey.space_id;

  if (resource === "ledger") {
    const [expenses, members] = await Promise.all([
      sr.entities.Expense.filter({ space_id }, "-created_date", 500),
      sr.entities.Membership.filter({ space_id }, undefined, 100),
    ]);
    return json({ space_id, resource: "ledger", ...computeLedger(expenses, members) });
  }

  const spec = resource ? RESOURCES[resource] : undefined;
  if (!spec) return json({ error: "unknown resource", resources: [...Object.keys(RESOURCES), "ledger"] }, 400);

  const rows = await (sr.entities as any)[spec.entity].filter({ space_id }, "-created_date", 500);
  return json({ space_id, resource, count: rows.length, data: rows.map((r: any) => pick(r, spec.pick)) });
});
