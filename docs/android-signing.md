# Android app signing (owner only)

Every Spectacle APK must be signed with the **same key**, or phones refuse to install updates
("App not installed"). The key lives in two GitHub secrets, so GitHub can build signed releases.

## One-time setup

1. Open **Settings → Secrets and variables → Actions** on the GitHub repo
   (`https://github.com/superclearice97-droid/spectacle/settings/secrets/actions`).
2. Tap **New repository secret** and add:
   - Name `SPECTACLE_KEYSTORE_B64`: paste the whole contents of `keystore-b64.txt`
   - Name `SPECTACLE_KEYSTORE_PASSWORD`: paste the contents of `password.txt`
3. Keep `spectacle-release.jks` and its password somewhere safe and private (password manager, USB stick).
   **If you lose them, nobody can update the app;** everyone would have to uninstall and reinstall.
   Never commit them to the repository.

## Making a release

Push a version tag, e.g. from the repo folder:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

GitHub builds the APK and publishes it as `Spectacle.apk` on the Releases page. This link always points to
the newest version, and is what invites send to family:

`https://github.com/superclearice97-droid/spectacle/releases/latest/download/Spectacle.apk`

Each release also has `Spectacle.apk.sha256` so you can check a download wasn't altered.

## Using your own key or fork

Generate a key with
`keytool -genkeypair -alias spectacle -keyalg RSA -keysize 4096 -validity 10000 -keystore spectacle-release.jks -storetype PKCS12`,
base64 it (`base64 -w0 spectacle-release.jks`), add the two secrets, and set `appDownloadUrl` in `config.json`
to your own release link.
