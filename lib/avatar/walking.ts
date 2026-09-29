import { Bone, Object3D, Vector3 } from "three";

export type WalkPoint = readonly [number, number];
export type WalkingSide = "D" | "E";
export type WalkingFoot = {
  /** Ankle position in the untransformed avatar model, in metres. */
  position: [number, number, number];
  /** Heading relative to the model and a small swing-phase toe lift. */
  yaw: number;
  pitch: number;
  support: boolean;
};
export type WalkingFeet = Record<WalkingSide, WalkingFoot>;
export type WalkingFrame = {
  x: number;
  z: number;
  yaw: number;
  active: boolean;
  weight: number;
  speed: number;
  stepCount: number;
  /**
   * The gait as a continuous count of footfalls: a whole number the instant a
   * heel lands, rising steadily through the double support and the swing that
   * follow, holding still when the poet stands. Built from the same state the
   * steps are integrated from at a fixed 120 Hz, so it reads the same at any
   * frame rate and never jumps across a hidden tab.
   */
  stridePhase: number;
  /** The foot whose heel landed at the last whole value of stridePhase. */
  landingSide: WalkingSide;
  feet: WalkingFeet;
  body: { lift: number; shift: number; lean: number; roll: number; twist: number };
  arms: Record<WalkingSide, number>;
  /** Elbow and wrist follow-through behind the arm swing, in radians; see samplePose(). */
  forearms: Record<WalkingSide, number>;
  wrists: Record<WalkingSide, number>;
};

type FootState = { x: number; y: number; z: number; yaw: number; pitch: number };
type Swing = { side: WalkingSide; elapsed: number; from: FootState; to: FootState; lift: number };
const SIDES: readonly WalkingSide[] = ["D", "E"];
const FIXED_STEP = 1 / 120;
const MAX_SPEED = 0.42;
const ACCELERATION = 0.55;
const BRAKING = 0.65;
const TURN_SPEED = 0.78;
const TURN_ACCELERATION = 2.0;
const SWING_SECONDS = 0.44;
// A real arm does not swing in lockstep with the opposite leg: it trails it by
// roughly fifty milliseconds. Expressed as a fraction of the swing so it holds
// at any cadence, and read from the phase rather than stored, so the pose stays
// reproducible and free of frame-rate drift.
const ARM_LAG = 0.12;
// Nor are the two arms mirror images; the trailing side carries a little less.
const ARM_ASYMMETRY = 0.93;
// How far the upper arm swings, in radians. This is the walk the poet uses
// when the captured one did not load, and at 0.17 it moved the wrist 13.9 cm
// across a stride against the capture's 37.8. At 0.35 it moves it 29.6. It
// stops there because the step test's frame-to-frame cap (0.05 rad) is reached
// at 0.37, and the continuity it guards is proven either way.
const ARM_SWING = 0.35;
// Down the arm each link trails the one above it, so the chain whips instead
// of swinging as one stick. In steps: the elbow 0.24 behind the shoulder, the
// wrist a further 0.14. Measured as the lag between the two joints' own
// rotation speeds, the elbow follows the shoulder by 117 ms (the capture: 83).
// Before, the forearm did not move at the elbow at all; now the elbow alone
// carries the wrist 11.6 cm a stride, against the capture's 11.0.
const FOREARM_LAG = 0.24;
const WRIST_LAG = 0.14;
const FOREARM_SWING = 0.27;
const WRIST_SWING = 0.08;
// Shoulders counter-rotate against the pelvis with each stride. At 0.016 the
// shoulder line turned 0.95 degrees a stride; at 0.16 it turns 9.3, a walker's.
const WALK_TWIST = 0.16;
// Below this much walk, a new step starts a new walk; see beginStep().
const GAIT_RESTART = 0.05;
const DOUBLE_SUPPORT_SECONDS = 0.10;
/** One step, landing to landing, when the poet walks without pausing. */
const STEP_SECONDS = SWING_SECONDS + DOUBLE_SUPPORT_SECONDS;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const approach = (value: number, target: number, amount: number) => value + clamp(target - value, -amount, amount);
const angleDelta = (target: number, current: number) => Math.atan2(Math.sin(target - current), Math.cos(target - current));
const ease = (u: number) => u * u * u * (u * (u * 6 - 15) + 10);

