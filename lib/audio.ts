export type MouthFrame = { open: number; round: number; wide: number; level: number };
export const CLOSED_MOUTH: MouthFrame = { open: 0, round: 0, wide: 0, level: 0 };
const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

/** Audio-energy animation, not phoneme recognition. Silence always closes the lips. */
export function mouthFromAudio(rms: number, lowEnergy = 1, highEnergy = 1): MouthFrame {
  if (!Number.isFinite(rms) || rms < 0.008) return { ...CLOSED_MOUTH };
  // A soft knee preserves the difference between ordinary and emphatic syllables.
  // The old linear gain flattened every loud vowel at the same 0.82 opening.
  const open = 0.98 * -Math.expm1(-(rms - 0.008) / 0.075);
  const low = Number.isFinite(lowEnergy) ? Math.max(0, lowEnergy) : 0;
  const high = Number.isFinite(highEnergy) ? Math.max(0, highEnergy) : 0;
  const balance = (low - high) / Math.max(0.0001, low + high);
  // Spectral colour suggests a lip shape; it does not identify a phoneme.
  // Stretching and rounding oppose one another, so avoid pulling both ways.
  return {
    open,
    round: open * Math.max(0, balance) * 0.52,
    wide: open * Math.max(0, -balance) * 0.46,
    level: clamp(rms * 5),
  };
}

/** Slow, bounded sensitivity adaptation; it never filters the syllable envelope. */
export class MouthAudioEnvelope {
  private voiceReference = 0.09;

  frame(rms: number, lowEnergy = 1, highEnergy = 1, deltaSeconds = 1 / 60): MouthFrame {
    if (!Number.isFinite(rms) || rms < 0.008) return { ...CLOSED_MOUTH };
    // Learn only while voice is present, so a pause cannot amplify background noise.
    const dt = Number.isFinite(deltaSeconds) ? clamp(deltaSeconds, 0, 0.05) : 0;
    const reference = clamp(rms, 0.025, 0.24);
    this.voiceReference += (reference - this.voiceReference) * -Math.expm1(-dt / 0.9);
    const sensitivity = clamp(Math.pow(0.09 / this.voiceReference, 0.65), 0.8, 2.4);
    const frame = mouthFromAudio(rms * sensitivity, lowEnergy, highEnergy);
    // Hand/body gestures continue to receive the original, unnormalised energy.
    frame.level = clamp(rms * 5);
    return frame;
  }
}

/** RMS amplitude of a frequency band from Web Audio's dB power spectrum. */
export function spectralBandEnergy(
  spectrum: Float32Array, sampleRate: number, fftSize: number, fromHz: number, toHz: number,
): number {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(fftSize) || fftSize <= 0) return 0;
  const start = Math.max(0, Math.ceil(fromHz * fftSize / sampleRate));
  const end = Math.min(spectrum.length, Math.ceil(toHz * fftSize / sampleRate));
  let power = 0;
  for (let index = start; index < end; index++) {
    const decibels = spectrum[index];
    if (Number.isFinite(decibels)) power += Math.pow(10, Math.min(0, decibels) / 10);
  }
  return Math.sqrt(power / Math.max(1, end - start));
}

const PCM_SAMPLE_RATE = 24_000;
const PCM_BLOCK_BYTES = 3_840; // 80 ms of signed, little-endian 16-bit mono PCM.
const PCM_START_BYTES = PCM_BLOCK_BYTES * 2; // Absorb small variations in network delivery.
const MAX_PCM_BYTES = 20 * 1024 * 1024;
const MAX_SCHEDULE_AHEAD_SECONDS = 0.65;
const START_LEAD_SECONDS = 0.04;
const cancelled = () => new DOMException('Reprodução cancelada', 'AbortError');

class SpeechPlaybackError extends Error {}

type Playback = {
  abort: AbortController;
  sources: Set<AudioBufferSourceNode>;
  analyser: AnalyserNode | null;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  raf: number;
  firstStart: number | null;
  started: boolean;
  onStart?: () => void;
  onDrained?: () => void;
};

