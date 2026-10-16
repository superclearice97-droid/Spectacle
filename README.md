<p align="center"><img src="public/icon-192.png" width="88" alt=""></p>

## New: independent apps for Linux and Android

Spectacle now includes a **Linux desktop app** that runs its own local camera server, and **Android independent mode** for capture, motion snapshots, recordings and offline species identification on the phone itself. Each works without the other. Shared-server connections remain optional.

See [installation, capabilities and current limits](docs/standalone.md). Download builds from the **Linux desktop** and **Android app** workflow artifacts on the standalone branch/PR. Android independent mode monitors while its Camera screen is open; Linux supports its own webcam and RTSP cameras.

<h1 align="center">Spectacle</h1>
<p align="center"><b>Private, self-hosted family security cameras — with a backyard biome log.</b></p>
<p align="center">
  <a href="https://github.com/superclearice97-droid/spectacle/actions/workflows/ci.yml"><img src="https://github.com/superclearice97-droid/spectacle/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522-3c873a" alt="Node 22+">
  <img src="https://img.shields.io/badge/dependencies-0-success" alt="Zero dependencies">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT"></a>
</p>

Spectacle turns a Linux box and your cameras (IP cams or old phones) into a 24/7 home security system the whole family can use at once — and quietly identifies the bugs, flowers and birds your cameras see, filing each species into its own folder with an explanation. Everything runs and stays in your home.

<p align="center">
  <img src="docs/screenshots/cameras-desktop.png" alt="Camera grid with live family presence" width="100%"><br>
  <img src="docs/screenshots/biome-mobile.png" alt="Biome log on a phone" width="32%">
  <img src="docs/screenshots/family-mobile.png" alt="Family presence on a phone" width="32%">
</p>

## What it does

