#!/usr/bin/env bash
# Sets up (or updates) the GameShelf website on a fresh Ubuntu or Debian VPS.
#
#   bash setup-vps.sh [your-domain.com]
#
# Run it as root. Without a domain, the site gets a free name that points at
# this server's IP (<ip with dashes>.sslip.io), so HTTPS works right away;
# run it again with your own domain once its DNS A record points here.
# Running it again also updates GameShelf to the latest code. Your keys go in
# /etc/gameshelf.env, which this script never overwrites.
set -euo pipefail

REPO=https://github.com/Alseiari971/Project-2.git
BRANCH=${GAMESHELF_BRANCH:-claude/clever-brahmagupta-stqn0m}
APP=/opt/gameshelf
ENV_FILE=/etc/gameshelf.env
DATA=/var/lib/gameshelf
BACKUPS=/var/backups/gameshelf

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root (log in as root, or put sudo in front)." >&2
  exit 1
fi
if ! command -v apt-get >/dev/null; then
  echo "This script is for Ubuntu or Debian." >&2
  exit 1
fi

IP=$(hostname -I | awk '{print $1}')
DOMAIN=${1:-}
if [ -z "$DOMAIN" ] && [ -f /etc/caddy/Caddyfile ] && grep -q '# gameshelf' /etc/caddy/Caddyfile; then
  DOMAIN=$(awk '/# gameshelf/ {getline; print $1; exit}' /etc/caddy/Caddyfile)
fi
DOMAIN=${DOMAIN:-${IP//./-}.sslip.io}

echo "==> Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl git gnupg ufw sqlite3 debian-keyring debian-archive-keyring apt-transport-https

if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)' 2>/dev/null; then
  echo "==> Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi

if ! command -v caddy >/dev/null; then
  echo "==> Installing Caddy (HTTPS)"
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

echo "==> Getting GameShelf ($BRANCH)"
id gameshelf >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin gameshelf
if [ -d "$APP/.git" ]; then
  git -C "$APP" fetch -q origin "$BRANCH"
  git -C "$APP" checkout -q -B "$BRANCH" "origin/$BRANCH"
else
  git clone -q -b "$BRANCH" "$REPO" "$APP"
fi
# The website doesn't need Electron, which only the desktop app uses.
(cd "$APP" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

if [ ! -f "$ENV_FILE" ]; then
  echo "==> Writing $ENV_FILE (fill in your keys)"
  cat > "$ENV_FILE" <<EOF
# GameShelf settings. Edit with:  nano $ENV_FILE
# then apply with:                systemctl restart gameshelf
NODE_ENV=production
PORT=3000
DB_FILE=$DATA/gameshelf.db

# Every game (from https://dev.twitch.tv/console/apps, see the README):
IGDB_CLIENT_ID=
IGDB_CLIENT_SECRET=
# "Import from Steam" (https://steamcommunity.com/dev/apikey):
STEAM_API_KEY=
# Shared Arabic translation (https://platform.openai.com/api-keys):
OPENAI_API_KEY=
# Spending limits: new lines per user per day, characters per month in all.
TRANSLATE_DAILY_LINES=2000
TRANSLATE_MONTHLY_CHARS=3000000
# Your username on the site: can see the most asked-for games, and your pack builds teach it RE Engine games' font names.
ARABIC_ADMINS=
EOF
fi
chown root:root "$ENV_FILE"
chmod 600 "$ENV_FILE"

echo "==> Setting up the gameshelf service"
cat > /etc/systemd/system/gameshelf.service <<EOF
[Unit]
Description=GameShelf website
After=network-online.target
Wants=network-online.target

[Service]
User=gameshelf
WorkingDirectory=$APP
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=3
StateDirectory=gameshelf
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

echo "==> Daily database backups to $BACKUPS (two weeks kept)"
install -d -m 700 "$BACKUPS"
cat > /usr/local/bin/gameshelf-backup <<EOF
#!/bin/sh
set -e
sqlite3 "$DATA/gameshelf.db" ".backup '$BACKUPS/gameshelf-\$(date +%F).db'"
find "$BACKUPS" -name 'gameshelf-*.db' -mtime +14 -delete
EOF
chmod 755 /usr/local/bin/gameshelf-backup
cat > /etc/systemd/system/gameshelf-backup.service <<EOF
[Unit]
Description=Back up the GameShelf database

[Service]
Type=oneshot
ExecStart=/usr/local/bin/gameshelf-backup
EOF
cat > /etc/systemd/system/gameshelf-backup.timer <<EOF
[Unit]
Description=Back up the GameShelf database every day

[Timer]
OnCalendar=*-*-* 04:17
Persistent=true

[Install]
WantedBy=timers.target
EOF

echo "==> HTTPS for $DOMAIN"
cat > /etc/caddy/Caddyfile <<EOF
# gameshelf
$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000
}
EOF

echo "==> Firewall: only SSH, HTTP and HTTPS"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443 >/dev/null
ufw --force enable >/dev/null

systemctl daemon-reload
systemctl enable -q gameshelf gameshelf-backup.timer caddy
systemctl restart gameshelf
systemctl start gameshelf-backup.timer
systemctl reload caddy 2>/dev/null || systemctl restart caddy

sleep 2
if systemctl is-active -q gameshelf; then
  echo
  echo "GameShelf is running: https://$DOMAIN"
  echo "Add your keys:   nano $ENV_FILE"
  echo "Then restart:    systemctl restart gameshelf"
  echo "See its log:     journalctl -u gameshelf -n 50"
else
  echo "GameShelf didn't start. Its log:" >&2
  journalctl -u gameshelf -n 30 --no-pager >&2
  exit 1
fi
