import { describe, expect, it } from "vitest";
import { AvatarWalker } from "../lib/avatar/walking";
import { isWalkable, planWalkPath, WALK_DESTINATIONS } from "../lib/avatar/walk-navigation";

describe("walking through the furnished study", () => {
  it("visits the actual destinations and returns to the chat without ever leaving the clear floor", () => {
    const walker = new AvatarWalker();
    const itinerary = [...WALK_DESTINATIONS.slice(1), WALK_DESTINATIONS[0]];
    for (const destination of itinerary) {
      const path = planWalkPath([walker.frame.x, walker.frame.z], destination.position);
      expect(path).not.toBeNull();
      walker.setPath(path!);
      let elapsed = 0;
      while (walker.frame.active && elapsed < 60) {
        const frame = walker.update(1 / 60);
        expect(isWalkable(frame.x, frame.z), `blocked floor en route to ${destination.id}`).toBe(true);
        elapsed += 1 / 60;
      }
      expect(walker.frame.active).toBe(false);
      expect(walker.frame.x).toBeCloseTo(destination.position[0], 5);
      expect(walker.frame.z).toBeCloseTo(destination.position[1], 5);
      expect(Math.sin(walker.frame.yaw)).toBeCloseTo(0, 5);
      expect(Math.cos(walker.frame.yaw)).toBeCloseTo(1, 5);
    }
    expect(Math.hypot(walker.frame.x, walker.frame.z)).toBeLessThan(0.001);
  });

  it("can redirect and stop on a safe route while its current step completes", () => {
    const walker = new AvatarWalker();
    walker.setPath(planWalkPath([0, 0], WALK_DESTINATIONS[3].position)!);
    for (let step = 0; step < 260; step++) walker.update(1 / 60);
    const path = planWalkPath([walker.frame.x, walker.frame.z], WALK_DESTINATIONS[4].position);
    expect(path).not.toBeNull();
    walker.setPath(path!);
    for (let step = 0; step < 170; step++) {
      const frame = walker.update(1 / 60);
      expect(isWalkable(frame.x, frame.z)).toBe(true);
    }
    walker.stop();
    let distance = 0;
    let previous = [walker.frame.x, walker.frame.z];
    for (let step = 0; step < 1200; step++) {
      const frame = walker.update(1 / 60);
      distance += Math.hypot(frame.x - previous[0], frame.z - previous[1]);
      previous = [frame.x, frame.z];
      expect(isWalkable(frame.x, frame.z)).toBe(true);
    }
    expect(walker.frame.active).toBe(false);
    expect(distance).toBeLessThan(0.16);
    expect(Math.cos(walker.frame.yaw)).toBeCloseTo(1, 5);
  });
});