#!/usr/bin/env bash
set -euo pipefail

# Moneta — First-time setup
# Usage: ./setup.sh

echo "=== Moneta Setup ==="

# Check prerequisites
command -v node >/dev/null 2>&1 || { echo "Error: Node.js is required (see docker/Dockerfile for the version Moneta ships with)."; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "Error: npm is required."; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "Error: Docker (with Compose) is required."; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Error: 'docker compose' is required."; exit 1; }

# Environment
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example — edit it with your values."
  echo "  Generate secrets with:"
  echo "    API_TOKEN=\$(openssl rand -hex 24)"
  echo "    APP_ENCRYPTION_KEY=\$(openssl rand -hex 32)"
  echo "  Then fill in TRUELAYER_* (docs/truelayer-setup.md) and ACTUAL_* (docs/actual-setup.md)."
else
  echo ".env already exists — leaving it as is."
fi

# Dependencies
echo "Installing dependencies..."
npm install

echo ""
echo "=== Setup complete! ==="
echo ""
echo "Next steps:"
echo "  1. Edit .env with your TrueLayer and Actual Budget configuration"
echo "  2. Run: docker compose up -d --build"
echo "  3. Open: http://localhost:3000/ui"
echo "  4. Budget UI: http://localhost:5006"
echo "  5. Using Claude Code? CLAUDE.md has all the context."
