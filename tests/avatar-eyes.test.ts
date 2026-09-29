import { describe, expect, it } from "vitest";
import { BufferGeometry, Mesh, MeshStandardMaterial, Object3D } from "three";
import { AvatarEyes } from "../lib/avatar/eyes";

const names = [
  "Boca - abrir", "Labios - alargar", "Labios - arredondar",
  "Palpebra - piscar.D", "Palpebra - piscar.E",
  "Olhar - direita", "Olhar - esquerda", "Olhar - cima", "Olhar - baixo",
  "Palpebra - arco.D", "Palpebra - arco.E",
];

function avatar(seed = 0x47d1a5) {
  const root = new Object3D();
  const mesh = new Mesh(new BufferGeometry(), new MeshStandardMaterial());
  mesh.morphTargetDictionary = Object.fromEntries(names.map((name, index) => [name, index]));
  mesh.morphTargetInfluences = [.61, .21, .13, 0, 0, 0, 0, 0, 0, 0, 0];
  const otherEye = new Mesh(mesh.geometry, mesh.material);
  otherEye.morphTargetDictionary = { "Olhar - direita": 0, "Olhar - esquerda": 1, "Olhar - cima": 2, "Olhar - baixo": 3, "Palpebra - piscar.E": 4 };
  otherEye.morphTargetInfluences = [0, 0, 0, 0, 0];
  root.add(mesh, otherEye);
  const eyes = new AvatarEyes(root, seed);
  return { eyes, weights: mesh.morphTargetInfluences, otherWeights: otherEye.morphTargetInfluences };
}

