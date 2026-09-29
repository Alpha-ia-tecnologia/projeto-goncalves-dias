import { describe, expect, it } from "vitest";
import { Box3, PerspectiveCamera, Vector3 } from "three";
import { CHAT_SURFACE_HEIGHT, CHAT_SURFACE_WIDTH, chatLayout, type ChatLayout } from "../lib/avatar/chat-layout";

const viewports = [[901, 620], [1500, 620], [1280, 500], [1440, 724], [1920, 1000], [480, 640]];
const gestures = new Box3(new Vector3(-0.7, 0, -0.6), new Vector3(0.7, 2.1, 0.6));

function cameraFor(layout: ChatLayout, width: number, height: number, radius = layout.cameraPosition[2], az = 0, polar = Math.PI / 2) {
  const camera = new PerspectiveCamera(layout.fov, width / height, 0.03, 45);
  const target = new Vector3(...layout.target);
  camera.position.set(radius * Math.sin(polar) * Math.sin(az), radius * Math.cos(polar), radius * Math.sin(polar) * Math.cos(az)).add(target);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
  return camera;
}

function projectBox(camera: PerspectiveCamera, box: Box3) {
  const points: Vector3[] = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) points.push(new Vector3(x, y, z).project(camera));
  return new Box3().setFromPoints(points);
}

function physicalBox(layout: ChatLayout, min: Vector3, max: Vector3) {
  const position = new Vector3(...layout.pedestalPosition);
  return new Box3(min.multiplyScalar(layout.pedestalScale).add(position), max.multiplyScalar(layout.pedestalScale).add(position));
}

function screenBox(layout: ChatLayout) {
  return physicalBox(layout, new Vector3(-0.48, 0.88, 0.11), new Vector3(0.48, 2.08, 0.11));
}

function assertVisible(box: Box3) {
  expect(box.min.x).toBeGreaterThan(-1);
  expect(box.max.x).toBeLessThan(1);
  expect(box.min.y).toBeGreaterThan(-1);
  expect(box.max.y).toBeLessThan(1);
}

describe("the complete reference pedestal beside the poet", () => {
  it("keeps the original shape, ground contact and complete object on desktop and mobile", () => {
    expect(CHAT_SURFACE_WIDTH / CHAT_SURFACE_HEIGHT).toBe(0.8);
    for (const [width, height] of viewports) {
      const layout = chatLayout(width, height);
      expect(layout.pedestalScale).toBe(1.3);
      expect(layout.pedestalPosition[0]).toBe(1.9);
      expect(layout.pedestalPosition[2]).toBe(0.15);
      const camera = cameraFor(layout, width, height);
      const stand = physicalBox(layout, new Vector3(-0.41, 0.003, -0.335), new Vector3(0.41, 1.64, 0.335));
      const frame = physicalBox(layout, new Vector3(-0.594, 0.766, -0.04), new Vector3(0.594, 2.259, 0.13));
      expect(stand.min.y).toBeCloseTo(0, 10);
      assertVisible(projectBox(camera, stand));
      if (width <= 900) expect((1 - projectBox(camera, stand).min.y) * height / 2).toBeLessThan(height - 140);
      assertVisible(projectBox(camera, frame));
      assertVisible(projectBox(camera, gestures));
    }
  });

  it("retains the 4:5 chat in the frame and leaves the speaking and waving envelope clear", () => {
    for (const [width, height] of viewports) {
      const layout = chatLayout(width, height);
      const camera = cameraFor(layout, width, height);
      const pedestal = physicalBox(layout, new Vector3(-0.594, 0.003, -0.335), new Vector3(0.594, 2.259, 0.335));
      expect(pedestal.intersectsBox(gestures)).toBe(false);
      const screen = projectBox(camera, screenBox(layout));
      const projectedWidth = (screen.max.x - screen.min.x) * width / 2;
      const projectedHeight = (screen.max.y - screen.min.y) * height / 2;
      expect(projectedWidth / projectedHeight).toBeCloseTo(0.8, 8);
      expect(projectedWidth).toBeCloseTo(layout.screenPixelWidth, 8);
      expect(projectedWidth).toBeGreaterThan(width < 900 ? 140 : 185);
      if (width >= 900 && height >= 620) expect(projectedWidth / CHAT_SURFACE_WIDTH * 44).toBeGreaterThan(16);
      assertVisible(screen);
      expect(projectBox(camera, gestures).max.x).toBeLessThan(projectBox(camera, pedestal).min.x);
    }
  });

  it("preserves feet, crest, text and gestures throughout the restricted conversation orbit", () => {
    for (const [width, height] of viewports) {
      const layout = chatLayout(width, height);
      const stand = physicalBox(layout, new Vector3(-0.41, 0.003, -0.335), new Vector3(0.41, 1.64, 0.335));
      const frame = physicalBox(layout, new Vector3(-0.594, 0.766, -0.04), new Vector3(0.594, 2.259, 0.13));
      for (const radius of [layout.minDistance, layout.cameraPosition[2], layout.maxDistance]) {
        for (const az of [layout.minAzimuthAngle, 0, layout.maxAzimuthAngle]) {
          for (const polar of [layout.minPolarAngle, Math.PI / 2, layout.maxPolarAngle]) {
            const camera = cameraFor(layout, width, height, radius, az, polar);
            assertVisible(projectBox(camera, stand));
      if (width <= 900) expect((1 - projectBox(camera, stand).min.y) * height / 2).toBeLessThan(height - 140);
            assertVisible(projectBox(camera, frame));
            assertVisible(projectBox(camera, gestures));
            assertVisible(projectBox(camera, screenBox(layout)));
            expect(projectBox(camera, gestures).max.x).toBeLessThan(projectBox(camera, frame).min.x);
          }
        }
      }
    }
  });
});