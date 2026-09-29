// Does the retarget actually reproduce the motion? Compares the direction of
// every bone - the vector from a joint to its child - between the Mixamo
// animation and our retargeted skeleton, frame by frame.
import { Vector3, Quaternion } from "three";
import { retarget, applyWorldTargets } from "./mocap-retarget.mjs";
import { BONE_MAP } from "./mocap-map.mjs";

const CHAINS = [
  ["mixamorig:RightArm", "mixamorig:RightForeArm"], ["mixamorig:RightForeArm", "mixamorig:RightHand"],
  ["mixamorig:LeftArm", "mixamorig:LeftForeArm"], ["mixamorig:LeftForeArm", "mixamorig:LeftHand"],
  ["mixamorig:Neck", "mixamorig:Head"], ["mixamorig:Spine", "mixamorig:Spine2"],
  ["mixamorig:RightUpLeg", "mixamorig:RightLeg"], ["mixamorig:RightLeg", "mixamorig:RightFoot"],
  ["mixamorig:LeftUpLeg", "mixamorig:LeftLeg"], ["mixamorig:LeftLeg", "mixamorig:LeftFoot"],
];

const path = process.argv[2];
const work = retarget(path, "./public/models/avatar-manifest.json");
const worst = new Map();
const frames = work.clip.frames;
for (let frame = 0; frame < frames; frame++) {
  const seconds = frame / 30;
  const pose = work.clip.poseAt(seconds);
  applyWorldTargets(work.skeleton, work.worldTargetsAt(seconds));
  for (const [from, to] of CHAINS) {
    const theirs = new Vector3().setFromMatrixPosition(pose.get(to))
      .sub(new Vector3().setFromMatrixPosition(pose.get(from))).normalize();
    const ourFrom = work.skeleton.getObjectByName(BONE_MAP[from]);
    const ourTo = work.skeleton.getObjectByName(BONE_MAP[to]);
    const ours = ourTo.getWorldPosition(new Vector3()).sub(ourFrom.getWorldPosition(new Vector3())).normalize();
    const degrees = Math.acos(Math.min(1, Math.max(-1, theirs.dot(ours)))) * 180 / Math.PI;
    const label = from.replace("mixamorig:", "") + "->" + to.replace("mixamorig:", "");
    const seen = worst.get(label) || { min: Infinity, max: 0 };
    worst.set(label, { min: Math.min(seen.min, degrees), max: Math.max(seen.max, degrees) });
  }
}
console.log(path.split(/[\/]/).pop(), "|", frames, "quadros | desvio de direcao em graus (min..max):");
for (const [label, span] of [...worst].sort((a, b) => b[1].max - a[1].max)) {
  console.log("  " + label.padEnd(28) + span.min.toFixed(2).padStart(6) + " .." + span.max.toFixed(2).padStart(7)
    + "   variacao " + (span.max - span.min).toExponential(1));
}
