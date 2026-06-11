#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

cleanup() {
  echo ""
  echo "Shutting down demo..."
  kill "$SPAWN_PID" "$PROXY_PID" "$VITE_PID" 2>/dev/null
  wait "$SPAWN_PID" "$PROXY_PID" "$VITE_PID" 2>/dev/null
  exit 0
}
trap cleanup SIGINT SIGTERM

cd "$ROOT"

echo "Building..."
npm run build

# Wipe all generated DB state so every node starts from a clean slate.
# The Raft log and SimpleDBMS files are recreated automatically.
echo "Cleaning generated database state..."
rm -rf "$ROOT/build/apps/data/generated-database"
rm -rf "$ROOT/data/generated-database"
mkdir -p "$ROOT/build/apps/data/generated-database"
mkdir -p "$ROOT/data/generated-database"

echo "Starting Raft cluster (nodes 1-3)..."
node build/apps/api-server/spawnMany.mjs &
SPAWN_PID=$!
sleep 3

echo "Starting proxy..."
node build/apps/api-server/proxy.mjs &
PROXY_PID=$!
sleep 1

echo "Starting frontend..."
cd "$ROOT/apps/frontend"
npx vite &
VITE_PID=$!
sleep 2

echo ""
echo "================================================"
echo "  Demo running!"
echo ""
echo "  Web UI:   http://localhost:5173"
echo "  API:      http://localhost:3001"
echo "  Swagger:  http://localhost:3001/api-docs"
echo "================================================"
echo ""
echo "Press Ctrl+C to stop all services."

wait
