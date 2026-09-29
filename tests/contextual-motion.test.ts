import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Bone, Group } from "three";
import { AvatarWalker } from "../lib/avatar/walking";

type ExportedBone = { name: string; translation: number[]; rotation: number[]; scale: number[]; children: number[]; nodeIndex: number };

function walker() {
  const manifest = JSON.parse(readFileSync(new URL("../public/models/avatar-manifest.json", import.meta.url), "utf8")) as { bones: ExportedBone[] };
  const map = new Map<number, Bone>();
  for (const data of manifest.bones) {
    const bone = new Bone(); bone.name = data.name;
    bone.position.fromArray(data.translation); bone.quaternion.fromArray(data.rotation); bone.scale.fromArray(data.scale);
    map.set(data.nodeIndex, bone);
  }
  for (const data of manifest.bones) for (const child of data.children) {
    const bone = map.get(child); if (bone) map.get(data.nodeIndex)!.add(bone);
  }
  const model = new Group();
  for (const bone of map.values()) if (!bone.parent) model.add(bone);
  model.updateMatrixWorld(true);
  return new AvatarWalker(model);
}

/** Walks a straight line and records the arm swing frame by frame. */
function stride(seconds = 6, fps = 60) {
  const walk = walker();
  walk.setPath([[0, 1.1], [0, 2.2]]);
  const samples: { time: number; armD: number; armE: number }[] = [];
  for (let step = 0; step < seconds * fps; step++) {
    const frame = walk.update(1 / fps);
    samples.push({ time: step / fps, armD: frame.arms.D, armE: frame.arms.E });
  }
  return samples;
}

const biggestStep = (samples: { armD: number }[]) => samples
  .slice(1)
  .reduce((worst, sample, index) => Math.max(worst, Math.abs(sample.armD - samples[index].armD)), 0);

describe("movimentos do contexto: a caminhada", () => {
  it("balança os braços com atraso em relação à perna, não em fase com ela", () => {
    const samples = stride();
    const swinging = samples.filter(sample => Math.abs(sample.armD) > 1e-6);
    expect(swinging.length).toBeGreaterThan(40);
    // The arm reaches its extreme after the middle of the leg swing, never before.
    const peak = swinging.reduce((best, sample) => Math.abs(sample.armD) > Math.abs(best.armD) ? sample : best, swinging[0]);
    const first = swinging[0].time, last = swinging[swinging.length - 1].time;
    expect(peak.time).toBeGreaterThan(first + (last - first) / 2);
  });

  it("não usa os dois braços como espelho exato um do outro", () => {
    const samples = stride().filter(sample => Math.abs(sample.armD) > 0.01);
    expect(samples.length).toBeGreaterThan(20);
    for (const sample of samples) {
      // Opposed, as a walk requires, but not identical in size.
      expect(Math.sign(sample.armE)).toBe(-Math.sign(sample.armD));
      expect(Math.abs(sample.armE)).toBeLessThan(Math.abs(sample.armD));
    }
    const ratios = samples.map(sample => Math.abs(sample.armE / sample.armD));
    expect(Math.max(...ratios)).toBeLessThan(0.99);
    expect(Math.min(...ratios)).toBeGreaterThan(0.85);
  });

  it("atravessa a virada de passo sem descontinuidade", () => {
    // On a continuous signal the largest frame-to-frame move halves when the
    // frame rate doubles. A genuine jump at the swing boundary would not shrink,
    // which is the failure the lagged arm could have introduced.
    const coarse = biggestStep(stride(8, 60));
    const fine = biggestStep(stride(8, 120));
    expect(fine).toBeLessThan(coarse * 0.62);
    expect(coarse).toBeLessThan(0.05);
  });

  it("mantém o passo reproduzível: a mesma caminhada dá a mesma sequência", () => {
    const first = stride(4).map(sample => sample.armD.toFixed(6)).join(",");
    const second = stride(4).map(sample => sample.armD.toFixed(6)).join(",");
    expect(second).toBe(first);
  });
});

