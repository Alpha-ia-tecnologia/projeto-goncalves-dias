import { describe, expect, it } from "vitest";
import { PerspectiveCamera, Vector3 } from "three";
import { walkFraming } from "../lib/avatar/walk-framing";
import { WALK_ROOM_BOUNDS } from "../lib/avatar/walk-navigation";
import { STUDY_ROTATION } from "../lib/avatar/stage-framing";

const up = new Vector3(0, 1, 0);
const screens = [[1500, 620], [1920, 1000], [901, 620], [480, 800], [320, 1000]];

describe("walking overview", () => {
  it("keeps the walking floor, whole avatar and hand envelope visible at every allowed orbit", () => {
    for (const [width, height] of screens) {
      const frame = walkFraming(width, height);
      const target = new Vector3(...frame.target);
      const radius = new Vector3(...frame.cameraPosition).distanceTo(target);
      const polar = Math.acos((frame.cameraPosition[1] - target.y) / radius);
      for (const distance of [frame.minDistance, frame.maxDistance])
        for (const azimuth of [frame.minAzimuthAngle, STUDY_ROTATION, frame.maxAzimuthAngle])
          for (const angle of [frame.minPolarAngle, polar, frame.maxPolarAngle]) {
            const camera = new PerspectiveCamera(frame.fov, width / height, 0.03, 60);
            camera.position.set(distance * Math.sin(angle) * Math.sin(azimuth), distance * Math.cos(angle), distance * Math.sin(angle) * Math.cos(azimuth)).add(target);
            camera.lookAt(target);
            camera.updateMatrixWorld(true);
            expect(camera.position.y).toBeLessThanOrEqual(3.80001);
            for (const x of [WALK_ROOM_BOUNDS.minX, WALK_ROOM_BOUNDS.maxX])
              for (const z of [WALK_ROOM_BOUNDS.minZ, WALK_ROOM_BOUNDS.maxZ])
                for (const y of [0, 2.15]) {
                  const point = new Vector3(x, y, z).applyAxisAngle(up, STUDY_ROTATION).project(camera);
                  expect(Math.abs(point.x)).toBeLessThan(1);
                  expect(Math.abs(point.y)).toBeLessThan(1);
                  expect(point.z).toBeGreaterThan(-1);
                  expect(point.z).toBeLessThan(1);
                }
          }
    }
  });

  it("looks through the real open front, below the ceiling and between the side walls", () => {
    for (const [width, height] of screens) {
      const frame = walkFraming(width, height);
      const camera = new Vector3(...frame.cameraPosition).applyAxisAngle(up, -STUDY_ROTATION);
      expect(camera.z).toBeGreaterThan(3.6);
      for (const x of [WALK_ROOM_BOUNDS.minX, WALK_ROOM_BOUNDS.maxX])
        for (const z of [WALK_ROOM_BOUNDS.minZ, WALK_ROOM_BOUNDS.maxZ])
          for (const y of [0, 2.15]) {
            const point = new Vector3(x, y, z);
            const t = (3.6 - point.z) / (camera.z - point.z);
            const doorway = point.clone().lerp(camera, t);
            expect(Math.abs(doorway.x)).toBeLessThan(4.3);
            expect(doorway.y).toBeGreaterThan(0);
            expect(doorway.y).toBeLessThan(4.1);
          }
    }
  });
});
