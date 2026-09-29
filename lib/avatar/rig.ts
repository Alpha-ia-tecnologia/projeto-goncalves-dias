import { Bone, MathUtils, Object3D, Quaternion, Vector3 } from "three";
import { PlantedLegs } from "./planted-legs";
import type { MocapClip } from "./mocap";
import BEND_BUDGET from "./bend-budget.json";
import type { WalkingFrame } from "./walking";
import { sampleIdleMotion, type IdleMotion } from "./idle-motion";
import { AttentionTracker, type AttentionInput, type AttentionMode } from "./attention";

export type { AttentionInput, AttentionMode };

type RestBone = {
  bone: Bone;
  local: Quaternion;
  world: Quaternion;
  inverseWorld: Quaternion;
  direction: Vector3;
  scale: Vector3;
  position: Vector3;
};

/** The eyes' own glance, in facial morph units, before any head compensation. */
export type GazeInput = { x: number; y: number };
/** Head rotation away from the exported rest pose, in radians; pitch is positive downward. */
export type HeadOffset = { yaw: number; pitch: number };
type Beat = { at: number; strength: number; nod: number; tilt: number; hand: number };
type BeatSample = { nod: number; tilt: number; hand: number };
type WaveSample = {
  active: boolean; arm: number; forearm: number; hand: number; oscillation: number;
  /** Small offsets to the upper arm and forearm aims while the arm is held; see holdDrift(). */
  hold: [number, number, number]; holdForearm: [number, number, number];
};

const normalizeName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
const smooth = (start: number, end: number, value: number) => MathUtils.smootherstep(value, start, end);
const bounded = (value: number, limit: number) => Number.isFinite(value) ? MathUtils.clamp(value, -limit, limit) : 0;
/** A brief impulse with zero initial slope, a unit peak at `peakAt` and a soft release. */
const pulse = (elapsed: number, peakAt: number) => {
  if (!(elapsed > 0)) return 0;
  const phase = elapsed / peakAt;
  return phase >= 10 ? 0 : phase * phase * Math.exp(2 - 2 * phase);
};
const AXIS_X = new Vector3(1, 0, 0);
const AXIS_Y = new Vector3(0, 1, 0);
const AXIS_Z = new Vector3(0, 0, 1);
const CONVERSATION_DURATIONS = [3.2, 4.0, 3.65, 4.35];
// Successive phrases settle the head into different attitudes: yaw, pitch, roll.
const PHRASE_ATTITUDES: readonly (readonly [number, number, number])[] = [
  [0.022, 0.012, 0.006], [-0.018, 0.016, -0.004], [0.008, -0.005, 0.008],
  [-0.026, 0.009, 0.003], [0.014, 0.020, -0.007], [-0.006, 0.004, -0.009],
];
// Conversational hand placements: arm depth, forearm lift, hand outward angle, hand lift.
const HAND_PLACEMENTS: readonly (readonly [number, number, number, number])[] = [
  [0.28, 0.08, 0.12, 0.03], [0.31, 0.15, 0.16, 0.10], [0.25, 0.03, 0.09, -0.01],
  [0.30, 0.11, 0.20, 0.06], [0.27, 0.06, 0.07, 0.08],
];
const BEAT_REFRACTORY_SECONDS = 0.26;
const BEAT_PEAK_SECONDS = 0.13;
const FINGERS = ["Polegar", "Indicador", "Medio", "Anelar", "Minimo"] as const;
type HandSide = "D" | "E";
// Each hand with the sign of its outward direction in model space.
const HAND_SIDES: readonly (readonly [HandSide, number])[] = [["D", -1], ["E", 1]];

/** Procedural gestures preserve each exported rest transform; no baked mouth loop runs. */
/**
 * The swing of the palm during a wave, as a pure function of wave time. Shared
 * so the fingers can sample it slightly behind the palm: a real hand does not
 * hold its fingers rigid while the wrist swings, they trail it and flex a
 * little at each extreme. A waving hand is not a metronome either: the beat
 * eases off as the gesture settles and no two swings reach the same height.
 */
/**
 * A raised arm does not hold still. Its muscles hunt around the target they
 * were given, a few times a second, and a greeting arm that stays exactly put
 * reads as a joint rather than a limb: during the hold of the wave the upper
 * arm moved 0.006 degrees in all. Three rates that never line up, in the
 * 1.3-3 Hz band where that hunting lives, mixed differently on each axis.
 *
 * A pure function of the gesture's own time, so it is the same curve at any
 * frame rate, and scaled by the caller's envelope so it is exactly nothing
 * before the arm rises and after it falls.
 */
function holdDrift(waveTime: number, scale: number, phase: number, out: [number, number, number]) {
  const slow = Math.sin(2 * Math.PI * 1.37 * waveTime + phase);
  const middle = Math.sin(2 * Math.PI * 2.11 * waveTime + 1.7 + phase);
  const quick = Math.sin(2 * Math.PI * 2.83 * waveTime + 4.1 + phase);
  out[0] = (0.55 * slow + 0.30 * middle + 0.15 * quick) * scale;
  out[1] = (0.20 * slow + 0.50 * middle + 0.30 * quick) * scale;
  out[2] = (0.35 * slow + 0.20 * middle + 0.45 * quick) * scale;
}

function waveSwing(waveTime: number) {
  const beat = (waveTime - 0.82) * (1.06 - 0.12 * smooth(0.8, 2.6, waveTime));
  return Math.sin(beat * Math.PI * 2) * (1 - 0.13 * Math.sin(beat * Math.PI * 0.74))
    * smooth(0.8, 1.08, waveTime) * (1 - smooth(2.15, 2.65, waveTime));
}

type InertialPart = "pelvis" | "spine" | "chest" | "neck" | "head" | "arm" | "forearm" | "hand" | "finger";

/**
 * Natural frequency and damping ratio per body part. Damping below one is
 * what allows the small overshoot a real limb shows; heavier parts are slower
 * and better damped. The products damping x omega are all well above 2.7 per
 * second, so any difference from a rest pose decays below a millionth within
 * the four seconds the silence tests allow.
 */
type Dynamics = { omega: number; damping: number };

const INERTIA: Record<InertialPart, Dynamics> = {
  pelvis: { omega: 5.5, damping: 0.85 },
  spine: { omega: 7, damping: 0.8 },
  chest: { omega: 7.5, damping: 0.78 },
  // Muscle stiffness, not pendulum stiffness: a controlled limb answers a
  // command within a few tenths of a second. Well damped, so a head lags its
  // trunk without bobbing after every stressed syllable, and an arm settles
  // where it was sent instead of ringing there.
  neck: { omega: 14, damping: 0.82 },
  head: { omega: 16, damping: 0.82 },
  arm: { omega: 14, damping: 0.78 },
  forearm: { omega: 16, damping: 0.76 },
  hand: { omega: 18, damping: 0.74 },
  finger: { omega: 22, damping: 0.8 },
};

/**
 * Sites that are deliberate, quick movements rather than posture. A nod is a
 * neck muscle firing, not a mass settling, and the gaze follow is already
 * damped upstream; both pass through nearly unchanged, so a nod still lands
 * on the syllable that caused it. Everything else on the head keeps the
 * inertia of a head.
 */
/** Orphaned channels returning to rest after a gesture; see settleOrphans(). */
const SETTLE_INERTIA: Dynamics = { omega: 20, damping: 0.9 };

const TAG_INERTIA: Record<string, Dynamics> = {
  nod: { omega: 22, damping: 0.85 },
  gaze: { omega: 20, damping: 0.85 },
  // The slight trunk lean that accompanies a wave is voluntary and tiny; with
  // the slow dynamics of posture it would still be settling long after the
  // arm had come to rest, and an arm is aimed in world space, so any residual
  // in the trunk shows up in the arm.
  lean: { omega: 16, damping: 0.85 },
};

/** Null for the legs, which the planted-foot IK owns. */
function inertialPart(bone: string): InertialPart | null {
  if (bone === "Quadril") return "pelvis";
  if (bone === "Coluna") return "spine";
  if (bone === "Peito") return "chest";
  if (bone === "Pescoco") return "neck";
  if (bone === "Cabeca") return "head";
  if (bone.startsWith("Braco.")) return "arm";
  if (bone.startsWith("Antebraco.")) return "forearm";
  if (bone.startsWith("Mao.")) return "hand";
  if (/^(Polegar|Indicador|Medio|Anelar|Minimo)./.test(bone)) return "finger";
  return null;
}

/** Seconds a clip takes to take over the body, and to hand it back. */
const CLIP_FADE = 0.28;
/**
 * Size of the held arm's hunting, in the aim's direction units; see
 * holdDrift(). What the upper arm then covers during the hold of the wave,
 * after its spring: 0.47 degrees at 0.008, 0.77 at 0.010, 1.02 at 0.012 - the
 * middle of the 0.4 to 1.0 a held human arm shows, where it reads as a limb
 * and not as a tremor. The elbow's quick residue on screen stays at 0.16 px.
 */
const HOLD_DRIFT_ARM = 0.010;
const HOLD_DRIFT_FOREARM = 0.006;
/** The captured walk, brought in from the hips up while the navigation runs. */
const WALK_CLIP = "caminhada";
/**
 * Share of the captured walk's head turn that is taken back out; see
 * steadyHead(). Measured over a 30 s walk, the face's turn from the path:
 * 49.7 degrees with none taken out, 22.2 at 0.6, 17.6 at 0.7, 13.1 at 0.8.
 * Per stride the median is 3.8 degrees at 0.7, which is a head that steadies
 * itself as a walker's does; 0.8 starts to hold it still as a gyroscope would.
 */
const HEAD_STEADYING = 0.7;
/** Captured ways of talking, played in turn while the poet speaks; see chooseSpeechClip(). */
const SPEECH_CLIPS = ["fala-1", "fala-2"];
/** Seconds of silence a stretch of speech survives, bridging the gaps between words. */
const SPEECH_HOLD = 0.6;
/**
 * Everything the walk owns, which a clip may decline to drive: the legs, which
 * the planted-foot solver holds to the ground, and the pelvis itself, which is
 * the boundary. Leaving the pelvis out is not only tidy - straightening a
 * captured curve leaves a residue in the root and nowhere else, and it was
 * swinging the poet 24 degrees while he walked a straight line.
 *
 * An exact set, not a pattern. It used to be /^(Quadril$|Coxa.|Canela.|Pe.)/,
 * the escapes lost on the way into the file, and "Pe." - Pe followed by any
 * character - matched Peito and Pescoco as well as the feet. The captured walk
 * never reached the chest or the neck: they sat 4.4 degrees away from what the
 * clip asked of them, and a walk measured with and without the clip gave the
 * chest and neck the same numbers to the decimal. A name cannot match by
 * prefix here.
 */
const BELOW_THE_HIPS = new Set(["Quadril", "Coxa.D", "Coxa.E", "Canela.D", "Canela.E", "Pe.D", "Pe.E"]);

const axisKey = (axis: Vector3) => axis === AXIS_X ? "x" : axis === AXIS_Y ? "y" : axis === AXIS_Z ? "z" : "custom";

