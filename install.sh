#!/usr/bin/env bash
# Spectacle installer for Debian/Ubuntu/Raspberry Pi OS/Fedora/Arch.
# - installs Node.js 22+ and ffmpeg if missing
# - makes a self-signed HTTPS certificate for your home network
# - downloads the offline species encyclopedia
# - installs a systemd service so Spectacle runs 24/7 and restarts on boot
set -euo pipefail
cd "$(dirname "$0")"
DIR="$(pwd)"
RUN_USER="${SUDO_USER:-$USER}"

say() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
need_sudo() { if [ "$(id -u)" -ne 0 ]; then sudo "$@"; else "$@"; fi; }

say "Checking ffmpeg"
if ! command -v ffmpeg >/dev/null; then
  if command -v apt-get >/dev/null; then need_sudo apt-get update && need_sudo apt-get install -y ffmpeg openssl
  elif command -v dnf >/dev/null; then need_sudo dnf install -y ffmpeg openssl
  elif command -v pacman >/dev/null; then need_sudo pacman -S --noconfirm ffmpeg openssl
  else echo "Please install ffmpeg, then rerun."; exit 1; fi
fi

say "Checking Node.js (22 or newer)"
NODE_MAJOR=$(node -v 2>/dev/null | sed 's/v\([0-9]*\).*/\1/' || echo 0)
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
  if command -v apt-get >/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | need_sudo bash - && need_sudo apt-get install -y nodejs
  else echo "Please install Node.js 22+ (https://nodejs.org), then rerun."; exit 1; fi
fi

[ -f config.json ] || { cp config.example.json config.json; say "Created config.json (edit it any time)"; }

if [ ! -f certs/cert.pem ]; then
  say "Creating a self-signed HTTPS certificate for your home network"
  mkdir -p certs
  IPS=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9.]+$' | sed 's/^/IP:/' | paste -sd, -)
  SAN="DNS:localhost,DNS:$(hostname),DNS:$(hostname).local,IP:127.0.0.1${IPS:+,$IPS}"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
    -keyout certs/key.pem -out certs/cert.pem -subj "/CN=Spectacle" -addext "subjectAltName=$SAN" 2>/dev/null
  chmod 600 certs/key.pem
fi

# Optional: everything else works without it. Only public species names are sent (to Wikipedia,
# Wikimedia Commons and GBIF), never anything from your cameras. Your IP address is visible to them.
CHOICE="${SPECTACLE_SPECIES_DB:-}"
if [ -z "$CHOICE" ] && [ -t 0 ]; then
  echo
  echo "Optional: download plain-language explanations for the 4,086 species Spectacle can identify?"
  echo "  This is a one-time download from Wikipedia, Wikimedia Commons and GBIF. It sends only"
  echo "  species names (never camera footage or photos). Identification works without it."
  read -r -p "  Download now? [y/N] " CHOICE
fi
case "$CHOICE" in
  y|Y|yes|YES)
    say "Downloading the offline species database (a few minutes; safe to rerun)"
    node server/scripts/build-species-db.js || echo "Download didn't finish — run 'npm run species-db' later to resume." ;;
  *) echo "Skipped. You can run 'npm run species-db' any time (add --no-images to skip reference photos)." ;;
esac

if command -v systemctl >/dev/null; then
  say "Installing the spectacle service (runs 24/7, starts on boot)"
  need_sudo tee /etc/systemd/system/spectacle.service >/dev/null <<EOF
[Unit]
Description=Spectacle family cameras
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
WorkingDirectory=$DIR
ExecStart=$(command -v node) $DIR/server/index.js
Restart=always
RestartSec=3
Nice=5
# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$DIR/data
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
  mkdir -p data && chown -R "$RUN_USER" data
  need_sudo systemctl daemon-reload
  need_sudo systemctl enable --now spectacle
fi

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
cat <<EOF

Spectacle is running.
  At home:   https://${IP:-this-computer}:8443   (accept the certificate warning once per device)
  Anywhere:  see README → "Remote access & phone notifications" (Tailscale recommended)
Logs:  journalctl -u spectacle -f
EOF
