import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Bone, Euler, Group, Quaternion, SkinnedMesh, Texture, Vector3 } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { AvatarRig } from "./rig";
import { smoothMouthFrame } from "./mouth";

type ExportedBone = {
  name: string;
  translation: number[];
  rotation: number[];
  scale: number[];
  children: number[];
  nodeIndex: number;
};

function realRig(includeFingers = true, includeLegs = true) {
  const manifest = JSON.parse(readFileSync(process.env.AVATAR_RIG_MANIFEST || new URL("../../public/models/avatar-manifest.json", import.meta.url), "utf8")) as { bones: ExportedBone[] };
  if (!includeFingers) manifest.bones = manifest.bones.filter((bone) => !/^(Polegar|Indicador|Medio|Anelar|Minimo)\./.test(bone.name));
  const byIndex = new Map<number, Bone>();
  for (const data of manifest.bones) {
    const bone = new Bone();
    bone.name = data.name.replaceAll(".", "");
    bone.position.fromArray(data.translation);
    bone.quaternion.fromArray(data.rotation);
    bone.scale.fromArray(data.scale);
    byIndex.set(data.nodeIndex, bone);
  }
  for (const data of manifest.bones) {
    for (const child of data.children) {
      const bone = byIndex.get(child);
      if (bone) byIndex.get(data.nodeIndex)!.add(bone);
    }
  }
  const group = new Group();
  for (const bone of byIndex.values()) if (!bone.parent) group.add(bone);
  if (!includeLegs) {
    group.updateMatrixWorld(true);
    const pelvis = group.getObjectByName("Quadril");
    const base = group.getObjectByName("Base");
    if (pelvis && base) {
      group.attach(base);
      pelvis.removeFromParent();
    }
  }
  return { group, rig: new AvatarRig(group) };
}

test("the real exported skeleton waves with its hand beside the face", () => {
  const { group, rig } = realRig();
  rig.gesture("wave", 0);
  rig.update(1.5, true);
  const hand = group.getObjectByName("MaoD")!;
  const wrist = hand.getWorldPosition(new Vector3());
  const fingertips = hand.localToWorld(new Vector3(0, 0.136, 0));
  assert.ok(wrist.y > 1.5, `wrist height: ${wrist.y}`);
  assert.ok(fingertips.y > 1.66, `fingertip height: ${fingertips.y}`);
  assert.ok(fingertips.x < -0.36 && fingertips.x > -0.68, `hand x: ${fingertips.x}`);
  assert.ok(fingertips.z > 0.05, `hand must remain in front: ${fingertips.z}`);
});

test("reduced motion restores every bone exactly and gestures never accumulate transforms", () => {
  const { group, rig } = realRig();
  const rest = new Map<string, number[]>();
  group.traverse((bone) => rest.set(bone.name, [...bone.position.toArray(), ...bone.quaternion.toArray(), ...bone.scale.toArray()]));
  rig.gesture("wave", 0);
  rig.update(1.4, true);
  rig.update(1.4, false);
  group.traverse((bone) => assert.deepEqual([...bone.position.toArray(), ...bone.quaternion.toArray(), ...bone.scale.toArray()], rest.get(bone.name)));
  rig.update(10, true);
  const once = group.getObjectByName("Cabeca")!.quaternion.clone();
  for (let index = 0; index < 200; index++) rig.update(10, true);
  assert.deepEqual(group.getObjectByName("Cabeca")!.quaternion.toArray(), once.toArray());
});

test("the wave returns both arms to the current quiet pose after the gesture", () => {
  const { group, rig } = realRig();
  const armNames = ["BracoD", "AntebracoD", "MaoD", "BracoE", "AntebracoE", "MaoE"];
  const quiet = realRig();
  rig.gesture("wave", 5);
  for (let frame = 0; frame <= 240; frame++) {
    rig.update(5 + frame / 60, true);
    quiet.rig.update(5 + frame / 60, true);
  }
  armNames.forEach(name => assert.ok(group.getObjectByName(name)!.quaternion.clone().normalize()
    .angleTo(quiet.group.getObjectByName(name)!.quaternion.clone().normalize()) < 0.000001));
});


test("speech adds restrained head movement and settles when audio stops", () => {
  const speaking = realRig();
  const quiet = realRig();
  for (let index = 0; index <= 60; index++) {
    speaking.rig.update(index / 60, true, 0.6);
    quiet.rig.update(index / 60, true, 0);
  }
  const headDifference = () => speaking.group.getObjectByName("Cabeca")!.quaternion.clone().normalize().angleTo(quiet.group.getObjectByName("Cabeca")!.quaternion.clone().normalize());
  assert.ok(headDifference() > 0.004, "speech should affect the head pose");
  assert.ok(headDifference() < 0.06, "speech motion should remain under four degrees");
  for (let index = 61; index <= 300; index++) {
    speaking.rig.update(index / 60, true, 0);
    quiet.rig.update(index / 60, true, 0);
  }
  assert.ok(headDifference() < 0.000001, "silence should return to the idle pose");
});

test("speech motion is independent of render frequency", () => {
  const simulate = (frequency: number) => {
    const avatar = realRig();
    for (let index = 0; index <= frequency; index++) avatar.rig.update(index / frequency, true, 0.4);
    return avatar.group.getObjectByName("Cabeca")!.quaternion.clone().normalize();
  };
  assert.ok(simulate(30).angleTo(simulate(120)) < 0.000001);
});

test("interrupted and repeated waves never snap the raised arm to rest", () => {
  const { group, rig } = realRig();
  const names = ["BracoD", "AntebracoD", "MaoD"];
  const rest = names.map((name) => group.getObjectByName(name)!.quaternion.clone());
  rig.gesture("wave", 0);
  rig.update(1.5, true);
  const raised = names.map((name) => group.getObjectByName(name)!.quaternion.clone());
  rig.gesture("wave", 1.5);
  rig.update(1.5, true);
  names.forEach((name, index) => assert.deepEqual(group.getObjectByName(name)!.quaternion.toArray(), raised[index].toArray()));
  rig.stopGesture(1.5);
  rig.update(1.5, true);
  names.forEach((name, index) => assert.deepEqual(group.getObjectByName(name)!.quaternion.toArray(), raised[index].toArray()));
  rig.update(1.7, true);
  assert.ok(group.getObjectByName("BracoD")!.quaternion.angleTo(rest[0]) > 0.05, "the arm should still be relaxing");
  rig.update(2.06, true);
  const quiet = realRig();
  for (const time of [1.5, 1.7, 2.06]) quiet.rig.update(time, true);
  names.forEach(name => assert.ok(group.getObjectByName(name)!.quaternion.clone().normalize()
    .angleTo(quiet.group.getObjectByName(name)!.quaternion.clone().normalize()) < 0.000001));
  rig.gesture("wave", 2.1);
  rig.update(3.6, true);
  assert.ok(group.getObjectByName("MaoD")!.getWorldPosition(new Vector3()).y > 1.5, "a subsequent greeting should wave again");
});

test("lip transitions are independent of frame rate and close fully during pauses", () => {
  const simulate = (frequency: number) => {
    const frame = { open: 0, round: 0, wide: 0 };
    for (let index = 0; index < frequency / 5; index++) smoothMouthFrame(frame, { open: 0.8, round: 0.5, wide: 0.3 }, 1 / frequency);
    return frame;
  };
  const slow = simulate(30);
  const fast = simulate(120);
  for (const key of ["open", "round", "wide"] as const) assert.ok(Math.abs(slow[key] - fast[key]) < 0.000001);
  for (let index = 0; index < 12; index++) smoothMouthFrame(fast, { open: 0, round: 1, wide: 1 }, 1 / 60);
  assert.deepEqual(fast, { open: 0, round: 0, wide: 0 });
});


test("stopping an idle avatar does not block the next greeting", () => {
  const { group, rig } = realRig();
  rig.stopGesture(0);
  rig.gesture("wave", 0.1);
  rig.update(1.6, true);
  assert.ok(group.getObjectByName("MaoD")!.getWorldPosition(new Vector3()).y > 1.5);
});


