// Moves a Mixamo clip onto our skeleton. The transfer is a world-space
// rotation delta measured from each rig's own rest pose, never a copy of local
// rotations: the two skeletons share proportions but not bone bases, and a
// local rotation means something different on each. Because the delta is
// measured in the world, a joint we do not have (clavicle, second spine link,
// toe) is not lost - its contribution already sits inside the world rotation
// of the bone below it.
import { Bone, Group, Matrix4, Quaternion, Vector3 } from "three";
import { readFileSync } from "node:fs";
import { extract } from "./mocap-extract.mjs";
import { BONE_MAP } from "./mocap-map.mjs";

/** Our avatar's rest skeleton, rebuilt from the exported manifest. */
export function restSkeleton(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const map = new Map();
  for (const data of manifest.bones) {
    const bone = new Bone(); bone.name = data.name;
    bone.position.fromArray(data.translation);
    bone.quaternion.fromArray(data.rotation);
    bone.scale.fromArray(data.scale);
    map.set(data.nodeIndex, bone);
  }
  for (const data of manifest.bones) for (const index of data.children) {
    const bone = map.get(index); if (bone) map.get(data.nodeIndex).add(bone);
  }
  const group = new Group();
  for (const bone of map.values()) if (!bone.parent) group.add(bone);
  group.updateMatrixWorld(true);
  return group;
}

const worldRotation = (matrix) => new Quaternion().setFromRotationMatrix(matrix);

export function retarget(fbxPath, manifestPath) {
  const clip = extract(fbxPath);
  const skeleton = restSkeleton(manifestPath);

  // Rest bases, one per rig.
  const theirRest = new Map(), ourRest = new Map(), ourRestLocal = new Map();
  for (const [theirs, ours] of Object.entries(BONE_MAP)) {
    const bindMatrix = clip.bind.get(theirs), bone = skeleton.getObjectByName(ours);
    if (!bindMatrix || !bone) continue;
    theirRest.set(ours, worldRotation(bindMatrix));
    ourRest.set(ours, bone.getWorldQuaternion(new Quaternion()));
    ourRestLocal.set(ours, bone.quaternion.clone());
  }
  const names = [...theirRest.keys()];

  /** World rotation each of our bones should hold at this time in the clip. */
  function worldTargetsAt(seconds) {
    const pose = clip.poseAt(seconds);
    const out = new Map();
    for (const [theirs, ours] of Object.entries(BONE_MAP)) {
      if (!theirRest.has(ours)) continue;
      const animated = worldRotation(pose.get(theirs));
      const delta = animated.clone().multiply(theirRest.get(ours).clone().invert());
      out.set(ours, delta.multiply(ourRest.get(ours)));
    }
    return out;
  }

  /** Hips travel in metres, relative to where the hips rest. */
  function rootAt(seconds) {
    const hips = clip.poseAt(seconds).get("mixamorig:Hips");
    const here = new Vector3().setFromMatrixPosition(hips);
    const rest = new Vector3().setFromMatrixPosition(clip.bind.get("mixamorig:Hips"));
    return here.sub(rest).multiplyScalar(0.01);
  }

  return { clip, skeleton, names, theirRest, ourRest, ourRestLocal, worldTargetsAt, rootAt };
}

/**
 * Drives our skeleton to a set of world rotations. Each bone is given the
 * local rotation that puts it where the target says, given where its parent
 * ended up - so the chain composes exactly, as it does at runtime.
 */
export function applyWorldTargets(skeleton, targets) {
  skeleton.updateMatrixWorld(true);
  skeleton.traverse(bone => {
    if (!bone.isBone) return;
    const target = targets.get(bone.name);
    if (!target) return;
    const parent = bone.parent.isBone ? bone.parent.getWorldQuaternion(new Quaternion()) : new Quaternion();
    bone.quaternion.copy(parent.invert().multiply(target));
    bone.updateMatrixWorld(true);
  });
  skeleton.updateMatrixWorld(true);
}

export { Matrix4, Quaternion, Vector3 };
