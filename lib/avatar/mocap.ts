import { Quaternion, Vector3 } from "three";

/**
 * A motion clip captured from a person, retargeted onto our skeleton and
 * written out by work/build-mocap-clips.mjs. Everything costly - decoding the
 * FBX, measuring each rig's rest pose, carrying the motion across as a
 * world-space rotation delta - happened when the file was built. What is left
 * here is one local rotation per bone per frame, so playing it back is a slerp.
 */
export type MocapClipData = {
  name: string;
  source: string;
  fps: number;
  frames: number;
  duration: number;
  rootMotion: "keep" | "inPlace";
  travelled: number;
  speed: number;
  bones: string[];
  /** base64 int16, frame-major: [frame][bone][x, y, z, w], scaled by 32767. */
  rotations: string;
  root: { x: number[]; y: number[]; z: number[] };
  /** Metres walked by each frame of the source. In-place clips only. */
  covered?: number[];
  /** Each heel strike of an in-place walk, alternating sides. See timeForStride(). */
  footfalls?: { t: number; side: "D" | "E" }[];
};

const SCALE = 1 / 32767;

function decodeBase64(text: string): Int16Array {
  const binary = typeof atob === "function"
    ? atob(text)
    : Buffer.from(text, "base64").toString("binary");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
}

export class MocapClip {
  readonly name: string;
  readonly fps: number;
  readonly frames: number;
  readonly duration: number;
  readonly bones: readonly string[];
  readonly inPlace: boolean;
  /** Average speed of the source walk, in metres per second. */
  readonly speed: number;
  /** Total ground the source covered, in metres. */
  readonly travelled: number;

  private readonly rotations: Int16Array;
  private readonly root: { x: number[]; y: number[]; z: number[] };
  private readonly covered: number[] | null;
  private readonly footfalls: { t: number; side: "D" | "E" }[] | null;
  private readonly stride: number;
  private readonly sample = new Quaternion();
  private readonly other = new Quaternion();

  constructor(data: MocapClipData) {
    this.name = data.name;
    this.fps = data.fps;
    this.frames = data.frames;
    this.duration = data.duration;
    this.bones = data.bones;
    this.inPlace = data.rootMotion === "inPlace";
    this.speed = data.speed;
    this.travelled = data.travelled;
    this.rotations = decodeBase64(data.rotations);
    this.root = data.root;
    this.covered = data.covered ?? null;
    this.footfalls = data.footfalls ?? null;
    if (this.footfalls) {
      const falls = this.footfalls;
      const alternating = falls.every((fall, index) => fall.side !== falls[(index + 1) % falls.length].side);
      const ordered = falls.every((fall, index) => index === 0 || fall.t > falls[index - 1].t);
      if (falls.length < 4 || falls.length % 2 !== 0 || !alternating || !ordered) {
        throw new Error(`clip ${data.name}: footfalls must be an even, ordered, alternating list of at least four`);
      }
    }
    this.stride = data.bones.length * 4;
    const expected = data.frames * this.stride;
    if (this.rotations.length !== expected) {
      throw new Error(`clip ${data.name}: expected ${expected} rotation components, read ${this.rotations.length}`);
    }
  }

  /** Where in the clip a time lands: the frame before it and how far past it. */
  private locate(seconds: number) {
    // Both clips close on themselves, so time wraps rather than clamps; the
    // last frame blends back into the first.
    const period = this.frames / this.fps;
    let position = (seconds % period) / period * this.frames;
    if (position < 0) position += this.frames;
    const frame = Math.floor(position);
    return { frame: frame % this.frames, next: (frame + 1) % this.frames, blend: position - frame };
  }

  /**
   * The pose at a time, one bone at a time. The rotation handed to the visitor
   * is reused between calls, so a caller that keeps it must copy it.
   */
  pose(seconds: number, visit: (bone: string, rotation: Quaternion) => void) {
    const { frame, next, blend } = this.locate(seconds);
    for (let index = 0; index < this.bones.length; index++) {
      const here = frame * this.stride + index * 4;
      const there = next * this.stride + index * 4;
      this.sample.set(this.rotations[here] * SCALE, this.rotations[here + 1] * SCALE,
        this.rotations[here + 2] * SCALE, this.rotations[here + 3] * SCALE).normalize();
      this.other.set(this.rotations[there] * SCALE, this.rotations[there + 1] * SCALE,
        this.rotations[there + 2] * SCALE, this.rotations[there + 3] * SCALE).normalize();
      visit(this.bones[index], this.sample.slerp(this.other, blend));
    }
  }