describe("natural eye movement", () => {
  it("fully closes both eyelids together, opens more slowly, and varies blink intervals", () => {
    const { eyes, weights } = avatar();
    const starts: number[] = [];
    const durations: { closing: number; opening: number }[] = [];
    let previous = 0, started = -1, fullyClosedAt = -1, openingAt = -1;
    let overlapFrames = 0;
    let peakArcRight = 0, peakArcLeft = 0;
    for (let frame = 0; frame <= 60 * 240; frame++) {
      const time = frame / 240;
      eyes.update(time, true, .3);
      const right = weights[3], left = weights[4];
      const arcRight = weights[9], arcLeft = weights[10];
      // Corrective surfaces vanish at either endpoint and pass around the
      // cornea at mid-closure; each follows its own asynchronous eyelid.
      expect(arcRight).toBeCloseTo(4 * right * (1 - right), 12);
      expect(arcLeft).toBeCloseTo(4 * left * (1 - left), 12);
      if (right === 0 || right === 1) expect(arcRight).toBe(0);
      if (left === 0 || left === 1) expect(arcLeft).toBe(0);
      peakArcRight = Math.max(peakArcRight, arcRight);
      peakArcLeft = Math.max(peakArcLeft, arcLeft);
      if (right > 0 && previous === 0) {
        starts.push(time);
        started = time;
        fullyClosedAt = -1;
        openingAt = -1;
      }
      if (right === 1 && fullyClosedAt < 0) fullyClosedAt = time;
      if (previous === 1 && right < 1) openingAt = time;
      if (right === 1 && left === 1) overlapFrames++;
      if (right === 0 && previous > 0) {
        expect(fullyClosedAt).toBeGreaterThan(started);
        durations.push({ closing: fullyClosedAt - started, opening: time - openingAt });
      }
      expect(Math.abs(right - left)).toBeLessThan(.14);
      expect(right).toBeGreaterThanOrEqual(0);
      expect(right).toBeLessThanOrEqual(1);
      previous = right;
    }
    expect(starts.length).toBeGreaterThanOrEqual(9);
    expect(starts.length).toBeLessThanOrEqual(19);
    expect(overlapFrames).toBeGreaterThan(60);
    expect(peakArcRight).toBeGreaterThan(.999);
    expect(peakArcLeft).toBeGreaterThan(.999);
    expect(durations.every(({ closing, opening }) => closing < .1 && opening > .12 && opening > closing)).toBe(true);
    const intervals = starts.slice(1).map((start, index) => start - starts[index]).filter((interval) => interval > 1);
    expect(Math.max(...intervals) - Math.min(...intervals)).toBeGreaterThan(1);
    expect(Math.min(...intervals)).toBeGreaterThan(3.3);
    expect(Math.max(...intervals)).toBeLessThan(6.5);
  });

  it("coordinates subtle gaze across both eyes and retains mostly central eye contact", () => {
    const { eyes, weights, otherWeights } = avatar();
    let neutral = 0, horizontal = 0, vertical = 0, maximumStep = 0;
    let previousX = 0, previousY = 0;
    const steps: number[] = [];
    for (let frame = 0; frame <= 90 * 120; frame++) {
      eyes.update(frame / 120, true, .4);
      const gaze = weights.slice(5, 9);
      expect(otherWeights.slice(0, 4)).toEqual(gaze);
      expect(otherWeights[4]).toBe(weights[4]);
      expect(gaze[0] * gaze[1]).toBe(0);
      expect(gaze[2] * gaze[3]).toBe(0);
      const x = gaze[0] - gaze[1], y = gaze[2] - gaze[3];
      steps.push(Math.hypot(x - previousX, y - previousY));
      maximumStep = Math.max(maximumStep, Math.abs(x - previousX), Math.abs(y - previousY));
      previousX = x;
      previousY = y;
      // Within one microsaccade of centre still counts as eye contact; a
      // planned glance away is at least four times larger.
      if (Math.abs(x) < .045 && Math.abs(y) < .045) neutral++;
      horizontal = Math.max(horizontal, Math.abs(x));
      vertical = Math.max(vertical, Math.abs(y));
    }
    expect(neutral / (90 * 120)).toBeGreaterThan(.6);
    expect(horizontal).toBeGreaterThan(.25);
    expect(horizontal).toBeLessThanOrEqual(.6);
    expect(vertical).toBeGreaterThan(.05);
    expect(vertical).toBeLessThanOrEqual(.35);
    // A saccade is ballistic and may sweep from one side to the other, so a
    // single 120 fps frame can carry a third of the gaze range. What must never
    // happen is a teleport: a real saccade spans several frames, so the frames
    // on either side of the largest step are moving too. A glitch stands alone.
    expect(maximumStep).toBeLessThan(.45);
    const largest = steps.indexOf(Math.max(...steps));
    expect(steps[largest - 1]).toBeGreaterThan(steps[largest] * .2);
    expect(steps[largest + 1]).toBeGreaterThan(steps[largest] * .2);
  });

  it.each([0x47d1a5, 24])("reaches identical timed poses at 30 and 120 frames per second (seed %i)", (seed) => {
    const slow = avatar(seed), fast = avatar(seed);
    for (let frame = 0; frame <= 300 * 120; frame++) {
      fast.eyes.update(frame / 120, true, .5);
      if (frame % 4 === 0) {
        slow.eyes.update(frame / 120, true, .5);
        for (let index = 3; index < names.length; index++) {
          expect(slow.weights[index]).toBeCloseTo(fast.weights[index], 10);
        }
      }
    }
  });

  it("never changes mouth articulation and returns to neutral with reduced motion or reset", () => {
    const { eyes, weights } = avatar();
    for (let frame = 0; frame < 900; frame++) eyes.update(frame / 60, true, .4);
    expect(weights.slice(0, 3)).toEqual([.61, .21, .13]);
    eyes.update(15, false, .4);
    expect(weights.slice(3)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    eyes.update(15.1, true, .4);
    expect(weights.slice(3)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    for (let frame = 0; frame < 1200; frame++) eyes.update(15.1 + frame / 60, true, .4);
    eyes.reset();
    expect(weights).toEqual([.61, .21, .13, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("resumes from a hidden tab without a caught-up blink or abrupt gaze", () => {
    const { eyes, weights } = avatar();
    for (let frame = 0; frame < 300; frame++) eyes.update(frame / 60, true, .3);
    eyes.update(300, true, .3);
    expect(weights.slice(3)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    // Eyelids stay open and no glance is replayed; the iris may microsaccade,
    // which is a fraction of a degree and never an abrupt jump.
    let previous = [0, 0, 0, 0];
    for (let frame = 1; frame < 90; frame++) {
      eyes.update(300 + frame / 60, true, .3);
      expect(weights.slice(3, 5)).toEqual([0, 0]);
      expect(weights.slice(9)).toEqual([0, 0]);
      const gaze = weights.slice(5, 9);
      for (let index = 0; index < 4; index++) {
        expect(gaze[index]).toBeLessThanOrEqual(.045);
        expect(Math.abs(gaze[index] - previous[index])).toBeLessThan(.05);
      }
      previous = gaze;
    }
  });

  it("keeps valid finite weights on invalid time, backward clocks, and invalid voice levels", () => {
    const { eyes, weights } = avatar();
    for (let frame = 0; frame < 600; frame++) eyes.update(frame / 60, true, NaN);
    expect(weights.every(Number.isFinite)).toBe(true);
    for (const time of [NaN, Infinity, -Infinity, 2, 1]) {
      eyes.update(time, true, Infinity);
      expect(weights.slice(3)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    }
    expect(weights.slice(0, 3)).toEqual([.61, .21, .13]);
  });

  it("uses reproducible seeds without requiring eye morphs in older models", () => {
    expect(() => {
      const eyes = new AvatarEyes(new Object3D());
      eyes.update(0, true);
      eyes.update(1 / 60, true);
      eyes.reset();
    }).not.toThrow();
    const first = avatar(123), same = avatar(123), different = avatar(234);
    let differences = 0;
    for (let frame = 0; frame < 1200; frame++) {
      for (const entry of [first, same, different]) entry.eyes.update(frame / 60, true, .3);
      expect(first.weights).toEqual(same.weights);
      if (first.weights[3] !== different.weights[3]) differences++;
    }
    expect(differences).toBeGreaterThan(30);
  });
});

describe("eyes coordinated with the head", () => {
  it("counter-rotates against head movement and reports its own glance separately", () => {
    const { eyes, weights } = avatar();
    for (let frame = 0; frame <= 30; frame++) eyes.update(frame / 60, true, 0, { yaw: 0.03, pitch: 0.02 });
    // A face turned toward +X looks back toward -X; a face turned down looks up.
    expect(weights[5]).toBe(0);
    expect(weights[6]).toBeCloseTo(0.18, 2);
    expect(weights[7]).toBeCloseTo(0.25, 2);
    expect(weights[8]).toBe(0);
    expect(eyes.glance).toEqual({ x: 0, y: 0 });
    eyes.update(31 / 60, true, 0, { yaw: -0.5, pitch: -0.4 });
    expect(weights[5]).toBeCloseTo(0.55, 6);
    expect(weights[8]).toBeCloseTo(0.45, 6);
    eyes.update(32 / 60, true, 0, { yaw: NaN, pitch: Infinity });
    expect(weights.slice(5, 9)).toEqual([0, 0, 0, 0]);
    eyes.update(33 / 60, true, 0);
    expect(weights.slice(5, 9)).toEqual([0, 0, 0, 0]);
  });

  it("averts the gaze up and aside while thinking, holds it, and returns when the reply begins", () => {
    const { eyes, weights } = avatar();
    let held = 0;
    for (let frame = 0; frame <= 60 * 3; frame++) {
      eyes.update(frame / 60, true, 0, undefined, "thinking");
      const x = weights[5] - weights[6], y = weights[7] - weights[8];
      if (frame >= 30) {
        expect(Math.abs(x)).toBeGreaterThan(0.35);
        expect(y).toBeGreaterThan(0.12);
        held++;
      }
    }
    expect(held).toBeGreaterThan(120);
    for (let frame = 1; frame <= 90; frame++) eyes.update(3 + frame / 60, true, 0.3, undefined, "idle");
    expect(Math.abs(weights[5] - weights[6])).toBeLessThan(0.05);
    expect(Math.abs(weights[7] - weights[8])).toBeLessThan(0.05);
  });

  it("keeps eye contact more steadily while listening than while speaking", () => {
    const count = (mode: "idle" | "listening", level: number) => {
      const { eyes, weights } = avatar();
      let neutral = 0;
      for (let frame = 0; frame <= 90 * 60; frame++) {
        eyes.update(frame / 60, true, level, undefined, mode);
        // Within one microsaccade of centre is still eye contact (see above).
        if (Math.abs(weights[5] - weights[6]) < .045 && Math.abs(weights[7] - weights[8]) < .045) neutral++;
      }
      return neutral / (90 * 60);
    };
    const listening = count("listening", 0), speaking = count("idle", .4);
    expect(listening).toBeGreaterThan(.85);
    expect(listening).toBeGreaterThan(speaking);
  });

  it("often blinks as the gaze shifts without shortening the natural interval between blinks", () => {
    const { eyes, weights } = avatar();
    const blinkStarts: number[] = [];
    const shiftStarts: number[] = [];
    let previousBlink = 0, moving = false, previousGlance = { x: 0, y: 0 };
    for (let frame = 0; frame <= 60 * 300; frame++) {
      const time = frame / 60;
      eyes.update(time, true, .4);
      if (weights[3] > 0 && previousBlink === 0) blinkStarts.push(time);
      previousBlink = weights[3];
      // The glance object is reused by the eyes, so copy its values.
      const glance = { ...eyes.glance };
      const isMoving = Math.abs(glance.x - previousGlance.x) > 1e-9 || Math.abs(glance.y - previousGlance.y) > 1e-9;
      if (isMoving && !moving) shiftStarts.push(time);
      moving = isMoving;
      previousGlance = glance;
    }
    const coincident = blinkStarts.filter((blink) => shiftStarts.some((shift) => Math.abs(shift - blink) < .06)).length;
    expect(coincident).toBeGreaterThanOrEqual(5);
    expect(coincident).toBeLessThan(blinkStarts.length * .5);
    const intervals = blinkStarts.slice(1).map((start, index) => start - blinkStarts[index]).filter((interval) => interval > 1);
    expect(Math.min(...intervals)).toBeGreaterThan(3.3);
    expect(Math.max(...intervals)).toBeLessThan(6.5);
  });
});
