#!/usr/bin/env python3
"""Sanity-check an exported detector on known pictures (fails the build if it can't see what's obviously there)."""
import sys, time
import numpy as np
import onnxruntime as ort
from PIL import Image

COCO = "person bicycle car motorcycle airplane bus train truck boat traffic_light fire_hydrant stop_sign parking_meter bench bird cat dog horse sheep cow elephant bear zebra giraffe backpack umbrella handbag tie suitcase frisbee skis snowboard sports_ball kite baseball_bat baseball_glove skateboard surfboard tennis_racket bottle wine_glass cup fork knife spoon bowl banana apple sandwich orange broccoli carrot hot_dog pizza donut cake chair couch potted_plant bed dining_table toilet tv laptop mouse remote keyboard cell_phone microwave oven toaster sink refrigerator book clock vase scissors teddy_bear hair_drier toothbrush".split()
model, imgdir = sys.argv[1], sys.argv[2]
s = ort.InferenceSession(model, providers=["CPUExecutionProvider"])
expect = {"grace_hopper.jpg": {"person": 1}, "cat.jpg": {"cat": 1}, "kite_and_cold.jpg": {"person": 2, "kite": 1}, "parrot.jpg": {"bird": 1}}
ok = True
for name, want in expect.items():
    im = Image.open(f"{imgdir}/{name}").convert("RGB")
    w, h = im.size
    x = np.asarray(im.resize((640, 640), Image.BILINEAR), dtype=np.float32).transpose(2, 0, 1)[None] / 255.0
    t = time.time()
    labels, boxes, scores = s.run(None, {"images": x, "orig_target_sizes": np.array([[w, h]], dtype=np.int64)})
    ms = (time.time() - t) * 1000
    found = {}
    for l, sc in zip(labels[0], scores[0]):
        if sc >= 0.5:
            found[COCO[int(l)]] = found.get(COCO[int(l)], 0) + 1
    good = all(found.get(k, 0) >= n for k, n in want.items())
    ok &= good
    print(f"{'PASS' if good else 'FAIL'} {name}: {found} ({ms:.0f} ms)")
    print(f"::notice title={model}::{'PASS' if good else 'FAIL'} {name}: {found} in {ms:.0f} ms (GitHub's 4-core CPU)")
sys.exit(0 if ok else 1)
