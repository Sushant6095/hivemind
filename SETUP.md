# SETUP — zero to live Hivemind

Every command in order. Steps 1–2 must run on **your** machine with **your** Base44 account (the competition requires the backend be created with the CLI during the build window, under your account).

## 0. Prerequisites

- Node 20+, git
- Telegram account
- Enrolled in the Dev Build-Off (you are ✅)

## 1. Create the Telegram bot (5 min)

1. DM **@BotFather** → `/newbot` → name it (e.g. `HivemindBot`) → copy the **token**.
2. **CRITICAL:** `/setprivacy` → select your bot → **Disable**. With privacy ON the bot cannot see group messages and nothing works.
3. Optional polish: `/setuserpic`, `/setdescription` ("I compile your group chat into a live database").

## 2. Create the Base44 backend (the competition-critical step)

```bash
npm install -g base44@latest
base44 login                       # browser auth with YOUR account
cd hivemind                        # this repo
base44 create                      # create the backend project — SAVE THE APP ID
# If `create` scaffolds into a new folder instead of linking here, run it in a
# scratch dir, note the App ID, then in THIS repo run:  base44 link  (choose the new app)
```

> Also install the AI skills so Claude Code / Cursor speak fluent Base44 while you iterate:
> `npx skills add base44/skills -g`

## 3. Push the backend

```bash
base44 entities push               # 9 schemas incl. RLS
base44 functions deploy            # all 10 functions + automations
base44 agents push                 # librarian
base44 types generate              # optional: typed SDK for the frontend
```

## 4. Secrets

```bash
base44 secrets set TELEGRAM_BOT_TOKEN=123456:ABC...   # from BotFather
base44 secrets set TG_WEBHOOK_SECRET=$(openssl rand -hex 16)
base44 secrets set SEED_DEMO_KEY=$(openssl rand -hex 8)
base44 secrets set APP_PUBLIC_URL=https://<your-app>.base44.app
```

## 5. Point Telegram at the webhook

```bash
# find the deployed URL of telegram-webhook (see `base44 functions list` / dashboard),
# then:
TELEGRAM_BOT_TOKEN=... TG_WEBHOOK_SECRET=... WEBHOOK_URL=https://... ./scripts/set-webhook.sh
```

## 6. Frontend

```bash
cp .env.example .env               # put your App ID in VITE_BASE44_APP_ID
npm install
npm run dev                        # local dev
npm run build && base44 site deploy   # live on Base44 hosting
```

## 7. Light it up

1. Create a Telegram group with 2–3 friends, add your bot.
2. Bot posts the claim link → open it → you own the space.
3. Chat normally. Watch the **Live feed** tab while someone types
   *"ok final — Goa Aug 14, Priya books flights by Friday"*. 🍿
4. Drop a receipt photo. Check the Ledger.
5. `/ask what's pending on me?` · `/research is August rainy in Goa?` · `/digest`

## 8. Judge sandbox (for submission)

```bash
curl -X POST "$FUNCTIONS_BASE/seed-demo" -H 'Content-Type: application/json' \
  -d '{"key":"<SEED_DEMO_KEY>","email":"judge@example.com"}'
```

Creates the "Goa Trip (Demo)" space compiled through the real pipeline and
visible to that email on login. Put the exact curl + a demo login in the
submission's access instructions.

## Troubleshooting

- **Bot silent in group** → privacy mode still ON, or webhook not set (`getWebhookInfo`).
- **Webhook 403** → TG_WEBHOOK_SECRET mismatch with set-webhook.sh.
- **Nothing compiles** → check `base44 logs` for process-messages; the sweeper runs every 5 min — or force one: invoke `process-messages` with `{"space_id":"...","force":true}`.
- **Dashboard empty** → you're logged in with an email that has no Membership; open the bot's claim link again.
- **RLS blocks reads in dev** → confirm `member_emails` contains your login email on the Space (bind-space fans it out).
