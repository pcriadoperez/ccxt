#!/usr/bin/env bash
# One-command setup for CCXT Radar on a fresh Ubuntu 22.04+/Debian 12+ server (run as root).
#
#   curl -fsSL https://raw.githubusercontent.com/pcriadoperez/ccxt/claude/inspiring-wozniak-ydnboe/radar/scripts/setup-server.sh -o setup-server.sh
#   bash setup-server.sh            # first install: asks for the bot token and (optional) OpenRouter key
#   bash setup-server.sh update     # later: pull the latest code and restart
#
# Non-interactive: TELEGRAM_BOT_TOKEN=... OPENROUTER_API_KEY=... bash setup-server.sh
# Optional: REPO_URL, BRANCH, INSTALL_DIR to install from somewhere else.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/pcriadoperez/ccxt.git}"
BRANCH="${BRANCH:-claude/inspiring-wozniak-ydnboe}"
INSTALL_DIR="${INSTALL_DIR:-/opt/ccxt-radar}"
MODE="${1:-install}"
APP_DIR="$INSTALL_DIR/radar"

say () { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn () { printf '\033[33m! %s\033[0m\n' "$*"; }
die () { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root (or with sudo)."
case "$MODE" in install|update) ;; *) die "Usage: $0 [install|update]";; esac

# ------------------------------------------------------------------ Docker
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    say "Installing Docker"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl git >/dev/null
    if ! apt-get install -y -qq docker.io docker-compose-v2 >/dev/null 2>&1; then
        warn "Distribution packages not available; using Docker's official install script"
        curl -fsSL https://get.docker.com | sh
    fi
    systemctl enable --now docker >/dev/null 2>&1 || true
fi
docker compose version >/dev/null 2>&1 || die "docker compose is not available after installing Docker."
command -v git >/dev/null 2>&1 || apt-get install -y -qq git >/dev/null

# ------------------------------------------------------------------ Code
if [ -d "$INSTALL_DIR/.git" ]; then
    say "Updating code ($BRANCH)"
    git -C "$INSTALL_DIR" fetch -q --depth 1 origin "$BRANCH"
    git -C "$INSTALL_DIR" checkout -q -B "$BRANCH" FETCH_HEAD
else
    [ "$MODE" = "update" ] && die "Nothing installed in $INSTALL_DIR yet. Run without 'update' first."
    say "Downloading code ($BRANCH)"
    # Only the radar folder is needed: sparse checkout keeps the download small.
    git clone -q --depth 1 --filter=blob:none --sparse -b "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
    git -C "$INSTALL_DIR" sparse-checkout set radar
fi
cd "$APP_DIR"

# ------------------------------------------------------------------ Configuration
set_env () { # set_env KEY VALUE: replace or append KEY=VALUE in .env
    local key="$1" value="$2"
    if grep -qE "^#? ?${key}=" .env; then
        local esc="${value//\\/\\\\}"
        esc="${esc//|/\\|}"
        esc="${esc//&/\\&}"
        sed -i -E "s|^#? ?${key}=.*|${key}=${esc}|" .env
    else
        printf '%s=%s\n' "$key" "$value" >> .env
    fi
}

if [ ! -f .env ]; then
    say "Configuring the bot"
    cp .env.example .env
    chmod 600 .env
    token="${TELEGRAM_BOT_TOKEN:-}"
    while [ -z "$token" ]; do
        read -r -s -p "Telegram bot token from @BotFather: " token </dev/tty; echo
    done
    me="$(curl -fsS "https://api.telegram.org/bot${token}/getMe" 2>/dev/null || true)"
    username="$(printf '%s' "$me" | sed -nE 's/.*"username":"([^"]+)".*/\1/p')"
    [ -n "$username" ] || die "Telegram rejected that token. Check it with @BotFather and run this script again."
    echo "✓ Token works for @$username"
    set_env TELEGRAM_BOT_TOKEN "$token"
    set_env RADAR_BOT_USERNAME "$username"

    key="${OPENROUTER_API_KEY-__ask__}"
    if [ "$key" = "__ask__" ]; then
        read -r -s -p "OpenRouter API key for the AI assistant (Enter to skip): " key </dev/tty; echo
    fi
    if [ -n "$key" ]; then
        code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $key" https://openrouter.ai/api/v1/key || true)"
        if [ "$code" = "200" ]; then echo "✓ OpenRouter key works"; else warn "OpenRouter answered HTTP $code; keeping the key, check it if the AI stays off"; fi
        set_env OPENROUTER_API_KEY "$key"
    else
        echo "AI assistant off (add OPENROUTER_API_KEY to $APP_DIR/.env later)"
    fi
else
    echo "Keeping existing $APP_DIR/.env"
fi

# ------------------------------------------------------------------ Reachability
say "Checking exchange access from this server"
for url in https://api.binance.com/api/v3/ping https://api.bybit.com/v5/market/time https://www.okx.com/api/v5/public/time; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url" || true)"
    host="$(printf '%s' "$url" | cut -d/ -f3)"
    if [ "$code" = "200" ]; then echo "✓ $host"; else warn "$host answered HTTP $code (451/403 usually means this server's country is blocked)"; fi
done

# ------------------------------------------------------------------ Start
say "Building and starting"
docker compose up -d --build
sleep 5
docker compose ps
echo
docker compose logs --tail 20
username="$(sed -nE 's/^RADAR_BOT_USERNAME=(.+)$/\1/p' .env)"
say "Done"
cat <<EOF
Open https://t.me/${username:-your_bot} and send /start.

Useful commands (run in $APP_DIR):
  docker compose logs -f          live logs (a status line every minute)
  docker compose ps               health: "healthy" once the first heartbeat is written
  docker compose restart          restart after editing .env
  bash scripts/setup-server.sh update   pull the latest code and rebuild
  docker compose down             stop (alerts and users stay in the radar-data volume)
EOF
