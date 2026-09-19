export type MouthFrame = { open: number; round: number; wide: number; level: number };
export const CLOSED_MOUTH: MouthFrame = { open: 0, round: 0, wide: 0, level: 0 };
const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

/** Audio-energy animation, not phoneme recognition. Silence always closes the lips. */
export function mouthFromAudio(rms: number, lowEnergy = 1, highEnergy = 1): MouthFrame {
  if (!Number.isFinite(rms) || rms < 0.008) return { ...CLOSED_MOUTH };
  const open = Math.min(0.94, Math.pow(clamp((rms - 0.008) * 8), 0.72));
  const total = Math.max(0.0001, lowEnergy + highEnergy);
  return { open, round: open * clamp(lowEnergy / total) * 0.65, wide: open * clamp(highEnergy / total) * 0.55, level: clamp(rms * 5) };
}

export class SpeechPlayer {
  private context: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private raf = 0;
  private generation = 0;
  private disposed = false;
  private finish: (() => void) | null = null;
  constructor(private readonly onFrame: (frame: MouthFrame) => void) {}

  async unlock() {
    if (this.disposed) throw new DOMException('Reprodução cancelada', 'AbortError');
    if (!this.context || this.context.state === 'closed') this.context = new AudioContext();
    if (this.context.state === 'suspended') await this.context.resume();
  }

  async play(bytes: ArrayBuffer, onStart?: () => void) {
    this.stop();
    const generation = this.generation;
    await this.unlock();
    if (generation !== this.generation || !this.context || this.disposed) throw new DOMException('Reprodução cancelada', 'AbortError');
    const context = this.context;
    const buffer = await context.decodeAudioData(bytes.slice(0));
    if (generation !== this.generation) throw new DOMException('Reprodução cancelada', 'AbortError');
    if (context.state !== 'running') throw new Error('O navegador bloqueou o áudio. Toque em ouvir novamente.');
    const source = context.createBufferSource();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.28;
    source.buffer = buffer;
    source.connect(analyser);
    analyser.connect(context.destination);
    this.source = source;
    this.analyser = analyser;
    const samples = new Float32Array(analyser.fftSize);
    const spectrum = new Uint8Array(analyser.frequencyBinCount);
    const band = (from: number, to: number) => {
      const start = Math.max(0, Math.floor(from * analyser.fftSize / context.sampleRate));
      const end = Math.min(spectrum.length, Math.ceil(to * analyser.fftSize / context.sampleRate));
      let value = 0;
      for (let i = start; i < end; i++) value += spectrum[i];
      return value / Math.max(1, end - start);
    };
    const update = () => {
      if (generation !== this.generation || this.source !== source) return;
      analyser.getFloatTimeDomainData(samples);
      analyser.getByteFrequencyData(spectrum);
      let energy = 0;
      for (const sample of samples) energy += sample * sample;
      this.onFrame(mouthFromAudio(Math.sqrt(energy / samples.length), band(250, 850), band(1100, 3000)));
      this.raf = requestAnimationFrame(update);
    };
    return new Promise<void>((resolve, reject) => {
      this.finish = resolve;
      source.onended = () => {
        if (this.source !== source) return;
        this.stop();
      };
      try {
        source.start();
        onStart?.();
        update();
      } catch (error) {
        this.finish = null;
        this.stop();
        reject(error);
      }
    });
  }

  stop() {
    this.generation += 1;
    cancelAnimationFrame(this.raf);
    const source = this.source;
    this.source = null;
    if (source) {
      source.onended = null;
      try { source.stop(); } catch { /* Already finished. */ }
      source.disconnect();
    }
    this.analyser?.disconnect();
    this.analyser = null;
    this.onFrame({ ...CLOSED_MOUTH });
    this.finish?.();
    this.finish = null;
  }

  dispose() {
    this.disposed = true;
    this.stop();
    const context = this.context;
    this.context = null;
    if (context && context.state !== 'closed') void context.close().catch(() => undefined);
  }
}