  /** Where the hips sit relative to their rest, in metres. */
  rootAt(seconds: number, out: Vector3): Vector3 {
    const { frame, next, blend } = this.locate(seconds);
    const lerp = (track: number[]) => track[frame] + (track[next] - track[frame]) * blend;
    return out.set(lerp(this.root.x), lerp(this.root.y), lerp(this.root.z));
  }

  /** Whether the clip knows where its heels land; see timeForStride(). */
  get hasFootfalls() {
    return this.footfalls !== null;
  }

  /**
   * How many strikes to shift the gait's count by so that the clip's strike
   * lands on the same foot as the walker's. The sides alternate on both, so
   * the answer is zero or one, and once chosen it stays right step after step.
   */
  stepShiftFor(landing: number, side: "D" | "E"): number {
    if (!this.footfalls) return 0;
    const count = this.footfalls.length;
    return this.footfalls[((Math.floor(landing) % count) + count) % count].side === side ? 0 : 1;
  }

  /**
   * The moment in the clip for a point in the gait, where whole numbers are
   * heel strikes. Between two strikes the clip runs linearly from one of its
   * own strikes to the next, so its steps take exactly as long as the
   * walker's - whatever the speed, and while turning on the spot, when the
   * feet step but the body covers no ground at all.
   *
   * This is what an upper body lent to someone else's legs needs. Driven by
   * distance instead, at the navigation's 0.42 m/s the clip's arms and trunk
   * swung at 0.39 Hz while the legs under them strode at 0.91: two rhythms on
   * one body. And turning in place it stood still - 2 to 8 s of frozen torso on
   * every trip - because turning covers no distance.
   */
  timeForStride(phase: number): number {
    if (!this.footfalls) return 0;
    const falls = this.footfalls;
    const count = falls.length;
    const period = this.frames / this.fps;
    const whole = Math.floor(phase);
    const index = ((whole % count) + count) % count;
    const lap = Math.floor(whole / count);
    const start = falls[index].t;
    const end = index + 1 < count ? falls[index + 1].t : falls[0].t + period;
    return lap * period + start + (phase - whole) * (end - start);
  }

  /**
   * The moment in the clip at which the source had walked this far. Speed is
   * not constant inside a stride - it dips at every heel strike - so an
   * in-place clip driven by the clock slides its planted foot even at exactly
   * the right average speed. Driven by distance, the foot stays on the floor
   * at whatever pace the navigation chooses, and slowing down lowers the
   * cadence instead of turning the walk into slow motion.
   */
  timeForDistance(metres: number): number {
    if (!this.covered) return metres / this.speed;
    const laps = Math.floor(metres / this.travelled);
    const within = metres - laps * this.travelled;
    let low = 0, high = this.covered.length - 1;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (this.covered[middle] <= within) low = middle; else high = middle;
    }
    const span = this.covered[high] - this.covered[low];
    const blend = span <= 0 ? 0 : (within - this.covered[low]) / span;
    return laps * (this.frames / this.fps) + (low + blend) / this.fps;
  }
}

export function decodeMocapClips(files: MocapClipData[]): Map<string, MocapClip> {
  const clips = new Map<string, MocapClip>();
  for (const data of files) clips.set(data.name, new MocapClip(data));
  return clips;
}

export type MocapClipFailure = { name: string; error: unknown };

/**
 * Fetches the built clips, each on its own. A clip that cannot be loaded is
 * handed back to the caller to report rather than swallowed, and it costs the
 * poet only the gesture it would have played, which falls back to the
 * procedural one it was built from.
 *
 * Each on its own because they used to be all or nothing: one clip that
 * failed to arrive rejected the lot, so a missing greeting took the walk down
 * with it.
 */
export async function loadMocapClips(names: readonly string[], revision: string, signal?: AbortSignal) {
  const clips = new Map<string, MocapClip>();
  const failed: MocapClipFailure[] = [];
  const outcomes = await Promise.allSettled(names.map(async (name) => {
    const response = await fetch(`/models/clips/${name}.json?v=${revision}`, { signal });
    if (!response.ok) throw new Error(`Não foi possível carregar o movimento "${name}" (HTTP ${response.status}).`);
    return new MocapClip(await response.json() as MocapClipData);
  }));
  outcomes.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") clips.set(names[index], outcome.value);
    else failed.push({ name: names[index], error: outcome.reason });
  });
  return { clips, failed };
}