export class AvatarRig {
  private bones = new Map<string, RestBone>();
  private legs: PlantedLegs;
  private bodyOffset = new Vector3();
  private palmNormals = new Map<HandSide, Vector3>();
  private palmTurns = new Map<string, number>();
  private fingerSpreadDirections = new Map<string, number>();
  private thumbOppositionDirections = new Map<HandSide, number>();
  private motionChannels = new Map<string, { value: number; velocity: number }>();
  /** One under-damped spring per rotation site; see inertia(). */
  private inertialChannels = new Map<string, { value: number; velocity: number; target: number; frame: number }>();
  private frameStamp = 0;
  /** Last direction asked of each aim site, so an orphaned aim can decay along it. */
  private aimDirections = new Map<string, [number, number, number]>();
  /** How much of the walker owns the pelvis this frame; see inertia(). */
  private walkWeight = 0;
  /** Captured clips available to play, by name; see playClip(). */
  private clips = new Map<string, MocapClip>();
  private clip: MocapClip | null = null;
  private clipStarted = -Infinity;
  private clipLoops = false;
  /** How much of the pose comes from the clip this frame; see applyClip(). */
  private clipWeight = 0;
  private clipRoot = new Vector3();
  private clipOrigin: { x: number; z: number; travelled: number } | null = null;
  /** True when a clip lends only its upper body; see applyClip(). */
  private clipAboveTheHips = false;
  /** How far the clip alone turned the face from forward this frame; see steadyHead(). */
  private clipHeadYaw = 0;
  /** The moment in the clip laid on the bones this frame; see clipTime. */
  private clipSeconds = 0;
  /** Strikes added to the gait's count so clip and walker land the same foot; see clipTimeFor(). */
  private clipStepShift = 0;
  /** True while the clip in play is one of the captured ways of talking; see chooseSpeechClip(). */
  private clipSpeaking = false;
  /** Stretches of speech so far, to take the talking clips in turn. */
  private speechBouts = 0;
  /** How far into a stretch of speech the poet is; see update(). */
  private speechPresence = 0;
  private budgetScratch = new Quaternion();
  private budgetRest = new Quaternion();
  /** True on a frame after a hidden tab or a clock stepping back; see inertia(). */
  private gapFrame = false;
  /** True while settleOrphans runs: channels then use the settle profile. */
  private settling = false;
  private handWorld = new Quaternion();
  private handAxis = new Vector3();
  private palmDirection = new Vector3();
  private facingDirection = new Vector3();
  private normalCross = new Vector3();
  private swing = new Quaternion();
  private localDelta = new Quaternion();
  private targetRotation = new Quaternion();
  private parentInverse = new Quaternion();
  private headDelta = new Quaternion();
  private direction = new Vector3();
  private waveStarted = -Infinity;
  private nodStarted = -Infinity;
  private gestureStoppedAt = Infinity;
  private previousTime: number | null = null;
  private idleTime = 0;
  private speaking = 0;
  private emphasis = 0;
  private handActivity = 0;
  private conversationStarted = -Infinity;
  private conversationIndex = -1;
  private conversationStrength = 1;
  private lastVoiceAt = -Infinity;
  private levelSlow = 0;
  private previousLevel = 0;
  private beats: Beat[] = [];
  private beatCount = 0;
  private lastBeatAt = -Infinity;
  private beatSample: BeatSample = { nod: 0, tilt: 0, hand: 0 };
  private waveSample: WaveSample = { active: false, arm: 0, forearm: 0, hand: 0, oscillation: 0, hold: [0, 0, 0], holdForearm: [0, 0, 0] };
  private flicks: Record<HandSide, number> = { D: 0, E: 0 };
  private attitudeFrom = [0, 0, 0];
  private attitude = [0, 0, 0];
  private attitudeSwitchedAt = -Infinity;
  private headYaw = 0;
  private headPitch = 0;
  private headOffsetValue: HeadOffset = { yaw: 0, pitch: 0 };
  private attention = new AttentionTracker();
  private frameDelta = 0;
  // Bound once, so the attention tracker can use the rig's channels without per-frame closures.
  private dampAttention = (key: string, target: number, omega: number) => this.dampChannel(key, target, this.frameDelta, omega, 0, 1);
  private randomFor = (index: number, salt: number) => this.beatRandom(index, salt);

  constructor(private model: Object3D) {
    model.updateMatrixWorld(true);
    model.traverse((object) => {
      if (!(object instanceof Bone)) return;
      const world = object.getWorldQuaternion(new Quaternion());
      this.bones.set(normalizeName(object.name), {
        bone: object,
        local: object.quaternion.clone(),
        world,
        inverseWorld: world.clone().invert(),
        direction: new Vector3(0, 1, 0).applyQuaternion(world),
        scale: object.scale.clone(),
        position: object.position.clone(),
      });
    });
    this.legs = new PlantedLegs(model);
    // Finger bones are optional so earlier exports still load. In the finger
    // rig, local +X flexes into the palm and local +Z is the palmar normal.
    for (const side of ["D", "E"] as const) {
      const hand = this.get(`Mao.${side}`);
      const normal = new Vector3();
      let count = 0;
      for (const finger of FINGERS.slice(1)) {
        const base = this.get(`${finger}.01.${side}`);
        if (!base) continue;
        normal.add(AXIS_Z.clone().applyQuaternion(base.world));
        count += 1;
      }
      if (hand && count >= 3 && normal.lengthSq() > 0.1) {
        this.palmNormals.set(side, normal.normalize().applyQuaternion(hand.inverseWorld).normalize());
      }
      const middle = this.get(`Medio.01.${side}`)?.bone.getWorldPosition(new Vector3());
      if (middle) {
        const thumb = this.get("Polegar.01." + side);
        const thumbTip = this.get("Polegar.03." + side);
        if (thumb && thumbTip) {
          const tip = thumbTip.bone.getWorldPosition(new Vector3());
          const thumbRay = tip.clone().sub(thumb.bone.getWorldPosition(new Vector3()));
          const rotationDirection = AXIS_Y.clone().applyQuaternion(thumb.world).cross(thumbRay);
          // Mirrored thumbs need opposite local rotations to approach the palm.
          this.thumbOppositionDirections.set(side, Math.sign(rotationDirection.dot(middle.clone().sub(tip))));
        }
        for (const finger of FINGERS) {
          const name = `${finger}.01.${side}`;
          const base = this.get(name);
          if (!base) continue;
          const awayFromMiddle = base.bone.getWorldPosition(new Vector3()).sub(middle);
          // A positive Z rotation moves the finger's Y direction toward -X.
          // Derive the sign from actual anatomy rather than assuming a mirror.
          const openingDirection = AXIS_X.clone().applyQuaternion(base.world).negate();
          this.fingerSpreadDirections.set(normalizeName(name), Math.sign(openingDirection.dot(awayFromMiddle)));
        }
      }
    }
    for (const name of ["Braco.D", "Antebraco.D", "Mao.D", "Cabeca", "Peito"]) {
      if (!this.get(name)) throw new Error("O esqueleto do personagem está incompleto.");
    }
  }

  /** Where the face points relative to rest, so the eyes can keep contact with the visitor. The object is reused; read it within the frame. */
  get headOffset(): HeadOffset {
    this.headOffsetValue.yaw = this.headYaw;
    this.headOffsetValue.pitch = this.headPitch;
    return this.headOffsetValue;
  }

  /**
   * Hands the rig its library of captured clips. Until one is installed every
   * gesture is the procedural one, which is what every test that does not ask
   * for a clip continues to see.
   */
  setClips(clips: Map<string, MocapClip>) {
    this.clips = clips;
  }

  /**
   * Plays a captured clip over the procedural layers. The clip is not a pose
   * the rig interpolates toward - it replaces what the bones call rest for as
   * long as it runs, and breathing, gaze and the inertial layer keep working on
   * top of it. A clip already carries the inertia of the body it was captured
   * from, so it is not fed through the springs; smoothing real motion only
   * takes the life out of it.
   */
  playClip(name: string, now: number, options: { loop?: boolean; aboveTheHips?: boolean } = {}) {
    const clip = this.clips.get(name);
    if (!clip || !Number.isFinite(now)) return false;
    this.clip = clip;
    this.clipStarted = now;
    this.clipLoops = options.loop ?? false;
    this.clipAboveTheHips = options.aboveTheHips ?? false;
    this.clipSpeaking = false;
    this.clipOrigin = null;
    this.clipStepShift = 0;
    return true;
  }

  stopClip(now: number) {
    if (!this.clip || !Number.isFinite(now)) return;
    // Rewound to its last moments, so the same fade that ends a clip naturally
    // also ends an interrupted one.
    const remaining = this.clip.duration - (now - this.clipStarted);
    if (remaining > CLIP_FADE) this.clipStarted = now - (this.clip.duration - CLIP_FADE);
    this.clipLoops = false;
  }

  /** How much of the upper body a clip lending only that is carrying this frame. */
  private get capturedShare() {
    return this.clipAboveTheHips ? this.clipWeight : 0;
  }

  get clipPlaying() {
    return this.clipWeight > 0;
  }

  /**
   * The moment in the clip that was laid on the bones this frame, or null when
   * none was. Which moment to show and whether the body then follows it are
   * separate promises, and this lets each be checked on its own.
   */
  get clipTime() {
    return this.clipWeight > 0 ? this.clipSeconds : null;
  }

  gesture(kind: "wave" | "nod", now: number) {
    if (!Number.isFinite(now)) return;
    if (Number.isFinite(this.gestureStoppedAt)) {
      if (now - this.gestureStoppedAt < 0.55) return;
      this.waveStarted = this.nodStarted = -Infinity;
      this.gestureStoppedAt = Infinity;
    }
    // A second greeting must not snap an already raised arm back to its rest pose.
    if (kind === "wave" && now - this.waveStarted >= 3.25) {
      this.waveStarted = now;
      this.palmTurns.clear();
    }
    if (kind === "nod" && now - this.nodStarted >= 1.65) this.nodStarted = now;
  }

  stopGesture(now: number) {
    const active = (now >= this.waveStarted && now - this.waveStarted < 3.25)
      || (now >= this.nodStarted && now - this.nodStarted < 1.65);
    if (active && Number.isFinite(now) && !Number.isFinite(this.gestureStoppedAt)) this.gestureStoppedAt = now;
  }

  private get(name: string) {
    return this.bones.get(normalizeName(name));
  }

