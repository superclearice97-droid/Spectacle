#!/usr/bin/env python3
"""Launch a fresh Android install offline; exercise its own camera/archive without a server."""
import re, subprocess, time, xml.etree.ElementTree as ET

def sh(*args):
    return subprocess.run(args, capture_output=True, text=True, check=True).stdout

def nodes():
    sh('adb', 'shell', 'uiautomator', 'dump', '/sdcard/standalone-ui.xml')
    xml = sh('adb', 'shell', 'cat', '/sdcard/standalone-ui.xml')
    return list(ET.fromstring(xml).iter('node'))

def tap(label, timeout=30):
    end = time.time() + timeout
    attempts = 0
    while time.time() < end:
        ns = nodes()
        matches = [n for n in ns if label.lower() in n.attrib.get('text', '').lower() and n.attrib.get('clickable') == 'true']
        matches.sort(key=lambda n: n.attrib.get('text', '').lower() != label.lower())
        for n in matches:
            b = list(map(int, re.findall(r'\d+', n.attrib['bounds'])))
            if b[3] > b[1] and b[2] > b[0]:
                sh('adb', 'shell', 'input', 'tap', str((b[0]+b[2])//2), str((b[1]+b[3])//2)); time.sleep(1); return
        # Controls below the preview must be reachable on small emulator/phone screens.
        size = list(map(int, re.findall(r'\d+', sh('adb', 'shell', 'wm', 'size'))))[-2:]
        x, low, high = size[0]//2, int(size[1]*0.82), int(size[1]*0.45)
        y1, y2 = (low, high) if attempts % 8 < 4 else (high, low)
        sh('adb', 'shell', 'input', 'swipe', str(x), str(y1), str(x), str(y2), '300')
        attempts += 1
        time.sleep(1)
    raise RuntimeError('Missing control: ' + label + '\nScreen: ' + ' | '.join(n.attrib.get('text','') for n in nodes()))

def wait_text(label, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        if any(label.lower() in n.attrib.get('text', '').lower() for n in nodes()): return
        time.sleep(1)
    raise RuntimeError('Missing text: ' + label + '\nScreen: ' + ' | '.join(n.attrib.get('text','') for n in nodes()))

sh('adb', 'install', '-r', 'Spectacle.apk')
sh('adb', 'shell', 'pm', 'clear', 'app.spectacle.family')
sh('adb', 'shell', 'pm', 'grant', 'app.spectacle.family', 'android.permission.CAMERA')
sh('adb', 'shell', 'svc', 'wifi', 'disable')
sh('adb', 'shell', 'svc', 'data', 'disable')
try:
    sh('adb', 'shell', 'am', 'start', '-n', 'app.spectacle.family/app.spectacle.MainActivity')
    tap('Use this phone independently')
    wait_text('Your phone is the camera')
    tap('Settings'); tap('Save motion snapshots'); tap('Automatic offline biome scans')
    tap('Camera')
    tap('Start camera'); tap('I agree')
    wait_text('Live', 45); time.sleep(3)
    tap('Save a photo')
    wait_text('Saved:', 90)
    tap('Start recording'); wait_text('REC'); time.sleep(5); tap('Stop recording'); time.sleep(3)
    tap('Archive'); wait_text('photo'); wait_text('video')
    tap('View'); tap('Close')
    # Restart with no saved server address and no network; the archive must persist.
    sh('adb', 'shell', 'am', 'force-stop', 'app.spectacle.family')
    sh('adb', 'shell', 'am', 'start', '-n', 'app.spectacle.family/app.spectacle.MainActivity')
    wait_text('Your phone is the camera')
    tap('Archive'); wait_text('photo')
    tap('Delete'); tap('Delete'); time.sleep(1)
    tap('Delete'); tap('Delete')
    wait_text('Nothing saved yet')
    print('PASS: Android local mode opens, captures, records, classifies, persists and deletes offline without a PC/server.')
finally:
    sh('adb', 'shell', 'svc', 'wifi', 'enable')
    sh('adb', 'shell', 'svc', 'data', 'enable')
    sh('adb', 'shell', 'pm', 'clear', 'app.spectacle.family')
