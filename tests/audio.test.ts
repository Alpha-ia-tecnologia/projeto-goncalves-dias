import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLOSED_MOUTH, MouthAudioEnvelope, mouthFromAudio, spectralBandEnergy, SpeechPlayer } from '../lib/audio';
import { getDemoReply } from '../lib/demo';

describe('sincronia a partir do áudio', () => {
  it('fecha a boca no silêncio e em entradas inválidas', () => {
    for (const rms of [0, 0.002, Number.NaN]) expect(mouthFromAudio(rms).open).toBe(0);
  });
  it('aumenta com a energia e limita os morph targets', () => {
    expect(mouthFromAudio(.1).open).toBeGreaterThan(mouthFromAudio(.02).open);
    const frame = mouthFromAudio(100, 0, 0);
    for (const value of Object.values(frame)) expect(value).toBeGreaterThanOrEqual(0);
    for (const value of Object.values(frame)) expect(value).toBeLessThanOrEqual(1);
  });
  it('mantém a articulação moderada mesmo em trechos muito altos', () => {
    expect(mouthFromAudio(.07).open).toBeGreaterThan(.1);
    expect(mouthFromAudio(.07).open).toBeLessThan(.6);
    expect(mouthFromAudio(.24).open).toBeGreaterThan(mouthFromAudio(.16).open);
    expect(mouthFromAudio(10).open).toBeLessThan(1);
  });
  it('diferencia o formato dos lábios e rejeita bandas inválidas', () => {
    const rounded = mouthFromAudio(.09, 180, 30);
    const wide = mouthFromAudio(.09, 30, 180);
    const neutral = mouthFromAudio(.09, 100, 100);
    expect(rounded.round).toBeGreaterThan(rounded.wide);
    expect(wide.wide).toBeGreaterThan(wide.round);
    expect(neutral.round + neutral.wide).toBeLessThan(.05);
    for (const bands of [[Number.NaN, 2], [Infinity, -3], [-2, -3]]) {
      for (const value of Object.values(mouthFromAudio(.09, bands[0], bands[1]))) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });
  it('faz aceno em saudações, sem confundir palavras ou negações', () => {
    expect(getDemoReply('Olá, tudo bem?').gesture).toBe('wave');
    expect(getDemoReply('Oi!').gesture).toBe('wave');
    expect(getDemoReply('Uma coisa qualquer').gesture).toBe('none');
    expect(getDemoReply('Não acene para mim').gesture).toBe('none');
  });
});

function localSpeechFrames(name: string, gain = 1) {
  const bytes = readFileSync(resolve('public/audio', name + '.wav'));
  let sampleRate = 0;
  let channels = 0;
  let samples = new Float32Array();
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4);
    const kind = bytes.toString('ascii', offset, offset + 4);
    if (kind === 'fmt ') {
      expect(bytes.readUInt16LE(offset + 8)).toBe(1); // PCM, not compressed audio.
      expect(bytes.readUInt16LE(offset + 22)).toBe(16);
      channels = bytes.readUInt16LE(offset + 10);
      sampleRate = bytes.readUInt32LE(offset + 12);
    }
    if (kind === 'data') {
      const start = offset + 8;
      const length = Math.floor(Math.min(size, bytes.length - start) / (2 * channels));
      samples = Float32Array.from({ length }, (_, index) => bytes.readInt16LE(start + index * channels * 2) / 32768 * gain);
      break;
    }
    offset += 8 + size + size % 2;
  }
  expect(sampleRate).toBeGreaterThan(0);
  expect(samples.length).toBeGreaterThan(sampleRate);
  const envelope = new MouthAudioEnvelope();
  const frames: { rms: number; before: number; open: number; level: number }[] = [];
  const window = Math.round(sampleRate * .02133);
  for (let index = 0; index + window < samples.length; index += Math.round(sampleRate / 60)) {
    let energy = 0;
    for (let sample = index; sample < index + window; sample++) energy += samples[sample] ** 2;
    const rms = Math.sqrt(energy / window);
    const frame = envelope.frame(rms, 1, 1, 1 / 60);
    frames.push({ rms, before: rms < .008 ? 0 : .82 * Math.min(1, (rms - .008) * 7) ** .78, open: frame.open, level: frame.level });
  }
  return frames;
}

