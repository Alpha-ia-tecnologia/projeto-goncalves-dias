import { MathUtils } from "three";

/** What the character attends to while not speaking; `level` is the visitor's voice while listening. */
export type AttentionMode = "idle" | "listening" | "thinking";
export type AttentionInput = { mode: AttentionMode; level?: number };
type Damp = (key: string, target: number, omega: number) => number;
type Random = (index: number, salt: number) => number;

const VOICED_LEVEL = 0.06;
const PAUSE_SECONDS = 0.35;
const SPEECH_BEFORE_NOD_SECONDS = 0.8;
const NOD_INTERVAL_SECONDS = 2.5;

/**
 * Listening and thinking between replies. Listening tilts toward the visitor
 * and acknowledges a pause after a stretch of their voice with one small nod;
 * thinking turns away to a freshly chosen side until the reply begins.
 */
export class AttentionTracker {
  mode: AttentionMode = "idle";
  listen = 0;
  think = 0;
  listenSide = 1;
  thinkSide = 1;
  backchannelAt = -Infinity;
  private switches = 0;
  private visitorSpeaking = false;
  private voiceSince = -Infinity;
  private silentSince = -Infinity;

  update(now: number, input: AttentionInput | undefined, damp: Damp, random: Random) {
    const mode = input?.mode === "listening" || input?.mode === "thinking" ? input.mode : "idle";
    if (mode !== this.mode) {
      this.switches += 1;
      if (mode === "listening") this.listenSide = random(this.switches, 7) < 0.5 ? -1 : 1;
      if (mode === "thinking") this.thinkSide = random(this.switches, 8) < 0.5 ? -1 : 1;
      this.visitorSpeaking = false;
      this.mode = mode;
    }
    this.listen = damp("attention-listen", mode === "listening" ? 1 : 0, 2.8);
    this.think = damp("attention-think", mode === "thinking" ? 1 : 0, 3.2);
    if (mode !== "listening") return;
    const level = input?.level;
    const voiced = Number.isFinite(level) && MathUtils.clamp(level!, 0, 1) > VOICED_LEVEL;
    if (voiced && !this.visitorSpeaking) {
      this.visitorSpeaking = true;
      this.voiceSince = now;
    } else if (!voiced && this.visitorSpeaking) {
      this.visitorSpeaking = false;
      this.silentSince = now;
    }
    // One nod per pause, only after the visitor has actually said something.
    if (!this.visitorSpeaking && now - this.silentSince >= PAUSE_SECONDS
      && this.silentSince - this.voiceSince >= SPEECH_BEFORE_NOD_SECONDS
      && this.backchannelAt < this.silentSince && now - this.backchannelAt >= NOD_INTERVAL_SECONDS) {
      this.backchannelAt = now;
    }
  }

  reset() {
    this.mode = "idle";
    this.listen = this.think = 0;
    this.visitorSpeaking = false;
    this.voiceSince = this.silentSince = this.backchannelAt = -Infinity;
  }
}
