import type { CaseExpectation } from "./scoring";

// The eval suite: 8 representative prompts with deterministic assertions.
// Six cover the product's bread and butter (enclosures, brackets, everyday
// parts); the two marked `hard` cover finicky operations
// (snap-fit joints, polar patterns) and are expected to fail at baseline.
//
// Assertions are ranges, not exact values: LLM output legitimately varies.
// `sortedBbox` ranges apply to the bounding-box dimensions sorted descending,
// so a bracket laid flat and one stood upright score the same.

export interface EvalCase {
  id: string;
  prompt: string;
  expect: CaseExpectation;
  hard?: boolean;
}

export const EVAL_CASES: EvalCase[] = [
  {
    id: "pi5-enclosure",
    // "single piece, no lid" pins the design so the bbox assertion is fair:
    // capable models otherwise produce a two-part base+lid laid out side by
    // side, which is fine engineering but blows the single-body bbox range.
    prompt: "Enclosure for a Raspberry Pi 5 with a USB-C cutout and 3mm walls. Single piece, open top, no lid.",
    // Pi 5 board is 85 x 56 mm; enclosure adds walls + clearance.
    expect: {
      sortedBbox: [
        [88, 120],
        [58, 95],
        [15, 50],
      ],
      watertight: true,
    },
  },
  {
    id: "l-bracket",
    prompt: "L-bracket 60x40mm with 3 holes for M3 screws.",
    expect: {
      sortedBbox: [
        [55, 68],
        [36, 52],
        [2, 45],
      ],
      watertight: true,
    },
  },
  {
    id: "phone-stand",
    prompt: "Phone stand angled at 70 degrees for a phone 80mm wide.",
    expect: {
      sortedBbox: [
        [60, 130],
        [40, 110],
        [3, 90],
      ],
      watertight: true,
    },
  },
  {
    id: "cable-clip",
    prompt: "Cable clip for a 6mm cable with a screw hole to mount it on a wall.",
    // A clip for a 6mm cable is a small part: nothing should exceed 40mm.
    expect: {
      sortedBbox: [
        [8, 40],
        [6, 40],
        [2, 40],
      ],
      watertight: true,
    },
  },
  {
    id: "vented-lid",
    prompt: "A flat lid 80x50mm, 3mm thick, with ventilation slots.",
    expect: {
      sortedBbox: [
        [75, 90],
        [45, 60],
        [2, 10],
      ],
      watertight: true,
    },
  },
  {
    id: "vase",
    prompt: "A revolved vase about 100mm tall with a 60mm diameter belly.",
    expect: {
      sortedBbox: [
        [85, 115],
        [40, 75],
        [40, 75],
      ],
      watertight: true,
    },
  },
  {
    id: "snap-fit-box",
    prompt: "A small box 50x30x20mm with a snap-fit lid.",
    // Multi-part output (box + lid, often a cq.Assembly); the combined
    // bounding box depends on how the parts are laid out, so only require a
    // valid watertight render.
    expect: { watertight: true },
    hard: true,
  },
  {
    id: "polar-flange",
    prompt: "A round flange 60mm diameter, 6mm thick, with 6 bolt holes for M4 screws on a 45mm bolt circle.",
    expect: {
      sortedBbox: [
        [55, 70],
        [55, 70],
        [3, 15],
      ],
      watertight: true,
    },
    hard: true,
  },
];
