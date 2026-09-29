import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Bone, Group, Quaternion, SkinnedMesh, Texture, Vector3 } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { AvatarRig } from "../lib/avatar/rig";
import { AvatarWalker, type WalkingFrame, type WalkingSide } from "../lib/avatar/walking";

type ExportedBone = { name: string; translation: number[]; rotation: number[]; scale: number[]; children: number[]; nodeIndex: number };
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
  const model = new Group(), locomotion = new Group(); locomotion.add(model);
  for (const bone of map.values()) if (!bone.parent) model.add(bone);
  model.updateMatrixWorld(true);
  return { model, locomotion, rig: new AvatarRig(model), walker: new AvatarWalker(model) };
}
function pose(subject: ReturnType<typeof avatar>, time: number, speech = 0) {
  subject.locomotion.position.set(0, 0, 0); subject.locomotion.rotation.set(0, 0, 0);
  subject.locomotion.updateMatrixWorld(true);
  const frame = subject.walker.update(1 / 60);
  subject.rig.update(time, true, speech, undefined, undefined, frame);
  subject.locomotion.position.set(frame.x, 0, frame.z); subject.locomotion.rotation.y = frame.yaw;
  subject.locomotion.updateMatrixWorld(true);
  return frame;
}
function worldFoot(frame: WalkingFrame, side: WalkingSide) {
  return new Vector3(...frame.feet[side].position).applyAxisAngle(new Vector3(0, 1, 0), frame.yaw).add(new Vector3(frame.x, 0, frame.z));
}

