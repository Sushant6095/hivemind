# 🐝 Hivemind — your group chat, compiled

**Base44 Dev Build-Off 2026 entry.** Add one bot to any Telegram group and nobody has to change how they chat: Hivemind silently **compiles conversation into a live database** — decisions made, commitments owed, questions unanswered, events planned, expenses split. It nudges people when they owe things, answers *"what did we decide?"* with receipts, settles debates with live internet research, and mails a weekly digest with an AI-painted group portrait. Beside it, a realtime dashboard where the group's brain visibly grows while people type.

Hivemind is **not a chatbot**. Chatbots answer when spoken to. Hivemind is an event-driven **compiler**: webhook → extraction pipeline → typed entities → realtime fan-out → scheduled actors → permission-scoped agent. The frontend is thin on purpose — **the backend is the product.**

## The 15-second demo

1. Friend types: *"ok final: Goa Aug 14, budget ₹40k, Priya books flights by Friday."*
2. On the dashboard, a **Decision**, an **Event** and a **Commitment** pop in — live.
3. Friday morning, the bot nudges Priya in the group. Nobody wrote anything down.

## Architecture

```
Telegram group
   │  webhook POST (secret-token verified, update_id dedup)
   ▼
[fn] telegram-webhook ──────────► RawMessage entity
                                      │ entity automation (create)
                                      ▼
                              [fn] process-messages
                              debounced burst → ONE InvokeLLM call
                              (gemini_3_flash, strict JSON schema)
                                      │
        ┌───────────┬───────────┬─────┴─────┬───────────┐
        ▼           ▼           ▼           ▼           ▼
    Decision    Commitment   Question     Event      Expense      ← RLS: member-only reads,
        │           │           │           │           │            service-role-only writes
        └───────────┴───── entities.subscribe() ───────┴──────►  REALTIME DASHBOARD
                                      ▲
                 [agent] librarian — read-scoped entity tools
                 + research function tool (internet grounding)
                                      ▲
                        /ask (Telegram) · Ask panel (web)

[fn sched] nudge-commitments  daily 09:00 IST → morning sweep in each group
[fn sched] weekly-digest      Sun 18:00 IST → LLM digest + GenerateImage
                              portrait + SendEmail to every member
[fn]       ingest-media       chat photos → UploadPrivateFile; receipts →
                              ExtractDataFromUploadedFile → itemized Expense
[fn]       seed-demo          replays a scripted trip chat through the REAL
                              pipeline so judges see compilation live
```

## Every backend capability, load-bearing

| Capability | Where it does real work |
|---|---|
| **Entities / database** | 9 schemas (`base44/entities/`); MongoDB-style queries (`$in`, `$gte`) across the pipeline |
| **Row + field-level security** | Member-only reads via denormalized `member_emails`; service-role-only writes; Telegram ids field-restricted to admins (`rls` blocks in every schema) |
| **Realtime subscriptions** | Board + live feed are pure `entities.subscribe()` — the demo IS realtime |
| **Backend functions** | 10 Deno functions: public webhook, compiler, media pipeline, Q&A, research, nudges, digests, seeder |
| **Automations** | Entity-triggered (RawMessage create ×2) + scheduled (5-min sweeper, daily nudge, weekly digest) |
| **AI / LLM** | `InvokeLLM` structured extraction (cheap model) + librarian answers (claude_sonnet_4_6) + `add_context_from_internet` research |
| **AI agents** | `librarian.jsonc` — least-privilege entity tools + research function tool; connectable to native Telegram/WhatsApp channels |
| **File & media storage** | Chat media → `UploadPrivateFile` + signed URLs; receipts → `ExtractDataFromUploadedFile` → auto-split expenses |
| **Auth** | Dashboard login via Base44 auth; membership enforced in functions and RLS |
| **Email** | `SendEmail` weekly digests |
| **Hosting** | SPA deployed to Base44 hosting |
| **Typed SDK** | `base44 types generate` emits `base44/.types/types.d.ts`, augmenting `@base44/sdk`'s `EntityTypeRegistry` from the 9 entity schemas |
| **Typed client** | `src/api/base44Client.js` consumes it — `listDecisions()` returns `Decision[]` straight from the generated types, no hand-written shapes |

## Repo layout

```
base44/
  entities/     9 JSON schemas with rls blocks
  functions/    10 functions (entry.ts + function.jsonc each)
  agents/       librarian.jsonc
src/            React dashboard (Vite) — api client, 4 live panels, hive theme
scripts/        bootstrap.sh · set-webhook.sh · push-to-github.sh
SETUP.md        every command from zero to live, in order
```

## Run it

See **[SETUP.md](./SETUP.md)** for the full path from `npx base44 create` to a live group. Short version:

```bash
base44 login && base44 create            # backend born (grab the App ID)
base44 entities push && base44 functions deploy && base44 agents push
base44 secrets set TELEGRAM_BOT_TOKEN=… TG_WEBHOOK_SECRET=… SEED_DEMO_KEY=… APP_PUBLIC_URL=…
./scripts/set-webhook.sh                 # point Telegram at the webhook fn
npm i && npm run build && base44 site deploy
```

**⚠️ BotFather `/setprivacy` must be OFF** for your bot — otherwise it cannot see group messages at all.

## Design notes & honest tradeoffs

- **Credit discipline:** extraction runs on a cheap model, ~1 call per conversation *burst* (45 s debounce + 5-min sweeper), not per message. The strong model is reserved for explicit `/ask`.
- **RLS by denormalization:** `member_emails` is mirrored onto child records because RLS rules can't join across entities. `bind-space` owns the fan-out. Tradeoff documented, scale-appropriate.
- **Provenance over trust:** every extraction carries `source_msg_ids` — answers come with receipts, and hallucinated "memories" are cheap to audit.
- **v1 ignores** edited/deleted Telegram messages (arrive as separate update types) and voice transcription — both are noted extension points, not silent gaps.

## Privacy

Groups opt in by adding the bot. Media lives in private storage behind signed URLs. Dashboard access requires login + membership; row-level security means even a valid login sees only their own spaces. Telegram user ids are field-level hidden from non-admins.

---

*Built solo in one week for the Base44 Dev Build-Off, with AI pair-programming (encouraged by the rules 🐝).*
