/**
 * Turns the Mixamo FBX exports in the repository root into the compact clips
 * the runtime plays. Everything expensive happens here: the FBX is decoded,
 * the motion is retargeted onto our skeleton, and what is written out is one
 * local rotation per bone per frame - so playback is a slerp and nothing more.
 *
 *   node work/build-mocap-clips.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Quaternion, Vector3 } from "three";
import { retarget, applyWorldTargets } from "./mocap-retarget.mjs";

const MANIFEST = "./public/models/avatar-manifest.json";
const OUT = "./public/models/clips";
const FPS = 30;
/**
 * Half-width, in frames, of the window the hips are averaged over before a
 * heading is taken from them, and of the difference that then reads it. Both
 * are a full stride - the walk runs at 40 frames per cycle - because the hips
 * sway sideways about as far between steps as they advance between frames. Read
 * over a short window the sway dominates the direction entirely: at six frames
 * the heading appeared to swing at up to 176 degrees a second, and taking that
 * out of the body did not remove a curve, it drove one into every bone. The
 * pelvis of the finished clip turned 41 degrees and the head 47, when a walking
 * head is the steadiest part of a person.
 */
const HEADING_SMOOTHING = 20;
const HEADING_WINDOW = 20;

const SOURCES = [
  {
    file: "../Talking.fbx", name: "fala-1", centreRoot: true,
    // A person talking while standing, looping cleanly (the last frame is the
    // first to 0.00 degrees). Its hips carry a real transfer of weight, 12 cm
    // from one leg to the other, which is kept: the rig lends the upper body
    // and hands this travel to the pelvis, whose legs the foot solver plants.
    rootMotion: "keep",
  },
  {
    file: "../Talking (1).fbx", name: "fala-2", centreRoot: true,
    // A second way of talking, so successive stretches of speech do not repeat.
    // Its head turns 35 degrees at the neck, past the budget, and is held to it.
    rootMotion: "keep",
  },
  {
    file: "../Shaking Hands 2.fbx", name: "cumprimento",
    // A greeting that steps forward and returns to where it started, so its own
    // root motion is kept: the feet stay on the floor and nothing drifts.
    rootMotion: "keep",
  },
  {
    file: "../Walk In Circle.fbx", name: "caminhada",
    // Walking is played in place - the navigation owns where the poet goes - so
    // the curve of the path is taken out and only the vertical bob survives.
    // What that costs is measurable: read in the frame of travel, the torso
    // leans sideways by 0.81 degrees on average. The walk is slow enough that
    // there is almost no centripetal lean to inherit, and the 3 degrees either
    // side of that is the ordinary sway of each step, which is kept.
    rootMotion: "inPlace",
  },
];

/**
 * How far a clip may bend each joint away from the rest pose, in degrees.
 *
 * A captured clip asks for angles this avatar has never been posed at. He is a
 * photogrammetry scan, and where two bones share a vertex the skin is a blend
 * of both: bend the joint far enough and that blend collapses inward - the
 * "candy wrapper". The numbers come from measuring it on this mesh rather than
 * from taste; work/mocap-skin-budget.mjs reads the weights out of the GLB, poses
 * the shared vertices and reports what they lose.
 *
 * Neck and head share 9286 vertices - the jaw, the chin, the base of the face,
 * a fifth of everything the head carries. The source clips bend that joint by
 * 52 degrees, at which the worst of those vertices caves in by 14 mm. That is
 * the face the poet was seen with. The procedural rig had never asked that
 * joint for more than 0.4 degrees, so nothing had ever shown it.
 *
 * The face and the chain that carries it are held to a loss of 1.2 mm, which is
 * nothing at conversation distance. The wrist, which a greeting puts in front
 * of the camera, is held to 4 mm. Shoulders, elbows, hips and knees are left
 * alone: they share few vertices or none, they are under clothing, and the
 * procedural walk has been bending the knee to 40 degrees all along.
 */
//   Cabeca 15   Pescoco>Cabeca: 9286 vertices shared, 1.2 mm at 15 degrees
//   Pescoco 15  Peito>Pescoco: 3178
//   Peito 12    Coluna>Peito: 3666
//   Coluna 12   Base>Coluna: 3802
//   Mao 39      Antebraco>Mao: 914, held to 4 mm
//
// The table itself lives in lib/avatar/bend-budget.json, read here and by the
// runtime rig, so the limit a clip is built to and the limit the rig enforces
// after every layer cannot drift apart.
const BEND_BUDGET = JSON.parse(readFileSync("./lib/avatar/bend-budget.json", "utf8"));

