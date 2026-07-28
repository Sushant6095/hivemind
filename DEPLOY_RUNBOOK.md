# Deploying Hivemind

Everything here runs from the repo root. The CLI is `base44` (installed globally); `npx base44` resolves nothing, since this repo carries no local dev-dependency on it.

Order matters in one place only — the site build embeds the app id, so `entities push` and `functions deploy` come before `site deploy`. Everything else is independent.

---

## 1. Authenticate

```bash
base44 login          # device-code flow in the browser
base44 whoami         # must print: Logged in as <your-email>
```

Credentials persist in `~/.base44/`. If a later command hangs with no output, the login didn't stick — run `base44 login` again rather than waiting.

---

## 2. Secrets

Four are required. They exist only in Base44's secret store — never in a file, never in `.env`, never in a commit.

| Secret | What it is |
|---|---|
| `TELEGRAM_BOT_TOKEN` | from @BotFather |
| `TG_WEBHOOK_SECRET` | shared secret proving a call came from our own webhook |
| `SEED_DEMO_KEY` | authorises `seed-demo`, which writes a whole space |
| `APP_PUBLIC_URL` | used to build claim links posted into groups |

```bash
export TG_WEBHOOK_SECRET=$(openssl rand -hex 16)
export SEED_DEMO_KEY=$(openssl rand -hex 8)
base44 secrets set TG_WEBHOOK_SECRET=$TG_WEBHOOK_SECRET
base44 secrets set SEED_DEMO_KEY=$SEED_DEMO_KEY
base44 secrets set TELEGRAM_BOT_TOKEN=<from BotFather>
base44 secrets set APP_PUBLIC_URL=<the deployed site URL>
base44 secrets list          # names only; values are never readable back
```

Keep the shell open — `set-webhook.sh` needs `$TG_WEBHOOK_SECRET` and step 6 needs `$SEED_DEMO_KEY`.

`ask`, `mark-done` and `research` each read `TG_WEBHOOK_SECRET` from the environment at call time rather than caching it, so rotating the secret updates every consumer at once. There is no window in which one function still trusts the old value.

`DEMO_SPACE_ID` is optional: set it to pin the public demo to one specific space instead of letting `demo` discover it by its `demo-` chat-id prefix.

---

## 3. Push the backend

```bash
base44 entities push        # 14 schemas, each with its RLS block
base44 functions deploy     # 15 Deno functions
base44 agents push          # the librarian agent
base44 types generate       # regenerates base44/.types/types.d.ts
base44 functions list       # verify 15
```

`entities push` is a full sync: the remote schema set becomes exactly what is in `base44/entities/`. Push from a stale checkout and you will remove entities the deployed functions depend on — `CompileJob`, `Lease` and `MetricEvent` in particular, which the compiler's job state machine and the reaper both require. Confirm `git status` is what you expect before pushing.

---

## 4. Build and deploy the site

```bash
npm run build
base44 site deploy
```

A rollup `MODULE_NOT_FOUND` on `native.js` means `node_modules` was installed for a different platform (a macOS tree opened on Linux, or the reverse). Rebuild it:

```bash
rm -rf node_modules package-lock.json && npm install && npm run build
```

Hosting is SPA-only: every unknown route returns `index.html` with HTTP 200. A `curl` against a deploy therefore always looks like it worked. Verify routes in a real browser, or the check means nothing.

---

## 5. Point Telegram at the webhook

In @BotFather, `/setprivacy` → the bot → **Disable**, first. With group privacy on, the bot receives only messages that mention it, and the entire product silently does nothing.

```bash
export TELEGRAM_BOT_TOKEN=<from BotFather>
export WEBHOOK_URL=<telegram-webhook URL from `base44 functions list`>
./scripts/set-webhook.sh
```

The `getWebhookInfo` output at the end must show the URL and **no** `last_error_message`. Rotating `TG_WEBHOOK_SECRET` invalidates the old registration, so re-run this after any rotation.

---

## 6. Seed the public demo

The no-login view at `/?demo=1` is served by the `demo` function, which resolves a space stamped `tg_chat_id = "demo-…"`. If no such space exists, `demo` returns 404 and the dashboard falls back to its sign-in card — quietly, with nothing in the logs. A deploy that skips this step looks completely healthy and has no public demo.

```bash
curl -X POST "$SITE/functions/seed-demo" -H 'Content-Type: application/json' \
  -d "{\"key\":\"$SEED_DEMO_KEY\",\"email\":\"<owner-email>\"}"
```

Then verify both that it serves rows and that it serves only the fields it is supposed to:

```bash
curl -s "$SITE/functions/demo" | head -c 400              # "ok":true, counts.compiled > 0
curl -s "$SITE/functions/demo" \
  | grep -o -E 'member_emails|invite_code|who_tg_id|media_file_uri' | sort -u
```

The second command must print nothing. `demo` rebuilds every row through a named field allow-list (see `PICK` in `base44/functions/demo/entry.ts`), so output is a projection, never a raw entity. If those field names appear, the deployed copy predates the allow-list — redeploy step 3.

Finally open `/?demo=1` in a private window and confirm a compiled board renders with no sign-in prompt.

---

## 7. Schedules

This runtime rejects legacy `automations` blocks in `function.jsonc` with a 409. Scheduled work is configured as **Workflows** in the dashboard (`base44 dashboard open` → Workflows → New):

| Name | Function | Payload | Cron |
|---|---|---|---|
| `burst_sweeper` | `process-messages` | `{"sweep": true}` | `*/5 * * * *` |
| `compile-reaper` | `compile-reaper` | `{}` | `*/5 * * * *` |
| `nudge-commitments` | `nudge-commitments` | `{}` | `30 3 * * *` |
| `weekly-digest` | `weekly-digest` | `{}` | `30 12 * * 0` |

`burst_sweeper` picks up conversations that went quiet mid-burst, so the debounce window closes even when no further message arrives to trigger it. Drop it to `*/1` when you want the board to visibly keep pace with a live group; `*/5` is the sane steady state.

`compile-reaper` is the crash-recovery half of the job state machine: it re-queues jobs whose lease expired without completing. Without it, a function that dies mid-compile leaves that batch stuck forever — the failure mode you only find by leaving the app running.

---

## 8. Verify end to end

```bash
node --test tests/*.test.mjs        # 84 tests, no network required
```

Then add the bot to a group and send something with a decision and a promise in it:

> `ok final — Goa Aug 14 to 17, 40k each. I'll book the flights by Friday`

Within a debounce window the board should grow a **Decision**, an **Event**, and a **Commitment** with a Friday due date, each carrying a working `sources ↗` link back to the originating message. Then try `/ask what did we decide about Goa` in the group.

Nothing appears? Check group privacy is disabled, then `base44 logs --level info` and look for `process-messages`.