const percentile = (values: number[], quantile: number) => {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.round((ordered.length - 1) * quantile)];
};

describe('sensibilidade da boca durante a fala', () => {
  it('adapta uma voz baixa sem alterar a energia enviada aos gestos', () => {
    const envelope = new MouthAudioEnvelope();
    let frame = CLOSED_MOUTH;
    for (let index = 0; index < 300; index++) frame = envelope.frame(.025, 1, 1, 1 / 60);
    expect(frame.open).toBeGreaterThan(mouthFromAudio(.025).open * 2);
    expect(frame.open).toBeLessThan(.55);
    expect(frame.level).toBe(.125);
    // Each new playback starts with its own sensitivity.
    expect(new MouthAudioEnvelope().frame(.025).open).toBeLessThan(frame.open * .6);
  });

  it('fecha no silencio, nao aprende ruido e reage imediatamente entre silabas', () => {
    const envelope = new MouthAudioEnvelope();
    const uninterrupted = new MouthAudioEnvelope();
    for (let index = 0; index < 180; index++) {
      envelope.frame(.04);
      uninterrupted.frame(.04);
    }
    for (let index = 0; index < 300; index++) expect(envelope.frame(.006)).toEqual(CLOSED_MOUTH);
    expect(envelope.frame(.04)).toEqual(uninterrupted.frame(.04));
    const soft = envelope.frame(.025).open;
    expect(envelope.frame(.1).open - soft).toBeGreaterThan(.3);
    expect(envelope.frame(0)).toEqual(CLOSED_MOUTH);
    for (const invalid of [Number.NaN, Infinity, -1]) expect(envelope.frame(invalid)).toEqual(CLOSED_MOUTH);
  });

  it('mantem a adaptacao consistente em diferentes taxas de quadros', () => {
    const run = (fps: number) => {
      const envelope = new MouthAudioEnvelope();
      let open = 0;
      for (let index = 0; index < fps * 3; index++) open = envelope.frame(.04, 1, 1, 1 / fps).open;
      return open;
    };
    expect(run(30)).toBeCloseTo(run(120), 10);
  });

  it.each(['generic', 'greeting', 'poetry', 'wave'])('articula a voz real de %s com contraste e pausas fechadas', name => {
    const frames = localSpeechFrames(name);
    const voiced = frames.filter(frame => frame.rms >= .008);
    const openings = voiced.map(frame => frame.open);
    expect(percentile(openings, .5)).toBeGreaterThan(percentile(voiced.map(frame => frame.before), .5) * 1.12);
    expect(percentile(openings, .9) - percentile(openings, .5)).toBeGreaterThan(.12);
    expect(Math.max(...openings)).toBeLessThan(.98);
    expect(frames.filter(frame => frame.rms < .008).every(frame => frame.open === 0 && frame.level === 0)).toBe(true);
    for (const frame of voiced) expect(frame.level).toBe(Math.min(1, frame.rms * 5));
  });

  it('preserva articulacao quando a mesma gravacao chega com volume menor', () => {
    const quiet = localSpeechFrames('poetry', .35).filter(frame => frame.rms >= .012);
    expect(percentile(quiet.map(frame => frame.open), .5))
      .toBeGreaterThan(percentile(quiet.map(frame => mouthFromAudio(frame.rms).open), .5) * 1.35);
  });

  it.each([24000, 44100, 48000, 96000])('mede bandas em hertz corretamente no dispositivo de %i Hz', sampleRate => {
    const fftSize = 2 ** Math.round(Math.log2(sampleRate * .02133));
    const spectrum = new Float32Array(fftSize / 2).fill(-Infinity);
    for (let index = 0; index < spectrum.length; index++) {
      const frequency = index * sampleRate / fftSize;
      if (frequency >= 250 && frequency < 850) spectrum[index] = -20;
      if (frequency >= 1100 && frequency < 3000) spectrum[index] = -40;
    }
    expect(spectralBandEnergy(spectrum, sampleRate, fftSize, 250, 850)).toBeCloseTo(.1, 7);
    expect(spectralBandEnergy(spectrum, sampleRate, fftSize, 1100, 3000)).toBeCloseTo(.01, 7);
    expect(spectralBandEnergy(spectrum, sampleRate, fftSize, 3500, 5000)).toBe(0);
  });
});

