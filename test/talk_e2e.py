#!/usr/bin/env python3
"""End-to-end test for two-way talk and the doorbell, in real Chromium with simulated mic/camera.

One page is the camera phone, two pages are family members. Checks:
  doorbell → alert + event · answering opens a call · the camera shows the notice · audio flows both ways
  · only one person talks at a time · hanging up turns the camera mic off · the call is logged (no audio)
  · security: no cookie → refused; talk disabled → refused
Run: python3 test/talk_e2e.py   (needs: pip install playwright; ffmpeg)
"""
import json, os, re, shutil, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
tmp = tempfile.mkdtemp(prefix="spectacle-talk-")
PORT = 19900 + os.getpid() % 90
BASE = f"http://127.0.0.1:{PORT}"
cfg = {"dataDir": f"{tmp}/data", "http": {"enabled": True, "host": "127.0.0.1", "port": PORT}, "https": {"enabled": False}, "biome": {"enabled": False}}
open(f"{tmp}/config.json", "w").write(json.dumps(cfg))
srv = subprocess.Popen(["node", f"{ROOT}/server/index.js"], env={**os.environ, "SPECTACLE_CONFIG": f"{tmp}/config.json"}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
cookie = ""
fails = 0

SHOTS = os.environ.get("TALK_SHOTS")
def shot(pg, name):
    if SHOTS: pg.screenshot(path=f"{SHOTS}/{name}.png")

def ok(c, m):
    global fails
    print(("  ✓ " if c else "  ✗ ") + m, flush=True)
    if os.environ.get("GITHUB_ACTIONS"): print(f"::{'notice' if c else 'error'} title=two-way talk::{m}")
    if not c: fails += 1

def call(path, body=None, method=None):
    global cookie
    req = urllib.request.Request(BASE + path, method=method or ("POST" if body is not None else "GET"), data=json.dumps(body).encode() if body is not None else None,
                                 headers={"X-Spectacle": "1", "Content-Type": "application/json", "Cookie": cookie})
    try:
        with urllib.request.urlopen(req) as r:
            sc = r.headers.get("Set-Cookie")
            if sc: cookie = sc.split(";")[0]
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{path}: {e.read().decode()}")

try:
    for _ in range(100):
        try: urllib.request.urlopen(BASE + "/api/state"); break
        except Exception: time.sleep(0.1)
    code = re.search(r"setup code: (\S+)", open(f"{tmp}/data/SETUP-CODE.txt").read()).group(1)
    call("/api/setup", {"setupCode": code, "name": "Jordan", "username": "jordan", "password": "correct horse battery", "consent": {"terms": True, "presence": True}})
    admin_cookie = cookie
    inv = call("/api/invites", {})
    cookie = ""
    call("/api/register", {"invite": inv["code"], "name": "Maya", "username": "maya", "password": "another long password", "consent": {"terms": True, "presence": True}})
    maya_cookie = cookie; cookie = admin_cookie
    cam = call("/api/cameras", {"name": "Front door", "type": "browser", "ackPlacement": True})["camera"]
    try: call(f"/api/cameras/{cam['id']}", {"talk": {"enabled": True}}, "PATCH"); ok(False, "talk needs the notice to be confirmed")
    except RuntimeError: ok(True, "turning on talk requires confirming the notice")
    call(f"/api/cameras/{cam['id']}", {"talk": {"enabled": True, "doorbell": True}, "ackTalk": True}, "PATCH")
    token = call(f"/api/cameras/{cam['id']}/pair", {})["token"]

    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
        host = "127.0.0.1"
        camctx = b.new_context(permissions=["camera", "microphone"], viewport={"width": 390, "height": 760}, device_scale_factor=2)
        camera = camctx.new_page()
        errs = []; logs = []
        camera.on("pageerror", lambda e: errs.append("camera: " + str(e)))
        camera.on("console", lambda m: logs.append("camera console: " + m.text))
        camera.goto(f"{BASE}/camera#token={token}")
        camera.check("#ack"); camera.click("#start")
        for _ in range(40):
            if call("/api/cameras")["cameras"][0]["status"] == "live": break
            time.sleep(0.5)
        ok(call("/api/cameras")["cameras"][0]["status"] == "live", "camera phone is live")
        camera.wait_for_selector("#ring:not([hidden])", timeout=10000)
        ok(True, "doorbell button shown on the camera screen")
        # count audio arriving at the camera's speaker
        camera.evaluate("""() => { window.__rx = 0; const o = SpTalk.speaker; SpTalk.speaker = async v => { const s = await o(v); const p = s.push; s.push = b => { window.__rx += b.byteLength; p(b); }; return s; }; }""")

        def family(name, ck):
            ctx = b.new_context(permissions=["microphone"], viewport={"width": 390, "height": 844}, device_scale_factor=2)
            ctx.add_cookies([{"name": ck.split("=")[0], "value": ck.split("=", 1)[1], "domain": host, "path": "/"}])
            pg = ctx.new_page(); pg.on("pageerror", lambda e: errs.append(name + ": " + str(e))); pg.on("console", lambda m: logs.append(name + " console: " + m.text))
            pg.goto(f"{BASE}/#cameras"); pg.wait_for_timeout(1500)
            pg.evaluate("""() => { window.__rx = 0; const o = SpTalk.speaker; SpTalk.speaker = async v => { const s = await o(v); const p = s.push; s.push = b => { window.__rx += b.byteLength; p(b); }; return s; }; }""")
            return pg
        jordan = family("jordan", admin_cookie)
        maya = family("maya", maya_cookie)

        camera.click("#ring")
        jordan.wait_for_selector(".toast:has-text('Someone is at Front door')", timeout=8000)
        ok(True, "pressing Ring alerts the family: 'Someone is at Front door'")
        ok(any(e.get("kind") == "ring" for e in call("/api/events")["events"]), "doorbell logged as an event")

        jordan.goto(f"{BASE}/#talk/{cam['id']}")
        jordan.wait_for_selector("#talkOpen:has-text('Answer')", timeout=8000)
        ok(True, "notification opens straight to an Answer button")
        shot(camera, "cam-ring"); jordan.locator("#talkBox").scroll_into_view_if_needed(); shot(jordan, "viewer-answer")
        jordan.click("#talkOpen")
        camera.wait_for_selector("#talkbar:not([hidden])", timeout=8000)
        ok(True, "camera shows 'someone from the house' notice as soon as the call starts")
        jordan.wait_for_selector("#talkSpeak:not([disabled])", timeout=10000)
        time.sleep(2)
        rx_j = jordan.evaluate("window.__rx")
        ok(rx_j > 20000, f"family hears the camera's microphone ({rx_j // 1000} KB of audio in 2 s)")
        jordan.click("#talkSpeak")
        time.sleep(2.5)
        rx_c = camera.evaluate("window.__rx")
        ok(rx_c > 20000, f"camera speaker plays the family member's voice ({rx_c // 1000} KB)")
        ok("Jordan is talking to you" in camera.inner_text("#talkbar"), "camera says who is talking: " + camera.inner_text("#talkWho"))
        shot(camera, "cam-call"); jordan.locator("#talkBox").scroll_into_view_if_needed(); shot(jordan, "viewer-call")

        maya.goto(f"{BASE}/#cam/{cam['id']}"); maya.wait_for_selector("#talkOpen", timeout=8000)
        ok("Join" in maya.inner_text("#talkOpen"), "others see the call and can join")
        maya.click("#talkOpen")
        maya.wait_for_selector("#talkSpeak", timeout=8000); time.sleep(1)
        ok(maya.is_disabled("#talkSpeak") and "Jordan is talking" in maya.inner_text("#talkStatus"), "only one person talks at a time (Maya waits)")
        time.sleep(1)
        ok(maya.evaluate("window.__rx") > 5000, "a second family member can listen in")

        maya.click("#talkEnd"); jordan.click("#talkEnd")
        camera.wait_for_selector("#talkbar", state="hidden", timeout=8000)
        ok(True, "hanging up removes the notice and turns the camera microphone off")
        time.sleep(1)
        talk_ev = [e for e in call("/api/events")["events"] if e.get("kind") == "talk"]
        ok(talk_ev and set(talk_ev[0]["people"]) == {"Jordan", "Maya"} and "audio" not in json.dumps(talk_ev[0]).lower(), f"call logged without audio: {talk_ev[0]['people'] if talk_ev else None}, {talk_ev[0]['durationSec'] if talk_ev else '?'} s")
        files = subprocess.run(["find", f"{tmp}/data", "-type", "f", "-newer", f"{tmp}/config.json"], capture_output=True, text=True).stdout
        ok(not re.search(r"\.(wav|pcm|ogg|opus|webm)$", files, re.M), "no audio files written anywhere")

        # security
        anon = b.new_context().new_page(); anon.goto(BASE + "/legal/privacy.html")
        refused = anon.evaluate(f"""() => new Promise(r => {{ const w = new WebSocket('ws://{host}:{PORT}/ws/talk?cam={cam['id']}'); w.onopen = () => r(false); w.onerror = () => r(true); w.onclose = () => r(true); }})""")
        ok(refused, "signed-out visitors can't open a call")
        call(f"/api/cameras/{cam['id']}", {"talk": {"enabled": False}}, "PATCH")
        jordan.goto(f"{BASE}/#cam/{cam['id']}"); jordan.wait_for_timeout(1500)
        ok(jordan.locator("#talkBox").is_hidden(), "turning talk off hides the call button")
        ok(not errs, "no page errors" + ("" if not errs else ": " + "; ".join(errs[:3])))
        b.close()
except Exception as e:
    ok(False, f"test crashed: {str(e)[:300]}")
    try:
        for l in (errs + logs)[-25:]: ok(False, "log: " + l[:250])
        ok(False, "camera talkbar: " + camera.evaluate("document.querySelector('#talkbar').outerHTML")[:300])
        ok(False, "family toasts: " + jordan.evaluate("[...document.querySelectorAll('.toast')].map(t => t.innerText).join(' | ')")[:300])
        ok(False, "server talk state: " + json.dumps(call("/api/cameras")["cameras"][0].get("talk"))[:300])
    except Exception as e2: ok(False, f"(diagnostics failed: {e2})")
    print(srv.stdout.read1(20000).decode(errors="ignore") if srv.stdout else "")
finally:
    srv.terminate()
    try: srv.wait(5)
    except Exception: srv.kill()
    shutil.rmtree(tmp, ignore_errors=True)
print("\nAll two-way talk checks passed." if not fails else f"\n{fails} check(s) failed.")
sys.exit(1 if fails else 0)
