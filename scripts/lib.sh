#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
state_dir="$repo_root/.markdownmode-state"
setup_lock_dir="$state_dir/setup.lock"
setup_stamp="$state_dir/setup.complete"

mkdir -p "$state_dir"

log() {
  printf '[roughdraft] %s\n' "$*"
}

ensure_tooling() {
  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js is required to run Roughdraft." >&2
    exit 1
  fi

  if ! command -v pnpm >/dev/null 2>&1; then
    echo "pnpm is required to run Roughdraft. Install it with 'corepack enable pnpm' or 'npm install -g pnpm'." >&2
    exit 1
  fi
}

setup_ready() {
  [[ -f "$setup_stamp" ]] &&
    [[ -d "$repo_root/node_modules" ]] &&
    [[ -f "$repo_root/packages/app/dist/index.html" ]] &&
    [[ -f "$repo_root/packages/server/dist/index.js" ]]
}

wait_for_setup_lock() {
  if [[ -d "$setup_lock_dir" ]]; then
    log "Waiting for setup to finish..."
  fi

  while [[ -d "$setup_lock_dir" ]]; do
    sleep 1
  done
}