test("conversation alternates both hands and keeps them beside and in front of the torso", () => {
  const { group, rig } = realRig();
  let firstRight = 0;
  let firstLeft = 0;
  let secondRight = 0;
  let secondLeft = 0;
  const previousTips = new Map<string, Vector3>();
  for (let index = 0; index <= 1200; index++) {
    const now = index / 60;
    const briefPause = now > 5 && (now % 0.7 < 0.12 || (now % 4.9 > 1.3 && now % 4.9 < 2.2));
    rig.update(now, true, briefPause ? 0 : 0.5 + Math.sin(now * 4.7) * 0.12);
    for (const side of ["D", "E"]) {
      const hand = group.getObjectByName(`Mao${side}`)!;
      const wrist = hand.getWorldPosition(new Vector3());
      const tip = hand.localToWorld(new Vector3(0, 0.136, 0));
      for (const point of [wrist, tip]) {
        assert.ok(Math.abs(point.x) > 0.22 && Math.abs(point.x) < 0.52, `hand should stay beside the jacket: ${point.toArray()} at ${now}`);
        assert.ok(point.y > 0.79 && point.y < 1.42, `hand should stay below the face: ${point.toArray()} at ${now}`);
        assert.ok(point.z > 0.025 && point.z < 0.57, `hand should unfold in front of the body: ${point.toArray()} at ${now}`);
      }
      const previous = previousTips.get(side);
      if (previous) assert.ok(tip.distanceTo(previous) < 0.025, `hand must move smoothly: ${tip.distanceTo(previous)} m at ${now}`);
      previousTips.set(side, tip);
      if (index === 72) {
        if (side === "D") firstRight = wrist.y;
        else firstLeft = wrist.y;
      }
      if (index === 300) {
        if (side === "D") secondRight = wrist.y;
        else secondLeft = wrist.y;
      }
    }
  }
  assert.ok(firstRight > firstLeft + 0.06, "the right hand should lead the first phrase");
  assert.ok(secondLeft > secondRight + 0.06, "the left hand should lead the next phrase");
});

test("both conversational arms settle after interruption and reduced motion resets them", () => {
  const { group, rig } = realRig();
  const names = ["BracoD", "AntebracoD", "MaoD", "BracoE", "AntebracoE", "MaoE"];
  const rest = names.map((name) => group.getObjectByName(name)!.quaternion.clone());
  for (let index = 0; index <= 72; index++) rig.update(index / 60, true, 0.6);
  assert.ok(group.getObjectByName("AntebracoD")!.quaternion.clone().normalize().angleTo(rest[1].clone().normalize()) > 0.1);
  rig.stopGesture(1.2);
  for (let index = 73; index <= 300; index++) rig.update(index / 60, true, 0);
  const quiet = realRig();
  for (let index = 0; index <= 300; index++) quiet.rig.update(index / 60, true, 0);
  names.forEach(name => assert.ok(group.getObjectByName(name)!.quaternion.clone().normalize()
    .angleTo(quiet.group.getObjectByName(name)!.quaternion.clone().normalize()) < 0.000001));
  for (let index = 301; index <= 390; index++) rig.update(index / 60, true, 0.6);
  rig.update(6.6, false, 0.6);
  names.forEach((name, index) => assert.deepEqual(group.getObjectByName(name)!.quaternion.toArray(), rest[index].toArray()));
});

test("the greeting wave takes priority over conversational right-hand gestures", () => {
  const speaking = realRig();
  const quiet = realRig();
  speaking.rig.gesture("wave", 0);
  quiet.rig.gesture("wave", 0);
  for (let index = 0; index <= 90; index++) {
    speaking.rig.update(index / 60, true, 0.6);
    quiet.rig.update(index / 60, true, 0);
  }
  const speakingWrist = speaking.group.getObjectByName("MaoD")!.getWorldPosition(new Vector3());
  const quietWrist = quiet.group.getObjectByName("MaoD")!.getWorldPosition(new Vector3());
  assert.ok(speakingWrist.y > 1.5, "the greeting must keep the waving hand beside the face");
  assert.ok(speakingWrist.distanceTo(quietWrist) < 0.025, "speech must not pull the raised arm out of its wave");
});


const fingerNames = ["Polegar", "Indicador", "Medio", "Anelar", "Minimo"] as const;

function fingerJoints(group: Group) {
  const joints = [];
  for (const side of ["D", "E"] as const) for (const finger of fingerNames) for (const joint of ["01", "02", "03"] as const) {
    const bone = group.getObjectByName(`${finger}${joint}${side}`);
    assert.ok(bone instanceof Bone, `the exported rig needs ${finger}.${joint}.${side}`);
    joints.push({ bone, side, finger, joint, rest: bone.quaternion.clone() });
  }
  return joints;
}

function jointAngles(bone: Bone, rest: Quaternion) {
  const delta = rest.clone().invert().multiply(bone.quaternion).normalize();
  return new Euler().setFromQuaternion(delta, "ZXY");
}

test("all thirty exported finger joints articulate during dialogue", () => {
  const { group, rig } = realRig();
  const joints = fingerJoints(group);
  for (let index = 0; index <= 72; index++) rig.update(index / 60, true, 0.6);
  for (const joint of joints) {
    assert.ok(Math.abs(jointAngles(joint.bone, joint.rest).x) > 0.004, `${joint.bone.name} should articulate during dialogue`);
  }
  const index = joints.find((joint) => joint.bone.name === "Indicador02D")!;
  const little = joints.find((joint) => joint.bone.name === "Minimo02D")!;
  assert.ok(Math.abs(jointAngles(index.bone, index.rest).x - jointAngles(little.bone, little.rest).x) > 0.04,
    "fingers should have distinct poses rather than rotating as a rigid group");
});

test("the greeting extends the curved fingers and presents the palm to the viewer", () => {
  const { group, rig } = realRig();
  const joints = fingerJoints(group);
  const hand = group.getObjectByName("MaoD")!;
  const palmarNormal = new Vector3();
  for (const finger of fingerNames.slice(1)) {
    palmarNormal.add(new Vector3(0, 0, 1).applyQuaternion(group.getObjectByName(`${finger}01D`)!.getWorldQuaternion(new Quaternion())));
  }
  palmarNormal.normalize().applyQuaternion(hand.getWorldQuaternion(new Quaternion()).invert());
  rig.gesture("wave", 0);
  for (let frame = 0; frame <= 90; frame++) rig.update(frame / 60, true);
  for (const joint of joints) {
    const angle = jointAngles(joint.bone, joint.rest).x;
    if (joint.side === "E") assert.ok(Math.abs(angle) < 0.000001, "the other hand stays relaxed");
    else if (joint.finger !== "Polegar") {
      assert.ok(angle < (joint.joint === "02" ? -0.17 : -0.08), `${joint.bone.name} should extend the scanned curl`);
    }
  }
  palmarNormal.applyQuaternion(hand.getWorldQuaternion(new Quaternion()));
  assert.ok(palmarNormal.z > 0.78, `the palm should face forward: ${palmarNormal.toArray()}`);
});

test("finger poses respect joint limits and the smaller spread of the left hand", () => {
  const { group, rig } = realRig();
  const joints = fingerJoints(group);
  rig.gesture("wave", 0);
  for (let index = 0; index <= 900; index++) {
    const now = index / 60;
    if (index === 720) rig.gesture("wave", now);
    rig.update(now, true, now < 10 ? 0.45 : 0);
    for (const joint of joints) {
      const angle = jointAngles(joint.bone, joint.rest);
      const position = Number(joint.joint) - 1;
      const thumb = joint.finger === "Polegar";
      const lower = thumb ? (position === 0 ? -0.15 : 0) : [-0.17, -0.36, -0.18][position];
      const upper = thumb ? (position === 0 ? 0.15 : 0.23) : [0.09, 0.14, 0.075][position];
      assert.ok(angle.x >= lower - 0.000001 && angle.x <= upper + 0.000001, `${joint.bone.name} flexion outside limits: ${angle.x}`);
      const spreadLimit = (thumb ? 0.15 : 0.065) * (joint.side === "E" ? 0.5 : 1);
      assert.ok(Math.abs(angle.z) <= (position === 0 ? spreadLimit : 0) + 0.000001, `${joint.bone.name} spread outside limits: ${angle.z}`);
      assert.ok(Math.abs(angle.y) <= (thumb && position === 0 ? 0.17 : 0) + 0.000001, "only the thumb base may oppose; phalanges must not twist");
    }
  }
});

