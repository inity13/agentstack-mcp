#!/usr/bin/env bash
# Re-vendor the three product engines into worker-src/engines/.
#
# AgentStack imports the SAME deterministic engines that power the three
# standalone servers. Rather than depend on sibling repos at build time, the
# engine files are vendored here so this repo is self-contained. Run this after
# a change lands in one of the upstream products to keep the stack in sync.
#
# Provenance (upstream -> vendored):
#   precisioncalc-mcp/worker-src/tools.mjs   -> worker-src/engines/precisioncalc.mjs
#   decisionmatrix-mcp/worker-src/engine.mjs -> worker-src/engines/decisionmatrix.mjs
#   scenariosim-mcp/worker-src/engine.mjs    -> worker-src/engines/scenariosim.mjs
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-$HOME/projects}"

copy() { echo "  $1 -> $2"; cp "$SRC/$1" "$ROOT/worker-src/engines/$2"; }

echo "Syncing engines from $SRC ..."
copy precisioncalc-mcp/worker-src/tools.mjs   precisioncalc.mjs
copy decisionmatrix-mcp/worker-src/engine.mjs decisionmatrix.mjs
copy scenariosim-mcp/worker-src/engine.mjs    scenariosim.mjs
echo "Done. Rebuild with: npm run build"