  /**
   * Lays the captured pose over the rest pose, before any procedural layer
   * runs. Each layer afterwards adds to what the clip left, so the poet still
   * breathes and still looks where he is looking while a clip plays.
   *
   * Which moment of the clip to show depends on who owns the feet; see
   * clipTimeFor().
   */
  private applyClip(now: number, walking?: WalkingFrame) {
    this.clipWeight = 0;
    this.chooseWalkClip(now, walking);
    this.chooseSpeechClip(now, walking);
    const clip = this.clip;
    if (!clip) return;
    const elapsed = now - this.clipStarted;
    if (elapsed < 0) return;
    if (!this.clipLoops && elapsed >= clip.duration) { this.clip = null; return; }
    // Eased in and out, so nothing starts or stops on a corner.
    // A clip lending its upper body to the walk comes and goes with the walk
    // itself. Faded on the clock instead, the fade began on whichever frame
    // first saw the walk - 8 ms in at 120 fps, 33 ms at 30 - and during the
    // fade the right hand sat 4.3 degrees apart at the two rates. The walker's
    // weight is integrated at a fixed 120 Hz, so this is the same at any rate.
    // The talking clip follows the stretch of speech, not the syllable. On the
    // voice envelope itself it fell halfway out of the posture in every 0.2 s
    // gap between words - a body pumping in and out of talking.
    const weight = this.clipSpeaking
      ? smooth(0, 1, this.speechPresence)
      : this.clipAboveTheHips
      ? smooth(0, 1, walking?.weight ?? 0)
      : smooth(0, CLIP_FADE, elapsed) * (this.clipLoops ? 1 : 1 - smooth(clip.duration - CLIP_FADE, clip.duration, elapsed));
    if (weight <= 0) return;
    this.clipWeight = weight;

    const seconds = this.clipTimeFor(clip, now, elapsed, walking);
    this.clipSeconds = seconds;
    clip.pose(seconds, (name, rotation) => {
      if (this.clipAboveTheHips && BELOW_THE_HIPS.has(name)) return;
      const rest = this.get(name);
      if (rest) rest.bone.quaternion.slerp(rotation, weight);
    });
    // A clip lending only its upper body leaves the ground to whatever owns the
    // legs, so it keeps neither its footfalls nor the rise and fall they carry.
    // Talking keeps its hips: their travel is a real transfer of weight, and the
    // pelvis carries it while the foot solver keeps the shoes planted.
    if (this.clipAboveTheHips && !this.clipSpeaking) this.clipRoot.set(0, 0, 0);
    else clip.rootAt(seconds, this.clipRoot);
    this.model.updateMatrixWorld(true);
    this.steadyHead(this.clipAboveTheHips ? weight * (walking?.weight ?? 0) : 0);
  }

  /**
   * A walking head is the steadiest part of a person, and the captured walk's
   * was not: the source walks in a circle and looks into the turn, and once
   * the chest and neck finally followed the clip the face swung 50 degrees
   * across a lap, against 3.6 for the procedural walk. What is taken out here
   * is only the turn the CLIP gave the head - measured right after the clip is
   * laid and before any procedural layer runs - so the gaze, which also turns
   * the head, keeps every degree it asks for.
   *
   * All of it goes on the head. Sharing it with the neck would pull the neck
   * off the capture it has only just been allowed to follow. It is applied to
   * the bone directly, not through a spring: it is a pure function of the pose
   * this frame, so it is the same at any frame rate, carries no state across a
   * hidden tab, and is exactly nothing once the clip has gone.
   */
  private steadyHead(weight: number) {
    this.clipHeadYaw = 0;
    const head = this.get("Cabeca");
    if (!head || weight <= 0) return;
    // The model sits at the origin facing its own forward while the rig runs
    // (the stage moves it along the path afterwards), so this is the face's
    // turn away from the direction of travel.
    head.bone.getWorldQuaternion(this.headDelta).multiply(head.inverseWorld);
    this.direction.copy(AXIS_Z).applyQuaternion(this.headDelta);
    this.clipHeadYaw = Math.atan2(this.direction.x, this.direction.z);
    this.swing.setFromAxisAngle(AXIS_Y, -HEAD_STEADYING * this.clipHeadYaw * weight);
    this.localDelta.copy(head.inverseWorld).multiply(this.swing).multiply(head.world);
    head.bone.quaternion.multiply(this.localDelta);
    this.model.updateMatrixWorld(true);
  }

  /**
   * The last word on how far any joint bends, after every layer has had its
   * say. Clips are built inside the bend budget, but the procedural layers add
   * to them afterwards - breathing, gaze, a nod - and the head of the captured
   * walk ended at 15.9 degrees against its 15, over skin that caves in past it.
   * Everything the procedural rig does on its own stays far inside: measured
   * across idle, speech, the wave, the nod, listening, thinking and walking,
   * the largest bend is the wave's hand at 29.7 of 39. So this touches nothing
   * but what a clip pushed out, and pulls it back along its own axis.
   */
  private holdBudget() {
    for (const name in BEND_BUDGET) {
      const rest = this.get(name);
      if (!rest) continue;
      const limit = BEND_BUDGET[name as keyof typeof BEND_BUDGET] * Math.PI / 180;
      // Both ends normalised. The rest pose comes from the exported manifest,
      // rounded on the way out, and is a hair off unit length: the angle from
      // the head's rest quaternion to ITSELF measures 0.00066 rad. Measured
      // against that, the head was held at 15.0000047 degrees instead of 15.
      this.budgetRest.copy(rest.local).normalize();
      this.budgetScratch.copy(rest.bone.quaternion).normalize();
      const bend = this.budgetRest.angleTo(this.budgetScratch);
      if (bend <= limit) continue;
      rest.bone.quaternion.copy(this.budgetRest).slerp(this.budgetScratch, limit / bend);
    }
  }

  /**
   * Walking brings in the captured walk on its own, and only from the hips up.
   * Measured over ten seconds of the navigation: the planted foot of the
   * procedural walk does not move at all, because the foot solver holds it
   * there, while the whole captured clip drags it 7 cm every second. Lending
   * only the upper body keeps both - the solver still owns the ground, and the
   * torso, arms and head carry five times the motion they did before.
   */
  private chooseWalkClip(now: number, walking?: WalkingFrame) {
    const walkClip = this.clips.get(WALK_CLIP);
    if (!walkClip) return;
    const gait = walking?.weight ?? 0;
    if (gait > 0 && this.clip !== walkClip) {
      this.clipSpeaking = false;
      this.clip = walkClip;
      this.clipStarted = now;
      this.clipLoops = true;
      this.clipAboveTheHips = true;
      this.clipOrigin = null;
      this.clipStepShift = 0;
    }
    // Standing still again. The clip's weight has already followed the walk's
    // down to nothing (see applyClip), so letting it go now cuts nothing.
    if (gait === 0 && this.clip === walkClip) this.clip = null;
  }

  /**
   * Speech brings in a captured way of talking, from the hips up, taking the
   * clips in turn so successive stretches of speech differ. Measured with the
   * recorded voice of the poet before this existed, the face travelled 15 px
   * across 18 s of speech at the conversation camera and nodded by 2, while
   * the hands swung 57: a still body and arms that moved alone, on procedural
   * beats that read as mechanical. Walking and the greeting come first.
   */
  private chooseSpeechClip(now: number, walking?: WalkingFrame) {
    const available = SPEECH_CLIPS.filter(name => this.clips.has(name));
    if (!available.length) return;
    const talking = this.clip !== null && this.clipSpeaking;
    if ((walking?.weight ?? 0) > 0 || (this.clip !== null && !talking)) return;
    if (this.speaking > 0 && !talking) {
      this.clip = this.clips.get(available[this.speechBouts % available.length])!;
      this.speechBouts += 1;
      this.clipStarted = now;
      this.clipLoops = true;
      this.clipAboveTheHips = true;
      this.clipSpeaking = true;
      this.clipOrigin = null;
      this.clipStepShift = 0;
    }
    // Out of speech. The clip has already followed the stretch down to nothing,
    // so letting it go now cuts nothing.
    if (this.speechPresence < 1e-4 && talking) {
      this.clip = null;
      this.clipSpeaking = false;
    }
  }

  /**
   * The moment of the clip to lay on the bones.
   *
   * A clip that keeps its own root plays on the clock. An in-place clip that
   * drives the whole body, feet included, plays by ground covered: speed is not
   * constant inside a stride, so at a steady rate the planted foot drags even
   * at exactly the right average speed.
   *
   * But the walk lends only its upper body, and the legs under it belong to
   * the walker. There the clip plays in step with THOSE legs: its own heel
   * strikes are matched to the walker's, foot for foot. By distance the arms
   * and trunk swung at 0.39 Hz over legs striding at 0.91, and stood frozen
   * through every turn on the spot, which covers no ground.
   */
  private clipTimeFor(clip: MocapClip, now: number, elapsed: number, walking?: WalkingFrame) {
    // Talking plays on the absolute clock: at a given instant it shows the same
    // moment at any frame rate, and each stretch of speech opens wherever the
    // loop happens to be, so no two begin alike.
    if (this.clipSpeaking) return now;
    if (!clip.inPlace) return elapsed;
    // No gait this frame (the walk is fading out and the stage stopped
    // reporting it): hold the last moment rather than jump to the clip's start.
    if (!walking) return this.clipSeconds;
    if (!this.clipAboveTheHips || !clip.hasFootfalls) return clip.timeForDistance(this.clipDistance(walking));
    // The clip's strike and the walker's must land on the same foot. The sides
    // alternate on both, so once matched they stay matched - unless the walker
    // steps one foot twice, which it can when squaring its feet. Across five
    // path shapes and 136 steps it never did; if it does, the count re-anchors
    // at once rather than leave the arm swinging with the leg on its own side.
    this.clipStepShift += clip.stepShiftFor(walking.stridePhase + this.clipStepShift, walking.landingSide);
    return clip.timeForStride(walking.stridePhase + this.clipStepShift);
  }

  /** Ground covered since an in-place clip began, in metres. */
  private clipDistance(walking?: WalkingFrame) {
    if (!walking) return 0;
    if (this.clipOrigin === null) this.clipOrigin = { x: walking.x, z: walking.z, travelled: 0 };
    this.clipOrigin.travelled += Math.hypot(walking.x - this.clipOrigin.x, walking.z - this.clipOrigin.z);
    this.clipOrigin.x = walking.x; this.clipOrigin.z = walking.z;
    return this.clipOrigin.travelled;
  }