class TestBuffer {
  readonly data: Float32Array;
  readonly duration: number;
  constructor(readonly length: number, readonly sampleRate: number) {
    this.data = new Float32Array(length);
    this.duration = length / sampleRate;
  }
  getChannelData() { return this.data; }
}

class TestSource {
  buffer: TestBuffer | null = null;
  onended: (() => void) | null = null;
  startedAt = Number.POSITIVE_INFINITY;
  scheduledAt = 0;
  stopped = false;
  connect = vi.fn();
  disconnect = vi.fn();
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private context: TestContext) {}
  start(at = this.context.currentTime) {
    this.startedAt = at;
    this.scheduledAt = this.context.currentTime;
    this.timer = setTimeout(() => this.onended?.(), Math.max(0, (at + this.buffer!.duration - this.context.currentTime) * 1000));
  }
  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); }
}

class TestAnalyser {
  fftSize = 2048;
  smoothingTimeConstant = 0;
  get frequencyBinCount() { return this.fftSize / 2; }
  connect = vi.fn();
  disconnect = vi.fn();
  constructor(private context: TestContext) {}
  getFloatTimeDomainData(data: Float32Array) {
    const active = this.context.sources.some(source => !source.stopped && source.startedAt <= this.context.currentTime
      && source.startedAt + source.buffer!.duration > this.context.currentTime);
    data.fill(active ? 0.2 : 0);
  }
  getFloatFrequencyData(data: Float32Array) { data.fill(-30); }
}

class TestContext {
  static instances: TestContext[] = [];
  sources: TestSource[] = [];
  analysers: TestAnalyser[] = [];
  state: AudioContextState = 'running';
  destination = {};
  sampleRate = 48_000;
  private origin = Date.now();
  get currentTime() { return (Date.now() - this.origin) / 1000; }
  constructor() { TestContext.instances.push(this); }
  resume = vi.fn(async () => { this.state = 'running'; });
  close = vi.fn(async () => { this.state = 'closed'; });
  createBuffer(_channels: number, length: number, sampleRate: number) { return new TestBuffer(length, sampleRate); }
  createBufferSource() { const source = new TestSource(this); this.sources.push(source); return source; }
  createAnalyser() { const analyser = new TestAnalyser(this); this.analysers.push(analyser); return analyser; }
  decodeAudioData = vi.fn(async () => new TestBuffer(4800, 24_000));
}

function controlledStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel });
  return { stream, controller, cancel };
}

function pcm(length: number) {
  const bytes = new Uint8Array(length);
  const values = [0, -32768, 32767, 16384];
  const view = new DataView(bytes.buffer);
  for (let offset = 0; offset + 1 < length; offset += 2) view.setInt16(offset, values[(offset / 2) % values.length], true);
  return bytes;
}

const flushPromises = () => vi.advanceTimersByTimeAsync(0);

