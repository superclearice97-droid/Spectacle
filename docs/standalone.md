# Independent Linux and Android apps

Each device can run Spectacle by itself. Neither app requires the other, a subscription, Tailscale, a cloud account or internet access for local capture and identification. Their accounts/archives are independent; there is no automatic syncing or cross-device viewing in independent mode.

## Linux desktop (including CachyOS)

Download the **Spectacle-linux** artifact from a successful **Linux desktop** GitHub Actions run. Unzip it to get an AppImage, Debian package and Linux tarball. The Electron app bundles its Node runtime, web interface and offline species models; FFmpeg is a system dependency.

On CachyOS/Arch, install FFmpeg once:

```bash
sudo pacman -S --needed ffmpeg
```

Make the downloaded AppImage executable in your file manager (Properties → Permissions), then double-click it. From a terminal, for an x86_64 build:

```bash
chmod +x Spectacle-1.1.0-x86_64.AppImage
./Spectacle-1.1.0-x86_64.AppImage
```

If your distribution cannot mount AppImages, use the tarball or run the AppImage with `--appimage-extract-and-run`. On Debian/Ubuntu, install the `.deb` through your package manager so FFmpeg and desktop libraries are installed automatically.

1. Open Spectacle. The setup dialog shows a setup code; it is also under **Spectacle → Show setup code**.
2. Create your local admin account in the app.
3. Add cameras. The best choice for 24/7 is **Spectacle → Add a USB camera, capture card or phone…** (see [Cameras on USB](#cameras-on-usb-webcams-capture-cards-and-phones)): it records with no window open. **Spectacle → Use this computer’s camera** also works; pick which camera in its window and keep that window open to continue capturing.
4. The main window shows live video, events, recordings and the biome log. You may also add standalone RTSP IP cameras in Settings without a phone.

The local runtime listens only on `127.0.0.1` on an automatically selected port. It stops when the app exits. Data lives in Electron's per-user Spectacle data directory, normally `~/.config/Spectacle/data`. Use **Open local data folder** to locate it. Back up this directory, including its vault key, if you need to migrate it. Completed recordings and photos use the existing server's encryption; in-progress segments can temporarily be plaintext in RAM or private staging storage.

### Running 24/7

- **Closing the window doesn't stop recording.** Spectacle keeps running with a tray icon; click it (or open Spectacle from your app menu again) to bring the window back. To stop recording, choose **Quit Spectacle** from the tray icon or the Spectacle menu. On GNOME, the tray icon needs the "AppIndicator and KStatusNotifierItem Support" extension; KDE Plasma (the CachyOS default) shows it out of the box.
- **Start when I log in** (tray icon or Spectacle menu) adds Spectacle to your desktop's startup apps, so it starts hidden and recording after a restart. It needs someone to log in. For a computer that should recover from a power cut on its own, turn on automatic login in your desktop's settings, or use the `install.sh` server instead, which runs as a system service before anyone logs in.
- **Keep computer awake** is on by default: Spectacle stops the computer going to sleep while it runs. The screen can still turn off. Turn it off from the same menus if you'd rather the computer sleeps.

### Cameras on USB: webcams, capture cards and phones

Open **Settings → Cameras → Add a camera**, choose **USB camera, capture card or phone on USB**, and pick it from the list (tap **Look again** after plugging something in). Spectacle reads the camera directly, so it records 24/7 with no window open, uses the best picture the camera offers (up to 1080p), and reconnects by itself after it's unplugged and plugged back in. It works the same on the `install.sh` server. Anything Linux sees as a camera appears in the list: USB webcams, HDMI capture cards, and phones in webcam mode. Each computer camera can be added once.

**Android 14 or newer (no extra software):** plug the phone in with a USB cable, pull down the phone's notifications, tap the USB notification ("Charging this device via USB"), and choose **Webcam**. The phone appears in the list. Not every phone maker includes this mode; if yours doesn't offer **Webcam**, use the next method.

**Other Android phones (Android 12 or newer):** [scrcpy](https://github.com/Genymobile/scrcpy) (free, open source, version 2.1 or newer) can pass the phone's camera to Linux as a webcam. Turn on USB debugging on the phone, then on the computer:

```bash
sudo pacman -S --needed scrcpy v4l2loopback-dkms      # CachyOS/Arch; Debian/Ubuntu: sudo apt install scrcpy v4l2loopback-dkms
sudo modprobe v4l2loopback card_label="Phone camera" exclusive_caps=1
scrcpy --video-source=camera --camera-facing=back --camera-size=1920x1080 --no-audio --v4l2-sink=/dev/video10 --no-playback   # use the device number modprobe created (ls /dev/video*)
```

Keep scrcpy running while the phone is the camera. The phone's screen can be off.

**iPhone:** iOS can't act as a USB webcam on Linux without third-party apps. Use it as a browser camera on Wi-Fi instead (**Old phone or webcam** in Settings).

Keep phones plugged in to a charger (the USB cable does this), and remove any case if the phone gets hot from running all day.

If a camera shows "No permission", the account running Spectacle needs to be in the `video` group (`sudo usermod -aG video $USER`, then log out and in). The `install.sh` service already includes it.

### Smart detection and two-way talk on the desktop

Open **Settings** and tap **Turn on smart detection**. The detector engine is already inside the app, so this downloads the
model once (about 124 MB; there's a smaller 41 MB version for older computers), checks it, and switches it on. Nothing is sent
anywhere while it runs. Two-way talk works with **Use this computer's camera**: turn it on for that camera in Settings, and
family can talk through the computer's speakers and microphone.

### Develop/build Linux

Node 24 and FFmpeg are needed for development only:

```bash
npm ci --prefix desktop
npm start --prefix desktop
npm run dist --prefix desktop
```

Installers appear in `desktop/dist/`. The build currently targets x86_64 Linux. A display server and standard Electron desktop libraries are required. The CI test uses a simulated local webcam in Chromium, not an Android client.

## Android independent mode

Install the updated APK from a successful **Android app** build artifact. On the welcome screen, tap **Use this phone independently**. Existing shared-server users can switch from Settings → **Use this phone independently**.

- **Camera:** start the camera, accept the placement notice, allow camera permission, then watch the live preview. Choose silent video recording, save a photo, or switch between front/rear cameras.
- **Archive:** view recordings and motion snapshots, export an item to an Android document destination, or delete it.
- **Biome:** view model candidates stored with photos or identify an imported image using bundled models.
- **Settings:** control automatic snapshots/scans, adjust motion sensitivity, enable notifications, or connect to an optional shared server.

Recording uses one-minute MP4 segments, with a 40 MB segment size limit. Completed clips, photos and archive metadata are encrypted with AES-GCM and an Android Keystore key. The active segment is temporarily plaintext in private app storage. Playback temporarily decrypts a clip into private cache and removes it when playback stops. Exported files are plaintext at the destination you choose. Uninstalling deletes both archive and key; export wanted items beforehand.

The local archive retains at most **7 days / 500 MB**, deleting oldest items automatically. Motion snapshots have a 15-second cooldown; automatic classification runs at most once per minute. The bundled iNaturalist models cover limited species and can be wrong; automatic sightings need at least 60% model confidence. Internet is not used for capture or classification. No taxonomy/explanation download is required.

**Current limits:** Android independent mode uses the phone's built-in cameras and monitors only while the Camera screen is open. Leaving it, locking/backgrounding the app, or switching mode stops capture and finalizes the current recording. It does not provide an always-on background camera service, RTSP ingestion, family accounts, or archive sync. Cameras that cannot support three simultaneous streams use a compatibility mode with video recording and motion analysis sampled from the preview. Cameras without compatible video support fall back to preview/photos with an explicit message. Linux retains the full existing multi-camera server features, including USB cameras and phones connected by USB.

## Optional shared server

The original self-hosted `install.sh` deployment and Android invite/camera pairing still work. From independent Android mode, open Settings → **Connect to a shared server (optional)** and paste an HTTPS invite. The phone's local archive stays separate and can be reopened through the independent-mode button. A shared-server camera still depends on that server by design; choosing independent mode removes that dependency for local operation.

## Verification

- Existing `npm test`: live ingestion, motion alerts, classification, recording/playback, encryption, authentication and hardening.
- `test/devices-unit.js`: finding USB cameras (stable paths, skipping metadata nodes, permission problems), choosing their format, and refusing anything that isn't a camera device. `npm test` also adds and removes a USB camera through the API.
- `desktop/test-main.cjs`: also checks that closing the main window keeps the camera recording.
- `desktop/test.cjs`: launches the actual local runtime through Electron, creates a local account, opens sandboxed Chromium, ingests a local simulated webcam and checks its snapshot, then requests orderly shutdown.
- Android instrumentation: archive round-trip after reopening, encrypted metadata/payload, authenticated-encryption tamper rejection, deletion and real bundled-model classification.
- Android emulator UI: disables Wi-Fi/mobile data, enters independent mode without an invite, captures/classifies a photo, views its archive, restarts the app and deletes the persisted photo. The original remote-client smoke test then runs separately.