describe("movimentos do contexto: o cotovelo e o punho na caminhada", () => {
  /** A straight walk, recording the arm chain signals frame by frame. */
  function chain(seconds = 8, fps = 60, path: [number, number][] = [[0, 3]]) {
    const walk = walker();
    walk.setPath(path);
    const samples: { time: number; arm: number; forearm: number; wrist: number; twist: number }[] = [];
    for (let step = 0; step < seconds * fps; step++) {
      const frame = walk.update(step === 0 ? 0 : 1 / fps);
      samples.push({ time: step / fps, arm: frame.arms.D, forearm: frame.forearms.D, wrist: frame.wrists.D, twist: frame.body.twist });
    }
    return samples;
  }
  const lagOf = (samples: ReturnType<typeof chain>, from: "arm" | "forearm", to: "forearm" | "wrist", fps = 60) => {
    let best = { shift: 0, score: -Infinity };
    for (let shift = 0; shift <= 30; shift++) {
      let score = 0;
      for (let index = 0; index + shift < samples.length; index++) score += samples[index][from] * samples[index + shift][to];
      if (score > best.score) best = { shift, score };
    }
    return best.shift * 1000 / fps;
  };

  it("dobra o cotovelo e o punho depois do ombro, como um chicote, e não como uma vara", () => {
    const samples = chain();
    // Before, the forearm did not move at the elbow at all.
    expect(Math.max(...samples.map(sample => Math.abs(sample.forearm)))).toBeGreaterThan(0.2);
    expect(Math.max(...samples.map(sample => Math.abs(sample.wrist)))).toBeGreaterThan(0.05);
    // Each link trails the one above it.
    expect(lagOf(samples, "arm", "forearm")).toBeGreaterThan(80);
    expect(lagOf(samples, "forearm", "wrist")).toBeGreaterThan(40);
  });

  it("atravessa o apoio duplo sem salto no cotovelo nem no punho", () => {
    // Read from the swing clock, which stops through the double support, the
    // forearm would still be at 73 percent of its swing when the swing ended
    // and drop to nothing in one frame. On a continuous signal the largest
    // frame-to-frame move halves when the frame rate doubles.
    for (const part of ["forearm", "wrist"] as const) {
      const biggest = (fps: number) => {
        const samples = chain(8, fps);
        return samples.slice(1).reduce((worst, sample, index) => Math.max(worst, Math.abs(sample[part] - samples[index][part])), 0);
      };
      expect(biggest(120), part).toBeLessThan(biggest(60) * 0.62);
    }
  });

  it("começa limpo: nenhum passo anterior que nunca aconteceu, nem na primeira caminhada nem na seguinte", () => {
    // At the start the elbow lag reaches back before the first step, and read
    // there it found a swing never taken - which bent the elbow on the first
    // frame and set 30 and 120 fps 0.81 degrees apart.
    const first = chain(0.2);
    for (const sample of first.filter(sample => sample.time < 0.05)) {
      expect(sample.forearm).toBe(0);
      expect(sample.wrist).toBe(0);
    }
    const walk = walker();
    walk.setPath([[0, 1]]);
    for (let step = 0; step < 12 * 60; step++) walk.update(1 / 60);   // walk, arrive, stand
    expect(walk.update(0).weight).toBe(0);
    walk.setPath([[0, 2]]);
    const again = walk.update(1 / 60);
    expect(again.forearms.D).toBe(0);
    expect(again.wrists.D).toBe(0);
  });

  it("gira a linha dos ombros como a de quem anda", () => {
    const twist = Math.max(...chain().map(sample => Math.abs(sample.twist)));
    // At 0.016 the shoulder line turned 0.95 degrees a stride. The rig spreads
    // this over pelvis, spine and chest; measured there it turns 9.3.
    expect(twist).toBeGreaterThan(0.12);
    expect(twist).toBeLessThan(0.2);
  });
});