/** Race non-cancellable Web Audio work against this playback's own cancellation. */
function interruptible<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => undefined); return Promise.reject(cancelled()); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(cancelled()); };
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(cancelled()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function pcmAsWav(chunks: Uint8Array[], byteLength: number): ArrayBuffer {
  const wav = new ArrayBuffer(44 + byteLength);
  const view = new DataView(wav);
  const label = (at: number, value: string) => {
    for (let index = 0; index < value.length; index++) view.setUint8(at + index, value.charCodeAt(index));
  };
  label(0, 'RIFF'); view.setUint32(4, 36 + byteLength, true);
  label(8, 'WAVE'); label(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, PCM_SAMPLE_RATE, true); view.setUint32(28, PCM_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  label(36, 'data'); view.setUint32(40, byteLength, true);
  const bytes = new Uint8Array(wav);
  let offset = 44;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return wav;
}

export class SpeechPlayer {
  private context: AudioContext | null = null;
  private playback: Playback | null = null;
  private disposed = false;
  constructor(private readonly onFrame: (frame: MouthFrame) => void) {}

  async unlock() {
    if (this.disposed) throw cancelled();
    if (!this.context || this.context.state === 'closed') this.context = new AudioContext();
    if (this.context.state === 'suspended') await this.context.resume();
  }

  private begin(onStart?: () => void): Playback {
    this.stop();
    if (this.disposed) throw cancelled();
    const playback: Playback = {
      abort: new AbortController(), sources: new Set(), analyser: null, reader: null,
      raf: 0, firstStart: null, started: false, onStart,
    };
    this.playback = playback;
    return playback;
  }

  private assertCurrent(playback: Playback) {
    if (this.playback !== playback || playback.abort.signal.aborted || this.disposed) throw cancelled();
  }

  private async prepare(playback: Playback): Promise<AudioContext> {
    await interruptible(this.unlock(), playback.abort.signal);
    this.assertCurrent(playback);
    const context = this.context!;
    if (context.state !== 'running') throw new SpeechPlaybackError('O navegador bloqueou o áudio. Toque em ouvir novamente.');
    const analyser = context.createAnalyser();
    // Keep the analysis window near 21 ms on 24, 44.1, 48 and 96 kHz devices.
    analyser.fftSize = 2 ** Math.round(Math.log2(clamp(context.sampleRate * 0.02133, 256, 4096)));
    analyser.smoothingTimeConstant = 0.08;
    analyser.connect(context.destination);
    playback.analyser = analyser;
    return context;
  }

  private notifyStart(playback: Playback, context: AudioContext) {
    if (this.playback !== playback || playback.started || playback.firstStart === null || context.state !== 'running') return;
    if (context.currentTime < playback.firstStart) return;
    playback.started = true;
    playback.onStart?.();
  }

  private analyse(playback: Playback, context: AudioContext) {
    const analyser = playback.analyser!;
    const samples = new Float32Array(analyser.fftSize);
    const spectrum = new Float32Array(analyser.frequencyBinCount);
    const envelope = new MouthAudioEnvelope();
    let lastTime = context.currentTime;
    const band = (from: number, to: number) => spectralBandEnergy(spectrum, context.sampleRate, analyser.fftSize, from, to);
    const update = () => {
      if (this.playback !== playback || playback.abort.signal.aborted) return;
      this.notifyStart(playback, context);
      analyser.getFloatTimeDomainData(samples);
      analyser.getFloatFrequencyData(spectrum);
      let energy = 0;
      for (const sample of samples) energy += sample * sample;
      const now = context.currentTime;
      const delta = now - lastTime;
      lastTime = now;
      this.onFrame(playback.started
        ? envelope.frame(Math.sqrt(energy / samples.length), band(250, 850), band(1100, 3000), delta)
        : { ...CLOSED_MOUTH });
      playback.raf = requestAnimationFrame(update);
    };
    playback.raf = requestAnimationFrame(update);
  }

  private schedule(playback: Playback, context: AudioContext, buffer: AudioBuffer, at: number) {
    this.assertCurrent(playback);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(playback.analyser!);
    playback.sources.add(source);
    source.onended = () => {
      source.disconnect();
      playback.sources.delete(source);
      if (this.playback !== playback || playback.abort.signal.aborted) return;
      this.notifyStart(playback, context);
      if (playback.sources.size === 0) playback.onDrained?.();
    };
    source.start(at);
    if (playback.firstStart === null) {
      playback.firstStart = at;
      this.analyse(playback, context);
    }
  }

  private async drain(playback: Playback) {
    this.assertCurrent(playback);
    if (playback.sources.size === 0) return;
    await interruptible(new Promise<void>(resolve => { playback.onDrained = resolve; }), playback.abort.signal);
    this.assertCurrent(playback);
    playback.onDrained = undefined;
  }

  /** Decode a complete WAV (demo audio or replay). */
  async play(bytes: ArrayBuffer, onStart?: () => void): Promise<void> {
    const playback = this.begin(onStart);
    try {
      const context = await this.prepare(playback);
      const buffer = await interruptible(context.decodeAudioData(bytes.slice(0)), playback.abort.signal);
      this.assertCurrent(playback);
      this.schedule(playback, context, buffer, context.currentTime + START_LEAD_SECONDS);
      await this.drain(playback);
    } finally {
      this.release(playback);
    }
  }

  /** Play OpenAI's raw 24 kHz PCM while it arrives, returning a WAV only after playback drains. */
  async playStream(stream: ReadableStream<Uint8Array>, onStart?: () => void): Promise<ArrayBuffer> {
    const playback = this.begin(onStart);
    const chunks: Uint8Array[] = [];
    const pending: Uint8Array[] = [];
    let pendingOffset = 0;
    let pendingBytes = 0;
    let totalBytes = 0;
    let nextStart: number | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let ended = false;
    try {
      reader = stream.getReader();
      playback.reader = reader;
      const context = await this.prepare(playback);
      const flush = async (final: boolean) => {
        if (nextStart === null && !final && pendingBytes < PCM_START_BYTES) return;
        while (pendingBytes >= PCM_BLOCK_BYTES || (final && pendingBytes >= 2)) {
          this.assertCurrent(playback);
          while (nextStart !== null && nextStart - context.currentTime > MAX_SCHEDULE_AHEAD_SECONDS) {
            await delay(20, playback.abort.signal);
            this.assertCurrent(playback);
          }
          const size = Math.min(PCM_BLOCK_BYTES, pendingBytes - pendingBytes % 2);
          const pcm = new Uint8Array(size);
          let offset = 0;
          while (offset < size) {
            const head = pending[0];
            const length = Math.min(head.byteLength - pendingOffset, size - offset);
            pcm.set(head.subarray(pendingOffset, pendingOffset + length), offset);
            offset += length;
            pendingOffset += length;
            if (pendingOffset === head.byteLength) { pending.shift(); pendingOffset = 0; }
          }
          pendingBytes -= size;
          const buffer = context.createBuffer(1, size / 2, PCM_SAMPLE_RATE);
          const samples = buffer.getChannelData(0);
          const view = new DataView(pcm.buffer);
          for (let index = 0; index < samples.length; index++) samples[index] = view.getInt16(index * 2, true) / 32_768;
          // Resume after an actual network underrun; otherwise keep every block sample-contiguous.
          const at: number = nextStart === null || nextStart < context.currentTime
            ? context.currentTime + START_LEAD_SECONDS : nextStart;
          this.schedule(playback, context, buffer, at);
          nextStart = at + buffer.duration;
        }
      };
      while (true) {
        const item = await interruptible(reader.read(), playback.abort.signal);
        this.assertCurrent(playback);
        if (item.done) { ended = true; break; }
        if (!item.value.byteLength) continue;
        totalBytes += item.value.byteLength;
        if (totalBytes > MAX_PCM_BYTES) throw new SpeechPlaybackError('O áudio excedeu o tamanho permitido. Tente uma resposta mais curta.');
        const chunk = item.value.slice();
        chunks.push(chunk);
        pending.push(chunk);
        pendingBytes += chunk.byteLength;
        await flush(false);
      }
      if (!totalBytes) throw new SpeechPlaybackError('A resposta de voz veio sem áudio. Tente novamente.');
      if (totalBytes % 2) throw new SpeechPlaybackError('A transmissão de voz terminou incompleta. Tente novamente.');
      await flush(true);
      await this.drain(playback);
      this.assertCurrent(playback);
      return pcmAsWav(chunks, totalBytes);
    } catch (error) {
      if (playback.abort.signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw cancelled();
      if (error instanceof SpeechPlaybackError) throw error;
      throw new Error('A transmissão da voz foi interrompida. Verifique sua conexão e tente novamente.', { cause: error });
    } finally {
      if (reader && !ended) void reader.cancel().catch(() => undefined);
      if (reader) {
        try { reader.releaseLock(); } catch { /* A cancelled read can still be settling. */ }
      }
      playback.reader = null;
      this.release(playback);
    }
  }

  private release(playback: Playback) {
    if (this.playback !== playback) return;
    this.playback = null;
    playback.abort.abort();
    cancelAnimationFrame(playback.raf);
    if (playback.reader) void playback.reader.cancel().catch(() => undefined);
    playback.reader = null;
    for (const source of playback.sources) {
      source.onended = null;
      try { source.stop(); } catch { /* Already finished. */ }
      source.disconnect();
    }
    playback.sources.clear();
    playback.analyser?.disconnect();
    playback.analyser = null;
    playback.onDrained = undefined;
    this.onFrame({ ...CLOSED_MOUTH });
  }

  stop() {
    if (this.playback) this.release(this.playback);
    else this.onFrame({ ...CLOSED_MOUTH });
  }

  dispose() {
    this.disposed = true;
    this.stop();
    const context = this.context;
    this.context = null;
    if (context && context.state !== 'closed') void context.close().catch(() => undefined);
  }
}