/**
 * Pulls every joint back inside its budget, parents before children, so a limb
 * below a joint that was held back travels with it instead of compensating.
 */
/** Records the largest bend each budgeted joint asks for; changes nothing. */
function measureBends(skeleton, restLocal, spent) {
  skeleton.traverse((bone) => {
    if (!bone.isBone || BEND_BUDGET[bone.name] === undefined) return;
    const rest = restLocal.get(bone.name);
    if (!rest) return;
    const bend = rest.clone().normalize().angleTo(bone.quaternion.clone().normalize()) * 180 / Math.PI;
    spent.set(bone.name, Math.max(spent.get(bone.name) ?? 0, bend));
  });
}

/**
 * Fits each budgeted joint inside its budget by scaling the whole of its motion,
 * not by cutting the peaks. A clip used to be clamped frame by frame, and a
 * clamped joint does not move: it sits on the limit while the rest of the body
 * carries on, then lets go at once. Measured, the talking clips held a wrist
 * there 45 percent of the time, the head 45, and the walk held the spine 72 -
 * joints frozen in the middle of living motion, which is what looked wrong.
 *
 * Scaled, every frame of a joint keeps its timing and its shape and only the
 * size changes, so nothing ever stops. The target is 95 percent of the budget,
 * leaving room for the breathing, gaze and nods laid on top; the rig still
 * holds the full budget as a last resort.
 */
function scaleToBudget(raw, names, frames, restLocal, asked) {
  const scales = new Map();
  const rest = new Quaternion(), pose = new Quaternion();
  names.forEach((name, index) => {
    const limit = BEND_BUDGET[name], largest = asked.get(name);
    if (limit === undefined || !largest || largest <= limit * BUDGET_HEADROOM) return;
    const scale = limit * BUDGET_HEADROOM / largest;
    scales.set(name, scale);
    rest.copy(restLocal.get(name)).normalize();
    for (let frame = 0; frame < frames; frame++) {
      const at = (frame * names.length + index) * 4;
      pose.set(raw[at], raw[at + 1], raw[at + 2], raw[at + 3]).normalize();
      const scaled = rest.clone().slerp(pose, scale);
      raw[at] = scaled.x; raw[at + 1] = scaled.y; raw[at + 2] = scaled.z; raw[at + 3] = scaled.w;
    }
  });
  return scales;
}

/** Share of the budget a clip is scaled to; see scaleToBudget(). */
const BUDGET_HEADROOM = 0.95;


/** Quaternion components live in [-1, 1]; int16 resolves them to 3e-5 rad. */
const quantise = (value) => Math.max(-32767, Math.min(32767, Math.round(value * 32767)));

/**
 * Where the poet is heading at each frame, read from the path rather than from
 * the hips. The hips yaw swings with every step, and that swing is real body
 * motion to be kept; only the heading of the journey is taken out.
 */
function pathHeading(hips) {
  // The clip closes on itself, so the window wraps rather than clamping and no
  // frame is read over a shorter span than any other.
  const at = (frame) => hips[((frame % hips.length) + hips.length) % hips.length];
  const smoothed = hips.map((_, frame) => {
    let x = 0, z = 0;
    for (let step = -HEADING_SMOOTHING; step <= HEADING_SMOOTHING; step++) {
      const point = at(frame + step); x += point.x; z += point.z;
    }
    const count = HEADING_SMOOTHING * 2 + 1;
    return { x: x / count, z: z / count };
  });
  const raw = smoothed.map((_, frame) => {
    const before = smoothed[((frame - HEADING_WINDOW) % smoothed.length + smoothed.length) % smoothed.length];
    const after = smoothed[(frame + HEADING_WINDOW) % smoothed.length];
    return Math.atan2(after.x - before.x, after.z - before.z);
  });
  const unwrapped = [raw[0]];
  for (let frame = 1; frame < raw.length; frame++) {
    let step = raw[frame] - raw[frame - 1];
    while (step > Math.PI) step -= 2 * Math.PI;
    while (step < -Math.PI) step += 2 * Math.PI;
    unwrapped.push(unwrapped[frame - 1] + step);
  }
  return unwrapped;
}

