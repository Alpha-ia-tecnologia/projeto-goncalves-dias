import { MathUtils } from "three";

export type AvatarView = "portrait" | "full" | "room" | "conversation" | "walk";

export const STAGE_FOV = 40;
/** Present the writing desk and books while the poet still faces the visitor. */
export const STUDY_ROTATION = -0.65;

export function stageFraming(view: AvatarView, aspect: number, modelTop = 1.9) {
  const width = Math.max(aspect, 0.3);
  const fov = view === "room" ? 55 : STAGE_FOV;
  const minimumHeight = view === "portrait" ? 1.6 : view === "full" ? 2.35 : 4.6;
  const height = Math.max(minimumHeight, 1.5 / width);
  const distance = height / (2 * Math.tan(MathUtils.degToRad(fov / 2)));
  // Reserve space above the head for the overlaid title, including on mobile.
  const targetY = view === "portrait" ? Math.max(modelTop / 2, modelTop - height * 0.32)
    : view === "full" ? modelTop / 2 + 0.1 : 1.47;
  const maxDistance = Math.max(distance, Math.min(distance * 1.25, 6.2));
  return {
    fov,
    distance,
    targetY,
    minDistance: Math.max(1.4, distance * 0.74),
    maxDistance,
    // In the rotated room these are +0.10..+0.80 radians: the camera and its
    // sightline remain in the clear entrance, even beyond the open front wall.
    // Symmetric limits would let the camera pass through the right windows.
    minAzimuthAngle: -0.55,
    maxAzimuthAngle: 0.15,
    minPolarAngle: Math.max(Math.PI * 0.42, Math.acos(MathUtils.clamp((3.7 - targetY) / maxDistance, -1, 1))),
    maxPolarAngle: Math.min(Math.PI * 0.54, Math.acos(MathUtils.clamp((0.18 - targetY) / maxDistance, -1, 1))),
  };
}