  /**
   * The inertial layer. Every rotation the rig asks for is a target, and what
   * reaches the bone is the state of a damped spring chasing it: a limb that
   * is asked to move gathers speed, overshoots a little and settles, and each
   * link down a chain lags the one driving it. That is what separates a body
   * from a pose being interpolated. The dynamics differ by part: fingers are
   * light and quick, the pelvis heavy and slow. Legs are excluded because the
   * planted-foot IK owns them and a shoe that lags its target slides.
   *
   * A site name may carry a tag after a hash, as in "Cabeca#nod": the bone is
   * the part before it, the whole string keys the spring. Several sites drive
   * the same bone and axis in one frame (the head from posture, from gaze and
   * from a nod); each gets its own spring, and since the spring is linear the
   * sum of the smoothed parts equals the smoothed sum. Advancing one spring
   * twice in a frame would be wrong, so the frame stamp forbids it loudly.
   *
   * Closed form, so a frame of any length lands on the same curve, and a zero
   * frame (hidden tab, clock stepping back) leaves the pose exactly where it is.
   */
  private inertia(key: string, target: number, dynamics: Dynamics, minimum = -Infinity, maximum = Infinity, part: InertialPart | null = null) {
    let channel = this.inertialChannels.get(key);
    if (!channel) {
      // Born on target: a fresh avatar, or one whose motion was re-enabled,
      // starts from rest with no transient to replay.
      channel = { value: target, velocity: 0, target, frame: this.frameStamp };
      this.inertialChannels.set(key, channel);
      return target;
    }
    if (channel.frame === this.frameStamp) {
      throw new Error("inertial channel advanced twice in one frame: " + key);
    }
    channel.frame = this.frameStamp;
    if (this.gapFrame) {
      // Across a hidden tab, two things must both hold. Quiet presence pauses
      // its clock, so its targets are where they were: the spring keeps the
      // pose it was displaying, and resuming shows no jump. Gesture envelopes
      // run on the wall clock and jump to their later phase, as they always
      // did: a spring that glided after them would invent motion that never
      // happened, so it is seated on the target. The channel itself tells the
      // two apart: only a target that moved appreciably across the gap jumped.
      // A repeated timestamp is not a gap, and never reaches this branch.
      const jumped = part !== "pelvis" && Math.abs(target - channel.target) > 0.01;
      if (jumped) {
        channel.value = target;
        channel.velocity = 0;
      }
      channel.target = target;
      if (part === "pelvis") return MathUtils.lerp(channel.value, target, this.walkWeight);
      return MathUtils.clamp(channel.value, minimum, maximum);
    }
    const { omega, damping } = dynamics;
    const delta = this.frameDelta;
    if (delta > 0) {
      // First-order hold: the target is taken to have moved in a straight line
      // from its previous value to this one over the frame. A spring fed the
      // value only at frame ends sees a 30 fps target twelve milliseconds later
      // than a 120 fps one, and speech poses drift apart between the two; fed a
      // ramp, the closed form lands on the same curve at either rate. With no
      // motion of the target this reduces to the plain damped response.
      const slope = (target - channel.target) / delta;
      const lag = (2 * damping / omega) * slope;
      const difference = channel.value - channel.target + lag;   // from the particular solution at t = 0
      const relative = channel.velocity - slope;
      const damped = omega * Math.sqrt(1 - damping * damping);
      const decay = Math.exp(-damping * omega * delta);
      const cosine = Math.cos(damped * delta);
      const sine = Math.sin(damped * delta);
      const rate = (relative + damping * omega * difference) / damped;
      channel.value = target - lag + decay * (difference * cosine + rate * sine);
      channel.velocity = slope + decay * ((damped * rate - damping * omega * difference) * cosine
        - (damped * difference + damping * omega * rate) * sine);
    }
    channel.target = target;
    // A joint stop is inelastic: meeting the limit ends the motion there.
    if (channel.value <= minimum || channel.value >= maximum) {
      channel.value = MathUtils.clamp(channel.value, minimum, maximum);
      channel.velocity = 0;
    }
    // Once the residual is far below anything visible, settle exactly. The
    // repository promises exact returns to rest; physics only promises them
    // asymptotically, and this closes the gap without a visible trace.
    if (Math.abs(channel.value - target) < 1e-7 && Math.abs(channel.velocity) < 1e-6) {
      channel.value = target;
      channel.velocity = 0;
    }
    // While walking, the walker already gives the pelvis its dynamics and the
    // planted-foot IK needs that exact pose to reach the ankles: a pelvis that
    // lagged it would leave the shoes short of the floor. The spring keeps
    // tracking underneath, so the hand-over back to it when the walk ends is
    // continuous rather than a jump.
    if (part === "pelvis") return MathUtils.lerp(channel.value, target, this.walkWeight);
    return channel.value;
  }

  /**
   * Sites that run only while a gesture is active stop being called when it
   * ends, and would leave their springs holding a residual that vanishes from
   * the bone in a single frame: the interrupted wave used to snap the wrist at
   * the instant its envelope reached zero. So every channel not advanced this
   * frame is driven toward zero here and its residual applied, and the motion
   * decays the way it began. A channel that has settled to exactly zero is
   * dropped, so the map only ever holds what is still moving.
   */
  private settleOrphans() {
    // A limb whose gesture has ended is falling back to a supported rest, which
    // gravity and the shoulder damp faster than a controlled raise. The tail
    // after the envelope reached zero is a couple of degrees at most.
    this.settling = true;
    for (const [key, channel] of this.inertialChannels) {
      if (channel.frame === this.frameStamp) continue;
      const [kind, site, axisName] = key.split(":");
      const axis = axisName === "x" ? AXIS_X : axisName === "y" ? AXIS_Y : axisName === "z" ? AXIS_Z : null;
      if (kind === "A") {
        // The four channels of an aim site advance together, toward weight zero
        // along the last direction asked; the other three then skip as advanced.
        const direction = this.aimDirections.get(site);
        if (!direction) continue;
        this.aim(site, direction[0], direction[1], direction[2], 0);
        const blend = this.inertialChannels.get("A:" + site + ":w");
        if (blend && blend.value === 0 && blend.velocity === 0) {
          for (const suffix of ["x", "y", "z", "w"]) this.inertialChannels.delete("A:" + site + ":" + suffix);
          this.aimDirections.delete(site);
        }
        continue;
      }
      if (kind === "P" || !axis) continue;     // the pelvis runs every frame; custom axes cannot be rebuilt
      if (kind === "R") this.rotate(site, axis, 0);
      else this.rotateLocal(site, axis, 0);
      if (channel.value === 0 && channel.velocity === 0) this.inertialChannels.delete(key);
    }
    this.settling = false;
  }

  /** Dynamics for a site: a tag such as #nod may ask for its own profile. */
  private dynamicsFor(site: string, part: InertialPart) {
    if (this.settling) return SETTLE_INERTIA;
    const tag = site.split("#")[1];
    return (tag && TAG_INERTIA[tag]) || INERTIA[part];
  }

  private rotate(site: string, axis: Vector3, angle: number) {
    const name = site.split("#")[0];
    const rest = this.get(name);
    if (!rest) return;
    const part = inertialPart(name);
    const applied = part ? this.inertia("R:" + site + ":" + axisKey(axis), angle, this.dynamicsFor(site, part), -Infinity, Infinity, part) : angle;
    this.swing.setFromAxisAngle(axis, applied);
    this.localDelta.copy(rest.inverseWorld).multiply(this.swing).multiply(rest.world);
    rest.bone.quaternion.multiply(this.localDelta);
  }

  /**
   * Aims a limb at a direction, blended in by weight. This is how every arm
   * pose is made, so it is where the arms get their mass: the four scalars go
   * through the inertial layer, the direction (so a hand trails the swing of
   * a wave) and the weight (so a raise gathers speed, overshoots a little past
   * full and settles). The weight may run slightly outside 0..1: the slerp
   * then extrapolates, which is the arm passing its mark and coming back, and
   * the bounds act as joint stops.
   */
  private aim(site: string, x: number, y: number, z: number, weight: number) {
    const name = site.split("#")[0];
    const rest = this.get(name);
    if (!rest) return;
    const part = inertialPart(name);
    if (part) {
      const dynamics = this.dynamicsFor(site, part);
      this.aimDirections.set(site, [x, y, z]);
      x = this.inertia("A:" + site + ":x", x, dynamics, -Infinity, Infinity, part);
      y = this.inertia("A:" + site + ":y", y, dynamics, -Infinity, Infinity, part);
      z = this.inertia("A:" + site + ":z", z, dynamics, -Infinity, Infinity, part);
      weight = this.inertia("A:" + site + ":w", weight, dynamics, -0.08, 1.08, part);
    }
    this.direction.set(x, y, z).normalize();
    this.swing.setFromUnitVectors(rest.direction, this.direction);
    this.targetRotation.copy(this.swing).multiply(rest.world);
    if (rest.bone.parent) {
      rest.bone.parent.getWorldQuaternion(this.parentInverse).invert();
      this.targetRotation.premultiply(this.parentInverse);
    }
    rest.bone.quaternion.slerp(this.targetRotation, weight);
    rest.bone.updateWorldMatrix(false, true);
  }

  private rotateLocal(site: string, axis: Vector3, angle: number, minimum = -Infinity, maximum = Infinity) {
    const name = site.split("#")[0];
    const rest = this.get(name);
    if (!rest) return;
    const part = inertialPart(name);
    // The target respects the joint, and the spring inside inertia() treats the
    // limit as a stop: an overshoot meets it and ends there.
    const applied = part
      ? this.inertia("L:" + site + ":" + axisKey(axis), MathUtils.clamp(angle, minimum, maximum), this.dynamicsFor(site, part), minimum, maximum, part)
      : MathUtils.clamp(angle, minimum, maximum);
    this.swing.setFromAxisAngle(axis, applied);
    rest.bone.quaternion.multiply(this.swing);
  }

  private palmTurn(side: HandSide) {
    const hand = this.get(`Mao.${side}`);
    const normal = this.palmNormals.get(side);
    if (!hand || !normal) return 0;
    hand.bone.getWorldQuaternion(this.handWorld);
    this.handAxis.copy(AXIS_Y).applyQuaternion(this.handWorld).normalize();
    this.palmDirection.copy(normal).applyQuaternion(this.handWorld);
    this.palmDirection.addScaledVector(this.handAxis, -this.palmDirection.dot(this.handAxis));
    this.facingDirection.copy(AXIS_Z).addScaledVector(this.handAxis, -AXIS_Z.dot(this.handAxis));
    if (this.palmDirection.lengthSq() < 0.0001 || this.facingDirection.lengthSq() < 0.0001) return 0;
    this.palmDirection.normalize();
    this.facingDirection.normalize();
    return Math.atan2(
      this.normalCross.crossVectors(this.palmDirection, this.facingDirection).dot(this.handAxis),
      this.palmDirection.dot(this.facingDirection),
    );
  }

  private continuousPalmTurn(side: HandSide, part: "forearm" | "wrist") {
    const key = side + ":" + part;
    let angle = this.palmTurn(side);
    const previous = this.palmTurns.get(key);
    // atan2 wraps at +/-pi while a lowered hand turns away from the viewer.
    // Keep the same rotation branch until this wave has completely relaxed.
    if (previous !== undefined) angle += Math.round((previous - angle) / (Math.PI * 2)) * Math.PI * 2;
    this.palmTurns.set(key, angle);
    return angle;
  }

  private presentPalm(side: HandSide, weight: number) {
    if (!this.palmNormals.has(side) || weight <= 0) return;
    // Share pronation between forearm and wrist instead of twisting only the hand.
    const turn = this.continuousPalmTurn(side, "forearm");
    this.rotateLocal(`Antebraco.${side}`, AXIS_Y, 0.6 * Math.tanh(turn * 0.5 / 0.6) * weight);
    this.get(`Antebraco.${side}`)?.bone.updateWorldMatrix(false, true);
    this.rotateLocal(`Mao.${side}`, AXIS_Y, 0.82 * Math.tanh(this.continuousPalmTurn(side, "wrist") / 0.82) * weight);
    this.get(`Mao.${side}`)?.bone.updateWorldMatrix(false, true);
  }