test("interruption and reduced motion restore the original finger poses", () => {
  const { group, rig } = realRig();
  const joints = fingerJoints(group);
  rig.gesture("wave", 0);
  for (let frame = 0; frame <= 90; frame++) rig.update(frame / 60, true);
  const raised = joints.map(({ bone }) => bone.quaternion.clone());
  rig.stopGesture(1.5);
  rig.update(1.5, true);
  joints.forEach(({ bone }, index) => assert.ok(bone.quaternion.clone().normalize().angleTo(raised[index].normalize()) < 0.000001));
  for (let frame = 91; frame <= 174; frame++) rig.update(frame / 60, true);
  joints.forEach(({ bone, rest }) => assert.deepEqual(bone.quaternion.toArray(), rest.toArray()));
  for (let index = 175; index <= 264; index++) rig.update(index / 60, true, 0.6);
  rig.update(4.5, false, 0.6);
  joints.forEach(({ bone, rest }) => assert.deepEqual(bone.quaternion.toArray(), rest.toArray()));
});

test("the earlier eleven-bone export still works without finger articulation", () => {
  const { group, rig } = realRig(false, false);
  let boneCount = 0;
  group.traverse(object => { if (object instanceof Bone) boneCount += 1; });
  assert.equal(boneCount, 11);
  assert.equal(group.getObjectByName("Indicador01D"), undefined);
  rig.gesture("wave", 0);
  for (let index = 0; index <= 90; index++) rig.update(index / 60, true, 0.6);
  assert.ok(group.getObjectByName("MaoD")!.getWorldPosition(new Vector3()).y > 1.5);
});


test("the connected left fingers keep their spacing while the other fingers remain expressive", () => {
  const { group, rig } = realRig();
  const joints = fingerJoints(group);
  const pairs = ["02", "03"].map((segment) => {
    const ring = group.getObjectByName(`Anelar${segment}E`)!;
    const little = group.getObjectByName(`Minimo${segment}E`)!;
    const distance = () => ring.getWorldPosition(new Vector3()).distanceTo(little.getWorldPosition(new Vector3()));
    return { distance, rest: distance() };
  });
  let greatestSeparationChange = 0;
  let independentMotion = false;
  const index = joints.find((joint) => joint.bone.name === "Indicador02E")!;
  const middle = joints.find((joint) => joint.bone.name === "Medio02E")!;
  for (let frame = 0; frame <= 900; frame++) {
    const now = frame / 60;
    if (frame === 120 || frame === 660) rig.gesture("wave", now);
    const level = now < 11 ? 0.45 + Math.sin(now * 4) * 0.18 : 0;
    rig.update(now, true, level);
    for (const pair of pairs) greatestSeparationChange = Math.max(greatestSeparationChange, Math.abs(pair.distance() - pair.rest));
    for (const joint of joints) {
      const position = joint.bone.getWorldPosition(new Vector3());
      assert.ok(position.toArray().every(Number.isFinite), `${joint.bone.name} must have a finite world position`);
    }
    if (Math.abs(jointAngles(index.bone, index.rest).x - jointAngles(middle.bone, middle.rest).x) > 0.025) independentMotion = true;
  }
  assert.ok(greatestSeparationChange < 0.006, `the skin bridge should not be pulled apart: ${greatestSeparationChange} m`);
  assert.ok(independentMotion, "index and middle should retain distinct poses");
});


test("successive frames stay smooth across phrase changes and an interrupted wave during speech", () => {
  const { group, rig } = realRig();
  const fingers = fingerJoints(group);
  const tracked = [
    ...fingers.map(({ bone }) => ({ bone, finger: true })),
    ...["BracoD", "AntebracoD", "MaoD", "BracoE", "AntebracoE", "MaoE"].map(name => ({ bone: group.getObjectByName(name) as Bone, finger: false })),
  ];
  const previous = new Map(tracked.map(({ bone }) => [bone.name, bone.quaternion.clone().normalize()]));
  const velocities = new Map<string, Vector3>();
  let fingerStep = 0;
  let fingerAcceleration = 0;
  let armStep = 0;
  let armAcceleration = 0;
  let abruptArm = "";
  rig.gesture("wave", 0);
  for (let frame = 0; frame <= 2160; frame++) {
    const now = frame / 120;
    if (frame === 174) rig.stopGesture(now);
    if (frame === 780) rig.gesture("wave", now);
    const pause = (now > 3.4 && now < 4.3) || (now > 10.2 && now < 11.1) || now > 16;
    rig.update(now, true, pause ? 0 : 0.42 + Math.sin(now * 3.7) * 0.13);
    for (const { bone, finger } of tracked) {
      const current = bone.quaternion.clone().normalize();
      const change = previous.get(bone.name)!.clone().invert().multiply(current).normalize();
      if (change.w < 0) change.set(-change.x, -change.y, -change.z, -change.w);
      const sine = Math.hypot(change.x, change.y, change.z);
      const angle = 2 * Math.atan2(sine, change.w);
      const step = sine > 0.0000001 ? new Vector3(change.x, change.y, change.z).multiplyScalar(angle / sine) : new Vector3();
      const acceleration = step.distanceTo(velocities.get(bone.name) ?? new Vector3());
      if (finger) {
        fingerStep = Math.max(fingerStep, angle);
        fingerAcceleration = Math.max(fingerAcceleration, acceleration);
      } else {
        armStep = Math.max(armStep, angle);
        if (acceleration > armAcceleration) abruptArm = `${bone.name} at ${now.toFixed(3)}s`;
        armAcceleration = Math.max(armAcceleration, acceleration);
      }
      previous.set(bone.name, current);
      velocities.set(bone.name, step);
    }
  }
  assert.ok(fingerStep < 0.018, `finger pose jumps between frames: ${fingerStep} radians`);
  assert.ok(fingerAcceleration < 0.003, `finger angular speed changes abruptly: ${fingerAcceleration} radians per frame`);
  assert.ok(armStep < 0.09, `arm or wrist snaps between frames: ${armStep} radians`);
  assert.ok(armAcceleration < 0.035, `arm or wrist angular speed changes abruptly: ${armAcceleration} radians per frame (${abruptArm})`);
});


test("dialogue opens the scanned fingers instead of adding a clenched grasp", () => {
  const { group, rig } = realRig();
  const joints = fingerJoints(group).filter(joint => joint.finger !== "Polegar");
  let extended = 0;
  for (let frame = 0; frame <= 720; frame++) {
    rig.update(frame / 60, true, 0.5);
    for (const { bone, rest } of joints) {
      const angle = jointAngles(bone, rest).x;
      assert.ok(angle < 0.055, `${bone.name} should not tighten the already curved scan into a grasp`);
      if (angle < -0.09) extended += 1;
    }
  }
  assert.ok(extended > 100, "the conversational hand should visibly open");
});

test("finger transition timing remains consistent at different render frequencies", () => {
  const simulate = (frequency: number) => {
    const { group, rig } = realRig();
    const joints = fingerJoints(group);
    rig.gesture("wave", 0);
    for (let frame = 0; frame <= frequency * 5; frame++) {
      const now = frame / frequency;
      if (frame === frequency * 2) rig.stopGesture(now);
      rig.update(now, true, now < 3 ? 0.5 : 0.35);
    }
    return joints.map(({ bone }) => bone.quaternion.clone().normalize());
  };
  const slow = simulate(30);
  const fast = simulate(120);
  slow.forEach((pose, index) => assert.ok(pose.angleTo(fast[index]) < 0.008, "finger pose should not depend on frame rate"));
});


