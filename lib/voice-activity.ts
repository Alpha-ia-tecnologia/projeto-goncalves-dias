export type VoiceActivity = 'listening' | 'complete' | 'no-speech';

/** Conservative turn detection: a short noise burst cannot submit a recording. */
export class VoiceActivityDetector {
  private previousTime: number;
  private voicedMs = 0;
  private lastVoiceTime: number | null = null;

  constructor(private readonly startedAt: number) {
    this.previousTime = startedAt;
  }

  update(rms: number, now: number): VoiceActivity {
    const elapsed = Math.max(0, Math.min(200, now - this.previousTime));
    this.previousTime = now;
    const recentVoice = this.lastVoiceTime !== null && now - this.lastVoiceTime < 240;
    const threshold = recentVoice ? 0.009 : 0.015;
    if (Number.isFinite(rms) && rms >= threshold) {
      if (this.voicedMs < 240 && this.lastVoiceTime !== null && now - this.lastVoiceTime > 400) this.voicedMs = 0;
      this.voicedMs += elapsed;
      this.lastVoiceTime = now;
    }
    if (this.voicedMs >= 240 && this.lastVoiceTime !== null && now - this.lastVoiceTime >= 1400) return 'complete';
    if (this.voicedMs < 240 && now - this.startedAt >= 8000) return 'no-speech';
    return 'listening';
  }
}
