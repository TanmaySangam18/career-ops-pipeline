#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✅ $*${NC}"; }
info() { echo -e "${CYAN}ℹ️  $*${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $*${NC}"; }
die()  { echo -e "${RED}❌ $*${NC}" >&2; exit 1; }

echo -e "${CYAN}"
echo "╔══════════════════════════════════════════╗"
echo "║   career-ops cloud setup — Ubuntu 22.04  ║"
echo "╚══════════════════════════════════════════╝"
echo -e "${NC}"

[[ "$(id -u)" -eq 0 ]] || die "Run as root (sudo bash cloud-setup.sh)"

# ── 1. Node.js 20 ─────────────────────────────────────────────────────────────
info "Step 1/8 — Installing Node.js 20 via NodeSource..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  || die "NodeSource setup script failed"
apt-get install -y nodejs \
  || die "apt-get install nodejs failed"
ok "Node $(node -v)  npm $(npm -v)"

# ── 2. Chromium system deps ────────────────────────────────────────────────────
info "Step 2/8 — Installing headless Chromium system dependencies..."
apt-get install -y \
  xvfb libgbm1 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
  libxfixes3 libxrandr2 libasound2 libpango-1.0-0 libpangocairo-1.0-0 \
  || die "apt-get install chromium deps failed"
ok "Chromium system dependencies installed"

# ── 3. PM2 ────────────────────────────────────────────────────────────────────
info "Step 3/8 — Installing PM2 globally..."
npm install -g pm2 \
  || die "npm install -g pm2 failed"
ok "PM2 $(pm2 -v)"

# ── 4. npm install ─────────────────────────────────────────────────────────────
info "Step 4/8 — Installing career-ops npm dependencies..."
CAREER_OPS_DIR="${HOME}/career-ops"
[[ -d "$CAREER_OPS_DIR" ]] || die "~/career-ops not found — clone the repo first"
cd "$CAREER_OPS_DIR"
npm install \
  || die "npm install in ~/career-ops failed"
ok "npm dependencies installed"

# ── 5. Playwright Chromium ─────────────────────────────────────────────────────
info "Step 5/8 — Installing Playwright Chromium browser..."
npx playwright install chromium \
  || die "playwright install chromium failed"
npx playwright install-deps chromium \
  || die "playwright install-deps chromium failed"
ok "Playwright Chromium ready"

# ── 6. .env.cloud ──────────────────────────────────────────────────────────────
info "Step 6/8 — Creating .env.cloud with placeholders..."
ENV_FILE="${CAREER_OPS_DIR}/.env.cloud"
if [[ -f "$ENV_FILE" ]]; then
  warn ".env.cloud already exists — skipping (edit manually)"
else
  cat > "$ENV_FILE" <<'EOF'
TELEGRAM_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_chat_id
CAREER_OPS_HEADLESS=true
CAREER_OPS_CONCURRENCY=3
EOF
  ok ".env.cloud created at ${ENV_FILE}"
  warn "Fill in TELEGRAM_TOKEN and TELEGRAM_CHAT_ID before the daemon starts"
fi

# ── 7. Start daemon via PM2 ────────────────────────────────────────────────────
info "Step 7/8 — Starting cloud-daemon.mjs via PM2..."
cd "$CAREER_OPS_DIR"
pm2 delete career-ops 2>/dev/null || true
pm2 start cloud-daemon.mjs --name career-ops --interpreter node \
  || die "pm2 start cloud-daemon.mjs failed"
ok "Daemon running (pm2 list to verify)"

# ── 8. PM2 startup + save ──────────────────────────────────────────────────────
info "Step 8/8 — Configuring PM2 to survive reboots..."
PM2_STARTUP=$(pm2 startup 2>&1 | grep "sudo" | tail -1)
if [[ -n "$PM2_STARTUP" ]]; then
  eval "$PM2_STARTUP" \
    || warn "pm2 startup command failed — run manually: ${PM2_STARTUP}"
fi
pm2 save \
  || die "pm2 save failed"
ok "PM2 startup hook configured"

# ── Done ───────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════╗"
echo    "║               Setup complete!                        ║"
echo    "╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo "Next steps:"
echo "  1. Edit ~/career-ops/.env.cloud — add your Telegram token + chat ID"
echo "  2. pm2 restart career-ops     — pick up new env vars"
echo "  3. pm2 logs career-ops        — tail live logs"
echo "  4. curl http://localhost:3456  — check daemon status page"
echo ""
echo "Schedule (UTC):"
echo "  23:00 scan  →  00:30 eval  →  07:00 tailor  →  08:00 LinkedIn"
echo "  09:00 ATS   →  10:00 merge →  10:30 network →  11:00 summary"