describe('voz PCM progressiva', () => {
  let player: SpeechPlayer;
  const frame = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    TestContext.instances = [];
    frame.mockClear();
    vi.stubGlobal('AudioContext', TestContext);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 16));
    vi.stubGlobal('cancelAnimationFrame', (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer));
    player = new SpeechPlayer(frame);
  });
  afterEach(() => {
    player.dispose();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('começa antes do fim da transmissão, mantém blocos contíguos e devolve WAV apenas após tocar tudo', async () => {
    const { stream, controller } = controlledStream();
    const started = vi.fn();
    let finished = false;
    const promise = player.playStream(stream, started).then(result => { finished = true; return result; });
    const first = pcm(7680);
    controller.enqueue(first.subarray(0, 3));
    await flushPromises();
    const context = TestContext.instances[0];
    expect(context.sources).toHaveLength(0);
    controller.enqueue(first.subarray(3));
    await flushPromises();
    expect(context.sources).toHaveLength(2);
    expect(context.sources[0].buffer!.data.slice(0, 4)).toEqual(new Float32Array([0, -1, 32767 / 32768, .5]));
    expect(context.sources[1].startedAt).toBeCloseTo(context.sources[0].startedAt + context.sources[0].buffer!.duration, 9);
    expect(started).not.toHaveBeenCalled();
    expect(frame.mock.calls.every(([value]) => value.open === 0)).toBe(true);
    await vi.advanceTimersByTimeAsync(65);
    expect(started).toHaveBeenCalledTimes(1);
    expect(frame.mock.calls.some(([value]) => value.open > 0)).toBe(true);
    expect(finished).toBe(false); // The network is still open while the user already hears the answer.
    controller.enqueue(pcm(3840));
    controller.close();
    await flushPromises();
    expect(context.sources).toHaveLength(3);
    expect(finished).toBe(false); // Network completion is not playback completion.
    await vi.advanceTimersByTimeAsync(240);
    const wav = await promise;
    expect(wav.byteLength).toBe(44 + 11520);
    expect(new TextDecoder().decode(new Uint8Array(wav, 0, 4))).toBe('RIFF');
    expect(new DataView(wav).getUint32(24, true)).toBe(24000);
    expect(new DataView(wav).getUint16(22, true)).toBe(1);
    expect(new Uint8Array(wav, 44, 7680)).toEqual(first);
    expect(started).toHaveBeenCalledTimes(1);
    expect(context.analysers).toHaveLength(1);
    expect(context.analysers[0].disconnect).toHaveBeenCalledOnce();
    expect(frame).toHaveBeenLastCalledWith(CLOSED_MOUTH);
    expect(stream.locked).toBe(false);
  });

  it('toca também uma fala menor que o buffer inicial, inclusive amostras divididas entre chunks', async () => {
    const { stream, controller } = controlledStream();
    const started = vi.fn();
    const promise = player.playStream(stream, started);
    const bytes = pcm(8);
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    controller.close();
    await flushPromises();
    expect(TestContext.instances[0].sources).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    const wav = await promise;
    expect(new Uint8Array(wav, 44)).toEqual(bytes);
    expect(started).toHaveBeenCalledOnce();
  });

  it('limita a antecedência da agenda mesmo quando vários segundos chegam em um único chunk', async () => {
    const { stream, controller } = controlledStream();
    const promise = player.playStream(stream);
    controller.enqueue(pcm(144000)); // Three seconds received all at once.
    controller.close();
    await flushPromises();
    const context = TestContext.instances[0];
    expect(context.sources.length).toBeGreaterThan(1);
    expect(context.sources.length).toBeLessThan(12);
    await vi.advanceTimersByTimeAsync(3200);
    await promise;
    expect(context.sources.length).toBeGreaterThan(30);
    for (const source of context.sources) expect(source.startedAt - source.scheduledAt).toBeLessThanOrEqual(.651);
    for (let index = 1; index < context.sources.length; index++) {
      const previous = context.sources[index - 1];
      expect(context.sources[index].startedAt).toBeCloseTo(previous.startedAt + previous.buffer!.duration, 9);
    }
  });

  it('cancela leitor e áudio pendente sem interromper uma reprodução iniciada em seguida', async () => {
    const first = controlledStream();
    const old = player.playStream(first.stream).catch(error => error);
    first.controller.enqueue(pcm(7680));
    await flushPromises();
    const context = TestContext.instances[0];
    const oldSources = context.sources.slice();
    const next = controlledStream();
    const newStarted = vi.fn();
    const current = player.playStream(next.stream, newStarted);
    next.controller.enqueue(pcm(7680));
    next.controller.close();
    await flushPromises();
    expect((await old).name).toBe('AbortError');
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(oldSources.every(source => source.stopped)).toBe(true);
    expect(context.analysers[0].disconnect).toHaveBeenCalledOnce();
    expect(context.analysers[1].disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(240);
    expect((await current).byteLength).toBe(7724);
    expect(newStarted).toHaveBeenCalledOnce();
    expect(first.stream.locked).toBe(false);
  });

  it('interrompe também uma fila de PCM grande enquanto aguarda espaço na agenda', async () => {
    const { stream, controller, cancel } = controlledStream();
    const started = vi.fn();
    const promise = player.playStream(stream, started).catch(error => error);
    controller.enqueue(pcm(144000));
    await flushPromises();
    const context = TestContext.instances[0];
    const scheduledCount = context.sources.length;
    expect(scheduledCount).toBeGreaterThan(0);
    player.stop();
    expect((await promise).name).toBe('AbortError');
    await vi.advanceTimersByTimeAsync(1000);
    expect(context.sources).toHaveLength(scheduledCount);
    expect(context.sources.every(source => source.stopped)).toBe(true);
    expect(started).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(frame).toHaveBeenLastCalledWith(CLOSED_MOUTH);
    expect(stream.locked).toBe(false);
  });
  it('interrompe leitura ainda sem resposta e libera o contexto ao descartar o player', async () => {
    const { stream, cancel } = controlledStream();
    const promise = player.playStream(stream).catch(error => error);
    await flushPromises();
    const context = TestContext.instances[0];
    player.dispose();
    expect((await promise).name).toBe('AbortError');
    expect(cancel).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(frame).toHaveBeenLastCalledWith(CLOSED_MOUTH);
    expect(stream.locked).toBe(false);
  });

  it.each([
    { name: 'vazia', size: 0, message: /sem áudio/ },
    { name: 'truncada no meio de uma amostra', size: 3, message: /incompleta/ },
    { name: 'excessivamente grande', size: 20 * 1024 * 1024 + 1, message: /tamanho permitido/ },
  ])('rejeita transmissão $name e deixa a boca fechada', async ({ size, message }) => {
    const { stream, controller } = controlledStream();
    const promise = player.playStream(stream).catch(error => error);
    if (size) controller.enqueue(new Uint8Array(size));
    controller.close();
    await flushPromises();
    expect((await promise).message).toMatch(message);
    expect(frame).toHaveBeenLastCalledWith(CLOSED_MOUTH);
    expect(stream.locked).toBe(false);
  });

  it('para blocos já agendados se a conexão falhar durante a resposta', async () => {
    const { stream, controller } = controlledStream();
    const promise = player.playStream(stream).catch(error => error);
    controller.enqueue(pcm(7680));
    await flushPromises();
    controller.error(new TypeError('terminated: socket hang up'));
    await flushPromises();
    expect((await promise).message).toBe('A transmissão da voz foi interrompida. Verifique sua conexão e tente novamente.');
    expect(TestContext.instances[0].sources.every(source => source.stopped)).toBe(true);
    expect(frame).toHaveBeenLastCalledWith(CLOSED_MOUTH);
  });

  it('preserva replay WAV e impede uma decodificação antiga de tocar sobre a fala atual', async () => {
    await player.unlock();
    const context = TestContext.instances[0];
    let resolveDecode!: (value: TestBuffer) => void;
    context.decodeAudioData.mockImplementationOnce(() => new Promise(resolve => { resolveDecode = resolve; }));
    const old = player.play(new ArrayBuffer(4)).catch(error => error);
    await flushPromises();
    const started = vi.fn();
    const replay = player.play(new ArrayBuffer(4), started);
    await flushPromises();
    resolveDecode(new TestBuffer(4800, 24000));
    await flushPromises();
    expect((await old).name).toBe('AbortError');
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0].stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(260);
    await replay;
    expect(started).toHaveBeenCalledOnce();
    expect(frame).toHaveBeenLastCalledWith(CLOSED_MOUTH);
  });
});