/**
 * Slow, deterministic footstep locomotion. The root follows the supplied safe
 * polyline exactly: turns never replace navigation segments with a shortcut.
 * Feet are stored in world space during support and converted back to model
 * coordinates for IK. Call the rig with an unrotated locomotion parent, then
 * apply frame.x/z/yaw to that parent after posing the skeleton.
 */
export class AvatarWalker {
  private rests: Record<WalkingSide, [number, number, number]> = {
    D: [-0.166, 0.115, -0.012], E: [0.145, 0.115, -0.012],
  };
  private hips: Record<WalkingSide, [number, number, number]> = { D: [-0.11, 0.99, -0.022], E: [0.10, 0.99, -0.022] };
  private reaches: Record<WalkingSide, number> = { D: 0.878, E: 0.878 };
  private feet: Record<WalkingSide, FootState>;
  private path: WalkPoint[] = [];
  private finalYaw = 0;
  private stopping = false;
  private speed = 0;
  private turnVelocity = 0;
  private nextSide: WalkingSide = "D";
  /** Before any step the right foot is next, so the left counts as last down. */
  private lastLanding: WalkingSide = "E";
  /** Where on the gait count the walk in progress began; see gaitRhythm(). */
  private gaitStart = DOUBLE_SUPPORT_SECONDS / STEP_SECONDS;
  private swing: Swing | null = null;
  private supportTime = DOUBLE_SUPPORT_SECONDS;
  private remainder = 0;
  private frameValue: WalkingFrame;

  constructor(model?: Object3D) {
    if (model) {
      model.updateMatrixWorld(true);
      const joints = new Map<string, Vector3>();
      model.traverse((object) => {
        if (!(object instanceof Bone)) return;
        const name = object.name.toLowerCase().replace(/[^a-z0-9]/g, "");
        joints.set(name, model.worldToLocal(object.getWorldPosition(new Vector3())));
        const side = name === "ped" ? "D" : name === "pee" ? "E" : null;
        if (side) this.rests[side] = model.worldToLocal(object.getWorldPosition(new Vector3())).toArray();
      });
      for (const side of SIDES) {
        const suffix = side.toLowerCase();
        const hip = joints.get("coxa" + suffix), knee = joints.get("canela" + suffix), ankle = joints.get("pe" + suffix);
        if (hip && knee && ankle) {
          this.hips[side] = hip.toArray();
          this.reaches[side] = hip.distanceTo(knee) + knee.distanceTo(ankle);
        }
      }
    }
    this.feet = {
      D: this.restFoot("D", 0, 0, 0),
      E: this.restFoot("E", 0, 0, 0),
    };
    const foot = (side: WalkingSide): WalkingFoot => ({ position: [...this.rests[side]], yaw: 0, pitch: 0, support: true });
    this.frameValue = {
      x: 0, z: 0, yaw: 0, active: false, weight: 0, speed: 0, stepCount: 0,
      stridePhase: DOUBLE_SUPPORT_SECONDS / STEP_SECONDS, landingSide: "E",
      feet: { D: foot("D"), E: foot("E") },
      body: { lift: 0, shift: 0, lean: 0, roll: 0, twist: 0 }, arms: { D: 0, E: 0 },
      forearms: { D: 0, E: 0 }, wrists: { D: 0, E: 0 },
    };
  }

  /** Reused frame object. Read it in the current render; copy for history. */
  get frame(): WalkingFrame { return this.frameValue; }

