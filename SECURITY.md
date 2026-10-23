# Security policy

Spectacle handles home camera footage, so security reports are taken seriously.

## Reporting a vulnerability

Please **don't** open a public issue. Use GitHub's private reporting instead:
**Security → Report a vulnerability** on this repository
(https://github.com/superclearice97-droid/spectacle/security/advisories/new).

Include what you found, how to reproduce it, and the impact you expect. Don't include real footage or
anyone's personal data. You'll get a reply as soon as possible; please allow time for a fix before
publishing details.

## Supported versions

Only the latest commit on `main` receives security fixes.

## Hardening your installation

- Reach Spectacle remotely through Tailscale (or another VPN). **Never** port-forward it to the internet.
- Prefer `rtsps://` camera addresses. Plain `rtsp://` is accepted but is **not encrypted or authenticated end to end**, so anyone on the same network could watch or tamper with the stream. Keep such cameras on a separate network. Spectacle shows a warning for any camera using `rtsp://`.
- Use long, unique passwords; remove members who no longer need access.
- Keep the server's OS, Node.js and ffmpeg updated.
- Put IP cameras on a separate network or block their internet access in your router.
- Treat camera pairing links and invite links like passwords. Generating a new pairing link revokes the old one.
- Back up `data/secrets.json` and `data/accounts.json` privately; never commit `data/` (it's in `.gitignore`).

## Built-in protections

- **Encryption at rest:** accounts, settings, the motion log, biome log, secrets, motion snapshots, biome photos
  and recordings are encrypted with AES-256-GCM (per-file keys, 64 KiB authenticated chunks, so tampering is
  detected). The master key is sealed with `systemd-creds` (bound to the TPM chip when present) by `install.sh`;
  otherwise it lives in `data/vault.key` (mode 600). Segments still being recorded stay in RAM (`/dev/shm`) and
  are encrypted to disk as soon as they finish, so unencrypted footage never touches the disk.
- **Accounts:** scrypt password hashing · constant-work sign-in (doesn't reveal which usernames exist) · per-account
  and per-address rate limiting on sign-in, invites and setup · first admin account requires the one-time setup
  code printed by the installer · changing a password signs out every other device.
- **Web:** random session tokens in HttpOnly, SameSite=Strict cookies · CSRF header check on every state-changing
  request · WebSocket Origin check · strict Content-Security-Policy, `frame-ancestors 'none'`, COOP/CORP ·
  footage and photos sent with `Cache-Control: no-store` so they never land in browser caches · signed-out
  visitors can't see whether the system is armed.
- **Media handling:** ffmpeg only ever opens the camera stream or our own pipe (`-protocol_whitelist`); uploads
  must be JPEG, PNG or WebP and are decoded with a fixed demuxer · path-traversal checks on all media routes.
- **Other:** encrypted Web Push (RFC 8291), push endpoints limited to real browser push services · systemd
  sandboxing (`ProtectSystem=strict`, no capabilities, restricted namespaces and address families,
  `UMask=0077`) · no third-party runtime dependencies in Spectacle itself (nothing to supply-chain). The optional
  smart-detection add-on installs one pinned package (onnxruntime-node 1.24.3) and models verified against
  SHA-256 checksums built into the code.
