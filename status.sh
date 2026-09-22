#!/bin/bash

# ================================================
# PMS - Status & Diagnostics Script
# Usage: bash status.sh [--fix]
# ================================================

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✅ $1${NC}"; }
err()  { echo -e "${RED}❌ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
info() { echo -e "${BOLD}$1${NC}"; }

FIX_MODE=false
[[ "$1" == "--fix" ]] && FIX_MODE=true

echo "================================================"
echo "  PMS Service Status"
echo "================================================"
echo ""

ALL_OK=true

# ── 1. Backend (port 5000) ─────────────────────────
info "1. Backend Server (port 5000)"
if lsof -Pi :5000 -sTCP:LISTEN -t >/dev/null 2>&1; then
    PID=$(lsof -Pi :5000 -sTCP:LISTEN -t)
    ok "Running  (PID $PID)"
else
    err "Not running"
    ALL_OK=false
    if $FIX_MODE; then
        warn "Starting backend in background..."
        cd "$(dirname "$0")" && npm run dev &
        sleep 6
    else
        echo "     → Run: bash start.sh dev"
    fi
fi
echo ""

# ── 2. Frontend (port 5173) ────────────────────────
info "2. Frontend Server (port 5173)"
if lsof -Pi :5173 -sTCP:LISTEN -t >/dev/null 2>&1; then
    PID=$(lsof -Pi :5173 -sTCP:LISTEN -t)
    ok "Running  (PID $PID)"
else
    warn "Not running  (start frontend separately)"
    echo "     → Run: npm run dev  (in the frontend folder)"
fi
echo ""

# ── 3. WAHA container ─────────────────────────────
info "3. WAHA Container"
if ! command -v docker &>/dev/null; then
    warn "Docker not installed — skipping WAHA check."
elif docker ps --format '{{.Names}}' | grep -q '^waha$'; then
    ok "Running"
    echo ""
    echo "     Last 5 log lines:"
    docker logs waha --tail 5 2>&1 | sed 's/^/       /'
else
    STATUS=$(docker ps -a --format '{{.Names}} {{.Status}}' | grep '^waha ' || echo "not found")
    err "Not running  ($STATUS)"
    ALL_OK=false
    if $FIX_MODE; then
        warn "Attempting to restart WAHA..."
        docker rm waha >/dev/null 2>&1 || true
        WAHA_ENV_FILE="$(dirname "$0")/waha/.env"
        ENV_ARG=""
        [ -f "$WAHA_ENV_FILE" ] && ENV_ARG="--env-file $WAHA_ENV_FILE"
        mkdir -p "$(dirname "$0")/waha/sessions"
        # shellcheck disable=SC2086
        docker run -d $ENV_ARG \
            -v "$(cd "$(dirname "$0")" && pwd)/waha/sessions:/app/.sessions" \
            -p 5001:3000 --name waha --restart unless-stopped \
            devlikeapro/waha >/dev/null 2>&1 \
        && ok "WAHA restarted." || err "Failed to restart WAHA."
        sleep 5
    else
        echo "     → Run: bash start.sh dev  (backend auto-starts WAHA)"
    fi
fi
echo ""

# ── 4. Backend health endpoint ─────────────────────
info "4. Backend Health Endpoint"
HEALTH=$(curl -s --max-time 5 http://localhost:5000/api/health 2>&1)
CURL_EXIT=$?
if [ $CURL_EXIT -eq 0 ]; then
    ok "Reachable"
    echo "$HEALTH" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(f'       status     : {d.get(\"status\",\"?\")}')
    print(f'       waha       : {d.get(\"waha\",\"?\")}')
    print(f'       wahaStatus : {d.get(\"wahaStatus\",\"?\")}')
except: pass
" 2>/dev/null || echo "       $HEALTH"
else
    err "Unreachable (curl exit $CURL_EXIT)"
    ALL_OK=false
fi
echo ""

# ── 5. WAHA proxy ─────────────────────────────────
info "5. WAHA Proxy  (via backend /waha/dashboard)"
HTTP=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:5000/waha/dashboard 2>&1)
case "$HTTP" in
    200|301|302) ok "OK  (HTTP $HTTP)" ;;
    000)         err "No response (backend not running?)" ; ALL_OK=false ;;
    *)           err "HTTP $HTTP" ; ALL_OK=false ;;
esac
echo ""

# ── Summary ────────────────────────────────────────
echo "================================================"
if $ALL_OK; then
    ok "All services are running!"
    echo ""
    echo "  Frontend : http://localhost:5173"
    echo "  Backend  : http://localhost:5000"
    echo "  WAHA     : http://localhost:5000/waha/dashboard"
else
    warn "Some services need attention."
    if ! $FIX_MODE; then
        echo ""
        echo "  Run with --fix to attempt auto-repair:"
        echo "  bash status.sh --fix"
    fi
fi
echo "================================================"
echo ""