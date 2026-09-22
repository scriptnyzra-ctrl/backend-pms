#!/bin/bash

# ================================================
# PMS - WAHA Management Script
# Usage: bash waha.sh [start|stop|restart|logs|reset]
# ================================================

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✅ $1${NC}"; }
err()  { echo -e "${RED}❌ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
info() { echo -e "${BOLD}➜  $1${NC}"; }

CMD="${1:-help}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WAHA_ENV="$SCRIPT_DIR/waha/.env"
WAHA_SESSIONS="$SCRIPT_DIR/waha/sessions"

_require_docker() {
    if ! command -v docker &>/dev/null; then
        err "Docker is not installed. Run: bash install.sh"
        exit 1
    fi
}

_run_container() {
    mkdir -p "$WAHA_SESSIONS"

    ENV_ARG=""
    [ -f "$WAHA_ENV" ] && ENV_ARG="--env-file $WAHA_ENV" \
        || warn "waha/.env not found — using default WAHA credentials."

    info "Pulling latest WAHA image..."
    docker pull devlikeapro/waha -q

    # shellcheck disable=SC2086
    docker run -d \
        $ENV_ARG \
        -v "$WAHA_SESSIONS:/app/.sessions" \
        -p 5001:3000 \
        --name waha \
        --restart unless-stopped \
        devlikeapro/waha

    ok "WAHA container started."

    info "Waiting 10 s for WAHA to initialize..."
    for i in {10..1}; do printf "\r   %d s remaining..." $i; sleep 1; done
    echo ""

    HTTP=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:5001/dashboard 2>&1)
    [ "$HTTP" = "200" ] || [ "$HTTP" = "302" ] \
        && ok "WAHA is responding (HTTP $HTTP)" \
        || warn "WAHA may still be starting (HTTP $HTTP) — check logs: bash waha.sh logs"
}

_stop_container() {
    if docker ps --format '{{.Names}}' | grep -q '^waha$'; then
        info "Stopping WAHA container..."
        docker stop waha >/dev/null && ok "Container stopped."
    else
        warn "WAHA is not running."
    fi
}

_remove_container() {
    if docker ps -a --format '{{.Names}}' | grep -q '^waha$'; then
        docker rm -f waha >/dev/null && ok "Container removed."
    fi
}

echo "================================================"
echo "  WAHA Management — $CMD"
echo "================================================"
echo ""

case "$CMD" in

  start)
    _require_docker
    if docker ps --format '{{.Names}}' | grep -q '^waha$'; then
        ok "WAHA is already running."
    else
        _remove_container   # clean stale stopped container
        _run_container
    fi
    ;;

  stop)
    _require_docker
    _stop_container
    ;;

  restart)
    _require_docker
    _stop_container
    _remove_container
    _run_container
    ;;

  logs)
    _require_docker
    if docker ps -a --format '{{.Names}}' | grep -q '^waha$'; then
        LINES="${2:-50}"
        info "Last $LINES lines from WAHA container:"
        echo ""
        docker logs waha --tail "$LINES" 2>&1
    else
        err "WAHA container does not exist."
    fi
    ;;

  reset)
    _require_docker
    warn "This will stop and remove the WAHA container AND delete all sessions."
    read -p "Continue? (y/n): " -n 1 -r; echo
    [[ ! $REPLY =~ ^[Yy]$ ]] && { echo "Cancelled."; exit 0; }

    _stop_container
    _remove_container

    if [ -d "$WAHA_SESSIONS" ]; then
        info "Removing session data..."
        rm -rf "$WAHA_SESSIONS"
        ok "Sessions removed."
    fi

    info "Removing waha/.env..."
    rm -f "$WAHA_ENV"
    ok "Config removed."

    warn "WAHA has been fully reset. Run 'bash waha.sh start' to set up fresh."
    ;;

  help|*)
    echo "Usage: bash waha.sh <command> [options]"
    echo ""
    echo "Commands:"
    echo "  start        Start WAHA container (pulls image if needed)"
    echo "  stop         Stop WAHA container"
    echo "  restart      Stop, remove, and re-start WAHA container"
    echo "  logs [N]     Show last N log lines (default: 50)"
    echo "  reset        Remove container, sessions, and config entirely"
    echo ""
    echo "WAHA runs on:"
    echo "  Direct  : http://localhost:5001/dashboard"
    echo "  Via PMS : http://localhost:5000/waha/dashboard"
    echo ""
    ;;
esac