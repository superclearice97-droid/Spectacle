#!/usr/bin/env bash
# CI only: start a throwaway Spectacle server with a self-signed cert reachable from the Android emulator
# (10.0.2.2 = the host), create an admin, and write an invite link (with cert pin) to $RUNNER_TEMP/invite.txt
set -euo pipefail
cd "$(dirname "$0")/../.."
T="$RUNNER_TEMP/spectacle-ci"; mkdir -p "$T/certs"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 \
  -keyout "$T/certs/key.pem" -out "$T/certs/cert.pem" -subj "/CN=Spectacle CI" \
  -addext "subjectAltName=IP:10.0.2.2,IP:127.0.0.1" 2>/dev/null
cat > "$T/config.json" <<EOF
{ "dataDir": "$T/data",
  "http":  { "enabled": true, "host": "127.0.0.1", "port": 8080 },
  "https": { "enabled": true, "host": "0.0.0.0", "port": 8443, "cert": "$T/certs/cert.pem", "key": "$T/certs/key.pem" } }
EOF
SPECTACLE_CONFIG="$T/config.json" nohup node server/index.js > "$T/server.log" 2>&1 &
for i in $(seq 1 50); do curl -sk https://127.0.0.1:8443/api/state >/dev/null && break; sleep 0.2; done
H=(-sk -H 'X-Spectacle: 1' -H 'Content-Type: application/json' -c "$T/jar" -b "$T/jar")
SETUP=$(sed -n 's/^Spectacle setup code: //p' "$T/data/SETUP-CODE.txt")
curl -f "${H[@]}" https://127.0.0.1:8443/api/setup -d "{\"setupCode\":\"$SETUP\",\"name\":\"CI Admin\",\"username\":\"ciadmin\",\"password\":\"ci-password-123\",\"consent\":{\"terms\":true,\"presence\":true}}" >/dev/null
INV=$(curl "${H[@]}" https://127.0.0.1:8443/api/invites -d '{}')
CODE=$(node -e "const j=JSON.parse(process.argv[1]);process.stdout.write(j.code)" "$INV")
FP=$(node -e "const j=JSON.parse(process.argv[1]);process.stdout.write(j.fp||'')" "$INV")
[ -n "$FP" ] || { echo "server did not return a cert fingerprint"; exit 1; }
LINK="https://10.0.2.2:8443/#join/$CODE?fp=$FP"
node -e "process.stdout.write(encodeURIComponent(process.argv[1]))" "$LINK" > "$RUNNER_TEMP/invite-encoded.txt"
echo "Invite link: $LINK"
