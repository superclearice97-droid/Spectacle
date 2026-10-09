# Contributing to Spectacle

Thanks for helping! A few ground rules keep Spectacle simple and private.

## Principles

1. **Privacy first.** Footage, photos and identifications stay on the home server. Any feature that sends data
   elsewhere (cloud AI, external notifications, analytics) must be **optional and off by default**, documented in
   `public/legal/privacy.html`, and listed in the README's privacy table.
2. **No runtime dependencies.** Spectacle runs on plain Node.js 22+ and ffmpeg. Please don't add npm packages;
   if you think one is truly needed, open an issue first.
3. **No build step.** The web app in `public/` is plain HTML/CSS/JS.
4. **Respect the people on camera.** No face recognition, people tracking, or covert-recording features.

## Development

```bash
cp config.example.json config.json   # set https.enabled=false for local dev
npm start                             # http://127.0.0.1:8080
npm test                              # end-to-end smoke test (needs ffmpeg)
```

`SPECTACLE_DEBUG=1 npm start` prints ffmpeg output and biome scan timings.

## Pull requests

- Keep changes focused; describe what and why.
- Run `npm test` and make sure CI passes.
- If you change what data is collected or where it goes, update the privacy policy and bump the version date
  in `server/lib/auth.js` (`LEGAL_VERSION`) so members are asked to re-accept.
- Never commit real footage, credentials or anything from `data/`.

By contributing you agree your work is released under the MIT License.