// The browser loads the GLB through this loader too. Keeping its skinning in
// the regression catches disconnected weights and name/export mismatches that
// a synthetic skeleton cannot detect. Textures do not participate in skinning.
async function realSkinnedAvatar() {
  const path = process.env.AVATAR_RIG_ASSET || new URL("../../public/models/goncalves-dias.glb", import.meta.url);
  const data = readFileSync(path);
  const loader = new GLTFLoader();
  loader.register(() => ({ name: "TEST_SKIP_TEXTURE_IMAGES", loadTexture: async () => new Texture() }));
  const { scene } = await loader.parseAsync(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), "");
  scene.updateMatrixWorld(true);
  const rig = new AvatarRig(scene);
  const meshes: SkinnedMesh[] = [];
  scene.traverse(object => {
    if (object instanceof SkinnedMesh && !object.userData.avatarEye && !object.userData.avatarEyelid) meshes.push(object);
  });
  const tips: { name: string; hand: Bone; side: "D" | "E"; samples: { mesh: SkinnedMesh; index: number; weight: number }[] }[] = [];
  for (const side of ["D", "E"] as const) for (const finger of fingerNames) {
    const name = finger + "03" + side;
    const hand = scene.getObjectByName("Mao" + side)!;
    assert.ok(hand instanceof Bone, "the loaded GLB must contain the hand " + side);
    const candidates: { mesh: SkinnedMesh; index: number; weight: number }[] = [];
    for (const mesh of meshes) {
      const boneIndex = mesh.skeleton.bones.findIndex(bone => bone.name.replaceAll(".", "") === name);
      assert.ok(boneIndex >= 0, "the mesh skeleton must contain " + name);
      const indices = mesh.geometry.getAttribute("skinIndex");
      const weights = mesh.geometry.getAttribute("skinWeight");
      for (let index = 0; index < indices.count; index++) {
        let weight = 0;
        for (let slot = 0; slot < 4; slot++) {
          if (indices.getComponent(index, slot) === boneIndex) weight += weights.getComponent(index, slot);
        }
        if (weight > 0.7) candidates.push({ mesh, index, weight });
      }
    }
    assert.ok(candidates.length >= 4, name + " needs vertices controlled by its distal joint");
    candidates.sort((a, b) => b.weight - a.weight);
    const stride = Math.max(1, Math.floor(candidates.length / 16));
    const samples = candidates.filter((_, index) => index % stride === 0).slice(0, 16);
    tips.push({ name, hand, side, samples });
  }
  const read = () => {
    scene.updateMatrixWorld(true);
    for (const mesh of meshes) mesh.skeleton.update();
    return tips.map(tip => {
      const inverseHand = tip.hand.matrixWorld.clone().invert();
      const center = new Vector3();
      for (const sample of tip.samples) {
        center.add(sample.mesh.getVertexPosition(sample.index, new Vector3())
          .applyMatrix4(sample.mesh.matrixWorld).applyMatrix4(inverseHand));
      }
      return center.divideScalar(tip.samples.length);
    });
  };
  return { scene, rig, meshes, tips, read };
}

test("the actual GLB fingertips visibly articulate relative to each palm during quiet speech", async () => {
  const { rig, tips, read } = await realSkinnedAvatar();
  const centers: Vector3[][] = tips.map(() => []);
  let previous = read();
  let maxStep = 0;
  for (let frame = 0; frame <= 540; frame++) {
    const now = frame / 60;
    rig.update(now, true, 0.10 * (0.65 + 0.35 * Math.sin(now * 8) ** 2));
    const next = read();
    next.forEach((point, index) => {
      maxStep = Math.max(maxStep, point.distanceTo(previous[index]));
      if (frame > 60 && frame % 4 === 0) centers[index].push(point);
    });
    previous = next;
  }
  centers.forEach((positions, index) => {
    let travel = 0;
    for (let a = 0; a < positions.length; a++) for (let b = a + 1; b < positions.length; b++) {
      travel = Math.max(travel, positions[a].distanceTo(positions[b]));
    }
    assert.ok(travel > 0.014, tips[index].name + " must visibly articulate independently of the arm; travel=" + travel);
    assert.ok(travel < 0.065, tips[index].name + " must stay within a relaxed anatomical range; travel=" + travel);
  });
  assert.ok(maxStep < 0.0028, "the deformed fingertip surface must not snap: " + maxStep);
});

test("the actual waving fingertips keep a soft opening and relaxing motion while the palm is raised", async () => {
  const { rig, tips, read } = await realSkinnedAvatar();
  const centers: Vector3[][] = tips.map(() => []);
  rig.gesture("wave", 0);
  for (let frame = 0; frame <= 140; frame++) {
    rig.update(frame / 60, true, 0);
    const next = read();
    if (frame >= 78 && frame <= 132) next.forEach((point, index) => centers[index].push(point));
  }
  centers.forEach((positions, index) => {
    let travel = 0;
    for (let a = 0; a < positions.length; a++) for (let b = a + 1; b < positions.length; b++) {
      travel = Math.max(travel, positions[a].distanceTo(positions[b]));
    }
    if (tips[index].side === "D") {
      assert.ok(travel > 0.0015, tips[index].name + " must not freeze during the held wave; travel=" + travel);
      assert.ok(travel < 0.014, tips[index].name + " must not wiggle excessively during the wave; travel=" + travel);
    } else assert.ok(travel < 0.000001, "the opposite hand should stay at rest relative to its palm");
  });
});


test("opposition brings both real thumb surfaces toward their own palm despite mirrored bone axes", async () => {
  const { scene, rig, tips, read } = await realSkinnedAvatar();
  const thumbBones = (["D", "E"] as const).map(side => {
    const bone = scene.getObjectByName("Polegar01" + side) as Bone;
    return { side, bone, rest: bone.quaternion.clone() };
  });
  for (let frame = 0; frame <= 114; frame++) rig.update(frame / 60, true, 0.35);
  const opposed = read();
  const palmCenters = thumbBones.map(({ side }) => {
    const hand = scene.getObjectByName("Mao" + side)!;
    return scene.getObjectByName("Medio01" + side)!.getWorldPosition(new Vector3())
      .applyMatrix4(hand.matrixWorld.clone().invert());
  });
  for (const { side, bone, rest } of thumbBones) {
    const opposition = jointAngles(bone, rest).y;
    assert.ok((side === "D" ? opposition < -0.01 : opposition > 0.01),
      "the mirrored thumbs must rotate in their anatomically closing direction");
    // Opposition is the final local rotation, so undo just that axis while
    // retaining exactly the same arm, spread and flexion poses.
    bone.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -opposition));
  }
  const withoutOpposition = read();
  thumbBones.forEach(({ side }, index) => {
    const tipIndex = tips.findIndex(tip => tip.name === "Polegar03" + side);
    const closure = withoutOpposition[tipIndex].distanceTo(palmCenters[index])
      - opposed[tipIndex].distanceTo(palmCenters[index]);
    assert.ok(closure > 0.0002, "opposition must bring the deformed thumb toward its palm; closure=" + closure + " on " + side);
  });
});


test("dialogue transfers weight through the hips and knees while both feet stay planted", () => {
  const { group, rig } = realRig();
  const pelvis = group.getObjectByName("Quadril");
  assert.ok(pelvis instanceof Bone, "the current asset needs a weighted pelvis");
  const restPelvis = pelvis.position.clone();
  const legs = (["D", "E"] as const).map(side => {
    const thigh = group.getObjectByName("Coxa" + side)!;
    const shin = group.getObjectByName("Canela" + side)!;
    const foot = group.getObjectByName("Pe" + side)!;
    return { thigh, shin, foot, restShin: shin.quaternion.clone().normalize(),
      anchor: foot.getWorldPosition(new Vector3()), orientation: foot.getWorldQuaternion(new Quaternion()).normalize(),
      previousKnee: shin.getWorldPosition(new Vector3()),
      length: thigh.getWorldPosition(new Vector3()).distanceTo(shin.getWorldPosition(new Vector3())) };
  });
  let minShift = 0;
  let maxShift = 0;
  let maxKnee = 0;
  let maxKneeStep = 0;
  let maxStep = 0;
  const previous = pelvis.position.clone();
  for (let frame = 0; frame <= 1920; frame++) {
    const now = frame / 60;
    rig.update(now, true, 0.4 + Math.sin(now * 4) * 0.12);
    minShift = Math.min(minShift, pelvis.position.x - restPelvis.x);
    maxShift = Math.max(maxShift, pelvis.position.x - restPelvis.x);
    maxStep = Math.max(maxStep, pelvis.position.distanceTo(previous));
    previous.copy(pelvis.position);
    for (const leg of legs) {
      const foot = leg.foot.getWorldPosition(new Vector3());
      assert.ok(foot.distanceTo(leg.anchor) < 0.000002, "the planted ankle must not skate: " + foot.distanceTo(leg.anchor));
      assert.ok(leg.foot.getWorldQuaternion(new Quaternion()).normalize().angleTo(leg.orientation) < 0.000002, "heel and toe orientation must stay anchored");
      const length = leg.thigh.getWorldPosition(new Vector3()).distanceTo(leg.shin.getWorldPosition(new Vector3()));
      assert.ok(Math.abs(length - leg.length) < 0.000002, "the thigh must not stretch to reach the floor");
      maxKnee = Math.max(maxKnee, leg.shin.quaternion.clone().normalize().angleTo(leg.restShin));
      const kneePosition = leg.shin.getWorldPosition(new Vector3());
      maxKneeStep = Math.max(maxKneeStep, kneePosition.distanceTo(leg.previousKnee));
      leg.previousKnee.copy(kneePosition);
    }
  }
  assert.ok(minShift < -0.010 && maxShift > 0.009, "dialogue should settle over each leg across different phrases");
  assert.ok(maxKnee > 0.07 && maxKnee < 0.24, "knees should visibly soften without squatting: " + maxKnee);
  assert.ok(maxStep < 0.0006, "weight transfer must remain slow and smooth: " + maxStep);
  assert.ok(maxKneeStep < 0.0015, "the knee plane must not snap on the first IK frame or on a new stance: " + maxKneeStep);
});

