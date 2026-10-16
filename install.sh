#!/usr/bin/env bash
# Spectacle installer for Debian/Ubuntu/Raspberry Pi OS/Fedora/Arch.
# - installs Node.js 22+ and ffmpeg if missing
# - makes a self-signed HTTPS certificate for your home network
# - downloads the offline species encyclopedia (optional)
# - installs smart detection: people / vehicles / animals and zones (optional, runs locally)
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

# Optional smart detection: tells people, vehicles and animals apart and supports zones.
# Runs only on this computer (nothing is sent anywhere). One-time download of ~50–250 MB from GitHub.
SMART="${SPECTACLE_SMART:-}"
if [ -z "$SMART" ] && [ -t 0 ]; then
  echo
  echo "Turn on smart detection? Alerts then say \"Person in Driveway\" instead of just \"Motion\","
  echo "  and you can draw zones. It runs only on this computer; nothing is sent anywhere."
  read -r -p "  Install smart detection now? [Y/n] " SMART
  SMART="${SMART:-y}"
fi
case "$SMART" in
  y|Y|yes|YES) node server/scripts/setup-smart.js || echo "Smart detection didn't install. You can try again later with: npm run smart-detection" ;;
  *) echo "Skipped. Install it any time with: npm run smart-detection" ;;
esac

# ---------- Encryption key, sealed to this machine ----------
# Everything Spectacle saves (accounts, recordings, snapshots, photos) is encrypted. The key is sealed with
# systemd-creds: tied to this computer's TPM security chip when it has one, so a copied or stolen disk
# can't be read anywhere else. Without systemd-creds the key stays in data/vault.key (owner-only).
LOAD_KEY=""
if command -v systemctl >/dev/null && command -v systemd-creds >/dev/null && systemd-creds encrypt --help >/dev/null 2>&1; then
  CRED=/etc/spectacle/spectacle-key.cred
  if ! need_sudo test -f "$CRED"; then
    say "Sealing Spectacle's encryption key to this machine"
    need_sudo install -d -m 700 /etc/spectacle
    TMPKEY=$(mktemp); chmod 600 "$TMPKEY"
    if [ -f data/vault.key ]; then cp data/vault.key "$TMPKEY"; else head -c 32 /dev/urandom | base64 > "$TMPKEY"; fi
    if need_sudo systemd-creds encrypt --name=spectacle-key --with-key=auto "$TMPKEY" "$CRED" \
       && need_sudo systemd-creds decrypt --name=spectacle-key "$CRED" - | cmp -s - "$TMPKEY"; then
      need_sudo chmod 600 "$CRED"
      [ -f data/vault.key ] && { shred -u data/vault.key 2>/dev/null || rm -f data/vault.key; }
      echo "Key sealed ($(need_sudo systemd-creds has-tpm2 >/dev/null 2>&1 && echo 'with the TPM chip' || echo 'to this machine'))."
    else
      echo "Couldn't seal the key; Spectacle will keep it in data/vault.key instead."
      need_sudo rm -f "$CRED"; [ -f data/vault.key ] || { mkdir -p data; cp "$TMPKEY" data/vault.key; chmod 600 data/vault.key; }
    fi
    shred -u "$TMPKEY" 2>/dev/null || rm -f "$TMPKEY"
  fi
  need_sudo test -f "$CRED" && LOAD_KEY="LoadCredentialEncrypted=spectacle-key:$CRED"
fi

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
$LOAD_KEY
# Hardening
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$DIR/data
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictSUIDSGID=true
RestrictRealtime=true
RestrictNamespaces=true
LockPersonality=true
CapabilityBoundingSet=
SystemCallArchitectures=native
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK

[Install]
WantedBy=multi-user.target
EOF
  mkdir -p data && chmod 700 data && chown -R "$RUN_USER" data
  need_sudo systemctl daemon-reload
  need_sudo systemctl enable --now spectacle
  need_sudo systemctl restart spectacle
fi

# The first admin account needs this code, so nobody else on the network can claim it first.
for _ in $(seq 1 20); do [ -f data/SETUP-CODE.txt ] && break; sleep 0.5; done
SETUP_CODE=$(sed -n 's/^Spectacle setup code: //p' data/SETUP-CODE.txt 2>/dev/null || true)

# ---------- Private access from anywhere (Tailscale) ----------
# Optional. Gives the server a private https://<name>.ts.net address with a real certificate, reachable only
# by devices you invite. Family install the Tailscale app once; nothing is opened to the public internet.
TS_CHOICE="${SPECTACLE_TAILSCALE:-}"
if [ -z "$TS_CHOICE" ] && [ -t 0 ]; then
  echo
  echo "Set up Tailscale so family can use Spectacle away from home (recommended)?"
  echo "  It's a private connection: only people you share the server with can reach it."
  read -r -p "  Set up Tailscale now? [Y/n] " TS_CHOICE
  TS_CHOICE="${TS_CHOICE:-y}"
fi
case "$TS_CHOICE" in
  y|Y|yes|YES)
    if ! command -v tailscale >/dev/null; then
      say "Installing Tailscale"
      curl -fsSL https://tailscale.com/install.sh | need_sudo sh
    fi
    if ! tailscale status >/dev/null 2>&1; then
      say "Sign this server in to Tailscale (a link will appear; open it on any device)"
      need_sudo tailscale up
    fi
    say "Publishing Spectacle privately on your tailnet"
    need_sudo tailscale serve --bg 8080 >/dev/null
    TS_NAME=$(tailscale status --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).Self.DNSName.replace(/\.$/,""))}catch{}})')
    if [ -n "$TS_NAME" ]; then
      node -e 'const fs=require("fs");const f="config.json";const c=JSON.parse(fs.readFileSync(f,"utf8"));c.publicUrl=process.argv[1];fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n")' "https://$TS_NAME"
      TS_URL="https://$TS_NAME"
      command -v systemctl >/dev/null && need_sudo systemctl restart spectacle 2>/dev/null || true
    else
      echo "Couldn't read the Tailscale name. Run 'tailscale status' and put https://<name>.ts.net in config.json → publicUrl."
    fi ;;
  *) echo "Skipped. Spectacle will only work on your home Wi-Fi until you set up Tailscale (see README)." ;;
esac

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
cat <<EOF

Spectacle is running.
${SETUP_CODE:+  Setup code: $SETUP_CODE   (you'll enter this when creating the admin account)
}  At home:   https://${IP:-this-computer}:8443   (accept the certificate warning once per device)
  Anywhere:  ${TS_URL:-not set up yet (see README: Tailscale)}
Invite family from the Family tab. Each invite message tells them how to install Tailscale and Spectacle.
Logs:  journalctl -u spectacle -f
EOF
