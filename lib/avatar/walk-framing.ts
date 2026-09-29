import { PerspectiveCamera, Vector3 } from "three";
import { STUDY_ROTATION } from "./stage-framing";
import { WALK_ROOM_BOUNDS } from "./walk-navigation";

/** Look through the open front of the supplied room, keeping the walking area visible. */
export function walkFraming(width: number, height: number) {
  const aspect = Math.max(0.2, width / Math.max(1, height));
  const fov = 50;
  const camera = new PerspectiveCamera(fov, aspect, 0.03, 60);
  const target = new Vector3(0, 1, 0);
  const corners: Vector3[] = [];
  for (const x of [WALK_ROOM_BOUNDS.minX, WALK_ROOM_BOUNDS.maxX])
    for (const y of [0, 2.15])
      for (const z of [WALK_ROOM_BOUNDS.minZ, WALK_ROOM_BOUNDS.maxZ]) corners.push(new Vector3(x, y, z));
  let distance = 7;
  for (let attempt = 0; attempt < 120; attempt++) {
    camera.position.set(0, 3.4, distance);
    camera.lookAt(target);
    camera.updateMatrixWorld(true);
    if (corners.every(corner => {
      const point = corner.clone().project(camera);
      return Math.abs(point.x) < 0.86 && Math.abs(point.y) < 0.78 && point.z < 1;
    })) break;
    distance += 0.35;
  }
  const cameraPosition = new Vector3(0, 3.4, distance).applyAxisAngle(new Vector3(0, 1, 0), STUDY_ROTATION);
  const radius = cameraPosition.distanceTo(target);
  const polar = Math.acos((3.4 - target.y) / radius);
  return {
    fov,
    cameraPosition: cameraPosition.toArray() as [number, number, number],
    target: target.toArray() as [number, number, number],
    minDistance: radius,
    maxDistance: radius * 1.12,
    minAzimuthAngle: STUDY_ROTATION - 0.06,
    maxAzimuthAngle: STUDY_ROTATION + 0.06,
    minPolarAngle: Math.max(polar - 0.015, Math.acos((3.8 - target.y) / (radius * 1.12))),
    maxPolarAngle: polar + 0.015,
  };
}
