#!/bin/bash

# ================================================
# PMS - Start Script
# Usage: bash start.sh [dev|prod]
# ================================================

set -e

BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✅ $1${NC}"; }
err()  { echo -e "${RED}❌ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
info() { echo -e "${BOLD}➜  $1${NC}"; }

MODE="${1:-}"

if [[ "$MODE" != "dev" && "$MODE" != "prod" ]]; then
    echo "Usage: bash start.sh [dev|prod]"
    echo ""
    echo "  dev   Development mode with auto-reload (nodemon)"
    echo "  prod  Production mode (node index.js)"
    exit 1
fi

echo "================================================"
echo "  PMS Server — $([ "$MODE" = "dev" ] && echo 'Development' || echo 'Production') Mode"
echo "================================================"
echo ""

# ── Preflight checks ───────────────────────────────
info "Running preflight checks..."

if [ ! -f .env ]; then
    warn ".env file not found. Run bash install.sh first."
fi

if [ ! -d node_modules ]; then
    err "node_modules missing. Run: bash install.sh"
    exit 1
fi

if ! command -v docker &>/dev/null; then
    warn "Docker not found — WAHA features will be unavailable."
fi

echo ""

# ── WAHA container ─────────────────────────────────
if command -v docker &>/dev/null; then
    info "Setting up WAHA container..."

    # Remove stale container
    if docker ps -a --format '{{.Names}}' | grep -q '^waha$'; then
        if ! docker ps --format '{{.Names}}' | grep -q '^waha$'; then
            warn "Found stopped WAHA container — removing it."
            docker rm waha >/dev/null
        else
            ok "WAHA container already running."
        fi
    fi

    # Start container if not running
    if ! docker ps --format '{{.Names}}' | grep -q '^waha$'; then
        WAHA_ENV_FILE="$(dirname "$0")/waha/.env"

        if [ ! -f "$WAHA_ENV_FILE" ]; then
            warn "waha/.env not found — starting WAHA without custom credentials."
            WAHA_ENV_ARGS=""
        else
            WAHA_ENV_ARGS="--env-file $WAHA_ENV_FILE"
        fi

        mkdir -p "$(dirname "$0")/waha/sessions"

        # shellcheck disable=SC2086
        docker run -d \
            $WAHA_ENV_ARGS \
            -v "$(cd "$(dirname "$0")" && pwd)/waha/sessions:/app/.sessions" \
            -p 5001:3000 \
            --name waha \
            --restart unless-stopped \
            devlikeapro/waha >/dev/null 2>&1 \
        && ok "WAHA container started." \
        || warn "Could not start WAHA container (it may already be running or port 5001 is in use)."
    fi
else
    warn "Skipping WAHA setup (Docker not available)."
fi

echo ""

# ── Start server ───────────────────────────────────
info "Starting PMS server in $MODE mode..."
echo ""

if [ "$MODE" = "dev" ]; then
    exec npm run dev
else
    exec node index.js
fi