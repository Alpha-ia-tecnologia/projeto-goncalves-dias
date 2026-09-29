import { describe, expect, it } from 'vitest';
import { VoiceActivityDetector } from '../lib/voice-activity';

describe('fim natural da fala no microfone', () => {
  it('aguarda uma pausa longa depois de uma fala, preservando pausas curtas', () => {
    const detector = new VoiceActivityDetector(0);
    for (let time = 80; time <= 640; time += 80) expect(detector.update(.03, time)).toBe('listening');
    expect(detector.update(0, 1600)).toBe('listening');
    expect(detector.update(.03, 1680)).toBe('listening');
    expect(detector.update(0, 3000)).toBe('listening');
    expect(detector.update(0, 3080)).toBe('complete');
  });
  it('não envia silêncio, valores inválidos ou ruídos breves como fala', () => {
    const detector = new VoiceActivityDetector(0);
    expect(detector.update(.09, 80)).toBe('listening');
    expect(detector.update(0, 1800)).toBe('listening');
    expect(detector.update(.09, 1880)).toBe('listening');
    expect(detector.update(Number.NaN, 4000)).toBe('listening');
    expect(detector.update(.004, 8000)).toBe('no-speech');
  });
  it('não interpreta um timer suspenso como uma fala sustentada', () => {
    const detector = new VoiceActivityDetector(0);
    expect(detector.update(.04, 5000)).toBe('listening');
    expect(detector.update(0, 8000)).toBe('no-speech');
  });
});
