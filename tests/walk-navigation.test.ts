import { describe, expect, it } from "vitest";
import { isWalkable, planWalkPath, WALK_BOUNDS, WALK_DESTINATIONS, WALK_ROOM_BOUNDS, type WalkPoint } from "../lib/avatar/walk-navigation";

const world = (x: number, z: number): [number, number] => [Math.cos(0.65) * x - Math.sin(0.65) * z, Math.sin(0.65) * x + Math.cos(0.65) * z];
const room = (x: number, z: number): [number, number] => [Math.cos(0.65) * x + Math.sin(0.65) * z, -Math.sin(0.65) * x + Math.cos(0.65) * z];

function checkPath(from: WalkPoint, to: WalkPoint) {
  const path = planWalkPath(from, to);
  expect(path).not.toBeNull();
  expect(path![0]).toEqual(from);
  expect(path!.at(-1)).toEqual(to);
  for (let segment = 1; segment < path!.length; segment++) {
    const a = path![segment - 1], b = path![segment];
    const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.015);
    for (let i = 0; i <= steps; i++) {
      const point: WalkPoint = [a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps];
      expect(isWalkable(...point)).toBe(true);
      const local = room(...point);
      // The original floor is 8.8 × 7.2 m; the whole body stays on it.
      expect(Math.abs(local[0]) + 0.55).toBeLessThan(4.4);
      expect(Math.abs(local[1]) + 0.55).toBeLessThan(3.6);
      expect(point[0] - 0.55).toBeGreaterThanOrEqual(WALK_BOUNDS[0] - 1e-8);
      expect(point[0] + 0.55).toBeLessThanOrEqual(WALK_BOUNDS[1] + 1e-8);
      expect(point[1] - 0.55).toBeGreaterThanOrEqual(WALK_BOUNDS[2] - 1e-8);
      expect(point[1] + 0.55).toBeLessThanOrEqual(WALK_BOUNDS[3] + 1e-8);
    }
  }
  return path!;
}

describe("walking through the furnished study", () => {
  it("connects every keyboard destination in both directions with usable two-to-three-metre walks", () => {
    expect(WALK_DESTINATIONS.some((d) => d.label === "Voltar ao quadro" && d.position[0] === 0 && d.position[1] === 0)).toBe(true);
    expect(WALK_DESTINATIONS.filter((d) => Math.hypot(...d.position) >= 2 && Math.hypot(...d.position) <= 3).length).toBeGreaterThanOrEqual(3);
    for (const from of WALK_DESTINATIONS) for (const to of WALK_DESTINATIONS) checkPath(from.position, to.position);
    expect(WALK_ROOM_BOUNDS.minX).toBeCloseTo(-3.15);
    expect(WALK_ROOM_BOUNDS.maxX).toBeCloseTo(3.2);
    expect(WALK_ROOM_BOUNDS.minZ).toBeCloseTo(-3.15);
    expect(WALK_ROOM_BOUNDS.maxZ).toBeCloseTo(3.25);
  });

  it("rejects furniture, foliage, the enlarged frame and insufficient body clearance", () => {
    for (const point of [world(-3.45, -1.43), world(-2.4, -1.35), world(-3.94, 1.2), world(2.5, -2.1), world(3.84, 0.07), world(3.8, 1.5), [1.9, 0.15] as const]) {
      expect(isWalkable(point[0], point[1])).toBe(false);
      expect(planWalkPath([0, 0], point)).toBeNull();
    }
    const frameLeft = 1.9 - 0.594 * 1.3;
    expect(isWalkable(frameLeft - 0.54, 0)).toBe(false);
    expect(isWalkable(frameLeft - 0.56, 0)).toBe(true);
  });

  it("takes a safe detour instead of cutting diagonally across the pedestal corner", () => {
    const path = checkPath([0.4, -0.6], [0.85, -1]);
    expect(path.length).toBeGreaterThan(2);
    expect(isWalkable(0.625, -0.8)).toBe(false);
    const back = WALK_DESTINATIONS.find((d) => d.id === "fundo")!;
    expect(checkPath([0, 0], back.position).length).toBeGreaterThan(2);
  });

  it("replans from an arbitrary in-flight position and returns cleanly to the original spot", () => {
    const back = WALK_DESTINATIONS.find((d) => d.id === "fundo")!;
    const windows = WALK_DESTINATIONS.find((d) => d.id === "janelas")!;
    const initial = checkPath([0, 0], back.position);
    const a = initial[0], b = initial[1];
    const current: WalkPoint = [a[0] + (b[0] - a[0]) * 0.731, a[1] + (b[1] - a[1]) * 0.731];
    checkPath(current, windows.position);
    checkPath(current, [0, 0]);
  });

  it("rejects invalid or out-of-area clicks without clamping them into an obstacle", () => {
    for (const point of [[100, 100], [-5, -5], world(2.8, 0), world(0, 3.1), [NaN, 0], [0, Infinity]] as WalkPoint[]) {
      expect(isWalkable(point[0], point[1])).toBe(false);
      expect(planWalkPath([0, 0], point)).toBeNull();
      expect(planWalkPath(point, [0, 0])).toBeNull();
    }
    expect(planWalkPath([0, 0], [0, 0])).toEqual([[0, 0]]);
  });

  it("does not mutate inputs or expose the cached grid to callers", () => {
    const from: WalkPoint = Object.freeze([0.4, -0.6]);
    const to: WalkPoint = Object.freeze([0.85, -1]);
    const first = checkPath(from, to);
    const expected = first.map((p) => [...p]);
    first[1][0] = 100;
    expect(planWalkPath(from, to)).toEqual(expected);
    expect(from).toEqual([0.4, -0.6]);
    expect(to).toEqual([0.85, -1]);
  });
});