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
    while time.time() < end:
        for n in nodes():
            if label.lower() in n.attrib.get('text', '').lower():
                b = list(map(int, re.findall(r'\d+', n.attrib['bounds'])))
                if b[3] > b[1]:
                    sh('adb', 'shell', 'input', 'tap', str((b[0]+b[2])//2), str((b[1]+b[3])//2)); time.sleep(1); return
        time.sleep(1)
    raise RuntimeError('Missing control: ' + label)

def wait_text(label, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        if any(label.lower() in n.attrib.get('text', '').lower() for n in nodes()): return
        time.sleep(1)
    raise RuntimeError('Missing text: ' + label)

sh('adb', 'install', '-r', 'Spectacle.apk')
sh('adb', 'shell', 'pm', 'clear', 'app.spectacle.family')
sh('adb', 'shell', 'pm', 'grant', 'app.spectacle.family', 'android.permission.CAMERA')
sh('adb', 'shell', 'svc', 'wifi', 'disable')
sh('adb', 'shell', 'svc', 'data', 'disable')
try:
    sh('adb', 'shell', 'am', 'start', '-n', 'app.spectacle.family/app.spectacle.MainActivity')
    tap('Use this phone independently')
    wait_text('Your phone is the camera')
    tap('Open this phone')
    tap('Start camera'); tap('I agree')
    wait_text('Live', 45)
    tap('Save a photo')
    wait_text('Saved:', 90)
    tap('Archive'); wait_text('photo')
    tap('View'); tap('Close')
    # Restart with no saved server address and no network; the archive must persist.
    sh('adb', 'shell', 'am', 'force-stop', 'app.spectacle.family')
    sh('adb', 'shell', 'am', 'start', '-n', 'app.spectacle.family/app.spectacle.MainActivity')
    wait_text('Your phone is the camera')
    tap('Archive'); wait_text('photo')
    tap('Delete'); tap('Delete')
    wait_text('Nothing saved yet')
    print('PASS: Android local mode opens, captures, classifies, persists and deletes offline without a PC/server.')
finally:
    sh('adb', 'shell', 'svc', 'wifi', 'enable')
    sh('adb', 'shell', 'svc', 'data', 'enable')
    sh('adb', 'shell', 'pm', 'clear', 'app.spectacle.family')
