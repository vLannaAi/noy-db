#!/usr/bin/env bash
#
# Privacy guard — greps the working tree for forbidden strings (client names,
# internal identifiers) that must never appear in public code, docs, or
# published tarballs.
#
# Runs in two places:
#   1. CI workflow (.github/workflows/ci.yml) on every push and PR
#   2. Local `pnpm run release` before `changeset publish`
#
# Exit 0 if clean, exit 1 (and print offending matches) if a forbidden
# string is found.

set -eu

# Forbidden strings — add new client/project names here.
# Patterns are treated as case-insensitive regex fragments joined with |.
FORBIDDEN=(
  "niwat"
)

# Paths to exclude from scanning. Build artifacts, dependencies, and
# git/history files are noise; CHANGELOG.md entries may contain historical
# content that was already public at the time.
EXCLUDE_DIRS=(
  ".git"
  "node_modules"
  "dist"
  ".turbo"
  ".changeset"
  ".claude"
  ".playwright-mcp"
  ".vscode"
  ".idea"
)
EXCLUDE_FILES=(
  "pnpm-lock.yaml"
  "package-lock.json"
  "yarn.lock"
  "CHANGELOG.md"
  "check-privacy.sh"
)

pattern=$(IFS='|'; echo "${FORBIDDEN[*]}")

grep_args=()
for d in "${EXCLUDE_DIRS[@]}"; do
  grep_args+=(--exclude-dir="$d")
done
for f in "${EXCLUDE_FILES[@]}"; do
  grep_args+=(--exclude="$f")
done

# -r recursive, -I skip binary, -n line numbers, -i case-insensitive, -E regex
matches=$(grep -rInEi "${grep_args[@]}" "$pattern" . || true)

if [ -n "$matches" ]; then
  echo "Privacy guard FAILED — forbidden strings found:" >&2
  echo >&2
  echo "$matches" >&2
  echo >&2
  echo "Patterns checked: ${FORBIDDEN[*]}" >&2
  echo "Remove these references before committing or publishing." >&2
  exit 1
fi

echo "Privacy guard: clean (${#FORBIDDEN[@]} pattern(s) checked)"
