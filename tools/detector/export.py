#!/usr/bin/env python3
"""Export a D-FINE checkpoint (Apache-2.0, https://github.com/Peterande/D-FINE) to ONNX for Spectacle.

Run inside a checkout of the D-FINE repository (the GitHub workflow does this):
    python export.py --dfine ./D-FINE --config configs/dfine/objects365/dfine_hgnetv2_l_obj2coco.yml \
                     --weights dfine_l_obj2coco_e25.pth --out dfine-l.onnx

The exported graph includes D-FINE's own post-processing, so the model directly returns, for one image:
    labels [1,300] int64 (0..79, COCO order) · boxes [1,300,4] float (x1,y1,x2,y2 in original pixels) · scores [1,300]
Inputs: images [1,3,640,640] float32 RGB scaled 0..1 (plain resize, no letterbox), orig_target_sizes [1,2] int64 = [width, height].
"""
import argparse, os, sys

import torch
import torch.nn as nn

p = argparse.ArgumentParser()
p.add_argument("--dfine", required=True)
p.add_argument("--config", required=True)
p.add_argument("--weights", required=True)
p.add_argument("--out", required=True)
a = p.parse_args()

sys.path.insert(0, os.path.abspath(a.dfine))
from src.core import YAMLConfig  # noqa: E402

cfg = YAMLConfig(os.path.join(a.dfine, a.config), resume=a.weights)
if "HGNetv2" in cfg.yaml_cfg:
    cfg.yaml_cfg["HGNetv2"]["pretrained"] = False  # weights come from the checkpoint, no download
ck = torch.load(a.weights, map_location="cpu")
state = ck["ema"]["module"] if "ema" in ck else ck["model"]
cfg.model.load_state_dict(state)


class Model(nn.Module):
    def __init__(self):
        super().__init__()
        self.model = cfg.model.deploy()
        self.post = cfg.postprocessor.deploy()

    def forward(self, images, orig_target_sizes):
        return self.post(self.model(images), orig_target_sizes)


m = Model().eval()
img = torch.rand(1, 3, 640, 640)
size = torch.tensor([[640, 640]])
with torch.no_grad():
    m(img, size)
    torch.onnx.export(
        m, (img, size), a.out,
        input_names=["images", "orig_target_sizes"],
        output_names=["labels", "boxes", "scores"],
        opset_version=17, do_constant_folding=True,
    )
import onnx  # noqa: E402

onnx.checker.check_model(onnx.load(a.out))
print("exported", a.out, os.path.getsize(a.out) // 1_000_000, "MB")