/**
 * A clip that loops has to end facing where it began. The path heading and the
 * poet's own heading do not turn by quite the same amount over a lap - here 345
 * against 360 degrees - and what is left over would twist him a little further
 * on every repeat. It is spread evenly across the clip instead: a thirtieth of
 * a degree per frame, which nothing can see, and the seam closes.
 */
function closeHeadingLoop(heading, residual) {
  const last = heading.length - 1;
  return heading.map((value, frame) => value + residual * (frame / last));
}

/**
 * Where each heel lands in an in-place walk, read from how far ahead one foot
 * is of the other: the right foot is furthest forward the instant its heel
 * strikes, the left the instant its own does. That separation is the standard
 * gait-event signal, and it is clean here - on "Walk In Circle" it gives 26
 * strikes, alternating without a slip, and the loop closes alternating too.
 *
 * The runtime uses these to play the upper body in step with legs it does not
 * drive. Anything irregular is refused rather than written: a strike map that
 * does not alternate would put the swinging arm on the wrong side of the body.
 */
function detectFootfalls(separation, fps) {
  const unique = separation.length - 1;   // the last frame repeats the first
  const at = (frame) => separation[((frame % unique) + unique) % unique];
  const WINDOW = 8, THRESHOLD = 0.05;
  const events = [];
  for (let frame = 0; frame < unique; frame++) {
    let highest = true, lowest = true;
    for (let offset = -WINDOW; offset <= WINDOW; offset++) {
      if (offset === 0) continue;
      if (at(frame + offset) > separation[frame]) highest = false;
      if (at(frame + offset) < separation[frame]) lowest = false;
    }
    if (highest && separation[frame] > THRESHOLD) events.push({ t: Math.round(frame / fps * 10000) / 10000, side: "D" });
    if (lowest && separation[frame] < -THRESHOLD) events.push({ t: Math.round(frame / fps * 10000) / 10000, side: "E" });
  }
  events.sort((a, b) => a.t - b.t);
  if (events.length < 4 || events.length % 2 !== 0) {
    throw new Error(`footfalls: ${events.length} strikes found; a looping walk needs an even number, at least four`);
  }
  for (let index = 0; index < events.length; index++) {
    if (events[index].side === events[(index + 1) % events.length].side) {
      throw new Error(`footfalls: two ${events[index].side} strikes in a row at ${events[index].t} s`);
    }
  }
  return events;
}

