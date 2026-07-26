#!/usr/bin/env bash
# One-shot local bootstrap after cloning. Interactive where auth is needed.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "🐝 Hivemind bootstrap"
command -v node >/dev/null || { echo "Install Node 20+ first"; exit 1; }

echo "→ Installing Base44 CLI + frontend deps"
npm install -g base44@latest
npm install

echo "→ Base44 login (browser will open)"
base44 login

echo "→ Create/link the backend (competition requires create during the window)"
base44 create || base44 link

echo "→ Pushing entities, functions, agent"
base44 entities push
base44 functions deploy
base44 agents push

cat <<'EOF'

Next (manual, 5 min):
  1. @BotFather: /newbot → token, then /setprivacy → DISABLE  ← critical
  2. base44 secrets set TELEGRAM_BOT_TOKEN=... TG_WEBHOOK_SECRET=... SEED_DEMO_KEY=... APP_PUBLIC_URL=...
  3. ./scripts/set-webhook.sh   (env vars as documented)
  4. cp .env.example .env  → add your App ID → npm run build && base44 site deploy
See SETUP.md for the full walkthrough.
EOF
