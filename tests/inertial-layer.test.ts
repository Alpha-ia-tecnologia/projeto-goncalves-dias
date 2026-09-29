import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Bone, Group, Quaternion } from "three";
import { AvatarRig } from "../lib/avatar/rig";
import { AvatarWalker } from "../lib/avatar/walking";

type ExportedBone = { name: string; translation: number[]; rotation: number[]; scale: number[]; children: number[]; nodeIndex: number };

/** The scanned skeleton inside a locomotion group, as the walking tests build it. */
function avatar() {
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
  const model = new Group(), locomotion = new Group();
  locomotion.add(model);
  for (const bone of map.values()) if (!bone.parent) model.add(bone);
  model.updateMatrixWorld(true);
  const rig = new AvatarRig(model);
  const bone = (name: string) => model.getObjectByName(name) as Bone;
  return { model, locomotion, rig, bone, walker: new AvatarWalker(model) };
}

/** Rotation of a bone away from its rest orientation, in radians. */
function restAngle(bone: Bone, rest: Quaternion) {
  return bone.getWorldQuaternion(new Quaternion()).angleTo(rest);
}

describe("a camada inercial", () => {
  it("dá seguimento ao movimento: o braço continua a mover-se depois que o comando do aceno já parou", () => {
    const { rig, bone } = avatar();
    const arm = bone("Braco.D");
    rig.update(0, true, 0);
    const rest = arm.getWorldQuaternion(new Quaternion());
    rig.gesture("wave", 1);
    // The raise envelope of the wave is flat from 0.72 s on. A bone driven
    // straight from it would be still by then; a bone with mass is not.
    let time = 1;
    const angleAt = (waveTime: number) => {
      for (; time <= 1 + waveTime + 1e-9; time += 1 / 120) rig.update(time, true, 0);
      return restAngle(arm, rest);
    };
    const atCommandEnd = angleAt(0.75);
    const later = angleAt(0.85);
    expect(Math.abs(later - atCommandEnd)).toBeGreaterThan(0.003);
    // But it settles: by the middle of the wave the arm is holding its pose.
    const held = angleAt(1.4), heldLater = angleAt(1.5);
    expect(Math.abs(heldLater - held)).toBeLessThan(0.02);
  });

  it("nunca avança uma mola duas vezes no mesmo quadro, em repouso, fala, aceno e caminhada", () => {
    const { rig, locomotion, walker } = avatar();
    // The guard inside the rig throws on a double advance, so simply driving
    // every context is the assertion. Each phase runs long enough to cross
    // several phrases, a whole wave and a few steps.
    let time = 0;
    const run = (seconds: number, speech: (t: number) => number, walk = false) => {
      for (let step = 0; step < seconds * 60; step++, time += 1 / 60) {
        const frame = walk ? walker.update(1 / 60) : undefined;
        locomotion.position.set(0, 0, 0); locomotion.rotation.set(0, 0, 0);
        locomotion.updateMatrixWorld(true);
        rig.update(time, true, speech(time), undefined, undefined, frame);
        if (frame) { locomotion.position.set(frame.x, 0, frame.z); locomotion.rotation.y = frame.yaw; }
      }
    };
    run(6, () => 0);
    run(8, t => 0.35 + 0.3 * Math.max(0, Math.sin(t * 7.3)));
    rig.gesture("wave", time);
    run(4, t => 0.2 + 0.2 * Math.max(0, Math.sin(t * 5.1)));
    walker.setPath([[0, 1.1], [0, 2.2]]);
    run(6, () => 0, true);
    rig.gesture("nod", time);
    run(3, () => 0);
    expect(time).toBeGreaterThan(26);
  });

  it("chega ao mesmo aceno a 30 e a 120 quadros por segundo", () => {
    // The wave is the fastest thing the poet does. Before the inertial layer
    // no test checked a gesture across frame rates; with springs fed a ramp
    // (first-order hold) the two rates must land on the same curve. What is
    // left is the curvature of the envelope inside one 33 ms frame, which no
    // causal hold can see: measured at 0.0062 rad, a third of a degree. Fed
    // the value only at frame ends it was 0.017.
    const simulate = (fps: number) => {
      const { rig, bone } = avatar();
      rig.update(0, true, 0);
      rig.gesture("wave", 0.5);
      const poses: Quaternion[][] = [];
      for (let frame = 0; frame <= fps * 4; frame++) {
        const time = frame / fps;
        rig.update(time, true, 0);
        if ([1.5, 2.5, 3.9].some(mark => Math.abs(time - mark) < 1e-9)) {
          poses.push(["Braco.D", "Antebraco.D", "Mao.D", "Cabeca"].map(name => bone(name).getWorldQuaternion(new Quaternion())));
        }
      }
      return poses;
    };
    const slow = simulate(30), fast = simulate(120);
    expect(slow).toHaveLength(3);
    slow.forEach((pose, sample) => pose.forEach((rotation, index) => {
      expect(rotation.angleTo(fast[sample][index])).toBeLessThan(0.01);
    }));
  });
});