  /** Path may include its current origin. A new destination never resets a foot mid-step. */
  setPath(points: readonly WalkPoint[], finalYaw = 0) {
    if (!Number.isFinite(finalYaw) || points.some(p => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) return;
    this.path = points.map(point => [point[0], point[1]] as WalkPoint);
    while (this.path.length && Math.hypot(this.path[0][0] - this.frame.x, this.path[0][1] - this.frame.z) < 0.00001) this.path.shift();
    this.finalYaw = finalYaw;
    this.stopping = false;
    this.frameValue.active = this.path.length > 0 || Math.abs(angleDelta(finalYaw, this.frame.yaw)) > 0.002
      || Boolean(this.swing) || this.frame.weight > 0 || Math.abs(this.turnVelocity) > 0.0001
      || this.footNeedsStep("D") || this.footNeedsStep("E");
  }

  /** Decelerate on the current safe segment, land the raised foot and face the visitor. */
  stop() {
    this.stopping = true;
    this.finalYaw = 0;
    if (this.path.length > 1) this.path = this.path.slice(0, 1);
  }

  private restFoot(side: WalkingSide, x: number, z: number, yaw: number): FootState {
    const [rx, y, rz] = this.rests[side];
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return { x: x + rx * c + rz * s, y, z: z - rx * s + rz * c, yaw, pitch: 0 };
  }

  private desiredYaw() {
    const point = this.path[0];
    return point && !this.stopping ? Math.atan2(point[0] - this.frame.x, point[1] - this.frame.z) : this.finalYaw;
  }

  private footNeedsStep(side: WalkingSide) {
    const ideal = this.restFoot(side, this.frame.x, this.frame.z, this.frame.yaw);
    const actual = this.feet[side];
    return Math.hypot(ideal.x - actual.x, ideal.z - actual.z) > 0.002
      || Math.abs(angleDelta(ideal.yaw, actual.yaw)) > 0.008;
  }

  private predictedRoot(seconds: number) {
    let x = this.frame.x, z = this.frame.z;
    const yaw = this.frame.yaw + clamp(angleDelta(this.desiredYaw(), this.frame.yaw), -TURN_SPEED * seconds, TURN_SPEED * seconds);
    const facing = Math.pow(Math.max(0, Math.cos(angleDelta(this.desiredYaw(), yaw))), 3);
    const futureSpeed = Math.min(MAX_SPEED * facing, this.speed + ACCELERATION * seconds);
    let travel = this.stopping
      ? Math.min(this.speed * seconds, this.speed * this.speed / (2 * BRAKING))
      : (this.speed + futureSpeed) * 0.5 * seconds;
    for (const [tx, tz] of this.path) {
      const distance = Math.hypot(tx - x, tz - z);
      if (distance < 0.000001) continue;
      const amount = Math.min(travel, distance);
      x += (tx - x) * amount / distance;
      z += (tz - z) * amount / distance;
      travel -= amount;
      if (travel <= 0 || this.stopping) break;
    }
    return { x, z, yaw };
  }

  private beginStep(side: WalkingSide) {
    const future = this.predictedRoot(SWING_SECONDS + 0.10);
    const from = { ...this.feet[side] };
    const to = this.restFoot(side, future.x, future.z, future.yaw);
    const distance = Math.hypot(to.x - from.x, to.z - from.z);
    const turn = Math.abs(angleDelta(to.yaw, from.yaw));
    this.swing = { side, elapsed: 0, from, to, lift: clamp(distance * 0.17 + turn * 0.01, 0.012, 0.048) };
    this.frameValue.stepCount += 1;
    this.nextSide = side === "D" ? "E" : "D";
  }

  private advanceRoot(delta: number) {
    const frame = this.frameValue;
    const targetYaw = this.desiredYaw();
    const turn = angleDelta(targetYaw, frame.yaw);
    const wantedTurn = clamp(turn * 3.8, -TURN_SPEED, TURN_SPEED);
    this.turnVelocity = approach(this.turnVelocity, wantedTurn, TURN_ACCELERATION * delta);
    if (Math.abs(turn) < 0.001 && Math.abs(this.turnVelocity) < 0.01) {
      frame.yaw += turn;
      this.turnVelocity = 0;
    } else frame.yaw += this.turnVelocity * delta;
    const point = this.path[0];
    if (!point) { this.speed = 0; return; }
    const dx = point[0] - frame.x, dz = point[1] - frame.z;
    const remaining = Math.hypot(dx, dz);
    let cornerSpeed = 0;
    if (this.path.length > 1) {
      const next = this.path[1];
      const after = Math.atan2(next[0] - point[0], next[1] - point[1]);
      cornerSpeed = MAX_SPEED * Math.pow(Math.max(0, Math.cos(angleDelta(after, Math.atan2(dx, dz)) / 2)), 8);
    }
    const facing = Math.pow(Math.max(0, Math.cos(angleDelta(Math.atan2(dx, dz), frame.yaw))), 3);
    const wantedSpeed = this.stopping ? 0 : Math.min(MAX_SPEED * facing, Math.sqrt(cornerSpeed * cornerSpeed + 2 * BRAKING * remaining));
    this.speed = approach(this.speed, wantedSpeed, (wantedSpeed < this.speed ? BRAKING : ACCELERATION) * delta);
    const travel = Math.min(remaining, this.speed * delta);
    if (remaining > 0.000001) {
      frame.x += dx * travel / remaining;
      frame.z += dz * travel / remaining;
    }
    if (remaining <= travel + 0.000001) {
      frame.x = point[0]; frame.z = point[1]; this.path.shift();
      if (!this.path.length) this.speed = 0;
    }
    if (this.stopping && this.speed <= 0.00001) this.path = [];
  }

  private integrate(delta: number) {
    const frame = this.frameValue;
    // While the walk has faded out the poet is standing, and whatever comes next
    // is a new walk: its start is pinned to where the gait count now holds.
    // Checked before the weight rises this frame, because the weight rises for
    // a few frames before the first foot leaves the floor. On a short pause the
    // walk is still under way, and its last swing is recent and real.
    if (frame.weight < GAIT_RESTART) this.gaitStart = frame.stridePhase;
    this.advanceRoot(delta);
    if (this.swing) {
      const step = this.swing;
      step.elapsed = Math.min(SWING_SECONDS, step.elapsed + delta);
      const u = step.elapsed / SWING_SECONDS, blend = ease(u);
      const foot = this.feet[step.side];
      foot.x = step.from.x + (step.to.x - step.from.x) * blend;
      foot.z = step.from.z + (step.to.z - step.from.z) * blend;
      foot.y = this.rests[step.side][1] + Math.sin(Math.PI * u) ** 2 * step.lift;
      foot.yaw = step.from.yaw + angleDelta(step.to.yaw, step.from.yaw) * blend;
      // The heel extends about 21 cm behind the ankle: small turning steps
      // need proportionally less toe-up rotation to keep the heel above the floor.
      foot.pitch = -Math.min(0.10, step.lift / 0.24) * Math.sin(Math.PI * u) ** 2;
      if (step.elapsed >= SWING_SECONDS) {
        this.feet[step.side] = { ...step.to };
        this.lastLanding = step.side;
        this.swing = null;
        this.supportTime = 0;
      }
    } else {
      this.supportTime += delta;
      const turning = Math.abs(this.turnVelocity) > 0.01 || Math.abs(angleDelta(this.desiredYaw(), frame.yaw)) > 0.008;
      const moving = this.speed > 0.025;
      if (this.supportTime >= DOUBLE_SUPPORT_SECONDS) {
        if (moving || turning || this.footNeedsStep(this.nextSide)) this.beginStep(this.nextSide);
        else {
          const other = this.nextSide === "D" ? "E" : "D";
          if (this.footNeedsStep(other)) this.beginStep(other);
        }
      }
    }
    const needsMotion = this.path.length > 0 || this.speed > 0.00001 || Boolean(this.swing)
      || Math.abs(this.turnVelocity) > 0.0001 || this.footNeedsStep("D") || this.footNeedsStep("E");
    frame.weight += ((needsMotion ? 1 : 0) - frame.weight) * -Math.expm1(-delta * (needsMotion ? 6 : 5));
    if (!needsMotion && frame.weight < 0.0001) frame.weight = 0;
    frame.active = needsMotion || frame.weight > 0;
    frame.speed = this.speed;
    // Footfalls so far, plus how far into the next one: the double support that
    // follows a landing, then the swing, which ends on the next whole number.
    // A pause holds at the end of the support rather than running ahead.
    const landings = frame.stepCount - (this.swing ? 1 : 0);
    const into = this.swing ? DOUBLE_SUPPORT_SECONDS + this.swing.elapsed : Math.min(DOUBLE_SUPPORT_SECONDS, this.supportTime);
    frame.stridePhase = landings + into / STEP_SECONDS;
    frame.landingSide = this.lastLanding;
    this.samplePose();
  }

  private samplePose() {
    const frame = this.frameValue;
    const c = Math.cos(frame.yaw), s = Math.sin(frame.yaw);
    for (const side of SIDES) {
      const world = this.feet[side], foot = frame.feet[side];
      const dx = world.x - frame.x, dz = world.z - frame.z;
      foot.position[0] = dx * c - dz * s;
      foot.position[1] = world.y;
      foot.position[2] = dx * s + dz * c;
      foot.yaw = angleDelta(world.yaw, frame.yaw);
      foot.pitch = world.pitch;
      foot.support = this.swing?.side !== side;
    }
    const u = this.swing ? this.swing.elapsed / SWING_SECONDS : 0;
    const rhythm = Math.sin(Math.PI * u) ** 3 * (this.swing?.side === "D" ? 1 : -1);
    const weight = frame.weight;
    frame.body.shift = rhythm * 0.012 * weight;
    frame.body.lift = (-0.032 + Math.abs(rhythm) * 0.004) * weight;
    // A planted leg may trail farther during acceleration or a turn. Lower
    // the pelvis just enough for its measured leg length, rather than letting
    // the IK clamp pull that shoe off the floor or stretch the scanned knee.
    for (const side of SIDES) {
      const [hx, hy, hz] = this.hips[side];
      const [fx, fy, fz] = frame.feet[side].position;
      const horizontal = (hx + frame.body.shift - fx) ** 2 + (hz - fz) ** 2;
      const reach = this.reaches[side] - 0.005 * weight;
      const vertical = Math.sqrt(Math.max(0, reach * reach - horizontal));
      frame.body.lift = Math.min(frame.body.lift, fy + vertical - hy);
    }
    frame.body.lean = -0.032 * this.speed / MAX_SPEED * weight;
    frame.body.roll = -rhythm * 0.008 * weight;
    frame.body.twist = rhythm * WALK_TWIST * weight;
    const sign = this.swing?.side === "D" ? 1 : -1;
    const lagged = u - ARM_LAG;
    // Before the lag runs out we are still inside the previous swing, which was
    // the other leg and is already close to rest, so the two meet at zero.
    const armRhythm = this.swing
      ? (lagged >= 0
        ? Math.sin(Math.PI * lagged) ** 3 * sign
        : -(Math.sin(Math.PI * (1 + lagged)) ** 3) * sign)
      : 0;
    frame.arms.D = armRhythm * ARM_SWING * weight;
    frame.arms.E = -armRhythm * ARM_SWING * weight * ARM_ASYMMETRY;
    // The elbow and the wrist ride the gait count, not the swing's own clock.
    // That clock stops through the double support, and their longer lags reach
    // back across it: read from it, the forearm would still be at 73 percent of
    // its swing when the swing ended and drop to nothing in one frame, at every
    // step. The gait count runs straight through, so the chain stays smooth.
    const armLag = ARM_LAG * SWING_SECONDS / STEP_SECONDS;
    const forearm = this.gaitRhythm(frame.stridePhase - armLag - FOREARM_LAG);
    const wrist = this.gaitRhythm(frame.stridePhase - armLag - FOREARM_LAG - WRIST_LAG);
    frame.forearms.D = forearm * FOREARM_SWING * weight;
    frame.forearms.E = -forearm * FOREARM_SWING * weight * ARM_ASYMMETRY;
    frame.wrists.D = wrist * WRIST_SWING * weight;
    frame.wrists.E = -wrist * WRIST_SWING * weight * ARM_ASYMMETRY;
  }

  /**
   * The arm-swing shape laid on the continuous gait count: nothing through the
   * double support that follows a landing, then the swing's rise and fall,
   * signed by the foot that swings - the same shape the arm uses, but on a
   * clock that never stops between steps.
   */
  private gaitRhythm(phase: number) {
    const frame = this.frameValue;
    const step = Math.floor(phase);   // this step ends with a landing at step + 1
    const into = phase - step;
    const support = DOUBLE_SUPPORT_SECONDS / STEP_SECONDS;
    if (into < support) return 0;
    // Only swings of the walk in progress. Reaching further back finds a step
    // taken long before, or on the very first walk one never taken at all,
    // while the weight of the walk is still rising from nothing: that bent the
    // elbow at the first frame and set 30 and 120 fps 0.81 degrees apart.
    if (phase < this.gaitStart) return 0;
    // The sides alternate, so the foot that lands at step + 1 follows from the
    // one that landed last.
    const sameAsLast = ((step + 1 - Math.floor(frame.stridePhase)) % 2 + 2) % 2 === 0;
    const side = sameAsLast ? frame.landingSide : frame.landingSide === "D" ? "E" : "D";
    return Math.sin(Math.PI * (into - support) / (1 - support)) ** 3 * (side === "D" ? 1 : -1);
  }

  /** update(0) is a read-only pose query; hidden-tab gaps never advance steps. */
  update(deltaSeconds: number): WalkingFrame {
    if (!(deltaSeconds > 0) || !Number.isFinite(deltaSeconds) || deltaSeconds > 0.25) return this.frameValue;
    this.remainder += Math.min(deltaSeconds, 0.1);
    while (this.remainder + 1e-10 >= FIXED_STEP) {
      this.integrate(FIXED_STEP);
      this.remainder = Math.max(0, this.remainder - FIXED_STEP);
    }
    return this.frameValue;
  }
}