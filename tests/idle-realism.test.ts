import { describe, expect, it } from "vitest";
import { sampleIdleMotion, type IdleMotion } from "../lib/avatar/idle-motion";

/** The sample object is reused every frame, so copy before comparing. */
const at = (time: number): IdleMotion => ({ ...sampleIdleMotion(time) });

const CHANNELS = ["yaw", "pitch", "roll", "shift", "depth", "rightHand", "leftHand", "armsForward", "transfer", "sigh"] as const;

/** Longest pose sequence in the module: without the modulator everything realigns here. */
const LONGEST_LOOP = 130.7;

describe("a presença silenciosa do poeta", () => {
  it("parte exatamente do repouso, sem começar no meio de uma sequência", () => {
    const start = at(0);
    expect(start.fade).toBe(0);
    for (const channel of CHANNELS) expect(Math.abs(start[channel])).toBe(0);
    expect(Math.abs(start.sway)).toBe(0);
    expect(Math.abs(start.swayDepth)).toBe(0);
    expect(Math.abs(start.breath)).toBe(0);
  });

  it("não se repete: o mesmo instante de dois ciclos distantes difere", () => {
    // Sampled well after the fade-in, so any difference is the modulator, not the ramp.
    for (const base of [180, 420, 900]) {
      const first = at(base);
      const later = at(base + LONGEST_LOOP);
      const moved = CHANNELS.filter(channel => Math.abs(first[channel] - later[channel]) > 1e-4);
      expect(`${base}s: ${moved.length} canais mudaram`).not.toBe(`${base}s: 0 canais mudaram`);
    }
  });

  it("continua determinística: o mesmo instante dá sempre o mesmo valor", () => {
    for (const time of [12.5, 97.3, 512.8]) {
      const first = at(time);
      at(time + 7.1);
      expect(at(time)).toEqual(first);
    }
  });

  it("independe da taxa de quadros: nada se acumula entre amostras", () => {
    const target = 43.5;
    // Walking there in 30 fps steps must land on the same pose as sampling directly.
    let clock = 0;
    for (let step = 0; step < Math.round(target * 30); step++) clock = (step + 1) / 30;
    expect(clock).toBeCloseTo(target, 6);
    expect(at(clock)).toEqual(at(target));
  });

  it("mantém a oscilação postural pequena e contínua, como um corpo parado de pé", () => {
    let previous = at(6).sway;
    let peak = 0;
    for (let time = 6; time <= 600; time += 1 / 60) {
      const { sway, swayDepth } = at(time);
      expect(Math.abs(sway)).toBeLessThanOrEqual(1.001);
      expect(Math.abs(swayDepth)).toBeLessThanOrEqual(1.001);
      // No jumps between frames: a body sways, it does not teleport.
      expect(Math.abs(sway - previous)).toBeLessThan(0.02);
      peak = Math.max(peak, Math.abs(sway));
      previous = sway;
    }
    // And it is real movement, not a flat line dressed up as one.
    expect(peak).toBeGreaterThan(0.3);
  });

  it("varia a duração de cada respiração em vez de repetir seis ciclos fixos", () => {
    // Peaks of the breath curve mark the top of each inhalation.
    const peaks: number[] = [];
    const start = 10;
    let rising = false, previous = at(start).breath;
    for (let time = start + 1 / 120; time < 400; time += 1 / 120) {
      const breath = at(time).breath;
      if (breath > previous) rising = true;
      // Only the top of an inhalation counts; starting mid-exhalation must not
      // register as a peak just because the curve flattens at the floor.
      else if (rising && previous > 0.9) { peaks.push(time); rising = false; }
      else if (breath < previous) rising = false;
      previous = breath;
    }
    expect(peaks.length).toBeGreaterThan(30);
    const gaps = peaks.slice(1).map((peak, index) => peak - peaks[index]);
    const unique = new Set(gaps.map(gap => gap.toFixed(2)));
    // Six identical cycles on repeat would collapse to a handful of values.
    expect(unique.size).toBeGreaterThan(10);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThan(3.5);
      expect(gap).toBeLessThan(8);
    }
  });

  it("preserva a amplitude original: mais vida, não mais agitação", () => {
    const limits: Record<string, number> = {
      yaw: 0.03, pitch: 0.015, roll: 0.008, shift: 0.005, depth: 0.002,
      rightHand: 1, leftHand: 1, armsForward: 1, transfer: 1, sigh: 1,
    };
    for (let time = 0; time <= 1200; time += 0.25) {
      const motion = at(time);
      for (const channel of CHANNELS) {
        const within = Math.abs(motion[channel]) <= limits[channel] + 1e-6;
        expect(`${channel}@${time}s dentro de ${limits[channel]}`)
          .toBe(`${channel}@${time}s ${within ? "dentro" : "FORA"} de ${limits[channel]}`);
      }
    }
  });
});
