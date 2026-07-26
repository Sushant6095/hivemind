#!/usr/bin/env bash
# Fallback push helper (only needed if the repo wasn't already pushed for you).
# Uses gh if available, else prints manual steps.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO_NAME="${1:-hivemind}"

if command -v gh >/dev/null 2>&1; then
  gh repo create "$REPO_NAME" --public --source . --push && exit 0
fi

cat <<EOF
gh CLI not found. Manual path:
  1. Create an empty repo named "$REPO_NAME" on github.com (no README).
  2. git remote add origin https://github.com/<you>/$REPO_NAME.git
  3. git push -u origin main
EOF
