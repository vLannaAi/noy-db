#!/usr/bin/env bash
# Sync the GitHub label catalog from .github/labels.yml.
#
# Idempotent: existing labels are updated, missing labels are created.
# Labels NOT in the file are left alone (we don't auto-delete).
#
# Requires: gh CLI authenticated with `repo` scope.
# Usage:    bash scripts/sync-labels.sh

set -euo pipefail

LABELS_FILE=".github/labels.yml"
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"

if [[ ! -f "$LABELS_FILE" ]]; then
  echo "ERROR: $LABELS_FILE not found"
  exit 1
fi

echo "Syncing labels to $REPO from $LABELS_FILE"
echo

# Parse the YAML manually (no yq dependency).
# Format expected: blocks of `- name:`, `color:`, `description:` (description optional).
name=""
color=""
description=""

flush() {
  if [[ -n "$name" ]]; then
    if gh label list --limit 200 --json name -q '.[].name' | grep -Fxq "$name"; then
      echo "  update: $name"
      gh label edit "$name" --color "$color" --description "$description" >/dev/null
    else
      echo "  create: $name"
      gh label create "$name" --color "$color" --description "$description" >/dev/null
    fi
  fi
  name=""; color=""; description=""
}

while IFS= read -r line; do
  case "$line" in
    "- name: "*)
      flush
      name="${line#- name: }"
      name="${name%\"}"; name="${name#\"}"
      ;;
    "  color: "*)
      color="${line#  color: }"
      color="${color%\"}"; color="${color#\"}"
      ;;
    "  description: "*)
      description="${line#  description: }"
      description="${description%\"}"; description="${description#\"}"
      ;;
  esac
done < "$LABELS_FILE"
flush

echo
echo "Done."
