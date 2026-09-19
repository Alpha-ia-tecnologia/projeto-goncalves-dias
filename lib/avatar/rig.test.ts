import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Bone, Group, Vector3 } from "three";
import { AvatarRig } from "./rig";

type ExportedBone = {
  name: string;
  translation: number[];
  rotation: number[];
  scale: number[];
  children: number[];
  nodeIndex: number;
};

function realRig() {
  const manifest = JSON.parse(readFileSync(new URL("../../public/models/avatar-manifest.json", import.meta.url), "utf8")) as { bones: ExportedBone[] };
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
  group.traverse((bone) => rest.set(bone.name, [...bone.quaternion.toArray(), ...bone.scale.toArray()]));
  rig.gesture("wave", 0);
  rig.update(1.4, true);
  rig.update(1.4, false);
  group.traverse((bone) => assert.deepEqual([...bone.quaternion.toArray(), ...bone.scale.toArray()], rest.get(bone.name)));
  rig.update(10, true);
  const once = group.getObjectByName("Cabeca")!.quaternion.clone();
  for (let index = 0; index < 200; index++) rig.update(10, true);
  assert.deepEqual(group.getObjectByName("Cabeca")!.quaternion.toArray(), once.toArray());
});

test("the wave returns both arms to their rest rotations after the gesture", () => {
  const { group, rig } = realRig();
  const armNames = ["BracoD", "AntebracoD", "MaoD", "BracoE", "AntebracoE", "MaoE"];
  const rotations = armNames.map((name) => group.getObjectByName(name)!.quaternion.clone());
  rig.gesture("wave", 5);
  rig.update(6.5, true);
  rig.update(8.3, true);
  armNames.forEach((name, index) => assert.deepEqual(group.getObjectByName(name)!.quaternion.toArray(), rotations[index].toArray()));
});