- **Cameras, 24/7** — IP cameras (RTSP/ONVIF: Reolink, Amcrest, Tapo, Hikvision…) and any old phone or webcam (opened in a browser). Continuous recording in 10-minute MP4 files, auto-deleted after 14 days or when disk gets low.
- **Multiple people at once** — everyone signed in sees who else is online (avatars in the top bar) and which camera they're watching (avatars on each camera tile). Quick notes to everyone online from the Family tab.
- **Motion alerts to the whole family** — phone notifications (Web Push), live in-app alerts, and optional [ntfy](https://ntfy.sh). Snapshot + jump to the moment in the recording. "Armed / Home" switch pauses alerts for everyone; each person can mute cameras for themselves.
- **Two-way talk & doorbell**: talk to whoever is at a camera, like a Nest doorbell. Phone and webcam cameras can show a big **Ring** button; pressing it alerts the family (even when set to Home), and the alert opens straight to **Answer**. Calls are live through your own server and **never recorded**. The camera always plays a chime and shows who's talking. One person talks at a time; others can listen in.
- **Smart detection (optional)**: alerts say *"Person in Driveway"* or *"Car at Front door"* instead of just "Motion". You can draw zones on each camera, set "only alert if they stay 30 seconds", and see live labels while you watch. Parked cars and other things that never move don't trigger alerts. About as accurate as YOLO26x, using the Apache-2.0 [D-FINE](https://github.com/Peterande/D-FINE) detector, entirely on your server.
- **Biome log** — about once a minute (only when the scene changes) and whenever something small moves, each camera's view is checked against **4,086 species** (1,021 insects, 2,101 plants, 964 birds). Each find gets a folder `data/biome/<Group>/<Order>/<Family>/<Species (Common name)>/` with `info.md` (what it is, classification, where/when seen) and `photos/`. The same folders are browsable in the app, where you confirm or reject each ID. You can also identify any photo you take.
- **Fully offline identification** — the models run on your server with a built-in engine; photos never leave home. Plain-language explanations are an **optional** one-time download (`npm run species-db`) of Wikipedia summaries + GBIF taxonomy (+ optional reference photos), stored in `data/species-db/`.

## Install

```bash
git clone https://github.com/superclearice97-droid/spectacle.git
cd spectacle
./install.sh
```

This installs Node 22 + ffmpeg if needed, makes an HTTPS certificate, asks whether you want the optional species explanations, and installs a `spectacle` systemd service so it runs 24/7 and starts on boot. No `npm install` is needed — there are no dependencies.

Then open `https://<server-ip>:8443` on your phone, accept the certificate warning, and create the admin account using the **setup code** the installer printed (also in `data/SETUP-CODE.txt` until it's used).

Everything Spectacle stores is encrypted on the server; see [SECURITY.md](SECURITY.md). To export a recording or photo outside the app, run `npm run decrypt -- <encrypted file> <output file>` on the server.

Manual run: `npm start` · Tests: `npm test` · Logs: `journalctl -u spectacle -f`

## The Android app (for family & friends)

Family members just follow the invite message you send them. It walks them through installing **Tailscale**
(the private connection home) and **Spectacle.apk**, then pasting the invite.

1. In Tailscale's admin page, open **Machines**, tap ⋯ next to the Spectacle server, choose **Share…** and copy
   an invite link. Share links are single-use, so make one per person. They only get access to this one server.
2. In Spectacle, open **Family**, paste that link, tap **Create invite link**, then **Send by text or email**.
3. They follow the message: install Tailscale and sign in, accept the share, install Spectacle, tap **Paste my invite**.

If Tailscale is switched off on their phone, Spectacle shows "Can't reach home" with a button that opens Tailscale,
and the "Watching for alerts" notification changes to tell them alerts aren't arriving.

Download link (always the latest version):
**https://github.com/superclearice97-droid/spectacle/releases/latest/download/Spectacle.apk**

A plain-language guide you can send them: [docs/family-guide.md](docs/family-guide.md).

What the app adds over the browser:
- One-tap setup from the invite message, with no addresses, certificates or settings to understand.
- Alerts arrive while the app is closed and come straight from your server (no Google push service).
  Alerts restart by themselves after the phone reboots.
- Turn an old phone into a camera from a "camera setup" message. "Dim screen" turns the backlight down while it keeps recording.
- Follows the phone's text size, works with TalkBack, high-contrast colours, large touch targets.

On your home Wi-Fi the app trusts your server's self-signed certificate **only** because the invite contains its
fingerprint. Away from home, use Tailscale. Building and signing releases: [docs/android-signing.md](docs/android-signing.md).

## Adding cameras (Settings → Cameras, admin only)

- **IP camera:** enter its RTSP address, e.g. `rtsp://user:pass@192.168.1.20:554/h264Preview_01_main`. H.264 cameras play everywhere; H.265 recordings may not play in every browser (choose H.264 in the camera's settings if you can).
- **Old phone / webcam:** add it, tap **Get pairing link** and send the message to the camera phone. On it, install the app, tap **Paste my invite**, tick the notice and press Start (or open the link in Chrome). Keep the page open, screen on and charger plugged in (browsers stop the camera in the background). "Dim screen" blacks out the display. The microphone is never used for recording; with two-way talk on, it's used only during announced calls.

## Remote access (Tailscale)

`./install.sh` offers to do this for you. It installs Tailscale, publishes Spectacle privately on your tailnet, and
fills in `publicUrl`. To do it by hand:

1. Install [Tailscale](https://tailscale.com) on the server and on each family phone (free for personal use).
2. On the server: `sudo tailscale serve --bg 8080`
3. Put the `https://<server>.<tailnet>.ts.net` address it prints in `config.json` → `publicUrl`, then
   `sudo systemctl restart spectacle`. Invites now use this address, so they work at home and away.

Don't expose Spectacle to the internet with router port forwarding.

## Configuration (`config.json`)

| Setting | Default | What it does |
|---|---|---|
| `recording.retentionDays` | 14 | Days of footage kept |
| `recording.minFreeGB` | 5 | Oldest footage is deleted first to keep this free |
| `biome.intervalSec` | 60 | How often each camera's view is checked |
| `biome.minConfidence` | 0.6 | Minimum certainty to log a species |
| `biome.groups` | insect, plant, bird | Which kinds to look for |
| `motion.cooldownSec` | 60 | Minimum gap between alerts per camera |
| `ntfy.url` | — | e.g. `https://ntfy.sh/a-long-secret-topic` |
| `contactEmail` | — | Sent with push requests and species downloads (optional) |

Restart after editing: `sudo systemctl restart spectacle`.

## Two-way talk and the doorbell

Turn it on per camera in **Settings → Cameras → Two-way talk** (you'll confirm a short notice), plus **Doorbell button** if the
camera is at a door. It works with phone and webcam cameras (the browser camera page, the Android app's camera mode and
the desktop app's webcam). IP cameras can't be talked through yet, because each brand uses its own audio protocol.

- **Answering:** tap the doorbell alert, then **Answer**. You hear them straight away. Tap **Start talking** when you want them to hear you,
  and **Hang up** when done. Anyone else in the family can **Join the call** to listen.
- **On the camera:** a chime plays and a banner says "Jordan is talking to you" for the whole call, so nobody is listened to without knowing.
  Echo cancellation lets a phone on loudspeaker work as a door intercom.
- **Privacy:** audio goes phone → your Spectacle server → camera over the same encrypted connection as video. Nothing is recorded; only
  "who called, when, how long" is kept in the alert log. Calls end automatically after 15 minutes.

## Smart detection: people, vehicles, animals and zones

On the **desktop app**, open Settings and tap **Turn on smart detection** (it's built in, so the model just downloads once).
On a **Linux server install**, `./install.sh` offers it, or run `npm run smart-detection` any time (then `sudo systemctl restart spectacle`).
It installs [ONNX Runtime](https://onnxruntime.ai) (MIT) and one D-FINE model into `addons/`, and checks the download
against a pinned SHA-256. Spectacle itself stays MIT-licensed with no dependencies, and no camera frames ever leave the machine.

| Size | Accuracy (COCO AP) | Comparable to | Time per check* | Pick it for |
|---|---|---|---|---|
| `--size s` | 50.7 | YOLO26s (48.6) | ~0.2 s | Raspberry Pi, old laptops |
| `--size l` (default) | 57.3 | YOLO26x (57.5) | ~0.6 s | Most home servers |
| `--size x` | 59.3 | better than YOLO26x | ~1 s | Strong desktop CPUs |

\*Measured on GitHub's 4-core CPU. The installer picks `s` or `l` for your hardware automatically.

How it works: ordinary motion detection wakes it up, then it checks about twice a second until things leave. It also
runs while someone has a camera open, to draw live labels. Each object is followed between checks, so a person who
walks up the drive and stops raises **one** alert, and things that never move (a parked car, a garden statue) are learned and ignored.
Zones count an object as "in" when its feet or wheels are inside. Settings live per camera under **Settings → Cameras**; zones under **Zones**.

It only notices *that* a person is there, never *who*: no face recognition, nothing biometric (see `LEGAL-REVIEW.md`).

## How well does identification work?

It works best when the subject fills a good part of the frame: a camera near a flowerbed, feeder or garden. A wide driveway camera will mostly see nothing small enough to identify. The models are trained on iNaturalist photos (strongest for North America) and know a fixed list of species; anything else gets matched to its closest look-alike, which is why every automatic find starts as **review**. Night-vision (black-and-white) frames are skipped. Each check takes roughly 0.3–1 s per model on a modern CPU, a few seconds on a Raspberry Pi.

## Hardware guide

- 1–3 cameras: Raspberry Pi 4/5 (4 GB) or any old laptop. IP cameras cost almost no CPU (recorded as-is); each phone camera needs re-encoding (~½ a core).
- Storage: roughly 10–20 GB per camera per day at 1080p. Use an external SSD/HDD; point `dataDir` at it.

## Privacy by design

Nothing leaves your home unless you switch it on:

| Connection | Default | What's sent |
|---|---|---|
| Identification (bugs, flowers, birds) | Always local | Nothing — models run on your server |
| Smart detection (people/vehicles/animals) | Offered at install; runs locally | Nothing. One-time model download from GitHub |
| Species explanations download | **Off** (asked at install) | Species names only, once, to Wikipedia / Wikimedia Commons / GBIF |
| Phone notifications (Web Push) | **Off** (each person opts in) | End-to-end encrypted alert text via the browser's push service |
| ntfy alerts | **Off** | Camera name + time, to the ntfy server you choose |
| Remote access (Tailscale) | Offered at install; needed for use away from home | End-to-end encrypted traffic; Tailscale sees account and device info, not video |

No analytics, ads, telemetry or accounts with anyone but your own server. Phone cameras never use the microphone; IP-camera audio is off by default.

## Privacy, legal & licences

Read and adjust before sharing with family:
- `public/legal/privacy.html` — what's collected, who sees it, what leaves the home
- `public/legal/terms.html` — terms and disclaimer (not a professional alarm; IDs can be wrong)
- `public/legal/recording-laws.html` — where you can record, audio consent, GDPR notes
- `docs/camera-notice-template.md` — signs and messages for visitors, carers and rentals
- `LEGAL-REVIEW.md` — what's covered and what to check before sharing outside your family
- `THIRD_PARTY_NOTICES.txt` — model (Apache-2.0), Wikipedia (CC BY-SA 4.0), GBIF (CC BY 4.0) and Commons attributions

Built-in safeguards: every member accepts the terms and the presence notice at sign-up (and again if terms change); adding a camera requires a placement acknowledgement; audio is off and needs a separate confirmation; phone cameras never use the mic; recordings auto-expire; members can export or delete their account.

## Layout

```
server/index.js          HTTP + WebSocket server, routes, presence hub
server/lib/cameras.js    ffmpeg pipeline per camera: live MJPEG, motion frames, recording
server/lib/motion.js     motion detector
server/lib/tflite.js     dependency-free TensorFlow Lite interpreter
server/lib/biome.js      species log + folders
server/lib/webpush.js    Web Push (VAPID + aes128gcm)
server/scripts/build-species-db.js   offline encyclopedia downloader
public/                  the web app (no build step) + camera.html for phone cameras
models/                  insect / plant / bird models and labels
data/                    created at run time: accounts, recordings, events, biome, species-db
```
