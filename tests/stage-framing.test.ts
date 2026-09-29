import { describe, expect, it } from "vitest";
import { Box3, PerspectiveCamera, Vector3 } from "three";
import { stageFraming, STUDY_ROTATION, type AvatarView } from "../lib/avatar/stage-framing";

const aspects = [0.3, 9 / 19.5, 9 / 16, 1, 1.1, 1.3, 16 / 9, 21 / 9];
const views: AvatarView[] = ["portrait", "full", "room"];
const up = new Vector3(0, 1, 0);

function cameraFor(view: AvatarView, aspect: number) {
  const frame = stageFraming(view, aspect);
  const camera = new PerspectiveCamera(frame.fov, aspect, 0.03, 40);
  camera.position.set(0, frame.targetY, frame.distance + 0.075);
  camera.lookAt(0, frame.targetY, 0.075);
  camera.updateMatrixWorld(true);
  return camera;
}

function projectedRoomBox(camera: PerspectiveCamera, min: Vector3, max: Vector3) {
  const corners: Vector3[] = [];
  for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) {
    corners.push(new Vector3(x, y, z).applyAxisAngle(up, STUDY_ROTATION).project(camera));
  }
  const box = new Box3().setFromPoints(corners);
  const visible = Math.max(0, Math.min(1, box.max.x) - Math.max(-1, box.min.x));
  return visible / (box.max.x - box.min.x);
}

describe("the poet in the supplied study", () => {
  it("keeps the head visible and full-body views above the floor on narrow and wide screens", () => {
    for (const view of views) for (const aspect of aspects) {
      const frame = stageFraming(view, aspect);
      const camera = cameraFor(view, aspect);
      expect(Math.abs(new Vector3(0, 1.9, 0).project(camera).y)).toBeLessThan(1);
      if (view !== "portrait") expect(Math.abs(new Vector3(0, 0, 0.1).project(camera).y)).toBeLessThan(1);
      expect(frame.targetY).toBeGreaterThanOrEqual(0.95);
      expect(frame.minDistance).toBeLessThanOrEqual(frame.distance);
      expect(frame.maxDistance).toBeGreaterThanOrEqual(frame.distance);
      expect(frame.minAzimuthAngle).toBeLessThanOrEqual(0);
      expect(frame.maxAzimuthAngle).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps every allowed orbit inside the open entrance and clear of the shutters", () => {
    // Conservative source bounds include the open shutters and curtains.
    const windows = new Box3(new Vector3(3.685, 0.84, -2.708), new Vector3(4.525, 3.802, 2.708));
    for (const view of views) for (const aspect of aspects) {
      const frame = stageFraming(view, aspect);
      for (const radius of [frame.minDistance, frame.distance, frame.maxDistance]) {
        for (let azIndex = 0; azIndex <= 8; azIndex++) for (let polarIndex = 0; polarIndex <= 4; polarIndex++) {
          const az = frame.minAzimuthAngle + (frame.maxAzimuthAngle - frame.minAzimuthAngle) * azIndex / 8;
          const polar = frame.minPolarAngle + (frame.maxPolarAngle - frame.minPolarAngle) * polarIndex / 4;
          const world = new Vector3(radius * Math.sin(polar) * Math.sin(az), frame.targetY + radius * Math.cos(polar), 0.075 + radius * Math.sin(polar) * Math.cos(az));
          expect(world.y).toBeGreaterThanOrEqual(0.18 - 1e-8);
          expect(world.y).toBeLessThanOrEqual(3.7 + 1e-8);
          const local = world.applyAxisAngle(up, -STUDY_ROTATION);
          if (local.z < 3.6) expect(Math.abs(local.x)).toBeLessThan(4.3);
          expect(windows.distanceToPoint(local)).toBeGreaterThan(0.3);
        }
      }
    }
  });

  it("shows the writing desk and books in the room view while the poet stays central", () => {
    for (const aspect of [1.1, 1.3, 16 / 9]) {
      const camera = cameraFor("room", aspect);
      const desk = projectedRoomBox(camera, new Vector3(-3.915, 0, -2.335), new Vector3(-2.985, 1.358, -0.525));
      const books = projectedRoomBox(camera, new Vector3(-4.37, 0, -0.125), new Vector3(-3.51, 3.74, 2.525));
      expect(desk).toBeGreaterThan(0.99);
      expect(books).toBeGreaterThan(0.25);
      const head = new Vector3(0, 1.9, 0).project(camera);
      const feet = new Vector3(0, 0, 0).project(camera);
      expect(head.x).toBeCloseTo(0, 8);
      expect((head.y - feet.y) / 2).toBeGreaterThan(0.39);
    }
  });
});