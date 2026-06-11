#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
cd "$ROOT"

# The compaction demo is a single in-process server: one SimpleDBMS instance
# plus the compaction module. No Raft cluster, proxy, or Vite — nothing that
# isn't needed to show shrinkDatabase() reclaiming space. It starts from an
# empty database every run and serves its own UI.

echo "Building..."
npm run build

echo "Starting compaction demo..."
exec node build/apps/api-server/compaction-demo-server.mjs
