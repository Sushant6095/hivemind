# 🐝 Hivemind — your group chat, compiled

**Base44 Dev Build-Off 2026 entry.** Add one bot to any Telegram group and nobody has to change how they chat: Hivemind silently **compiles conversation into a live database** — decisions made, commitments owed, questions unanswered, events planned, expenses split. It nudges people when they owe things, answers *"what did we decide?"* with receipts, settles debates with live internet research, and mails a weekly digest with an AI-painted group portrait. Beside it, a realtime dashboard where the group's brain visibly grows while people type.

Hivemind is **not a chatbot**. Chatbots answer when spoken to. Hivemind is an event-driven **compiler**: webhook → extraction pipeline → typed entities → realtime fan-out → scheduled actors → permission-scoped agent. The frontend is thin on purpose — **the backend is the product.**

## The 15-second demo

1. Friend types: *"ok final: Goa Aug 14, budget ₹40k, Priya books flights by Friday."*
2. On the dashboard, a **Decision**, an **Event** and a **Commitment** pop in — live.
3. Friday morning, the bot nudges Priya in the group. Nobody wrote anything down.

## Import a year of chat in one minute

The bot only remembers from the moment it joins a group. The **Import** tab backfills the *past*: export the chat from Telegram Desktop (**⋮ → Export chat history → JSON, media off**), drop the `result.json` into the dashboard, and Hivemind replays every text message through the *same* compiler pass. Years of decisions, commitments, questions and events land on the board — with a live progress bar as they compile.

- Upload goes to **private storage** (`UploadPrivateFile`); the `import-history` function reads it back via a signed URL.
- Only plain-text messages are imported (media/service messages are skipped in v1); capped at 2,000 messages per run and idempotent on re-import (`tg_update_id` dedup).
- An **ImportJob** entity streams `done / total` over realtime — the progress bar is just `entities.ImportJob.subscribe()`.

![Import tab — pick your Telegram export](docs/import-panel.png)
![History compiling live onto the board](docs/import-progress.png)

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

## Surfaces

The same compiled backend is reachable from four surfaces — the dashboard is
just the most visible one.

| Surface | What it is | Where |
|---|---|---|
| **Dashboard** | Realtime web app — board, live feed, ledger, librarian | `src/` |
| **Telegram bot** | In-chat capture + `/ask`, `/research`, nudges, digests | `base44/functions/` |
| **Chrome Sidekick** | MV3 side-panel extension pinning the dashboard (`?panel=1`) beside any tab | `extension/` |
| **Headless API** | Keyed, read-only HTTP/JSON over a space's memory (`decisions`, `commitments`, `expenses`, `events`, `ledger`) for scripts & automations | `base44/functions/api/` · [docs/API.md](./docs/API.md) |

## Instrumented + observable

Every pipeline completion point emits a best-effort **analytics event** (`base44.analytics.track`, each wrapped in try/catch so telemetry can never break the pipeline):

| Event | Fired by | Properties |
|---|---|---|
| `compile_burst` | `process-messages` | `extracted`, `skipped` |
| `ask_answered` | `ask` | `space_id`, `via` (telegram/dashboard) |
| `research_run` | `research` | `space_id`, `sources` |
| `nudge_sent` | `nudge-commitments` | `count` |
| `digest_sent` | `weekly-digest` | `space_id` |
| `receipt_parsed` | `ingest-media` | `space_id`, `amount`, `currency` |

Two events are **cross-branch and intentionally not wired here** — their functions don't exist on `main` yet: `import_done{total}` belongs to ws-c's `import-history`, and `api_hit{resource}` to ws-a's `api`. Add them at those functions' completion points when those branches merge.

Owners get an **Engine Room** tab (gated on `Membership.role === "owner"`): a terminal-style, auto-refreshing tail of the app's `appLogs.fetchLogs()` plus a rolling-counter row. Counters read from `Space.stats`, not analytics — `analytics.track()` is write-only (the SDK exposes no read/query API), so there is nothing to query back.

![Engine Room — owner-only observability tab](docs/engine-room.png)
<!-- screenshot placeholder: live app-log tail + Space.stats counters -->

## Repo layout

```
base44/
  entities/     9 JSON schemas with rls blocks
  functions/    10 functions (entry.ts + function.jsonc each)
  agents/       librarian.jsonc
src/            React dashboard (Vite) — api client, 5 live panels, hive theme, installable PWA
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
- **Provenance over trust:** every extraction carries `source_msg_ids` — answers come with receipts, and hallucinated "memories" are cheap to audit. On the board each compiled card links **"sources ↗"** straight to the origin Telegram message (`t.me/c/…`); receipt photos open in a modal via a short-lived signed URL minted by the member-scoped `get-signed-url` function.
- **Dashboard polish (ws-d):** per-space stats header (messages seen · records compiled · ₹ tracked), a **Digest** tab that renders the weekly narrative with an in-repo markdown renderer plus a gallery of AI-painted portraits, loading skeletons, warm per-tab empty states, error toasts on failed function calls, and an installable **PWA** (manifest + service worker) that works down to 480px.
- **v1 ignores** edited/deleted Telegram messages (arrive as separate update types) and voice transcription — both are noted extension points, not silent gaps.

## Privacy

Groups opt in by adding the bot. Media lives in private storage behind signed URLs. Dashboard access requires login + membership; row-level security means even a valid login sees only their own spaces. Telegram user ids are field-level hidden from non-admins.

---

*Built solo in one week for the Base44 Dev Build-Off, with AI pair-programming (encouraged by the rules 🐝).*