function build(source) {
  const work = retarget(source.file, MANIFEST);
  const { skeleton, names } = work;
  const frames = work.clip.frames;
  const inPlace = source.rootMotion === "inPlace";

  const offsets = [];
  for (let frame = 0; frame < frames; frame++) offsets.push(work.rootAt(frame / FPS));
  let heading = inPlace ? pathHeading(offsets) : offsets.map(() => 0);
  if (inPlace) {
    const hipsYaw = (frame) => {
      const rotation = work.worldTargetsAt(frame / FPS).get("Quadril");
      const forward = new Vector3(0, 0, 1).applyQuaternion(rotation);
      return Math.atan2(forward.x, forward.z);
    };
    let drift = (hipsYaw(frames - 1) - heading[frames - 1]) - (hipsYaw(0) - heading[0]);
    while (drift > Math.PI) drift -= 2 * Math.PI;
    while (drift < -Math.PI) drift += 2 * Math.PI;
    heading = closeHeadingLoop(heading, drift);
  }

  const rotations = new Int16Array(frames * names.length * 4);
  /** Full-precision local rotations, scaled to the budget before they are quantised. */
  const raw = new Float64Array(frames * names.length * 4);
  // A clip that should sway about where the poet stands has its hips centred
  // across the floor on their own average, so the transfer of weight swings
  // either side of the rest pose. Not in height: the actor lowered the hips
  // 1.5-2.4 cm while talking, softening the knees, and that slack is what lets
  // the hips travel 7 cm to one side with both feet still on the floor. Centred
  // in height as well, the far foot came 3.7 mm short of the ground.
  const centre = new Vector3();
  if (source.centreRoot) { for (const offset of offsets) centre.add(offset); centre.divideScalar(offsets.length); centre.y = 0; }
  const root = { x: [], y: [], z: [] };
  // How far the source had walked by each frame. Speed is not constant inside a
  // stride - it dips at every heel strike - so playing an in-place clip at a
  // constant rate slides the planted foot back and forth even at exactly the
  // right average speed. Runtime reads this to turn distance covered into clip
  // time, and the foot stays put.
  const covered = [];
  /** What each budgeted joint was asked for before being held back. */
  const asked = new Map();
  /** How far the right foot is ahead of the left, per frame; see detectFootfalls(). */
  const separation = [];
  let distance = 0;

  for (let frame = 0; frame < frames; frame++) {
    const targets = work.worldTargetsAt(frame / FPS);
    if (inPlace) {
      const straighten = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -heading[frame]);
      for (const [name, rotation] of targets) targets.set(name, straighten.clone().multiply(rotation));
    }
    applyWorldTargets(skeleton, targets);
    measureBends(skeleton, work.ourRestLocal, asked);
    if (inPlace) {
      // After straightening the walk heads along +Z, so this is how far the
      // right foot is ahead of the left.
      const right = skeleton.getObjectByName("Pe.D").getWorldPosition(new Vector3());
      const left = skeleton.getObjectByName("Pe.E").getWorldPosition(new Vector3());
      separation.push(right.z - left.z);
    }

    for (let index = 0; index < names.length; index++) {
      const local = skeleton.getObjectByName(names[index]).quaternion;
      const at = (frame * names.length + index) * 4;
      raw[at] = local.x; raw[at + 1] = local.y; raw[at + 2] = local.z; raw[at + 3] = local.w;
    }

    const offset = offsets[frame];
    root.x.push(inPlace ? 0 : offset.x - centre.x);
    root.y.push(offset.y - centre.y);
    root.z.push(inPlace ? 0 : offset.z - centre.z);
    if (frame > 0) distance += Math.hypot(offset.x - offsets[frame - 1].x, offset.z - offsets[frame - 1].z);
    covered.push(distance);
  }

  const scales = scaleToBudget(raw, names, frames, work.ourRestLocal, asked);
  for (let at = 0; at < raw.length; at++) rotations[at] = quantise(raw[at]);

  const round = (list) => list.map(value => Math.round(value * 10000) / 10000);
  const duration = (frames - 1) / FPS;
  return {
    name: source.name,
    source: source.file.replace("../", ""),
    fps: FPS,
    frames,
    duration: Math.round(duration * 10000) / 10000,
    rootMotion: source.rootMotion,
    // How far the poet actually walked while the clip played. In-place playback
    // reads this to advance the clip by distance covered instead of by time, so
    // the feet stay on the floor whatever speed the navigation chooses.
    travelled: Math.round(distance * 10000) / 10000,
    speed: Math.round(distance / duration * 10000) / 10000,
    bends: Object.fromEntries([...asked].map(([name, degrees]) =>
      [name, { asked: Math.round(degrees * 10) / 10, budget: BEND_BUDGET[name], scale: Math.round((scales.get(name) ?? 1) * 1000) / 1000 }])),
    bones: names,
    rotations: Buffer.from(rotations.buffer).toString("base64"),
    root: { x: round(root.x), y: round(root.y), z: round(root.z) },
    covered: inPlace ? round(covered) : undefined,
    footfalls: inPlace ? detectFootfalls(separation, FPS) : undefined,
  };
}

mkdirSync(OUT, { recursive: true });
const index = [];
for (const source of SOURCES) {
  const clip = build(source);
  const text = JSON.stringify(clip);
  writeFileSync(`${OUT}/${clip.name}.json`, text);
  index.push({ name: clip.name, source: clip.source, frames: clip.frames, duration: clip.duration,
    rootMotion: clip.rootMotion, travelled: clip.travelled, speed: clip.speed, bones: clip.bones.length,
    bytes: text.length });
  console.log(`${OUT}/${clip.name}.json  ${clip.frames} quadros  ${clip.duration}s  ${(text.length / 1024).toFixed(0)} KB`);
}
writeFileSync(`${OUT}/manifest.json`, JSON.stringify({
  revision: "mocap-4",
  generator: "work/build-mocap-clips.mjs",
  skeleton: "public/models/avatar-manifest.json",
  retarget: "world-space rotation delta measured from each rig's own rest pose",
  clips: index,
}, null, 2));
console.log(JSON.stringify(index, null, 2));