test("the planted soles of the actual weighted GLB stay still while the trousers articulate", async () => {
  const { scene, rig, meshes } = await realSkinnedAvatar();
  const soles: { mesh: SkinnedMesh; index: number; rest: Vector3 }[] = [];
  const knees: { mesh: SkinnedMesh; index: number; rest: Vector3 }[] = [];
  const weighted = new Set<string>();
  for (const mesh of meshes) {
    const indices = mesh.geometry.getAttribute("skinIndex");
    const weights = mesh.geometry.getAttribute("skinWeight");
    for (let index = 0; index < indices.count; index++) {
      const point = mesh.getVertexPosition(index, new Vector3()).applyMatrix4(mesh.matrixWorld);
      for (let slot = 0; slot < 4; slot++) {
        const name = mesh.skeleton.bones[indices.getComponent(index, slot)].name.replaceAll(".", "");
        const weight = weights.getComponent(index, slot);
        if (/^(Coxa|Canela|Pe)[DE]$/.test(name) && weight > 0.4) weighted.add(name);
      }
      if (point.y < 0.055 && index % 11 === 0) soles.push({ mesh, index, rest: point });
      if (point.y > 0.43 && point.y < 0.57 && index % 29 === 0) knees.push({ mesh, index, rest: point });
    }
  }
  assert.equal(weighted.size, 6, "all six leg and foot joints must influence the visible mesh");
  assert.ok(soles.length > 30 && knees.length > 30, "sample the actual shoes and trouser knees");
  let soleDrift = 0;
  let kneeTravel = 0;
  for (let frame = 0; frame <= 360; frame++) {
    rig.update(frame / 60, true, 0.42);
    if (frame % 6) continue;
    scene.updateMatrixWorld(true);
    for (const mesh of meshes) mesh.skeleton.update();
    for (const sample of soles) soleDrift = Math.max(soleDrift,
      sample.mesh.getVertexPosition(sample.index, new Vector3()).applyMatrix4(sample.mesh.matrixWorld).distanceTo(sample.rest));
    for (const sample of knees) kneeTravel = Math.max(kneeTravel,
      sample.mesh.getVertexPosition(sample.index, new Vector3()).applyMatrix4(sample.mesh.matrixWorld).distanceTo(sample.rest));
  }
  assert.ok(soleDrift < 0.0002, "the actual shoe soles must not slide or levitate: " + soleDrift);
  assert.ok(kneeTravel > 0.018 && kneeTravel < 0.09, "the trousers must deform with the bending knees: " + kneeTravel);
});

test("foot planting follows the model coordinate system when the avatar is repositioned", () => {
  const { group, rig } = realRig();
  const feet = ["PeD", "PeE"].map(name => {
    const foot = group.getObjectByName(name)!;
    return { foot, anchor: foot.getWorldPosition(new Vector3()), orientation: foot.getWorldQuaternion(new Quaternion()).normalize() };
  });
  for (let frame = 0; frame <= 240; frame++) {
    if (frame === 120) {
      group.position.set(0.37, -0.04, 0.2);
      group.rotation.set(0.08, 0.45, -0.03);
      group.scale.setScalar(1.15);
    }
    rig.update(frame / 60, true, 0.45);
    for (const { foot, anchor, orientation } of feet) {
      assert.ok(foot.getWorldPosition(new Vector3()).distanceTo(group.localToWorld(anchor.clone())) < 0.000002);
      assert.ok(foot.getWorldQuaternion(new Quaternion()).normalize().angleTo(orientation.clone().premultiply(group.quaternion)) < 0.000002);
    }
  }
});

test("body motion settles after interruption and reduced motion restores bone positions too", () => {
  const active = realRig();
  const quiet = realRig();
  const bodyNames = ["Quadril", "Base", "Coluna", "Peito", "CoxaD", "CoxaE", "CanelaD", "CanelaE", "PeD", "PeE"];
  const rest = bodyNames.map(name => {
    const bone = active.group.getObjectByName(name)!;
    return { bone, position: bone.position.clone(), rotation: bone.quaternion.clone(), scale: bone.scale.clone() };
  });
  for (let frame = 0; frame <= 900; frame++) {
    const now = frame / 60;
    active.rig.update(now, true, now < 4 ? 0.45 : 0);
    quiet.rig.update(now, true, 0);
  }
  for (const name of bodyNames) {
    const activeBone = active.group.getObjectByName(name)!;
    const quietBone = quiet.group.getObjectByName(name)!;
    assert.ok(activeBone.position.distanceTo(quietBone.position) < 0.000001, "silence should restore " + name);
    assert.ok(activeBone.quaternion.clone().normalize().angleTo(quietBone.quaternion.clone().normalize()) < 0.000001, "silence should release " + name);
  }
  for (let frame = 901; frame <= 1080; frame++) active.rig.update(frame / 60, true, 0.6);
  active.rig.update(18.1, false, 0.6);
  for (const { bone, position, rotation, scale } of rest) {
    assert.deepEqual(bone.position.toArray(), position.toArray());
    assert.deepEqual(bone.quaternion.toArray(), rotation.toArray());
    assert.deepEqual(bone.scale.toArray(), scale.toArray());
  }
});

test("torso and support timing stay consistent at thirty and one hundred twenty frames per second", () => {
  const simulate = (frequency: number) => {
    const { group, rig } = realRig();
    for (let frame = 0; frame <= frequency * 22; frame++) rig.update(frame / frequency, true, 0.42);
    return ["Quadril", "Coluna", "Peito", "CoxaD", "CanelaD", "CoxaE", "CanelaE"].map(name => {
      const bone = group.getObjectByName(name)!;
      return { name, position: bone.position.clone(), rotation: bone.quaternion.clone().normalize() };
    });
  };
  const slow = simulate(30);
  const fast = simulate(120);
  slow.forEach((pose, index) => {
    assert.ok(pose.position.distanceTo(fast[index].position) < 0.0002, "position should be stable across frame rates: " + pose.name);
    assert.ok(pose.rotation.angleTo(fast[index].rotation) < 0.004, "rotation should be stable across frame rates: " + pose.name);
  });
});

test("the earlier forty-one-bone avatar still speaks and waves without leg joints", () => {
  const { group, rig } = realRig(true, false);
  assert.equal(group.getObjectByName("Quadril"), undefined);
  assert.equal(group.getObjectByName("CoxaD"), undefined);
  rig.gesture("wave", 0);
  for (let frame = 0; frame <= 90; frame++) rig.update(frame / 60, true, 0.5);
  assert.ok(group.getObjectByName("MaoD")!.getWorldPosition(new Vector3()).y > 1.5);
  assert.ok(group.getObjectByName("Indicador02D") instanceof Bone);
});


test("repeated timestamps do not accumulate pelvic displacement or knee rotations", () => {
  const { group, rig } = realRig();
  for (let frame = 0; frame <= 120; frame++) rig.update(frame / 60, true, 0.5);
  const original = ["Quadril", "CoxaD", "CanelaD", "CoxaE", "CanelaE"].map(name => {
    const bone = group.getObjectByName(name)!;
    return { bone, position: bone.position.clone(), quaternion: bone.quaternion.clone().normalize() };
  });
  for (let frame = 0; frame < 100; frame++) rig.update(2, true, 0.5);
  for (const { bone, position, quaternion } of original) {
    assert.ok(bone.position.distanceTo(position) < 0.000000001);
    assert.ok(bone.quaternion.clone().normalize().angleTo(quaternion) < 0.0000001);
  }
});

