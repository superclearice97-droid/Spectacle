#!/usr/bin/env bash
# CI only: install the APK on the emulator, open an invite via the deep link, and check the
# app connects to the server (pinned self-signed cert) and shows the sign-up page without crashing.
set -uo pipefail
ENC=$(cat "$RUNNER_TEMP/invite-encoded.txt")
adb install -r Spectacle.apk
adb logcat -c
adb shell am start -a android.intent.action.VIEW -d "'spectacle://join?link=$ENC'"
ok=0
for i in $(seq 1 30); do
  sleep 3
  adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 && adb pull /sdcard/ui.xml ui.xml >/dev/null 2>&1
  if grep -q "Join your family" ui.xml 2>/dev/null && grep -q "Create account" ui.xml; then ok=1; break; fi
done
adb shell screencap -p /sdcard/shot.png && adb pull /sdcard/shot.png emulator-join.png >/dev/null 2>&1
adb logcat -d > logcat.txt
if grep -q "FATAL EXCEPTION" logcat.txt; then echo "::error::App crashed"; grep -A30 "FATAL EXCEPTION" logcat.txt | head -60; exit 1; fi
if [ "$ok" != 1 ]; then echo "::error::Sign-up page never appeared"; grep -E "spectacle|chromium" -i logcat.txt | tail -60; cat ui.xml | head -c 3000; exit 1; fi
echo "Invite opened in the app and the sign-up page loaded over the pinned certificate."
adb shell dumpsys activity services app.spectacle.family | grep -q AlertService && echo "Background alert service is running." || { echo "::error::AlertService not running"; exit 1; }