  private dampChannel(key: string, target: number, delta: number, omega: number, minimum = -Infinity, maximum = Infinity, initial = 0) {
    let channel = this.motionChannels.get(key);
    if (!channel) {
      channel = { value: initial, velocity: 0 };
      this.motionChannels.set(key, channel);
    }
    // Closed-form critically damped motion keeps angular velocity continuous
    // when a new phrase changes its target pose or the leading hand switches.
    const difference = channel.value - target;
    const continuation = channel.velocity + omega * difference;
    const decay = Math.exp(-omega * delta);
    channel.value = target + (difference + continuation * delta) * decay;
    channel.velocity = (channel.velocity - omega * continuation * delta) * decay;
    if (channel.value < minimum || channel.value > maximum) {
      channel.value = MathUtils.clamp(channel.value, minimum, maximum);
      channel.velocity = 0;
    }
    if (Math.abs(channel.value - target) < 0.00001 && Math.abs(channel.velocity) < 0.0001) {
      channel.value = target;
      channel.velocity = 0;
    }
    return channel.value;
  }

  /** Exact first-order tracking with separate attack and release rates. */
  private follow(current: number, target: number, attack: number, release: number, delta: number) {
    return current + (target - current) * -Math.expm1(-delta * (target > current ? attack : release));
  }