test("quiet presence moves the actual head, chest and fingers without shifting the shoe soles or opening the mouth", async () => {
  const { rig, meshes, tips, read } = await realSkinnedAvatar();
  const surface: { mesh: SkinnedMesh; index: number; region: string; rest: Vector3; previous: Vector3 }[] = [];
  for (const mesh of meshes) {
    const joints = mesh.geometry.getAttribute("skinIndex");
    const weights = mesh.geometry.getAttribute("skinWeight");
    for (let index = 0; index < joints.count; index += 17) {
      const rest = mesh.getVertexPosition(index, new Vector3()).applyMatrix4(mesh.matrixWorld);
      let region = rest.y < 0.055 ? "sole" : "";
      for (let slot = 0; slot < 4; slot++) {
        const name = mesh.skeleton.bones[joints.getComponent(index, slot)].name;
        if (weights.getComponent(index, slot) > 0.8 && (name === "Cabeca" || name === "Peito")) region = name;
      }
      if (region) surface.push({ mesh, index, region, rest, previous: rest.clone() });
    }
  }
  for (const region of ["sole", "Cabeca", "Peito"]) assert.ok(surface.filter(item => item.region === region).length > 20);
  const restTips = read();
  const tipTravel = tips.map(() => 0);
  const travel = { sole: 0, Cabeca: 0, Peito: 0 };
  let surfaceStep = 0;
  for (let frame = 0; frame <= 1350; frame++) {
    rig.update(frame / 30, true, 0);
    const positions = read();
    positions.forEach((point, index) => { tipTravel[index] = Math.max(tipTravel[index], point.distanceTo(restTips[index])); });
    for (const sample of surface) {
      const next = sample.mesh.getVertexPosition(sample.index, new Vector3()).applyMatrix4(sample.mesh.matrixWorld);
      const region = sample.region as keyof typeof travel;
      travel[region] = Math.max(travel[region], next.distanceTo(sample.rest));
      surfaceStep = Math.max(surfaceStep, next.distanceTo(sample.previous));
      sample.previous.copy(next);
    }
    for (const mesh of meshes) for (const [name, index] of Object.entries(mesh.morphTargetDictionary ?? {})) {
      if (/Boca|Labios/.test(name)) assert.equal(mesh.morphTargetInfluences![index], 0, "quiet presence must leave the mouth closed");
    }
  }
  assert.ok(travel.sole < 0.0002, "the idle avatar must not slide or lift either sole: " + travel.sole);
  assert.ok(travel.Cabeca > 0.004 && travel.Cabeca < 0.022, "the visible head needs restrained living movement: " + travel.Cabeca);
  assert.ok(travel.Peito > 0.002 && travel.Peito < 0.014, "breathing must deform the jacket gently: " + travel.Peito);
  assert.ok(surfaceStep < 0.001, "quiet surface motion must remain slow and continuous: " + surfaceStep);
  tipTravel.forEach((distance, index) => assert.ok(distance > (tips[index].name.startsWith("Polegar") ? 0.0004 : 0.0012) && distance < 0.007,
    "the resting hand should occasionally relax without fidgeting: " + tips[index].name + " travel=" + distance));
});

test("idle motion starts neutral at an arbitrary browser timestamp and resumes without a hidden-tab jump", () => {
  const late = realRig();
  const zero = realRig();
  const rest = new Map<string, { position: Vector3; quaternion: Quaternion; scale: Vector3 }>();
  late.group.traverse(bone => rest.set(bone.name, { position: bone.position.clone(), quaternion: bone.quaternion.clone().normalize(), scale: bone.scale.clone() }));
  late.rig.update(84751, true);
  late.group.traverse(bone => {
    const original = rest.get(bone.name)!;
    assert.ok(bone.position.distanceTo(original.position) < 0.00000001);
    assert.ok(bone.quaternion.clone().normalize().angleTo(original.quaternion) < 0.0000001);
    assert.ok(bone.scale.distanceTo(original.scale) < 0.00000001);
  });
  for (let frame = 0; frame <= 900; frame++) {
    late.rig.update(84751 + frame / 60, true);
    zero.rig.update(frame / 60, true);
  }
  const tracked = ["Cabeca", "Pescoco", "Peito", "BracoD", "Quadril", "MaoD", "MaoE", "Indicador02D"];
  tracked.forEach(name => {
    const a = late.group.getObjectByName(name)!;
    const b = zero.group.getObjectByName(name)!;
    assert.ok(a.position.distanceTo(b.position) < 0.0000001, "startup time must not change " + name);
    assert.ok(a.quaternion.clone().normalize().angleTo(b.quaternion.clone().normalize()) < 0.0000001, "startup time must not change " + name);
  });
  const before = tracked.map(name => {
    const bone = late.group.getObjectByName(name)!;
    return { bone, position: bone.position.clone(), quaternion: bone.quaternion.clone().normalize(), scale: bone.scale.clone() };
  });
  late.rig.update(90000, true);
  before.forEach(({ bone, position, quaternion, scale }) => {
    assert.ok(bone.position.distanceTo(position) < 0.00000001, "resuming must not jump " + bone.name);
    assert.ok(bone.quaternion.clone().normalize().angleTo(quaternion) < 0.0000001, "resuming must not jump " + bone.name);
    assert.ok(bone.scale.distanceTo(scale) < 0.00000001);
  });
  for (let frame = 1; frame <= 60; frame++) {
    late.rig.update(90000 + frame / 60, true);
    zero.rig.update(15 + frame / 60, true);
  }
  tracked.forEach(name => assert.ok(late.group.getObjectByName(name)!.quaternion.clone().normalize()
    .angleTo(zero.group.getObjectByName(name)!.quaternion.clone().normalize()) < 0.0000001,
  "resuming should continue the same local pose sequence: " + name));
});

test("reduced motion clears idle activity and reenabling begins gently without queued adjustments", () => {
  const { group, rig } = realRig();
  const rest = new Map<string, number[]>();
  group.traverse(bone => rest.set(bone.name, [...bone.position.toArray(), ...bone.quaternion.toArray(), ...bone.scale.toArray()]));
  for (let frame = 0; frame <= 720; frame++) rig.update(frame / 60, true);
  rig.update(12.1, false);
  rig.gesture("wave", 200);
  rig.update(201, false);
  group.traverse(bone => assert.deepEqual([...bone.position.toArray(), ...bone.quaternion.toArray(), ...bone.scale.toArray()], rest.get(bone.name)));
  const fresh = realRig();
  for (let frame = 0; frame <= 240; frame++) {
    rig.update(300 + frame / 60, true);
    fresh.rig.update(frame / 60, true);
  }
  for (const name of ["Cabeca", "Peito", "Quadril", "MaoD", "Indicador02D"]) {
    const actual = group.getObjectByName(name)!;
    const expected = fresh.group.getObjectByName(name)!;
    assert.ok(actual.quaternion.clone().normalize().angleTo(expected.quaternion.clone().normalize()) < 0.0000001);
    assert.ok(actual.position.distanceTo(expected.position) < 0.0000001);
  }
});

test("quiet pose timing stays consistent at thirty and one hundred twenty frames per second", () => {
  const simulate = (frequency: number) => {
    const { group, rig } = realRig();
    for (let frame = 0; frame <= frequency * 38; frame++) rig.update(frame / frequency, true);
    return ["Quadril", "Peito", "Cabeca", "Pescoco", "BracoD", "MaoD", "Indicador02D", "Polegar02E", "CanelaD"].map(name => {
      const bone = group.getObjectByName(name)!;
      return { name, position: bone.getWorldPosition(new Vector3()), quaternion: bone.quaternion.clone().normalize() };
    });
  };
  const slow = simulate(30);
  const fast = simulate(120);
  slow.forEach((pose, index) => {
    assert.ok(pose.position.distanceTo(fast[index].position) < 0.0001, "idle position should be stable across frame rates: " + pose.name);
    assert.ok(pose.quaternion.angleTo(fast[index].quaternion) < 0.0003, "idle timing should be stable across frame rates: " + pose.name);
  });
});

