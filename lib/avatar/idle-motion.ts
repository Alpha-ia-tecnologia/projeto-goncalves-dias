import { MathUtils } from "three";

const ease = (value: number) => MathUtils.smootherstep(value, 0, 1);
type Pose = readonly [duration: number, value: number];

/** Independent slow pose sequences, with unequal moves and quiet holds. */
function drift(time: number, poses: readonly Pose[], offset = 0) {
  const length = poses.reduce((sum, [duration]) => sum + duration, 0);
  let phase = ((time + offset) % length + length) % length;
  for (let index = 0; index < poses.length; index++) {
    const [duration, target] = poses[index];
    if (phase <= duration) {
      const previous = poses[(index + poses.length - 1) % poses.length][1];
      // A gentle move occupies most of a segment, followed by a short hold.
      return MathUtils.lerp(previous, target, ease(phase / (duration * 0.82)));
    }
    phase -= duration;
  }
  return poses[poses.length - 1][1];
}

/**
 * Every pose sequence above loops on its own fixed length, so left alone the
 * whole body returns to an identical state on a predictable cycle and a visitor
 * who stays a while sees the loop. These three periods share no common multiple
 * for about sixty days, so the sequences never line up the same way twice in a
 * session. It stays a pure function of time: no state, no accumulation, and the
 * same instant always samples the same value.
 */
function wander(time: number, phase: number) {
  return (Math.sin(time / 23.7 + phase)
    + Math.sin(time / 37.9 + phase * 1.7) * 0.7
    + Math.sin(time / 61.3 + phase * 2.3) * 0.45) / 2.15;
}

/**
 * The phase nudge a sequence receives, anchored so it is exactly zero at the
 * start. Without the anchor the poet would begin mid-sequence, already leaning,
 * instead of coming to life from rest.
 */
function wanderOffset(time: number, phase: number) {
  return (wander(time, phase) - wander(0, phase)) * 2.6;
}

/**
 * Quiet standing is never still: the body sways continuously around its base of
 * support. This is that sway, a few millimetres on its own slow clocks, which is
 * what separates a living figure from a posed one.
 */
function posturalSway(time: number, phase: number) {
  return (Math.sin(time / 7.3 + phase)
    + Math.sin(time / 11.9 + phase * 1.4) * 0.66
    + Math.sin(time / 4.7 + phase * 2.6) * 0.24) / 1.9;
}

const yaw: readonly Pose[] = [[7.8, 0.024], [5.6, 0.007], [9.4, -0.020], [6.7, -0.005], [8.9, 0.015], [10.1, 0]];
const pitch: readonly Pose[] = [[5.3, -0.010], [7.1, 0.009], [6.2, 0.002], [8.7, -0.006], [6.8, 0]];
const roll: readonly Pose[] = [[9.7, 0.006], [7.6, -0.004], [10.8, 0.002], [6.9, 0]];
const support: readonly Pose[] = [[10.8, -0.0041], [8.3, -0.0022], [12.6, 0.0038], [9.7, 0.0011], [11.4, -0.0027], [8.8, 0]];
const depth: readonly Pose[] = [[8.9, 0.0012], [12.2, -0.0008], [10.7, 0.0004], [9.1, 0]];
const rightHand: readonly Pose[] = [[4.8, 0], [4.1, 0.82], [4.8, 0.38], [5.7, 0], [7.2, 0], [4.6, 0.58], [5.3, 0]];
const leftHand: readonly Pose[] = [[8.7, 0], [4.8, 0.64], [5.3, 0.21], [7.4, 0], [5.1, 0.44], [6.8, 0]];
// Larger adjustments a standing person makes while waiting, each on its own
// slow clock: forearms brought forward for a while, a decided transfer of
// weight to one leg, and an occasional deeper breath.
const armsForward: readonly Pose[] = [[19.5, 0], [3.4, 1], [12.6, 1], [3.1, 0], [30.8, 0], [3.0, 0.72], [9.4, 0.72], [2.8, 0], [24.5, 0]];
const transfer: readonly Pose[] = [[26.5, 0], [3.2, 1], [13.5, 1], [3.0, 0], [21.0, 0], [3.4, -1], [11.5, -1], [3.2, 0], [17.5, 0]];
const sigh: readonly Pose[] = [[40.5, 0], [2.6, 1], [0.6, 1], [3.4, 0], [55.0, 0], [2.4, 0.85], [0.5, 0.85], [3.2, 0]];
const breathing = [4.9, 5.5, 4.6, 5.8, 5.1, 5.4];

