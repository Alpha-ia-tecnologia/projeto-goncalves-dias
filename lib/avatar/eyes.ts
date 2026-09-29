import { MathUtils, Mesh, Object3D } from "three";

type EyeBinding = {
  weights: number[];
  blinkRight: number;
  blinkLeft: number;
  arcRight: number;
  arcLeft: number;
  right: number;
  left: number;
  up: number;
  down: number;
};

/** Head rotation away from rest, in radians; pitch is positive when the face turns down. */
export type HeadPose = { yaw: number; pitch: number };
/** Listening keeps eye contact; thinking averts the gaze up and aside until the reply begins. */

export type GazeMode = "idle" | "listening" | "thinking";

const smooth = (value: number) => {
  const t = MathUtils.clamp(value, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

// The full gaze morphs shift each iris 2 mm sideways and about 1 mm
// vertically over an eyeball of roughly 12 mm radius.
const RADIANS_PER_HORIZONTAL_UNIT = 0.167;
/** One gaze unit in degrees, derived from the morph rather than assumed. */
const GAZE_DEGREES = RADIANS_PER_HORIZONTAL_UNIT * 180 / Math.PI;
const RADIANS_PER_VERTICAL_UNIT = 0.08;
const HORIZONTAL_COMPENSATION_LIMIT = 0.55;

/**
 * The full gaze morph moves the iris about twelve degrees. Real saccades follow
 * the main sequence: roughly 21 ms plus 2.2 ms per degree of amplitude, so a
 * small glance lands in about 30 ms and a wide one in 80. The previous fixed
 * 160-260 ms was smooth-pursuit speed, which is why the gaze glided instead of
 * jumping. The floor is a little above the physiological minimum: at 30 fps a
 * frame lasts 33 ms, and a jump completed inside one frame renders as a teleport.
 */
function saccadeSeconds(fromX: number, fromY: number, toX: number, toY: number) {
  const degrees = Math.hypot(toX - fromX, toY - fromY) * GAZE_DEGREES;
  return Math.min(0.09, Math.max(0.045, 0.021 + degrees * 0.0022));
}

/** The widest planned glance; nothing layered on top may exceed it. */
const GLANCE_LIMIT = 0.6;

/** Microsaccades run about a fifth of a degree and land in roughly 20 ms. */
const MICRO_SECONDS = 0.02;
const MICRO_MIN = 0.1 / GAZE_DEGREES;
const MICRO_MAX = 0.45 / GAZE_DEGREES;

const VERTICAL_COMPENSATION_LIMIT = 0.45;
const MINIMUM_BLINK_INTERVAL = 3.35;

/**
 * Coordinated gaze and eyelids on the exported facial morphs. All timings are
 * absolute, so blink closure and gaze transitions do not depend on frame rate.
 * The small positive gaze weights move both irises in the same direction.
 */
export class AvatarEyes {
  private bindings: EyeBinding[] = [];
  private readonly seed: number;
  private blinkRandomState: number;
  private gazeRandomState: number;
  private microRandomState: number;
  private previousTime: number | null = null;

  private blinkStart = Infinity;
  private blinkSecondStart = Infinity;
  private blinkEnd = Infinity;
  private previousBlinkStart = -Infinity;
  private closeDuration = 0.08;
  private closedDuration = 0.04;
  private openDuration = 0.15;
  private eyeDelay = 0.003;

  private gazeStarted = 0;
  private microAt = Infinity;
  private microStarted = 0;
  private microDuration = 0.02;
  private microFromX = 0;
  private microFromY = 0;
  private microX = 0;
  private microY = 0;
  private nextGazeAt = Infinity;
  private gazeDuration = 0.2;
  private gazeFromX = 0;
  private gazeFromY = 0;
  private gazeTargetX = 0;
  private gazeTargetY = 0;
  private glanceX = 0;
  private glanceY = 0;
  private glanceValue = { x: 0, y: 0 };
  private mode: GazeMode = "idle";

  constructor(model: Object3D, seed = 0x47d1a5) {
    this.seed = Number.isFinite(seed) ? seed >>> 0 : 0x47d1a5;
    this.blinkRandomState = this.seed;
    this.gazeRandomState = (this.seed ^ 0x9e3779b9) >>> 0;
    this.microRandomState = (this.seed ^ 0x7f4a7c15) >>> 0;
    model.traverse((object) => {
      if (!(object instanceof Mesh) || !object.morphTargetDictionary || !object.morphTargetInfluences) return;
      const dictionary = object.morphTargetDictionary;
      const binding: EyeBinding = {
        weights: object.morphTargetInfluences,
        blinkRight: dictionary["Palpebra - piscar.D"] ?? -1,
        blinkLeft: dictionary["Palpebra - piscar.E"] ?? -1,
        arcRight: dictionary["Palpebra - arco.D"] ?? -1,
        arcLeft: dictionary["Palpebra - arco.E"] ?? -1,
        right: dictionary["Olhar - direita"] ?? -1,
        left: dictionary["Olhar - esquerda"] ?? -1,
        up: dictionary["Olhar - cima"] ?? -1,
        down: dictionary["Olhar - baixo"] ?? -1,
      };
      if ([binding.blinkRight, binding.blinkLeft, binding.arcRight, binding.arcLeft, binding.right, binding.left, binding.up, binding.down].some((index) => index >= 0)) {
        this.bindings.push(binding);
      }
    });
    this.apply(0, 0, 0, 0);
  }

  /** The eyes' own glance in morph units, without the compensation for head movement. The object is reused; read it within the frame. */
  get glance() {
    this.glanceValue.x = this.glanceX;
    this.glanceValue.y = this.glanceY;
    return this.glanceValue;
  }

  update(nowSeconds: number, motionEnabled: boolean, speechLevel = 0, head?: HeadPose, mode: GazeMode = "idle") {
    if (!motionEnabled || !Number.isFinite(nowSeconds)) {
      this.reset();
      return;
    }

    const elapsed = this.previousTime === null ? 0 : nowSeconds - this.previousTime;
    if (this.previousTime === null || elapsed < 0 || elapsed > 0.75) {
      // Resume with open eyes and a fresh interval; never replay missed blinks.
      this.beginTimeline(nowSeconds);
      this.previousTime = nowSeconds;
      this.glanceX = this.glanceY = 0;
      this.apply(0, 0, 0, 0);
      return;
    }
    this.previousTime = nowSeconds;

    const attention: GazeMode = mode === "listening" || mode === "thinking" ? mode : "idle";
    if (attention !== this.mode) {
      if (attention === "thinking") this.avert(nowSeconds);
      else if (this.mode === "thinking") this.resumeContact(nowSeconds);
      this.mode = attention;
    }

    if (nowSeconds > this.blinkEnd) {
      this.previousBlinkStart = Number.isFinite(this.blinkSecondStart) ? this.blinkSecondStart : this.blinkStart;
      this.planBlink(this.blinkEnd + 3.2 + this.random("blink") * 2.8, true);
    }
    if (nowSeconds >= this.nextGazeAt) {
      const speaking = Number.isFinite(speechLevel) && speechLevel > 0.025;
      const wasAway = this.gazeTargetX !== 0 || this.gazeTargetY !== 0;
      this.gazeFromX = this.gazeTargetX;
      this.gazeFromY = this.gazeTargetY;
      this.gazeStarted = this.nextGazeAt;
      this.gazeDuration = 0;   // set below, once the amplitude is known
      // Mostly retain eye contact. Occasional brief glances are slightly more
      // frequent during speech, with no continuous sinusoidal wandering. A
      // listener glances away rarely; thought wanders more, and upward.
      const threshold = this.mode === "listening" ? 0.9 : this.mode === "thinking" ? 0.5 : speaking ? 0.62 : 0.8;
      const glance = this.random("gaze") > threshold;
      this.gazeTargetX = glance ? (this.random("gaze") < 0.5 ? -1 : 1) * (0.18 + this.random("gaze") * 0.42) : 0;
      this.gazeTargetY = glance ? (this.random("gaze") - (this.mode === "thinking" ? 0.25 : 0.6)) * 0.58 : 0;
      this.gazeDuration = saccadeSeconds(this.gazeFromX, this.gazeFromY, this.gazeTargetX, this.gazeTargetY);
      const hold = glance ? 0.65 + this.random("gaze") * 0.75 : (this.mode === "listening" ? 3.2 : 2.0) + this.random("gaze") * 2.8;
      this.nextGazeAt = this.gazeStarted + this.gazeDuration + hold;
      if (glance || wasAway) this.accompanyGazeShift();
    }

    const gazeBlend = smooth((nowSeconds - this.gazeStarted) / this.gazeDuration);
    this.glanceX = MathUtils.lerp(this.gazeFromX, this.gazeTargetX, gazeBlend);
    this.glanceY = MathUtils.lerp(this.gazeFromY, this.gazeTargetY, gazeBlend);

    // A fixating eye is never still: it makes microsaccades of a few tenths of
    // a degree roughly once a second. Without them the iris reads as glass.
    // They do not occur during a saccade, so the schedule waits one out.
    if (nowSeconds >= this.microAt) {
      this.microFromX = this.microX;
      this.microFromY = this.microY;
      this.microStarted = this.microAt;
      this.microDuration = MICRO_SECONDS;
      const angle = this.random("micro") * Math.PI * 2;
      const size = MICRO_MIN + this.random("micro") * (MICRO_MAX - MICRO_MIN);
      this.microX = Math.cos(angle) * size;
      this.microY = Math.sin(angle) * size;
      this.microAt = this.microStarted + this.microDuration + 0.5 + this.random("micro") * 1.0;
    }
    // Microsaccades do not occur during a saccade: fade them out for its
    // duration and back in over the next 80 ms. Reading only absolute times
    // keeps this identical at any frame rate and independent of the schedules.
    const sinceSaccade = nowSeconds - (this.gazeStarted + this.gazeDuration);
    const untilSaccade = this.nextGazeAt - nowSeconds;
    const fixating = smooth(sinceSaccade / 0.08) * smooth(untilSaccade / 0.08);
    const microBlend = smooth((nowSeconds - this.microStarted) / this.microDuration);
    this.glanceX += MathUtils.lerp(this.microFromX, this.microX, microBlend) * fixating;
    this.glanceY += MathUtils.lerp(this.microFromY, this.microY, microBlend) * fixating;
    this.glanceX = MathUtils.clamp(this.glanceX, -GLANCE_LIMIT, GLANCE_LIMIT);
    this.glanceY = MathUtils.clamp(this.glanceY, -GLANCE_LIMIT, GLANCE_LIMIT);
    let x = this.glanceX;
    let y = this.glanceY;
    if (head) {
      // Like the vestibulo-ocular reflex, the eyes counter-rotate as the head
      // moves so the gaze stays on the visitor instead of drifting with the head.
      const yaw = Number.isFinite(head.yaw) ? head.yaw : 0;
      const pitch = Number.isFinite(head.pitch) ? head.pitch : 0;
      x -= MathUtils.clamp(yaw / RADIANS_PER_HORIZONTAL_UNIT, -HORIZONTAL_COMPENSATION_LIMIT, HORIZONTAL_COMPENSATION_LIMIT);
      y += MathUtils.clamp(pitch / RADIANS_PER_VERTICAL_UNIT, -VERTICAL_COMPENSATION_LIMIT, VERTICAL_COMPENSATION_LIMIT);
      x = MathUtils.clamp(x, -1, 1);
      y = MathUtils.clamp(y, -1, 1);
    }
    const right = Math.max(this.blinkAt(nowSeconds - this.blinkStart), this.blinkAt(nowSeconds - this.blinkSecondStart));
    const left = Math.max(this.blinkAt(nowSeconds - this.blinkStart - this.eyeDelay), this.blinkAt(nowSeconds - this.blinkSecondStart - this.eyeDelay));
    this.apply(right, left, x, y);
  }

  reset() {
    this.previousTime = null;
    this.blinkRandomState = this.seed;
    this.gazeRandomState = (this.seed ^ 0x9e3779b9) >>> 0;
    this.microRandomState = (this.seed ^ 0x7f4a7c15) >>> 0;
    this.blinkStart = this.blinkSecondStart = this.blinkEnd = Infinity;
    this.previousBlinkStart = -Infinity;
    this.nextGazeAt = Infinity;
    this.microAt = Infinity;
    this.microFromX = this.microFromY = this.microX = this.microY = 0;
    this.gazeFromX = this.gazeFromY = this.gazeTargetX = this.gazeTargetY = 0;
    this.glanceX = this.glanceY = 0;
    this.mode = "idle";
    this.apply(0, 0, 0, 0);
  }

  private avert(now: number) {
    // Formulating an answer looks up and aside for a while, as people do
    // under thought; the head follows part of the way through the rig.
    this.gazeFromX = this.glanceX;
    this.gazeFromY = this.glanceY;
    this.gazeStarted = now;
    this.gazeDuration = 0;
    this.gazeTargetX = (this.random("gaze") < 0.5 ? -1 : 1) * (0.45 + this.random("gaze") * 0.25);
    this.gazeTargetY = 0.18 + this.random("gaze") * 0.2;
    this.gazeDuration = saccadeSeconds(this.gazeFromX, this.gazeFromY, this.gazeTargetX, this.gazeTargetY);
    this.nextGazeAt = this.gazeStarted + this.gazeDuration + 2.4 + this.random("gaze") * 2.2;
  }

  private resumeContact(now: number) {
    // The reply begins with eye contact, settled for a moment before the
    // ordinary glances continue.
    this.gazeFromX = this.glanceX;
    this.gazeFromY = this.glanceY;
    this.gazeStarted = now;
    this.gazeTargetX = this.gazeTargetY = 0;
    this.gazeDuration = saccadeSeconds(this.gazeFromX, this.gazeFromY, 0, 0);
    this.nextGazeAt = this.gazeStarted + this.gazeDuration + 1.2 + this.random("gaze") * 1.5;
  }

  private beginTimeline(now: number) {
    this.gazeFromX = this.gazeFromY = this.gazeTargetX = this.gazeTargetY = 0;
    this.gazeStarted = now;
    this.nextGazeAt = now + 1.6 + this.random("gaze");
    this.microFromX = this.microFromY = this.microX = this.microY = 0;
    this.microStarted = now;
    this.microAt = now + 0.6 + this.random("micro") * 0.8;
    this.planBlink(now + 1.8 + this.random("blink") * 1.7, false);
  }

  private accompanyGazeShift() {
    // Blinks often coincide with a change of gaze. Advance an already planned
    // blink to this shift when it is due soon, never shortening the rest
    // interval below its natural minimum.
    const dueSoon = this.blinkStart > this.gazeStarted && this.blinkStart - this.gazeStarted < 1.1;
    const rested = this.gazeStarted - this.previousBlinkStart >= MINIMUM_BLINK_INTERVAL;
    if (this.random("gaze") >= 0.55 || !dueSoon || !rested) return;
    const advance = this.blinkStart - this.gazeStarted;
    this.blinkStart -= advance;
    this.blinkSecondStart -= advance;
    this.blinkEnd -= advance;
  }

  private planBlink(start: number, allowDouble: boolean) {
    this.blinkStart = start;
    this.closeDuration = 0.072 + this.random("blink") * 0.018;
    this.closedDuration = 0.034 + this.random("blink") * 0.016;
    this.openDuration = 0.135 + this.random("blink") * 0.035;
    this.eyeDelay = 0.002 + this.random("blink") * 0.003;
    const duration = this.closeDuration + this.closedDuration + this.openDuration + this.eyeDelay;
    const double = allowDouble && this.random("blink") < 0.08;
    this.blinkSecondStart = double ? start + duration + 0.16 + this.random("blink") * 0.1 : Infinity;
    this.blinkEnd = (double ? this.blinkSecondStart : start) + duration;
  }

  private blinkAt(elapsed: number) {
    if (elapsed < 0 || !Number.isFinite(elapsed)) return 0;
    if (elapsed < this.closeDuration) return smooth(elapsed / this.closeDuration);
    const opening = elapsed - this.closeDuration - this.closedDuration;
    if (opening <= 0) return 1;
    if (opening < this.openDuration) return 1 - smooth(opening / this.openDuration);
    return 0;
  }

  private apply(blinkRight: number, blinkLeft: number, x: number, y: number) {
    // The intermediate corrective surface follows the cornea as lids close.
    // It contributes nothing to the authored fully open or fully closed poses.
    const arcRight = 4 * blinkRight * (1 - blinkRight);
    const arcLeft = 4 * blinkLeft * (1 - blinkLeft);
    for (const binding of this.bindings) {
      if (binding.blinkRight >= 0) binding.weights[binding.blinkRight] = blinkRight;
      if (binding.blinkLeft >= 0) binding.weights[binding.blinkLeft] = blinkLeft;
      if (binding.arcRight >= 0) binding.weights[binding.arcRight] = arcRight;
      if (binding.arcLeft >= 0) binding.weights[binding.arcLeft] = arcLeft;
      if (binding.right >= 0) binding.weights[binding.right] = Math.max(0, x);
      if (binding.left >= 0) binding.weights[binding.left] = Math.max(0, -x);
      if (binding.up >= 0) binding.weights[binding.up] = Math.max(0, y);
      if (binding.down >= 0) binding.weights[binding.down] = Math.max(0, -y);
    }
  }

  private random(channel: "blink" | "gaze" | "micro") {
    // Separate streams keep event ordering independent of render frame rate,
    // even when a gaze change, a microsaccade and a blink land in the same frame.
    const current = channel === "blink" ? this.blinkRandomState
      : channel === "gaze" ? this.gazeRandomState : this.microRandomState;
    const value = (Math.imul(1664525, current) + 1013904223) >>> 0;
    if (channel === "blink") this.blinkRandomState = value;
    else if (channel === "gaze") this.gazeRandomState = value;
    else this.microRandomState = value;
    return value / 0x100000000;
  }
}
