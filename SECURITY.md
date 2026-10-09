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
- Use long, unique passwords; remove members who no longer need access.
- Keep the server's OS, Node.js and ffmpeg updated.
- Put IP cameras on a separate network or block their internet access in your router.
- Treat camera pairing links and invite links like passwords. Generating a new pairing link revokes the old one.
- Back up `data/secrets.json` and `data/accounts.json` privately; never commit `data/` (it's in `.gitignore`).

## Built-in protections

scrypt password hashing · random session tokens in HttpOnly, SameSite=Strict cookies · login rate limiting ·
CSRF header check on every state-changing request · strict Content-Security-Policy · path-traversal checks on
all media routes · encrypted Web Push (RFC 8291) · systemd sandboxing (`ProtectSystem=strict`) · no third-party
runtime dependencies (nothing to supply-chain).
