#!/usr/bin/env python3
"""CI only. Acts like a family member on an Android emulator:
open invite link -> sign up in the app -> close the app -> server sends an alert -> notification appears.
Failures are printed as GitHub annotations so they're readable from the run summary."""
import os, re, subprocess, sys, time, urllib.parse

TMP = os.environ["RUNNER_TEMP"]
ENC = open(f"{TMP}/invite-encoded.txt").read().strip()
JAR = f"{TMP}/spectacle-ci/jar"

def sh(cmd, check=False):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if check and r.returncode: fail(f"Command failed: {cmd}", r.stdout + r.stderr)
    return r.stdout

def fail(title, detail=""):
    detail = "\n".join(l[:200] for l in detail.strip().splitlines()[-40:])
    enc = lambda s: s.replace("%", "%25").replace("\r", "").replace("\n", "%0A")
    print(f"::error::{enc(title)}%0A{enc(detail)}")
    log = sh("adb logcat -d")
    crash = re.search(r"FATAL EXCEPTION[\s\S]{0,3000}", log)
    if crash: print(f"::error::Crash%0A{enc(crash.group(0)[:2500])}")
    sys.exit(1)

def nodes():
    sh("adb shell uiautomator dump /sdcard/ui.xml"); sh("adb pull /sdcard/ui.xml ui.xml")
    try: xml = open("ui.xml", encoding="utf-8").read()
    except FileNotFoundError: return []
    out = []
    for m in re.finditer(r"<node [^>]*>", xml):
        a = dict(re.findall(r'([\w-]+)="([^"]*)"', m.group(0)))
        b = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", a.get("bounds", ""))
        if b: a["c"] = ((int(b[1]) + int(b[3])) // 2, (int(b[2]) + int(b[4])) // 2); a["h"] = int(b[4]) - int(b[2])
        out.append(a)
    return out

def screen_text(ns): return " | ".join(t for n in ns for t in (n.get("text"), n.get("content-desc")) if t)

def wait_for(texts, secs=60):
    end = time.time() + secs
    while time.time() < end:
        ns = nodes(); st = screen_text(ns)
        for t in texts:
            if t.lower() in st.lower(): return t, ns
        time.sleep(2)
    fail(f"Timed out waiting for {texts}", screen_text(nodes()))

def tap(n): sh(f"adb shell input tap {n['c'][0]} {n['c'][1]}"); time.sleep(0.8)

def tap_text(t):
    for n in nodes():
        if t.lower() in (n.get("text", "") + n.get("content-desc", "")).lower() and n.get("c") and n.get("h", 0) > 0:
            tap(n); return
    fail(f"Couldn't find '{t}' to tap", screen_text(nodes()))

def type_into(index, value):
    fields = [n for n in nodes() if n.get("class") == "android.widget.EditText" and n.get("c")]
    if len(fields) <= index: fail("Sign-up field missing", screen_text(nodes()))
    tap(fields[index]); sh(f"adb shell input text {value}"); time.sleep(0.5)

# 1. Install and open the invite like a family member tapping "Open in the app"
sh("adb install -r Spectacle.apk", check=True)
sh("adb logcat -c")
sh(f"adb shell am start -a android.intent.action.VIEW -d \"'spectacle://join?link={ENC}'\"")
wait_for(["Join your family"], 90)
print("✓ Invite opened in the app over the pinned home certificate")

# 2. Sign up
type_into(0, "CI%sFamily"); type_into(1, "cifamily"); type_into(2, "family-pass-123")
sh("adb shell input keyevent 111")  # hide keyboard (Escape)
time.sleep(1)
boxes = [n for n in nodes() if n.get("class") == "android.widget.CheckBox" and n.get("c")]
if len(boxes) < 2:
    sh("adb shell input swipe 500 1500 500 600"); time.sleep(1)
    boxes = [n for n in nodes() if n.get("class") == "android.widget.CheckBox" and n.get("c")]
for b in boxes[:2]: tap(b)
tap_text("Create account")
seen, _ = wait_for(["Get alerts right away", "No cameras yet", "Cameras"], 60)
print("✓ Signed up inside the app")
if seen == "Get alerts right away":
    print("✓ Background-alerts prompt shown after sign-in")
    tap_text("Not now")

# 3. Leave the app, then have the server send an alert to everyone
sh("adb shell input keyevent 3"); time.sleep(6)
out = sh(f"curl -sk -b {JAR} -H 'X-Spectacle: 1' -X POST https://127.0.0.1:8443/api/push/test")
end = time.time() + 45
while time.time() < end:
    if "Spectacle test" in sh("adb shell dumpsys notification --noredact"):
        print("✓ Alert arrived as a phone notification with the app closed (no Google push)")
        break
    time.sleep(3)
    sh(f"curl -sk -b {JAR} -H 'X-Spectacle: 1' -X POST https://127.0.0.1:8443/api/push/test")
else:
    fail("Alert notification never appeared", sh("adb shell dumpsys activity services app.spectacle.family") + "\n" + sh("adb logcat -d | grep -i -E 'spectacle|okhttp' | tail -30"))

if "FATAL EXCEPTION" in sh("adb logcat -d"): fail("App crashed during the test")
print("All Android checks passed.")
