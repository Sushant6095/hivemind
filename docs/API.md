# Hivemind Headless API

A small, read-only HTTP API over a space's **compiled memory** — the same
decisions, commitments, expenses, events and ledger you see on the dashboard,
served as clean JSON for scripts, dashboards, and automations (Zapier, Grafana,
a cron job, an LLM tool). It is served by the `api` backend function.

> **Base URL.** Replace `https://hivemind-6aebd8e4.base44.app` below with your
> deployed Base44 app origin once the app ships. The function lives at
> `<origin>/functions/api`.

## Auth model

- **Reads are keyed.** Every read requires an `?key=` query param. A key is a
  bearer secret (`hmk_…`) scoped to exactly one space; it is looked up
  service-role, so the caller sees only that space's data. There is no per-user
  login on the read path.
- **Keys are managed by the space owner.** Generating and revoking keys is
  done through the same function with a `POST` and a logged-in Base44 session,
  and only the member whose `Membership.role === "owner"` may do it. Owners
  manage keys from the dashboard's **API** panel.
- **The API never writes app data.** In v1 the keyed path is strictly read-only;
  the only writes the function performs are creating/deleting `ApiKey` rows on
  behalf of the owner.
- **Treat a key like a password.** Anyone with the key can read the space. Rotate
  by generating a new key and revoking the old one.

## Read endpoint

```
GET /functions/api?key=<KEY>&resource=<RESOURCE>
```

| Param | Required | Values |
|---|---|---|
| `key` | yes | A `hmk_…` key for the space |
| `resource` | yes | `decisions` · `commitments` · `expenses` · `events` · `ledger` |

### Status codes

| Code | When |
|---|---|
| `200` | OK |
| `400` | `key` missing, or `resource` missing/unknown |
| `404` | Unknown key |
| `405` | Method other than `GET`/`POST`/`OPTIONS` |

### Examples

```bash
BASE="https://hivemind-6aebd8e4.base44.app/functions/api"
KEY="hmk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

curl "$BASE?key=$KEY&resource=decisions"
curl "$BASE?key=$KEY&resource=commitments"
curl "$BASE?key=$KEY&resource=expenses"
curl "$BASE?key=$KEY&resource=events"
curl "$BASE?key=$KEY&resource=ledger"
```

### Sample responses

**`resource=decisions`** (also the shape of `commitments`, `expenses`, `events`):

```json
{
  "space_id": "spc_abc123",
  "resource": "decisions",
  "count": 2,
  "data": [
    {
      "id": "dec_01",
      "title": "Goa trip, Aug 14",
      "detail": "Budget ₹40k, 5 people",
      "status": "active",
      "confidence": 0.92,
      "decided_at": "2026-07-20T18:04:00Z",
      "source_msg_ids": ["tg_5567"],
      "created_date": "2026-07-20T18:04:03Z"
    }
  ]
}
```

**`resource=commitments`** item fields: `who_name`, `what`, `due_at`, `status`,
`confidence`, `source_msg_ids`.
**`resource=expenses`** item fields: `payer_name`, `amount`, `currency`,
`description`, `items[]`, `split[]`, `source_msg_ids`.
**`resource=events`** item fields: `title`, `starts_at`, `location`,
`attendees[]`, `confidence`, `source_msg_ids`.

> Internal fields (`member_emails`, Telegram user ids, private receipt URIs,
> `created_by_id`) are stripped — the API returns clean, shareable JSON only.

**`resource=ledger`** — net positions computed from compiled expenses (positive
`net` = is owed, negative = owes):

```json
{
  "space_id": "spc_abc123",
  "resource": "ledger",
  "currency": "INR",
  "total": 12400,
  "positions": [
    { "name": "Priya", "net": 3720 },
    { "name": "Arjun", "net": -1860 },
    { "name": "Sam", "net": -1860 }
  ]
}
```

**Error:**

```json
{ "error": "unknown resource", "resources": ["decisions", "commitments", "expenses", "events", "ledger"] }
```

## Key management (owner-only)

`POST /functions/api` with a logged-in Base44 session (cookie/bearer from the
dashboard SDK). Body is JSON.

**Generate** — returns the key value **once**:

```json
POST /functions/api
{ "action": "generate", "space_id": "spc_abc123", "label": "Grafana" }
→ 200 { "ok": true, "id": "key_09", "key": "hmk_…", "label": "Grafana" }
```

**Revoke:**

```json
POST /functions/api
{ "action": "revoke", "space_id": "spc_abc123", "key_id": "key_09" }
→ 200 { "ok": true, "revoked": "key_09" }
```

| Code | When |
|---|---|
| `401` | Not logged in |
| `403` | Logged in but not the space owner |
| `400` | Missing `space_id` / `key_id`, or unknown `action` |
| `404` | Revoke target not found in this space |

In practice you don't hand-craft these POSTs — the dashboard **API** panel calls
`base44.functions.invoke("api", …)` for you.
