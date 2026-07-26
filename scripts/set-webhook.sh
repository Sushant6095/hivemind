#!/usr/bin/env bash
# Point Telegram at the deployed telegram-webhook function.
# Usage: TELEGRAM_BOT_TOKEN=... TG_WEBHOOK_SECRET=... WEBHOOK_URL=https://... ./scripts/set-webhook.sh
set -euo pipefail

: "${TELEGRAM_BOT_TOKEN:?set TELEGRAM_BOT_TOKEN}"
: "${TG_WEBHOOK_SECRET:?set TG_WEBHOOK_SECRET}"
: "${WEBHOOK_URL:?set WEBHOOK_URL (deployed telegram-webhook function URL)}"

curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=${WEBHOOK_URL}" \
  -d "secret_token=${TG_WEBHOOK_SECRET}" \
  -d 'allowed_updates=["message","edited_message"]'
echo
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
echo