test("idle to dialogue and greeting transitions stay smooth and return to the same ongoing quiet pose", () => {
  const active = realRig();
  const quiet = realRig();
  const tracked = ["Cabeca", "Pescoco", "Peito", "Quadril", "MaoD", "MaoE", "Indicador02D", "Indicador02E"];
  let previous: Quaternion[] | null = null;
  let maximumStep = 0;
  let maximumAt = "";
  for (let frame = 0; frame <= 2400; frame++) {
    const now = frame / 60;
    if (frame === 1260) active.rig.gesture("wave", now);
    if (frame === 1360) active.rig.stopGesture(now);
    active.rig.update(now, true, now >= 12 && now < 24 ? 0.45 : 0);
    quiet.rig.update(now, true);
    const next = tracked.map(name => active.group.getObjectByName(name)!.quaternion.clone().normalize());
    if (previous) next.forEach((pose, index) => { const step = pose.angleTo(previous![index]); if (step > maximumStep) { maximumStep = step; maximumAt = tracked[index] + " at " + now; } });
    previous = next;
  }
  assert.ok(maximumStep < 0.14, "the animated joints must not snap when leaving or returning to idle: " + maximumStep + " " + maximumAt);
  tracked.forEach(name => {
    const activeBone = active.group.getObjectByName(name)!;
    const quietBone = quiet.group.getObjectByName(name)!;
    assert.ok(activeBone.position.distanceTo(quietBone.position) < 0.000001);
    assert.ok(activeBone.quaternion.clone().normalize().angleTo(quietBone.quaternion.clone().normalize()) < 0.000001,
      "speech and greeting should release into the continuing idle motion: " + name);
  });
});


const restHeadRotation = new Quaternion().fromArray(
  (JSON.parse(readFileSync(new URL("../../public/models/avatar-manifest.json", import.meta.url), "utf8")) as { bones: ExportedBone[] })
    .bones.find((bone) => bone.name === "Cabeca")!.rotation,
);

function headPitch(group: Group) {
  return jointAngles(group.getObjectByName("Cabeca") as Bone, restHeadRotation).x;
}

function nodPeaks(series: number[], fps: number) {
  const found: number[] = [];
  for (let index = 2; index < series.length - 2; index++) {
    const before = series.slice(Math.max(0, index - Math.round(fps * 0.35)), index);
    if (series[index] >= series[index - 1] && series[index] > series[index + 1] && series[index] - Math.min(...before) > 0.012) found.push(index / fps);
  }
  return found;
}

test("stressed syllables produce distinct chin-down nods while a flat voice level does not", () => {
  const fps = 120;
  const bursts = realRig();
  const flat = realRig();
  const quiet = realRig();
  const burstPitch: number[] = [];
  const flatPitch: number[] = [];
  for (let frame = 0; frame <= fps * 4.4; frame++) {
    const now = frame / fps;
    bursts.rig.update(now, true, now % 0.55 < 0.22 ? 0.75 : 0.18);
    flat.rig.update(now, true, 0.5);
    quiet.rig.update(now, true, 0);
    burstPitch.push(headPitch(bursts.group) - headPitch(quiet.group));
    flatPitch.push(headPitch(flat.group) - headPitch(quiet.group));
  }
  const burstNods = nodPeaks(burstPitch, fps);
  assert.ok(burstNods.length >= 4, "stressed syllables should nod the head: " + burstNods.join(", "));
  assert.ok(nodPeaks(flatPitch.slice(0, fps * 3), fps).length <= 1, "a constant level must not keep nodding");
  assert.ok(Math.max(...burstPitch) > 0.03 && Math.max(...burstPitch) < 0.08, "nods should stay restrained: " + Math.max(...burstPitch));
  for (const at of burstNods) {
    const sinceOnset = at % 0.55;
    assert.ok(sinceOnset > 0.05 && sinceOnset < 0.32, "each nod should follow a syllable onset: " + at);
  }
});

test("syllable beats keep the head consistent between thirty and one hundred twenty frames per second", () => {
  const simulate = (frequency: number) => {
    const { group, rig } = realRig();
    for (let frame = 0; frame <= frequency * 3; frame++) {
      const now = frame / frequency;
      rig.update(now, true, Math.round(now * 120) % 60 < 24 ? 0.7 : 0.15);
    }
    return group.getObjectByName("Cabeca")!.quaternion.clone().normalize();
  };
  assert.ok(simulate(30).angleTo(simulate(120)) < 0.004, "beat timing must not depend on the render frequency");
});

test("the head follows a glance slightly, reports where the face points, and releases exactly", () => {
  const glancing = realRig();
  const quiet = realRig();
  for (let frame = 0; frame <= 72; frame++) {
    glancing.rig.update(frame / 60, true, 0, { x: 0.6, y: 0.3 });
    quiet.rig.update(frame / 60, true, 0);
  }
  const yaw = glancing.rig.headOffset.yaw - quiet.rig.headOffset.yaw;
  assert.ok(yaw > 0.012 && yaw < 0.03, "the head should turn a little toward the glance: " + yaw);
  assert.ok(glancing.rig.headOffset.pitch - quiet.rig.headOffset.pitch < -0.002, "an upward glance should lift the face slightly");
  assert.ok(Math.abs(quiet.rig.headOffset.yaw) < 0.003 && Math.abs(quiet.rig.headOffset.pitch) < 0.003, "the quiet head stays near its rest direction");
  for (let frame = 73; frame <= 300; frame++) {
    glancing.rig.update(frame / 60, true, 0, { x: 0, y: 0 });
    quiet.rig.update(frame / 60, true, 0);
  }
  for (const name of ["Cabeca", "Pescoco"]) {
    assert.ok(glancing.group.getObjectByName(name)!.quaternion.clone().normalize()
      .angleTo(quiet.group.getObjectByName(name)!.quaternion.clone().normalize()) < 0.000001, "releasing the glance should restore " + name);
  }
  const nodding = realRig();
  nodding.rig.gesture("nod", 0);
  for (let frame = 0; frame <= 18; frame++) nodding.rig.update(frame / 60, true, 0);
  assert.ok(nodding.rig.headOffset.pitch > 0.03, "a nod must report the face turning downward: " + nodding.rig.headOffset.pitch);
});

test("a nod dips clearly, dips again more softly and never overshoots far above rest", () => {
  const { group, rig } = realRig();
  rig.gesture("nod", 0);
  let first = 0;
  let second = 0;
  let lift = 0;
  for (let frame = 0; frame <= 100; frame++) {
    const now = frame / 60;
    rig.update(now, true);
    const pitch = headPitch(group);
    if (now < 0.5) first = Math.max(first, pitch);
    else if (now < 1.0) second = Math.max(second, pitch);
    lift = Math.min(lift, pitch);
  }
  assert.ok(first > 0.045, "the first dip should be clear: " + first);
  assert.ok(second > first * 0.4 && second < first * 0.8, "the second dip should be softer: " + second + " after " + first);
  assert.ok(lift > -0.02, "the head should not swing far above rest: " + lift);
});

test("the greeting lifts the shoulder with the arm and the torso returns to the quiet pose", () => {
  const waving = realRig();
  const quiet = realRig();
  waving.rig.gesture("wave", 0);
  const difference = (name: string) => waving.group.getObjectByName(name)!.quaternion.clone().normalize()
    .angleTo(quiet.group.getObjectByName(name)!.quaternion.clone().normalize());
  let raised = 0;
  for (let frame = 0; frame <= 300; frame++) {
    waving.rig.update(frame / 60, true);
    quiet.rig.update(frame / 60, true);
    if (frame === 72) raised = difference("Peito");
  }
  assert.ok(raised > 0.015 && raised < 0.05, "the chest should tilt with the raised arm: " + raised);
  for (const name of ["Coluna", "Peito", "Cabeca"]) assert.ok(difference(name) < 0.000001, name + " should return to the quiet pose after the greeting");
});

test("invalid voice levels and glances never reach the bones, and reduced motion restarts the phrase sequence", () => {
  const { group, rig } = realRig();
  const finite = () => group.traverse((bone) => {
    assert.ok([...bone.position.toArray(), ...bone.quaternion.toArray(), ...bone.scale.toArray()].every(Number.isFinite), bone.name + " must stay finite");
  });
  for (let frame = 0; frame <= 120; frame++) {
    rig.update(frame / 60, true, frame % 3 === 0 ? NaN : frame % 3 === 1 ? Infinity : -Infinity, { x: NaN, y: Infinity });
    finite();
    assert.ok(Number.isFinite(rig.headOffset.yaw) && Number.isFinite(rig.headOffset.pitch));
  }
  rig.update(NaN, true, 0.5);
  rig.update(2.1, true, 0.5, { x: -Infinity, y: NaN });
  finite();
  // After several phrases, disabling motion resets the conversation so the
  // next speech starts from the first phrase attitude and placement again.
  const spoken = realRig();
  for (let frame = 0; frame <= 60 * 9; frame++) {
    const now = frame / 60;
    spoken.rig.update(now, true, now < 2.5 || (now > 3.4 && now < 5.9) || now > 6.8 ? 0.5 : 0);
  }
  spoken.rig.update(9.1, false, 0);
  const fresh = realRig();
  for (let frame = 0; frame <= 90; frame++) {
    spoken.rig.update(20 + frame / 60, true, 0.5);
    fresh.rig.update(frame / 60, true, 0.5);
  }
  for (const name of ["Cabeca", "AntebracoD", "MaoD", "Indicador02D"]) {
    assert.ok(spoken.group.getObjectByName(name)!.quaternion.clone().normalize()
      .angleTo(fresh.group.getObjectByName(name)!.quaternion.clone().normalize()) < 0.000001, "reenabled speech should restart like a fresh avatar: " + name);
  }
});