describe("avatar walking on the real 48-bone skeleton", () => {
  it("finishes a path, turns toward the visitor and releases walking motion", () => {
    const walker = new AvatarWalker(); walker.setPath([[0, 0], [0, 0.9], [0.65, 0.9]]);
    let sawFinalTurn = false, maxSpeed = 0;
    for (let i = 0; i < 3600; i++) {
      const frame = walker.update(1 / 60); maxSpeed = Math.max(maxSpeed, frame.speed);
      if (Math.hypot(frame.x - 0.65, frame.z - 0.9) < 0.001 && Math.abs(frame.yaw) > 0.08 && frame.active) sawFinalTurn = true;
      expect(Math.min(Math.abs(frame.x), Math.abs(frame.z - 0.9))).toBeLessThan(0.00001);
    }
    expect(walker.frame.active).toBe(false);
    expect(walker.frame.x).toBeCloseTo(0.65, 6); expect(walker.frame.z).toBeCloseTo(0.9, 6);
    expect(walker.frame.yaw).toBeCloseTo(0, 4); expect(walker.frame.weight).toBe(0);
    expect(walker.frame.stepCount).toBeGreaterThan(5); expect(maxSpeed).toBeGreaterThan(0.35); expect(maxSpeed).toBeLessThanOrEqual(0.42);
    expect(sawFinalTurn).toBe(true);
  });

  it("keeps supporting ankles and shoe orientation fixed in world space while the root moves and turns", () => {
    const subject = avatar(); subject.walker.setPath([[0, 0], [0, 0.9], [0.65, 0.9]]);
    const previous = new Map<WalkingSide, { point: Vector3; orientation: Quaternion; support: boolean }>();
    let maximumError = 0, maximumSlide = 0, maximumTwist = 0, lift = 0; 
    const steps = new Set<WalkingSide>();
    for (let i = 0; i < 1800; i++) {
      const frame = pose(subject, i / 60, i % 360 < 120 ? 0.4 : 0);
      for (const side of ["D", "E"] as const) {
        const bone = subject.model.getObjectByName(`Pe.${side}`)!;
        const point = bone.getWorldPosition(new Vector3()), orientation = bone.getWorldQuaternion(new Quaternion()).normalize();
        maximumError = Math.max(maximumError, point.distanceTo(worldFoot(frame, side)));
        const last = previous.get(side);
        if (last?.support && frame.feet[side].support) {
          maximumSlide = Math.max(maximumSlide, point.distanceTo(last.point));
          maximumTwist = Math.max(maximumTwist, orientation.angleTo(last.orientation));
        }
        if (!frame.feet[side].support) { steps.add(side); lift = Math.max(lift, frame.feet[side].position[1] - 0.115); }
        previous.set(side, { point, orientation, support: frame.feet[side].support });
      }
    }
    expect(maximumError, "IK ankle target error in metres").toBeLessThan(0.00005);
    expect(maximumSlide, "support ankle sliding in metres/frame").toBeLessThan(0.00005);
    expect(maximumTwist, "support shoe rotation in radians/frame").toBeLessThan(0.00005);
    expect(lift).toBeGreaterThan(0.025); expect(steps.size).toBe(2);
  });

  it("stops mid-stride without teleporting a foot and remains active until landing and settling", () => {
    const walker = new AvatarWalker(); walker.setPath([[0, 2.5]]);
    let previous: Record<WalkingSide, Vector3> = { D: worldFoot(walker.frame, "D"), E: worldFoot(walker.frame, "E") };
    let stopAt = -1, maximumJump = 0, landedWhileActive = false;
    for (let i = 0; i < 1800; i++) {
      const frame = walker.update(1 / 60);
      if (stopAt < 0 && frame.speed > 0.35 && !frame.feet.D.support && frame.feet.D.position[1] > 0.13) { stopAt = i; walker.stop(); }
      if (stopAt >= 0 && frame.feet.D.support && frame.feet.E.support && frame.active) landedWhileActive = true;
      const current = { D: worldFoot(frame, "D"), E: worldFoot(frame, "E") };
      maximumJump = Math.max(maximumJump, current.D.distanceTo(previous.D), current.E.distanceTo(previous.E)); previous = current;
    }
    expect(stopAt).toBeGreaterThan(0); expect(landedWhileActive).toBe(true);
    expect(maximumJump).toBeLessThan(0.035);
    expect(walker.frame.active).toBe(false); expect(walker.frame.z).toBeLessThan(1.0);
    expect(walker.frame.feet.D.support && walker.frame.feet.E.support).toBe(true);
  });

  it("a sideward stop completes its step and pivots back toward the visitor without moving the support foot", () => {
    const subject = avatar(); subject.walker.setPath([[1.6, 0]]);
    let stopped = false, sawTurning = false, maximumError = 0, lastX = 0;
    for (let i = 0; i < 2400; i++) {
      const frame = pose(subject, i / 60);
      if (!stopped && frame.speed > 0.32 && frame.yaw > 0.8) { subject.walker.stop(); stopped = true; }
      if (stopped && frame.speed === 0 && frame.active && frame.yaw > 0.05) sawTurning = true;
      for (const side of ["D", "E"] as const) {
        const ankle = subject.model.getObjectByName(`Pe.${side}`)!.getWorldPosition(new Vector3());
        maximumError = Math.max(maximumError, ankle.distanceTo(worldFoot(frame, side)));
      }
      expect(Math.abs(frame.x - lastX)).toBeLessThan(0.008); lastX = frame.x;
    }
    expect(stopped && sawTurning).toBe(true); expect(subject.walker.frame.active).toBe(false);
    expect(subject.walker.frame.yaw).toBeCloseTo(0, 5); expect(subject.walker.frame.x).toBeLessThan(1.2);
    expect(maximumError).toBeLessThan(0.00005);
  });

  it("is deterministic across 30, 60 and 120 FPS and ignores hidden-tab gaps", () => {
    const simulate = (hz: number) => { const walker = new AvatarWalker(); walker.setPath([[0.6, 0.5], [-0.2, 1.0]]); for (let i = 0; i < 9 * hz; i++) walker.update(1 / hz); return structuredClone(walker.frame); };
    expect(simulate(30)).toEqual(simulate(60)); expect(simulate(60)).toEqual(simulate(120));
    const walker = new AvatarWalker(); walker.setPath([[0, 1]]); walker.update(0.1);
    const before = structuredClone(walker.frame);
    for (const delta of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 300]) expect(walker.update(delta)).toEqual(before);
  });

  it("keeps walking arm counterbalance subordinate to a greeting and expressive fingers", () => {
    const subject = avatar(); subject.walker.setPath([[0, 2]]); subject.rig.gesture("wave", 0);
    let raised = 0, fingerMotion = 0, previous: Quaternion | null = null;
    for (let i = 0; i < 240; i++) {
      pose(subject, i / 60, 0.4);
      const finger = subject.model.getObjectByName("Indicador.02.D")!.quaternion;
      if (previous) fingerMotion += finger.angleTo(previous); previous = finger.clone();
      raised = Math.max(raised, subject.model.getObjectByName("Mao.D")!.getWorldPosition(new Vector3()).y);
    }
    expect(raised).toBeGreaterThan(1.44); expect(fingerMotion).toBeGreaterThan(0.3);
  });

  it("the actual weighted shoe surfaces clear the floor during tiny pivot steps and longer strides", async () => {
    const bytes = readFileSync(new URL("../public/models/goncalves-dias.glb", import.meta.url));
    const loader = new GLTFLoader();
    loader.register(() => ({ name: "WALK_TEST_SKIP_TEXTURES", loadTexture: async () => new Texture() }));
    const { scene: model } = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
    const locomotion = new Group(); locomotion.add(model); model.updateMatrixWorld(true);
    const subject = { model, locomotion, rig: new AvatarRig(model), walker: new AvatarWalker(model) };
    const shoes: { mesh: SkinnedMesh; index: number; side: WalkingSide; previous: Vector3; support: boolean }[] = [];
    model.traverse(object => {
      if (!(object instanceof SkinnedMesh) || object.userData.avatarEye || object.userData.avatarEyelid) return;
      const count = object.geometry.getAttribute("position").count;
      for (let index = 0; index < count; index++) {
        const point = object.getVertexPosition(index, new Vector3()).applyMatrix4(object.matrixWorld);
        if (point.y < 0.055 && index % 5 === 0) shoes.push({ mesh: object, index, side: point.x < 0 ? "D" : "E", previous: point, support: true });
      }
    });
    expect(shoes.length).toBeGreaterThan(60);
    subject.walker.setPath([[0.7, 0], [0.7, 0.7]]);
    let lowestSole = Infinity, supportDrift = 0, highestSole = 0;
    for (let i = 0; i < 1500; i++) {
      const frame = pose(subject, i / 60, 0.2);
      for (const sample of shoes) {
        const point = sample.mesh.getVertexPosition(sample.index, new Vector3()).applyMatrix4(sample.mesh.matrixWorld);
        lowestSole = Math.min(lowestSole, point.y); highestSole = Math.max(highestSole, point.y);
        if (frame.feet[sample.side].support && sample.support) {
          const drift=point.distanceTo(sample.previous);
          supportDrift = Math.max(supportDrift, drift);
        }
        sample.previous.copy(point); sample.support = frame.feet[sample.side].support;
      }
    }
    expect(lowestSole, "heel/toe penetration in metres").toBeGreaterThan(-0.0005);
    expect(supportDrift, "weighted sole drift in metres/frame").toBeLessThan(0.0001);
    expect(highestSole).toBeGreaterThan(0.075);
    expect(subject.walker.frame.active).toBe(false);
  }, 15000);

  it("redirects during a step without resetting its world-space trajectory", () => {
    const walker = new AvatarWalker(); walker.setPath([[0, 1.8]]);
    for (let i = 0; i < 90; i++) walker.update(1 / 60);
    const before = structuredClone(walker.frame), right = worldFoot(before, "D"), left = worldFoot(before, "E");
    walker.setPath([[before.x, before.z], [0.5, before.z], [0.5, 0]]);
    expect(worldFoot(walker.update(0), "D").distanceTo(right)).toBe(0);
    expect(worldFoot(walker.frame, "E").distanceTo(left)).toBe(0);
    let maximum = 0; let lastD = right, lastE = left;
    for (let i = 0; i < 2400; i++) { const frame = walker.update(1 / 60); const d = worldFoot(frame, "D"), e = worldFoot(frame, "E"); maximum = Math.max(maximum, d.distanceTo(lastD), e.distanceTo(lastE)); lastD = d; lastE = e; }
    expect(maximum).toBeLessThan(0.04); expect(walker.frame.active).toBe(false);
    expect(walker.frame.x).toBeCloseTo(0.5, 6); expect(walker.frame.z).toBeCloseTo(0, 6);
  });
});