export type IdleMotion = {
  breath: number; yaw: number; pitch: number; roll: number; shift: number; depth: number; settle: number;
  rightHand: number; leftHand: number; armsForward: number; transfer: number; sigh: number; fade: number;
  /** Continuous postural sway, normalised to about -1..1. */
  sway: number; swayDepth: number;
  /** The same sway further down the chain, delayed: the torso trails the hips
   *  and the head trails the torso, which is what reads as follow-through. */
  swayChest: number; swayHead: number;
};

const breathLength = breathing.reduce((sum, duration) => sum + duration, 0);
// Reused every frame; callers read the sample within the same frame.
const sample: IdleMotion = {
  breath: 0, yaw: 0, pitch: 0, roll: 0, shift: 0, depth: 0, settle: 0,
  rightHand: 0, leftHand: 0, armsForward: 0, transfer: 0, sigh: 0, fade: 0,
  sway: 0, swayDepth: 0, swayChest: 0, swayHead: 0,
};

/** A model-local clock makes the first frame and a resumed tab continuous. */
export function sampleIdleMotion(time: number): IdleMotion {
  const age = Math.max(0, time);
  const fade = ease(age / 2.4);
  // Warping the clock keeps every breath continuous: shortening the cycle
  // length directly would cut the curve off at the boundary and jump.
  const breathClock = Math.max(0, age + (wander(age, 4.1) - wander(0, 4.1)) * 1.6);
  let phase = breathClock % breathLength;
  let duration = breathing[0];
  for (const candidate of breathing) {
    duration = candidate;
    if (phase <= duration) break;
    phase -= duration;
  }
  const inhalation = duration * 0.39;
  const breath = phase <= inhalation
    ? ease(phase / inhalation)
    : 1 - ease((phase - inhalation) / (duration * 0.55));
  sample.breath = breath * fade;
  sample.yaw = drift(age + wanderOffset(age, 0.7), yaw) * fade;
  sample.pitch = drift(age + wanderOffset(age, 1.9), pitch) * fade;
  sample.roll = drift(age + wanderOffset(age, 3.1), roll) * fade;
  sample.shift = drift(age + wanderOffset(age, 4.4), support) * fade;
  sample.depth = drift(age + wanderOffset(age, 5.2), depth) * fade;
  sample.settle = -(0.0007 + breath * 0.00035) * fade;
  sample.rightHand = drift(age + wanderOffset(age, 6), rightHand) * fade;
  sample.leftHand = drift(age + wanderOffset(age, 0.3), leftHand) * fade;
  sample.armsForward = drift(age + wanderOffset(age, 2.5), armsForward) * fade;
  sample.transfer = drift(age + wanderOffset(age, 3.8), transfer) * fade;
  sample.sigh = drift(age + wanderOffset(age, 5), sigh) * fade;
  sample.sway = posturalSway(age, 1.1) * fade;
  sample.swayDepth = posturalSway(age, 3.7) * fade;
  // A delayed sample is follow-through without state: no spring to ring, the
  // pose stays a pure function of the clock, and silence returns exactly to rest.
  sample.swayChest = posturalSway(Math.max(0, age - 0.16), 1.1) * fade;
  sample.swayHead = posturalSway(Math.max(0, age - 0.31), 1.1) * fade;
  sample.fade = fade;
  return sample;
}