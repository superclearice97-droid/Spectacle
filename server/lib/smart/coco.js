'use strict';
// The 80 COCO object classes the detector knows, in model output order, and how Spectacle groups them.
const LABELS = ['person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat', 'traffic light',
  'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear',
  'zebra', 'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball',
  'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket', 'bottle', 'wine glass', 'cup', 'fork',
  'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake',
  'chair', 'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard',
  'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear',
  'hair drier', 'toothbrush'];

// What people actually want alerts about. Everything else is still detected and shown, just never alerts.
const GROUPS = {
  person: ['person'],
  vehicle: ['bicycle', 'car', 'motorcycle', 'bus', 'truck', 'boat', 'train', 'airplane'],
  animal: ['bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe'],
  package: ['backpack', 'handbag', 'suitcase'],
};
const GROUP_OF = {};
for (const [g, ls] of Object.entries(GROUPS)) for (const l of ls) GROUP_OF[l] = g;
const groupOf = label => GROUP_OF[label] || 'other';
const GROUP_NAMES = { person: 'Person', vehicle: 'Vehicle', animal: 'Animal', package: 'Bag or package', other: 'Object' };
const nice = label => label.charAt(0).toUpperCase() + label.slice(1);

module.exports = { LABELS, GROUPS, groupOf, GROUP_NAMES, nice };