test("quiet waiting brings the forearms forward, transfers weight and takes a deeper breath, then returns", () => {
  const { group, rig } = realRig();
  const forearmDirection = () => new Vector3(0, 1, 0).applyQuaternion(group.getObjectByName("AntebracoD")!.getWorldQuaternion(new Quaternion()));
  const forearmRest = forearmDirection();
  const pelvis = group.getObjectByName("Quadril")!;
  const restShift = pelvis.position.x;
  const feet = ["PeD", "PeE"].map((name) => ({ foot: group.getObjectByName(name)!, anchor: group.getObjectByName(name)!.getWorldPosition(new Vector3()) }));
  const previousHand = group.getObjectByName("MaoD")!.getWorldPosition(new Vector3());
  let forearmPeak = 0;
  let forearmLater = 0;
  let shiftPeak = 0;
  let chestPeak = 0;
  let handStep = 0;
  for (let frame = 0; frame <= 30 * 100; frame++) {
    const now = frame / 30;
    rig.update(now, true, 0);
    const forearm = forearmDirection().angleTo(forearmRest);
    if (now >= 20 && now <= 36) forearmPeak = Math.max(forearmPeak, forearm);
    if (now >= 45 && now <= 48) forearmLater = Math.max(forearmLater, forearm);
    if (now >= 28 && now <= 44) shiftPeak = Math.max(shiftPeak, Math.abs(pelvis.position.x - restShift));
    if (now >= 40 && now <= 47) chestPeak = Math.max(chestPeak, group.getObjectByName("Peito")!.scale.y);
    for (const { foot, anchor } of feet) assert.ok(foot.getWorldPosition(new Vector3()).distanceTo(anchor) < 0.000002, "the shoes stay planted through every adjustment");
    const hand = group.getObjectByName("MaoD")!.getWorldPosition(new Vector3());
    handStep = Math.max(handStep, hand.distanceTo(previousHand));
    previousHand.copy(hand);
  }
  assert.ok(forearmPeak > 0.25 && forearmPeak < 0.5, "the forearms should rest visibly forward for a while: " + forearmPeak);
  assert.ok(forearmLater < 0.03, "the arms should return beside the coat afterwards: " + forearmLater);
  assert.ok(shiftPeak > 0.008 && shiftPeak < 0.02, "weight should transfer decidedly over one leg: " + shiftPeak);
  assert.ok(chestPeak > 1.004 && chestPeak < 1.008, "a deeper breath should lift the chest more than tidal breathing: " + chestPeak);
  assert.ok(handStep < 0.004, "quiet arm adjustments must stay slow: " + handStep + " m per frame");
});

test("listening tilts the head toward the visitor and acknowledges pauses in their voice", () => {
  const listening = realRig();
  const inattentive = realRig();
  const quiet = realRig();
  const fps = 60;
  const listeningPitch: number[] = [];
  const inattentivePitch: number[] = [];
  let listeningRoll = 0;
  let inattentiveRoll = 0;
  for (let frame = 0; frame <= fps * 10; frame++) {
    const now = frame / fps;
    // The visitor speaks for 1.5 s and pauses for 1 s, repeatedly.
    const level = now % 2.5 < 1.5 ? 0.4 : 0;
    listening.rig.update(now, true, 0, undefined, { mode: "listening", level });
    inattentive.rig.update(now, true, 0, undefined, { mode: "idle", level });
    quiet.rig.update(now, true, 0);
    listeningPitch.push(headPitch(listening.group) - headPitch(quiet.group));
    inattentivePitch.push(headPitch(inattentive.group) - headPitch(quiet.group));
    if (frame === fps * 3) {
      const roll = (group: Group) => jointAngles(group.getObjectByName("Cabeca") as Bone, restHeadRotation).z;
      listeningRoll = roll(listening.group) - roll(quiet.group);
      inattentiveRoll = roll(inattentive.group) - roll(quiet.group);
    }
  }
  const nods = nodPeaks(listeningPitch, fps);
  assert.ok(nods.length >= 3, "pauses in the visitor's voice should earn acknowledging nods: " + nods.join(", "));
  for (const at of nods) {
    const sincePause = (at % 2.5) - 1.5;
    assert.ok(sincePause > 0.35 && sincePause < 1.1, "each nod should follow a pause, not the speech itself: " + at);
  }
  assert.ok(Math.abs(listeningRoll) > 0.02 && Math.abs(listeningRoll) < 0.06, "listening should tilt the head: " + listeningRoll);
  assert.equal(nodPeaks(inattentivePitch, fps).length, 0, "the visitor level is ignored outside listening");
  assert.ok(Math.abs(inattentiveRoll) < 0.002, "idle attention adds no tilt");
});

test("thinking turns the face up and aside, and returns exactly when attention ends or motion is reduced", () => {
  const thinking = realRig();
  const quiet = realRig();
  for (let frame = 0; frame <= 180; frame++) {
    thinking.rig.update(frame / 60, true, 0, undefined, { mode: "thinking" });
    quiet.rig.update(frame / 60, true, 0);
  }
  const yaw = thinking.rig.headOffset.yaw - quiet.rig.headOffset.yaw;
  const pitch = thinking.rig.headOffset.pitch - quiet.rig.headOffset.pitch;
  assert.ok(Math.abs(yaw) > 0.02 && Math.abs(yaw) < 0.06, "thought should turn the face aside: " + yaw);
  assert.ok(pitch < -0.008, "thought should lift the face slightly: " + pitch);
  for (let frame = 181; frame <= 540; frame++) {
    thinking.rig.update(frame / 60, true, 0, undefined, { mode: "idle" });
    quiet.rig.update(frame / 60, true, 0);
  }
  for (const name of ["Cabeca", "Pescoco", "Peito"]) {
    assert.ok(thinking.group.getObjectByName(name)!.quaternion.clone().normalize()
      .angleTo(quiet.group.getObjectByName(name)!.quaternion.clone().normalize()) < 0.000001, "ending attention should release " + name);
  }
  const rest = new Map<string, number[]>();
  realRig().group.traverse((bone) => rest.set(bone.name, [...bone.position.toArray(), ...bone.quaternion.toArray(), ...bone.scale.toArray()]));
  for (let frame = 541; frame <= 660; frame++) thinking.rig.update(frame / 60, true, 0, undefined, { mode: "thinking" });
  thinking.rig.update(11.1, false, 0, undefined, { mode: "thinking" });
  thinking.group.traverse((bone) => assert.deepEqual([...bone.position.toArray(), ...bone.quaternion.toArray(), ...bone.scale.toArray()], rest.get(bone.name)));
});

test("successive phrases place the leading hand differently", () => {
  const { group, rig } = realRig();
  const forearm = () => new Vector3(0, 1, 0).applyQuaternion(group.getObjectByName("AntebracoD")!.getWorldQuaternion(new Quaternion()));
  let firstPhrase = new Vector3();
  let thirdPhrase = new Vector3();
  for (let frame = 0; frame <= 60 * 9.5; frame++) {
    const now = frame / 60;
    const speaking = now < 2.5 || (now > 3.4 && now < 5.9) || now > 6.8;
    rig.update(now, true, speaking ? 0.5 : 0);
    if (frame === 90) firstPhrase = forearm();
    if (frame === Math.round(8.3 * 60)) thirdPhrase = forearm();
  }
  assert.ok(firstPhrase.angleTo(thirdPhrase) > 0.02, "two right-leading phrases should not repeat the same forearm pose: " + firstPhrase.angleTo(thirdPhrase));
});