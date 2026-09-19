import { describe, it, expect } from 'vitest';
import { mouthFromAudio } from '../lib/audio';
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
  it('faz aceno em saudações, sem confundir palavras ou negações', () => {
    expect(getDemoReply('Olá, tudo bem?').gesture).toBe('wave');
    expect(getDemoReply('Oi!').gesture).toBe('wave');
    expect(getDemoReply('Uma coisa qualquer').gesture).toBe('none');
    expect(getDemoReply('Não acene para mim').gesture).toBe('none');
  });
});