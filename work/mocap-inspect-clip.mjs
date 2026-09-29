// Reads a built clip back and checks it against the skeleton it was made for.
import { readFileSync } from "node:fs";
import { Quaternion, Vector3 } from "three";
import { restSkeleton } from "./mocap-retarget.mjs";

const clip = JSON.parse(readFileSync(`./public/models/clips/${process.argv[2]}.json`, "utf8"));
const buffer = Buffer.from(clip.rotations, "base64");
const rotations = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
const skeleton = restSkeleton("./public/models/avatar-manifest.json");
const stride = clip.bones.length * 4;

const poseFrame = (frame) => {
  for (let index = 0; index < clip.bones.length; index++) {
    const at = frame * stride + index * 4;
    skeleton.getObjectByName(clip.bones[index]).quaternion.set(
      rotations[at] / 32767, rotations[at + 1] / 32767, rotations[at + 2] / 32767, rotations[at + 3] / 32767).normalize();
  }
  skeleton.position.set(clip.root.x[frame], clip.root.y[frame], clip.root.z[frame]);
  skeleton.updateMatrixWorld(true);
};

const yaws = [], feet = { "Pe.D": [], "Pe.E": [] };
for (let frame = 0; frame < clip.frames; frame++) {
  poseFrame(frame);
  const hips = skeleton.getObjectByName("Quadril");
  const forward = new Vector3(0, 0, 1).applyQuaternion(hips.getWorldQuaternion(new Quaternion()));
  yaws.push(Math.atan2(forward.x, forward.z) * 180 / Math.PI);
  for (const name of Object.keys(feet)) feet[name].push(skeleton.getObjectByName(name).getWorldPosition(new Vector3()));
}
let unwrapped = [yaws[0]];
for (let f = 1; f < yaws.length; f++) { let d = yaws[f] - yaws[f-1]; while (d > 180) d -= 360; while (d < -180) d += 360; unwrapped.push(unwrapped[f-1] + d); }
console.log(clip.name + ": " + clip.frames + " quadros, " + clip.bones.length + " ossos, raiz " + clip.rootMotion);
console.log("  guinada acumulada do quadril: " + (unwrapped[unwrapped.length-1] - unwrapped[0]).toFixed(1) + " graus  (faixa " + (Math.max(...unwrapped) - Math.min(...unwrapped)).toFixed(1) + ")");
const ys = clip.root.y;
console.log("  balanco vertical da raiz: " + ((Math.max(...ys) - Math.min(...ys)) * 100).toFixed(1) + " cm");
for (const [name, track] of Object.entries(feet)) {
  const h = track.map(p => p.y), floor = Math.min(...h);
  // while a foot is on the floor, how fast does it move? in place that is the
  // speed the ground must pass under it.
  const planted = track.map((p, f) => ({ p, f })).filter(({ f }) => h[f] < floor + 0.015);
  let slide = 0, samples = 0;
  for (let i = 1; i < planted.length; i++) {
    if (planted[i].f !== planted[i-1].f + 1) continue;
    slide += planted[i].p.clone().sub(planted[i-1].p).setY(0).length() * 30; samples++;
  }
  console.log("  " + name + ": altura " + (floor*100).toFixed(1) + ".." + (Math.max(...h)*100).toFixed(1)
    + " cm | apoiado em " + planted.length + " quadros | deslize medio do pe apoiado " + (samples ? (slide/samples).toFixed(3) : "-") + " m/s");
}
console.log("  velocidade natural do clipe: " + clip.speed + " m/s");