  private beatRandom(index: number, salt: number) {
    // Deterministic per-beat variation, unrelated to the render frame rate.
    let value = (Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0;
    value = Math.imul(value ^ (value >>> 15), 0x2c1b3c6d) >>> 0;
    value = Math.imul(value ^ (value >>> 12), 0x297a2d39) >>> 0;
    return ((value ^ (value >>> 15)) >>> 0) / 0x100000000;
  }

  private registerBeat(now: number, strength: number) {
    const index = this.beatCount++;
    const kind = this.beatRandom(index, 1);
    // Most stressed syllables nod; some only tilt, and a few leave the head
    // still so the hands carry the rhythm alone. Nothing repeats identically.
    this.beats.push({
      at: now,
      strength,
      nod: kind < 0.62 ? 0.6 + this.beatRandom(index, 2) * 0.4 : kind < 0.78 ? 0.25 : 0,
      tilt: (this.beatRandom(index, 3) < 0.5 ? -1 : 1) * (kind >= 0.62 && kind < 0.78 ? 1 : 0.35),
      hand: this.beatRandom(index, 4) < 0.72 ? 0.7 + this.beatRandom(index, 5) * 0.3 : 0.3,
    });
    if (this.beats.length > 4) this.beats.shift();
    this.lastBeatAt = now;
  }

  private sampleBeats(now: number) {
    const sample = this.beatSample;
    sample.nod = sample.tilt = sample.hand = 0;
    for (const beat of this.beats) {
      const age = now - beat.at;
      const head = pulse(age, BEAT_PEAK_SECONDS) * beat.strength;
      sample.nod += head * beat.nod;
      sample.tilt += head * beat.tilt;
      sample.hand += pulse(age, 0.12) * beat.strength * beat.hand;
    }
    sample.nod = Math.min(sample.nod, 1.4);
    sample.tilt = MathUtils.clamp(sample.tilt, -1.4, 1.4);
    sample.hand = Math.min(sample.hand, 1.3);
    return sample;
  }

  private beginPhrase(now: number, level: number) {
    // Blend from the attitude the head actually holds, whatever phase the
    // previous phrase reached, into the new phrase's attitude.
    this.samplePhraseAttitude(now, this.attitudeFrom);
    this.conversationStarted = now;
    this.conversationIndex += 1;
    this.conversationStrength = 0.8 + smooth(0.04, 0.4, level) * 0.2;
    this.attitudeSwitchedAt = now;
  }

  private samplePhraseAttitude(now: number, out: number[]) {
    if (this.conversationIndex < 0) {
      out[0] = out[1] = out[2] = 0;
      return out;
    }
    const index = this.conversationIndex;
    const duration = CONVERSATION_DURATIONS[index % CONVERSATION_DURATIONS.length];
    const elapsed = now - this.conversationStarted;
    const primary = PHRASE_ATTITUDES[index % PHRASE_ATTITUDES.length];
    const secondary = PHRASE_ATTITUDES[(index + 3) % PHRASE_ATTITUDES.length];
    const settle = smooth(0, 0.55, now - this.attitudeSwitchedAt);
    // Longer phrases shift the head part way toward another attitude midway.
    const shift = smooth(duration * 0.52, duration * 0.52 + 0.75, elapsed) * 0.5;
    for (let axis = 0; axis < 3; axis++) {
      out[axis] = MathUtils.lerp(this.attitudeFrom[axis], MathUtils.lerp(primary[axis], secondary[axis], shift), settle);
    }
    return out;
  }

  private sampleWave(waveTime: number, gestureWeight: number) {
    const wave = this.waveSample;
    wave.active = waveTime >= 0 && waveTime < 3.25;
    if (!wave.active) {
      wave.arm = wave.forearm = wave.hand = wave.oscillation = 0;
      wave.hold.fill(0); wave.holdForearm.fill(0);
      return wave;
    }
    // Shoulder leads, then elbow and wrist; all ease back to the exact rest pose.
    wave.arm = smooth(0, 0.72, waveTime) * (1 - smooth(2.45, 3.25, waveTime)) * gestureWeight;
    wave.forearm = smooth(0.1, 0.88, waveTime) * (1 - smooth(2.38, 3.17, waveTime)) * gestureWeight;
    wave.hand = smooth(0.26, 0.99, waveTime) * (1 - smooth(2.3, 3.05, waveTime)) * gestureWeight;
    wave.oscillation = waveSwing(waveTime);
    holdDrift(waveTime, HOLD_DRIFT_ARM * wave.arm, 0, wave.hold);
    holdDrift(waveTime, HOLD_DRIFT_FOREARM * wave.forearm, 2.3, wave.holdForearm);
    return wave;
  }

  private articulateFinger(name: string, axis: "flex" | "spread" | "opposition", target: number, minimum: number, maximum: number, delta: number) {
    if (!this.get(name)) return;
    void delta;   // the spring inside rotateLocal reads the frame delta itself
    this.rotateLocal(name + "#" + axis, axis === "flex" ? AXIS_X : axis === "spread" ? AXIS_Z : AXIS_Y, target, minimum, maximum);
  }

  private poseFingers(side: HandSide, conversationWeight: number, waveWeight: number, waveTime: number, delta: number, idleRelax = 0, flick = 0) {
    const duration = CONVERSATION_DURATIONS[Math.max(0, this.conversationIndex) % CONVERSATION_DURATIONS.length];
    const beatTime = this.previousTime! - this.conversationStarted;
    const variant = Math.max(0, this.conversationIndex) % 3;
    const spreadScale = side === "E" ? 0.5 : 1;
    const spread = [0.14, 0.06, 0, 0.032, 0.05];
    // A phrase unfolds, gathers, then releases. The scan is already curled:
    // extension supplies most of the travel, with only a small extra flexion.
    // Deliberately different poses prevent the fingers moving as one rigid fan.
    const openingProfiles = [
      [1, 1, 0.91, 0.73, 0.64],
      [0.76, 0.48, 0.98, 0.87, 0.78],
      [0.90, 0.84, 0.63, 0.91, 0.83],
    ][variant];
    FINGERS.forEach((finger, index) => {
      // Ring and little fingers share skin in the left scan. Their timing,
      // spread and flexion must agree throughout the entire gesture.
      const coupledLeft = side === "E" && index >= 3;
      const motionIndex = coupledLeft ? 3.5 : index;
      const delay = motionIndex * 0.035;
      const opening = smooth(0.06 + delay, 0.91 + delay, beatTime)
        * (1 - smooth(duration - 1.06 + delay, duration - 0.13 + delay, beatTime));
      const gather = smooth(1.02 + delay, 1.55 + delay, beatTime)
        * (1 - smooth(1.73 + delay, 2.34 + delay, beatTime));
      const profile = coupledLeft ? (openingProfiles[3] + openingProfiles[4]) * 0.5 : openingProfiles[index];
      const openness = profile * opening * (1 - gather * (variant === 1 && index === 1 ? 0.62 : 0.34));
      const fingerWave = waveWeight * smooth(0.30 + delay, 0.87 + delay, waveTime);
      // The palm's two beats bring a small shared relaxation, delayed slightly
      // through the joints. Fingers stay open without freezing or fidgeting.
      const waveRelax = smooth(0.99 + delay, 1.35 + delay, waveTime)
        * (1 - smooth(1.42 + delay, 1.75 + delay, waveTime))
        + smooth(1.82 + delay, 2.13 + delay, waveTime)
        * (1 - smooth(2.22 + delay, 2.48 + delay, waveTime));
      // Sampled behind the palm, so the fingers follow the swing rather than
      // copy it. Outward swing opens them a touch, inward swing curls them.
      const swing = waveWeight > 0 ? waveSwing(waveTime - 0.03 - delay) : 0;
      const spreadFinger = coupledLeft ? "Anelar" : finger;
      const spreadSign = this.fingerSpreadDirections.get(normalizeName(spreadFinger + ".01." + side)) ?? 0;
      const spreadAmount = coupledLeft ? 0.004 : spread[index] * spreadScale;
      const speechSpread = spreadAmount * spreadSign * (0.15 + openness * 0.85);
      // Breathes around a slightly narrower base so the widest thumb spread
      // stays inside its joint limit at the peak of the outward stroke.
      const waveSpread = spreadAmount * spreadSign * (0.94 - waveRelax * 0.20 + swing * 0.06);
      this.articulateFinger(finger + ".01." + side, "spread",
        MathUtils.lerp(speechSpread * conversationWeight, waveSpread, fingerWave), -0.16, 0.16, delta);

      for (const [joint, segment] of [[0, "01"], [1, "02"], [2, "03"]] as const) {
        const thumb = index === 0;
        const jointDelay = delay + joint * 0.045;
        const unfolding = smooth(0.06 + jointDelay, 0.91 + jointDelay, beatTime)
          * (1 - smooth(duration - 1.06 + jointDelay, duration - 0.13 + jointDelay, beatTime));
        // A stressed syllable briefly opens the fingers a little further.
        const jointOpenness = Math.min(1, profile * unfolding * (1 - gather * (variant === 1 && index === 1 ? 0.62 : 0.34))
          + flick * (thumb ? 0.05 : 0.12));
        const relaxed = thumb ? [0.055, 0.15, 0.075][joint] : [0.027, 0.046, 0.02][joint];
        const extension = thumb ? [-0.12, 0.015, 0.009][joint] : [-0.15, -0.33, -0.16][joint];
        const idleAngle = (thumb ? [-0.026, 0.025, 0.014] : [-0.028, -0.052, -0.026])[joint] * idleRelax;
        const speechAngle = MathUtils.lerp(relaxed, extension, jointOpenness) * conversationWeight + idleAngle;
        // The swing breathes the fingers around the open pose: a touch more
        // open on the outward stroke, a touch curled on the inward one, about
        // ten millimetres at the tip of the longest finger. The amplitudes are
        // sized so that, even with the relaxation pulse at its peak and the
        // stroke inward, every joint stays clearly extended beyond the scanned
        // curl, and the outward stroke only just grazes the joint limit.
        const breathe = swing * (thumb ? [0, 0.015, 0.008] : [0.017, 0.027, 0.015])[joint];
        const waveAngle = (thumb
          ? [-0.115, 0.025 + waveRelax * 0.065, 0.012 + waveRelax * 0.035][joint]
          : [-0.155 + waveRelax * 0.045, -0.33 + waveRelax * 0.115, -0.165 + waveRelax * 0.062][joint]) - breathe;
        const minimum = thumb ? (joint === 0 ? -0.15 : 0) : [-0.17, -0.36, -0.18][joint];
        const maximum = thumb ? (joint === 0 ? 0.15 : 0.23) : [0.09, 0.14, 0.075][joint];
        const angle = MathUtils.lerp(speechAngle, waveAngle, fingerWave);
        this.articulateFinger(finger + "." + segment + "." + side, "flex", angle, minimum, maximum, delta);
      }
      if (index === 0) {
        // Opposition belongs at the thumb's base, not as a twist along each
        // phalanx. The other joints flex in sequence as the hand gathers.
        const speechOpposition = (0.025 + 0.105 * gather + 0.035 * opening) * conversationWeight;
        const opposed = MathUtils.lerp(speechOpposition, 0.025 + waveRelax * 0.045, fingerWave);
        this.articulateFinger(finger + ".01." + side, "opposition",
          opposed * (this.thumbOppositionDirections.get(side) ?? 0), -0.17, 0.17, delta);
      }
    });
  }

  /**
   * The trunk and the neck while the poet speaks.
   *
   * Measured before this existed: over twenty seconds of speech the forearm
   * swung 45 degrees and the spine 0.86. Gesturing arms on a body that does not
   * move is what reads as a puppet, and three things were missing.
   *
   * Speech is exhalation. The ribcage is full when a phrase begins and spent by
   * its end, refilling in the pause, and that slow fall is the largest thing a
   * talking trunk does. The rig had breathing, but only the quiet kind - a
   * third of a degree of it, keeping its own time regardless of the voice.
   *
   * Nothing scaled with the voice. Trunk weight was a flag, whether any sound
   * had arrived in the last 0.58 s, so a loud passage and a murmured one moved
   * the body identically - and measured identically, to the second decimal.
   *
   * And the neck was a rigid link: it carried a sixth of the trunk's turn, a
   * quarter of a degree, so the head sat on the chest as though bolted to it.
   * Here it gives back most of what the chest takes, which is what keeps a face
   * level over a moving body, and adds its own share of each stressed syllable.
   *
   * Everything is damped rather than read from the clock. Measured: the same
   * pose at 30 and at 120 frames per second to within 0.074 degrees, a jump of
   * 0.015 degrees on returning from a hidden tab, and eighteen seconds after
   * falling silent the poet stands within 0.006 degrees of one who never spoke.
   * The angles also stay well inside what this scan's skin takes, against the
   * budget work/mocap-skin-budget.mjs measures: the chest reaches 2.7 degrees
   * of its 12, the neck 1.6 of its 15.
   */
  private poseSpeechTrunk(now: number, delta: number) {
    const index = Math.max(0, this.conversationIndex);
    const duration = CONVERSATION_DURATIONS[index % CONVERSATION_DURATIONS.length];
    const elapsed = now - this.conversationStarted;
    // Yields to a captured way of talking, which carries its own breath and turn.
    const voice = this.speaking * (1 - this.capturedShare);
    const side = index % 2 === 0 ? -1 : 1;

    // Breath of the phrase: full at its start, spent by its end. Before the
    // first phrase there is no elapsed time to speak of and the chest simply
    // rests.
    const spent = Number.isFinite(elapsed) ? smooth(0.06, duration * 0.78, elapsed) : 1;
    // Louder speech spends more air, so the fall of the ribcage is deeper. The
    // trunk weight the rig had was a flag - any sound within 0.58 s - and
    // saturated at a level of 0.32, which is why a shouted passage and a
    // murmured one measured the same to the second decimal.
    const loudness = 0.55 + 0.45 * this.emphasis;
    const breath = this.dampChannel("speech-breath", (0.62 - spent) * voice * loudness, delta, 2.6);
    // Loudness again, a beat behind the head this time.
    const stress = this.dampChannel("speech-stress", this.emphasis * voice, delta, 7.2);
    // The trunk turns toward the listener within a phrase and unwinds between
    // phrases, alternating sides so successive phrases do not mirror.
    const open = Number.isFinite(elapsed) ? smooth(0.1, 1.2, elapsed) * (1 - smooth(duration - 0.9, duration + 0.2, elapsed)) : 0;
    const turn = this.dampChannel("speech-trunk-turn", side * open * voice * loudness, delta, 2.4);

    this.rotate("Coluna#fala", AXIS_X, breath * 0.016 + stress * 0.008);
    this.rotate("Peito#fala", AXIS_X, breath * 0.030 + stress * 0.013);
    this.rotate("Coluna#fala", AXIS_Y, turn * 0.018);
    this.rotate("Peito#fala", AXIS_Y, turn * 0.024);
    this.rotate("Coluna#fala", AXIS_Z, turn * -0.008);
    this.rotate("Peito#fala", AXIS_Z, turn * -0.012);
    // The neck returns most of the chest's pitch and turn, so the face keeps
    // looking where it was looking while the body under it works.
    this.rotate("Pescoco#fala", AXIS_X, -breath * 0.026 - stress * 0.010);
    this.rotate("Pescoco#fala", AXIS_Y, -turn * 0.020);
    this.rotate("Pescoco#fala", AXIS_Z, turn * 0.008);
  }

  private poseBody(now: number, delta: number, idle: IdleMotion, idleWeight: number, posture: number, walking?: WalkingFrame) {
    // Each stance lasts several phrases, with unequal offsets and holds.
    // Conversational weight shifts remain separate from the optional footstep layer.
    const stances = [
      [-0.013, -0.006, 0.0032], [0.011, 0.005, 0.0025],
      [-0.007, -0.003, -0.002], [0.014, 0.0065, -0.0015],
      [-0.010, -0.0045, -0.001], [0.004, 0.002, 0.002],
    ];
    const index = Math.max(0, this.conversationIndex);
    const stance = stances[Math.floor(index / 2) % stances.length];
    const active = now - this.lastVoiceAt < 0.58 ? 1 : 0;
    const walkWeight = walking?.weight ?? 0;
    const weight = this.dampChannel("body-activity", active, delta, 3.0, 0, 1) * (1 - walkWeight * 0.8);
    const duration = CONVERSATION_DURATIONS[index % CONVERSATION_DURATIONS.length];
    const elapsed = now - this.conversationStarted;
    const phrase = smooth(0.12, 1.35, elapsed) * (1 - smooth(duration - 1.03, duration + 0.12, elapsed));
    const side = index % 2 === 0 ? -1 : 1;
    // A stressed syllable reaches the trunk a beat after the head: a small
    // forward pulse and a dip at the pelvis, which the planted legs absorb.
    const pulse = this.dampChannel("body-pulse", this.emphasis * weight, delta, 9);
    // Within a phrase the weight also moves toward the leading side and back,
    // instead of holding one stance until the next phrase. Built like the turn
    // above, from the phrase envelope and the leading side through a damped
    // channel: that survives a beat landing a frame later at 30 fps than at
    // 120, and it restarts with the phrase sequence when motion is re-enabled,
    // exactly as a fresh avatar would. A clock-based sine could do neither.
    const speechShift = this.dampChannel("speech-shift", side * phrase * 0.004 * weight, delta, 3.2);
    const lean = this.dampChannel("body-lean", (-0.010 - phrase * 0.019) * weight, delta, 3.6) - pulse * 0.010 + (walking?.body.lean ?? 0);
    // The gait's shoulder counter-rotation yields to a captured walk, which
    // already turns the shoulders as a walker does; laid on top it would double.
    const gaitTwist = (walking?.body.twist ?? 0) * (1 - (this.clipAboveTheHips ? this.clipWeight : 0));
    const turn = this.dampChannel("body-turn", side * (0.005 + phrase * 0.023) * weight, delta, 3.2) + gaitTwist;
    // A quiet transfer of weight moves the pelvis decidedly over one leg,
    // softens the knees a little and leans the trunk the other way.
    const transfer = idle.transfer * idleWeight;
    const counterbalance = this.dampChannel("body-counterbalance", -stance[1] * weight, delta, 2.8) - idle.shift * posture * 0.36 - transfer * 0.0036 - speechShift * 0.36;
    const pelvis = this.get("Quadril");
    let plantFeet = false;
    if (pelvis && this.legs.available) {
      const sway = idle.sway * posture;
      const shift = this.dampChannel("pelvis-shift", stance[0] * weight, delta, 2.6) + idle.shift * posture + sway * 0.0021 + transfer * 0.010 + speechShift + (walking?.body.shift ?? 0);
      const settle = this.dampChannel("pelvis-settle", -0.0038 * weight, delta, 2.6) + idle.settle * posture - Math.abs(transfer) * 0.0025 - pulse * 0.0035 + (walking?.body.lift ?? 0);
      const forward = this.dampChannel("pelvis-forward", stance[2] * weight, delta, 2.6) + idle.depth * posture + idle.swayDepth * posture * 0.0014 + pulse * 0.0025;
      const roll = this.dampChannel("pelvis-roll", stance[1] * weight, delta, 2.6) + idle.shift * posture * 0.36 + sway * 0.0028 + transfer * 0.0036 + speechShift * 0.36 + (walking?.body.roll ?? 0);
      this.bodyOffset.set(
        this.inertia("P:shift", shift, INERTIA.pelvis, -Infinity, Infinity, "pelvis"),
        this.inertia("P:settle", settle, INERTIA.pelvis, -Infinity, Infinity, "pelvis"),
        this.inertia("P:forward", forward, INERTIA.pelvis, -Infinity, Infinity, "pelvis"),
      // A clip's own travel is real captured motion and goes on unsmoothed: run
      // through the pelvis spring it would lag, and the feet it was captured
      // with would leave the floor.
      ).addScaledVector(this.clipRoot, this.clipWeight);
      plantFeet = this.bodyOffset.lengthSq() > 0 || roll !== 0 || turn !== 0;
      // Offsets are expressed in model space; the scene may be translated,
      // rotated or uniformly scaled without detaching the planted shoes.
      this.bodyOffset.add(this.model.worldToLocal(pelvis.bone.getWorldPosition(new Vector3())));
      this.model.localToWorld(this.bodyOffset);
      if (pelvis.bone.parent) pelvis.bone.parent.worldToLocal(this.bodyOffset);
      pelvis.bone.position.copy(this.bodyOffset);
      this.rotate("Quadril", AXIS_Z, roll);
      this.rotate("Quadril", AXIS_Y, turn * -0.16);
    }
    this.rotate("Coluna#body", AXIS_X, lean * 0.42);
    this.rotate("Peito#body", AXIS_X, lean * 0.58);
    this.rotate("Coluna#body", AXIS_Y, turn * 0.42);
    this.rotate("Peito#body", AXIS_Y, turn * 0.58);
    this.rotate("Coluna#body", AXIS_Z, counterbalance * 0.65);
    this.rotate("Peito#body", AXIS_Z, counterbalance * 0.35);
    // The small neck correction lets the body accompany a phrase while
    // keeping the gaze comfortably directed toward the listener.
    this.rotate("Pescoco#body", AXIS_Y, -turn * 0.16);
    this.model.updateMatrixWorld(true);
    // A clip was captured with its feet on a floor and keeps them there; the
    // planted-foot solver would be pulling the same ankles toward a pose the
    // clip is not in, so it stands down while one plays.
    if ((plantFeet || walking) && (this.clipAboveTheHips || this.clipWeight < 0.5)) this.legs.update(walking?.feet);
  }

  private poseHead(now: number, delta: number, idle: IdleMotion, nodEnvelope: number, beats: BeatSample, gaze?: GazeInput) {
    const idleWeight = 1 - this.speaking;
    // Attentive listening and thinking hold the head stiller than idle waiting.
    const { listen, think, listenSide, thinkSide, backchannelAt } = this.attention;
    const headIdleWeight = idleWeight * (1 - nodEnvelope) * (1 - listen * 0.45 - think * 0.3);
    // Follow-through down the chain: the chest trails the swaying hips and the
    // head trails the chest. Driven from the postural sway only, so speech
    // gestures keep their exact envelopes.
    const chestFollow = idle.swayChest * idleWeight;
    const headFollow = idle.swayHead;
    const speechHeadWeight = 1 - nodEnvelope * 0.9;
    const voice = this.speaking * speechHeadWeight;
    const sigh = idle.sigh * idleWeight;
    // Speech settles the head into a phrase attitude, with a slight lean toward
    // the listener; stressed syllables add brief nods or tilts. The neck and
    // chest share each movement so the head never pivots alone.
    const attitude = this.samplePhraseAttitude(now, this.attitude);
    const yaw = attitude[0] * voice;
    const pitch = attitude[1] * voice + 0.008 * voice;
    const roll = attitude[2] * voice;
    const nod = beats.nod * speechHeadWeight;
    const tilt = beats.tilt * speechHeadWeight;
    // A phrase begins with a small catch breath that lifts the chest.
    const inhale = this.conversationIndex >= 0 ? pulse(now - this.conversationStarted, 0.3) * this.conversationStrength : 0;
    // Listening tilts and leans slightly toward the visitor, and a pause in
    // their voice earns a small acknowledging nod. Thinking turns the face a
    // little up and aside, in the direction the eyes avert. A deep breath
    // opens the chest, raises both shoulders and lifts the chin a touch.
    const ack = pulse(now - backchannelAt, 0.2) * 0.9 + pulse(now - backchannelAt - 0.42, 0.18) * 0.5;
    const listenTilt = listen * listenSide;
    const thinkTurn = think * thinkSide;
    this.rotate("Coluna#head", AXIS_X, -idle.breath * 0.0018 - sigh * 0.0032);
    this.rotate("Peito#head", AXIS_X, idle.breath * 0.0065 + sigh * 0.0117 - this.speaking * 0.005 - this.emphasis * 0.004 - inhale * 0.005 + nod * 0.003 + listen * 0.006);
    this.rotate("Peito#head", AXIS_Y, yaw * 0.12 + idle.yaw * idleWeight * 0.08 + chestFollow * 0.0022);
    this.rotate("Pescoco#head", AXIS_X, pitch * 0.25 + nod * 0.010 + ack * 0.008 - sigh * 0.003 - think * 0.004 + idle.pitch * headIdleWeight * 0.28);
    this.rotate("Pescoco#head", AXIS_Y, yaw * 0.26 + thinkTurn * 0.012 + idle.yaw * headIdleWeight * 0.24);
    this.rotate("Pescoco#head", AXIS_Z, listenTilt * 0.008);
    this.rotate("Cabeca#head", AXIS_X, pitch * 0.75 + nod * 0.030 + ack * 0.028 + listen * 0.010 - sigh * 0.008 - think * 0.012
      + this.emphasis * 0.006 * speechHeadWeight + idle.pitch * headIdleWeight * 0.72);
    this.rotate("Cabeca#head", AXIS_Y, yaw * 0.62 + tilt * 0.004 + thinkTurn * 0.022 + idle.yaw * headIdleWeight * 0.76);
    this.rotate("Cabeca#head", AXIS_Z, roll + tilt * 0.010 + listenTilt * 0.030 + thinkTurn * 0.010 + idle.roll * headIdleWeight + headFollow * headIdleWeight * 0.0040);
    const chest = this.get("Peito");
    if (chest) chest.bone.scale.y *= 1 + idle.breath * 0.0017 + sigh * 0.0034 + inhale * 0.0014;
    // Small shoulder rotations follow the breath, with different weights on
    // each side. The scanned jacket does not need synthetic shoulder bones.
    this.rotate("Braco.D", AXIS_Z, idle.breath * 0.0065 + sigh * 0.0117);
    this.rotate("Braco.E", AXIS_Z, -idle.breath * 0.0053 - sigh * 0.0095);
    if (gaze || this.motionChannels.has("gaze-yaw")) {
      // The head follows a glance slightly and late, as in a natural gaze
      // shift; the eyes then counter-rotate to keep the visitor in view.
      const followYaw = this.dampChannel("gaze-yaw", gaze ? bounded(gaze.x, 1) * 0.030 : 0, delta, 5);
      const followPitch = this.dampChannel("gaze-pitch", gaze ? bounded(gaze.y, 1) * 0.014 : 0, delta, 5);
      this.rotate("Pescoco#gaze", AXIS_Y, followYaw * 0.3);
      this.rotate("Cabeca#gaze", AXIS_Y, followYaw * 0.7);
      this.rotate("Pescoco#gaze", AXIS_X, -followPitch * 0.25);
      this.rotate("Cabeca#gaze", AXIS_X, -followPitch * 0.75);
    }
  }

  private poseNod(nodTime: number, nodEnvelope: number) {
    if (nodEnvelope <= 0) return;
    // An affirming nod: a clear dip, a smaller second dip and a slight lift
    // before settling, with a small tilt so the head never moves on one axis.
    const dip = 0.075 * pulse(nodTime, 0.24) + 0.040 * pulse(nodTime - 0.62, 0.22) - 0.010 * pulse(nodTime - 1.1, 0.25);
    this.rotate("Cabeca#nod", AXIS_X, dip * 0.8 * nodEnvelope);
    this.rotate("Pescoco#nod", AXIS_X, dip * 0.2 * nodEnvelope);
    this.rotate("Cabeca#nod", AXIS_Z, (0.008 * pulse(nodTime, 0.3) - 0.004 * pulse(nodTime - 0.62, 0.3)) * nodEnvelope);
  }

  private poseConversationArms(now: number, delta: number, beats: BeatSample, wave: WaveSample) {
    const index = Math.max(0, this.conversationIndex);
    const duration = CONVERSATION_DURATIONS[index % CONVERSATION_DURATIONS.length];
    const beatTime = now - this.conversationStarted;
    const beat = smooth(0, 1.12, beatTime) * (1 - smooth(duration - 1.12, duration, beatTime));
    const shape = this.dampChannel("conversation-shape", beat, delta, 12, 0, 1);
    const placement = HAND_PLACEMENTS[index % HAND_PLACEMENTS.length];
    const leadingRight = this.conversationIndex % 2 === 0;
    const flicks = this.flicks;
    flicks.D = flicks.E = 0;
    for (const [side, sign] of HAND_SIDES) {
      const leading = side === "D" ? leadingRight : !leadingRight;
      const desiredStrength = this.handActivity * (0.20 + beat * (leading ? 0.54 : 0.22) * this.conversationStrength);
      const strength = this.dampChannel(`conversation-${side}`, desiredStrength, delta, 12, 0, 1);
      // Each phrase settles the hands into a slightly different placement.
      const depth = this.dampChannel(`placement-${side}-depth`, placement[0], delta, 5, -Infinity, Infinity, placement[0]);
      const lift = this.dampChannel(`placement-${side}-lift`, placement[1], delta, 5, -Infinity, Infinity, placement[1]);
      const outward = this.dampChannel(`placement-${side}-out`, placement[2], delta, 5, -Infinity, Infinity, placement[2]);
      const handLift = this.dampChannel(`placement-${side}-hand`, placement[3], delta, 5, -Infinity, Infinity, placement[3]);
      if (strength === 0) continue;
      // The leading hand marks stressed syllables with a short downward
      // stroke of the wrist. The greeting keeps priority over the right hand.
      const flick = beats.hand * (leading ? 1 : 0.3) * (side === "D" ? 1 - wave.hand : 1) * strength;
      flicks[side] = flick;
      // Elbows stay beside the jacket. Forearms and fingers unfold in front
      // of the torso, below the face, using only the exported arm bones.
      // A captured way of talking gestures for itself; these hands yield to it
      // in proportion, as the gait's arms yield to the captured walk.
      const own = strength * (1 - this.capturedShare);
      this.aim(`Braco.${side}#talk`, sign * 0.19, -0.95, depth, own * 0.86);
      this.aim(`Antebraco.${side}#talk`, -sign * 0.055, lift + shape * 0.10 - flick * 0.05, 0.98, own);
      this.aim(`Mao.${side}#talk`, sign * (outward + shape * 0.10), handLift + shape * 0.18 - flick * 0.14, 0.98, own * 0.95);
    }
    return flicks;
  }

  private poseWalkingArms(walking: WalkingFrame | undefined, wave: WaveSample) {
    if (!walking || walking.weight === 0) return;
    // A captured walk already swings the arms, and swings them as a person
    // does. Laid on top, the gait's own swing doubled them at the leg cadence:
    // the right arm sat a mean 3.4 degrees and up to 7.5 away from the capture,
    // and the forearm a constant 4.0 - which is this function's 0.07 rad, to
    // the hundredth. It yields in proportion to the clip rather than switching
    // off, so the hand-over rides the clip's own fade instead of jumping.
    const captured = this.clipAboveTheHips ? this.clipWeight : 0;
    for (const side of ["D", "E"] as const) {
      // The free arm balances the opposite swinging leg. Conversation and
      // greeting have priority, rather than being overwritten by the gait.
      const free = (1 - captured) * (1 - this.handActivity * 0.88) * (side === "D" ? 1 - wave.arm : 1);
      this.rotate("Braco." + side, AXIS_X, walking.arms[side] * free);
      this.rotate("Antebraco." + side, AXIS_X, (-0.07 * walking.weight + walking.forearms[side]) * free);
      this.rotate("Mao." + side + "#walk", AXIS_X, walking.wrists[side] * free);
    }
    this.model.updateMatrixWorld(true);
  }

  private poseWave(wave: WaveSample) {
    if (!wave.active) return 0;
    // Raising the arm lifts that shoulder and tilts the head a little toward
    // the greeting, so the gesture involves the body rather than the arm alone.
    //
    // Measured against the captured greeting, it did not involve it enough: at
    // the conversation camera the face moved 4.7 px relative to the pelvis
    // (the capture moves it up to 34), and the free arm did not move at all.
    // A person who raises one arm shifts the trunk under it and lets the other
    // arm answer. The spine now carries most of the lean - 4 degrees, a third
    // of its skin budget - while the chest stays under the 0.05 rad its own
    // test allows, the neck and head follow toward the greeting, and the left
    // arm opens a little from the side with its elbow softening.
    this.rotate("Coluna#lean", AXIS_Z, -0.070 * wave.arm);
    this.rotate("Peito#lean", AXIS_Z, -0.036 * wave.arm);
    this.rotate("Pescoco#lean", AXIS_Z, 0.010 * wave.arm);
    this.rotate("Cabeca#lean", AXIS_Z, 0.030 * wave.arm);
    this.rotate("Braco.E#lean", AXIS_Z, 0.10 * wave.arm);
    this.rotate("Braco.E#lean", AXIS_X, -0.05 * wave.arm);
    this.rotate("Antebraco.E#lean", AXIS_X, -0.10 * wave.arm);
    this.model.updateMatrixWorld(true);
    this.aim("Braco.D#wave", -0.70 + wave.hold[0], -0.55 + wave.hold[1], 0.44 + wave.hold[2], wave.arm);
    this.aim("Antebraco.D#wave", -0.13 + wave.oscillation * 0.065 + wave.holdForearm[0], 0.96 + wave.holdForearm[1], 0.24 + wave.holdForearm[2], wave.forearm);
    this.aim("Mao.D#wave", -0.16 + wave.oscillation * 0.18, 0.94, 0.26, wave.hand);
    this.presentPalm("D", wave.hand);
    return wave.hand;
  }

  private measureHead() {
    const head = this.get("Cabeca");
    if (!head) return;
    // The world-space change from the rest orientation, applied to the rest
    // facing direction. The scene root is not expected to rotate at runtime.
    head.bone.getWorldQuaternion(this.headDelta).multiply(head.inverseWorld);
    this.direction.copy(AXIS_Z).applyQuaternion(this.headDelta);
    this.headYaw = Math.atan2(this.direction.x, this.direction.z);
    this.headPitch = -Math.asin(MathUtils.clamp(this.direction.y, -1, 1));
  }

  private resetMotion() {
    this.waveStarted = this.nodStarted = -Infinity;
    this.gestureStoppedAt = Infinity;
    this.speaking = this.emphasis = this.handActivity = this.speechPresence = 0;
    this.motionChannels.clear();
    this.inertialChannels.clear();
    this.aimDirections.clear();
    this.palmTurns.clear();
    this.idleTime = 0;
    this.conversationStarted = this.lastVoiceAt = -Infinity;
    this.conversationIndex = -1;
    this.conversationStrength = 1;
    this.levelSlow = this.previousLevel = 0;
    this.beats.length = 0;
    this.beatCount = 0;
    this.lastBeatAt = -Infinity;
    this.attitudeFrom.fill(0);
    this.attitude.fill(0);
    this.attitudeSwitchedAt = -Infinity;
    this.headYaw = this.headPitch = 0;
    this.attention.reset();
  }

  private poseIdleArms(idle: IdleMotion, idleHands: number, wave: WaveSample) {
    // While waiting, the forearms occasionally come forward into a relaxed
    // resting posture for a while, then return to hanging beside the coat.
    const forward = idle.armsForward * idleHands;
    if (forward <= 0) return;
    for (const [side, sign] of HAND_SIDES) {
      const weight = forward * 0.62 * (side === "D" ? 1 - wave.arm : 1);
      if (weight <= 0) continue;
      this.aim(`Braco.${side}#idle`, sign * 0.17, -0.97, 0.16, weight * 0.35);
      this.aim(`Antebraco.${side}#idle`, sign * 0.04, -0.66, 0.75, weight);
      this.aim(`Mao.${side}#idle`, sign * 0.10, -0.55, 0.83, weight * 0.9);
    }
  }

  private trackVoice(now: number, delta: number, speechLevel: number) {
    // Audio controls the strength of the gesture, never an unrelated mouth loop.
    // Two envelopes avoid bobbing the whole head at every syllable.
    const level = Number.isFinite(speechLevel) ? MathUtils.clamp(speechLevel, 0, 1) : 0;
    const activity = smooth(0.015, 0.32, level);
    this.speaking = this.follow(this.speaking, activity, 5.5, 3.8, delta);
    this.emphasis = this.follow(this.emphasis, level, 11, 6, delta);
    if (activity === 0 && this.speaking < 0.0001) this.speaking = 0;
    if (level === 0 && this.emphasis < 0.0001) this.emphasis = 0;

    // Prosodic onsets: a syllable clearly louder than the recent voice starts
    // a beat, as does a new phrase. The head and the leading hand share its
    // timing. The slow reference holds the previous sample over the elapsed
    // step, so the same audio yields the same beats at any frame rate.
    this.levelSlow = this.follow(this.levelSlow, this.previousLevel, 6, 2.5, delta);
    if (this.previousLevel === 0 && this.levelSlow < 0.0001) this.levelSlow = 0;
    this.previousLevel = level;
    const onset = level > 0.06 && level > this.levelSlow * 1.3 + 0.04;
    const beatStrength = MathUtils.clamp((level - this.levelSlow) / 0.35, 0.35, 1);

    // A new phrase or a later stressed passage starts the next hand gesture.
    // Unequal durations and alternating leading hands avoid a mirrored loop.
    const beatDuration = CONVERSATION_DURATIONS[Math.max(0, this.conversationIndex) % CONVERSATION_DURATIONS.length];
    let phraseStarted = false;
    if (level > 0.035) {
      if (now - this.lastVoiceAt > 0.7
        || (now - this.conversationStarted > beatDuration + 0.18 && level >= this.emphasis * 0.85)) {
        this.beginPhrase(now, level);
        phraseStarted = true;
      }
      this.lastVoiceAt = now;
    }
    if ((onset || phraseStarted) && now - this.lastBeatAt >= BEAT_REFRACTORY_SECONDS) {
      this.registerBeat(now, phraseStarted ? Math.max(0.65, beatStrength) : beatStrength);
    }
    // Keep a phrase gesture through brief gaps between syllables, then relax.
    const handTarget = now - this.lastVoiceAt < 0.32 ? 1 : 0;
    this.handActivity = this.follow(this.handActivity, handTarget, 3.0, 4.0, delta);
    if (handTarget === 0 && this.handActivity < 0.0001) this.handActivity = 0;
  }

  update(now: number, motionEnabled: boolean, speechLevel = 0, gaze?: GazeInput, attention?: AttentionInput, walking?: WalkingFrame) {
    if (!Number.isFinite(now)) return;
    const elapsed = this.previousTime === null ? 0 : now - this.previousTime;
    // A hidden tab must resume the pose it displayed, not jump ahead through
    // several unattended breaths or queued posture changes.
    const delta = elapsed >= 0 && elapsed <= 0.25 ? Math.min(elapsed, 0.1) : 0;
    this.gapFrame = elapsed < 0 || elapsed > 0.25;
    this.previousTime = now;
    for (const rest of this.bones.values()) {
      rest.bone.quaternion.copy(rest.local);
      rest.bone.scale.copy(rest.scale);
      rest.bone.position.copy(rest.position);
    }
    if (!motionEnabled) {
      this.resetMotion();
      this.model.updateMatrixWorld(true);
      return;
    }

    this.idleTime += delta;
    this.frameDelta = delta;
    this.frameStamp += 1;
    // The voice is read first: a clip that follows speech must follow this
    // frame's, not the last one's, which lags by a different amount at 30 fps
    // than at 120. Neither touches a bone, so the order is otherwise free.
    this.trackVoice(now, delta, speechLevel);
    // Whether the poet is in a stretch of speech, rather than how loud this
    // syllable is. It holds across the gaps between words and lets go a little
    // after the last one; a body does not drop its talking posture at every
    // pause. Advanced every frame, so it never resumes from a stale value.
    this.speechPresence = this.dampChannel("speech-presence", now - this.lastVoiceAt < SPEECH_HOLD ? 1 : 0, delta, 3.0, 0, 1);
    this.attention.update(now, attention, this.dampAttention, this.randomFor);
    this.applyClip(now, walking);

    const gestureWeight = Number.isFinite(this.gestureStoppedAt)
      ? 1 - smooth(this.gestureStoppedAt, this.gestureStoppedAt + 0.55, now) : 1;
    if (gestureWeight === 0) this.waveStarted = this.nodStarted = -Infinity;
    const nodTime = now - this.nodStarted;
    const nodEnvelope = nodTime >= 0 && nodTime < 1.65
      ? smooth(0, 0.22, nodTime) * (1 - smooth(1.25, 1.65, nodTime)) * gestureWeight : 0;

    // Quiet presence has its own slow clock and independent pose timings.
    // Speech fades the adjustments; breathing continues without driving lips.
    const idle = sampleIdleMotion(this.idleTime);
    const beats = this.sampleBeats(now);
    this.poseHead(now, delta, idle, nodEnvelope, beats, gaze);
    this.poseNod(nodTime, nodEnvelope);
    this.model.updateMatrixWorld(true);
    // Waiting behaviours (a decided weight transfer, forearms forward) yield to
    // speech; postural life does not. A talking body still sways and breathes,
    // and speech even adds to it: see poseBody.
    const walkWeight = walking?.weight ?? 0;
    this.walkWeight = walkWeight;
    this.poseBody(now, delta, idle, (1 - this.speaking) * (1 - walkWeight), (1 - this.speaking * 0.45) * (1 - walkWeight), walking);
    // After the trunk has been placed and the legs solved from the pelvis, and
    // before the arms are aimed, so a raised hand accounts for the chest under it.
    this.poseSpeechTrunk(now, delta);
    this.model.updateMatrixWorld(true);

    const waveTime = now - this.waveStarted;
    const wave = this.sampleWave(waveTime, gestureWeight);
    const idleHands = (1 - this.handActivity) * (1 - (walking?.weight ?? 0)) * (1 - this.capturedShare);
    this.poseIdleArms(idle, idleHands, wave);
    this.poseWalkingArms(walking, wave);
    const flicks = this.poseConversationArms(now, delta, beats, wave);
    // Hand accommodations last several seconds and are intentionally offset;
    // the fingers relax together instead of repeatedly tapping one by one.
    // Forearms brought forward relax the fingers a little more.
    const relaxRight = Math.min(0.85, idle.rightHand + idle.armsForward * 0.45) * idleHands;
    const relaxLeft = Math.min(0.85, idle.leftHand + idle.armsForward * 0.45) * idleHands;
    this.rotateLocal("Mao.D", AXIS_X, relaxRight * 0.016);
    this.rotateLocal("Mao.E", AXIS_X, relaxLeft * 0.014);
    this.model.updateMatrixWorld(true);
    const waveHandWeight = this.poseWave(wave);
    const leadingRight = this.conversationIndex % 2 === 0;
    this.poseFingers("D", this.handActivity * (leadingRight ? 1 : 0.68), waveHandWeight, waveTime, delta, relaxRight, flicks.D);
    this.poseFingers("E", this.handActivity * (leadingRight ? 0.68 : 1), 0, 0, delta, relaxLeft, flicks.E);
    this.settleOrphans();
    this.holdBudget();
    this.model.updateMatrixWorld(true);
    this.measureHead();
  }
}
