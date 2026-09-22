#!/bin/bash

# ================================================
# PMS - Installation Script
# Installs Docker (if needed) + npm dependencies
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

echo "================================================"
echo "  PMS Installation Script"
echo "================================================"
echo ""

# ── 1. Docker ──────────────────────────────────────
info "Checking Docker..."

if command -v docker &>/dev/null; then
    ok "Docker already installed: $(docker --version)"
else
    warn "Docker not found. Installing Docker Engine (requires sudo)..."
    echo ""

    if [ ! -f /etc/os-release ]; then
        err "Cannot detect OS. Install Docker manually: https://docs.docker.com/engine/install/"
        exit 1
    fi

    . /etc/os-release

    read -p "Install Docker on $ID $VERSION_ID? (y/n): " -n 1 -r; echo
    [[ ! $REPLY =~ ^[Yy]$ ]] && { echo "Skipped."; exit 0; }

    sudo apt-get update -q
    sudo apt-get install -y -q ca-certificates curl gnupg lsb-release

    sudo mkdir -p /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/$ID/gpg \
        | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg

    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/$ID $(lsb_release -cs) stable" \
        | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

    sudo apt-get update -q
    sudo apt-get install -y -q docker-ce docker-ce-cli containerd.io \
        docker-buildx-plugin docker-compose-plugin

    sudo docker run --rm hello-world &>/dev/null && ok "Docker installed successfully!" \
        || { err "Docker verification failed."; exit 1; }

    sudo usermod -aG docker "$USER"
    warn "Run 'newgrp docker' or re-login to use Docker without sudo."
fi

echo ""

# ── 2. npm dependencies ────────────────────────────
info "Checking npm dependencies..."

if [ ! -f package.json ]; then
    err "package.json not found. Run this script from the backend-pms directory."
    exit 1
fi

if [ -d node_modules ]; then
    ok "node_modules already exists. Skipping npm install."
else
    info "Installing npm packages..."
    npm install && ok "npm packages installed." || { err "npm install failed."; exit 1; }
fi

echo ""

# ── 3. Environment file ────────────────────────────
info "Checking .env file..."

if [ -f .env ]; then
    ok ".env file found."
else
    if [ -f .env.example ]; then
        cp .env.example .env
        warn ".env created from .env.example — please fill in your values."
    else
        warn "No .env or .env.example found. Create a .env file before starting the server."
    fi
fi

echo ""
echo "================================================"
ok "Installation complete!"
echo "================================================"
echo ""
echo "Next steps:"
echo "  Development : bash start.sh dev"
echo "  Production  : bash start.sh prod"
echo ""