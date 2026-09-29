import { MathUtils } from "three";

/** Native DOM resolution; CSS3DRenderer maps this 4:5 surface onto Tela_Chat. */
export const CHAT_SURFACE_WIDTH = 640;
export const CHAT_SURFACE_HEIGHT = 800;

export type ChatLayout = {
  pedestalPosition: [number, number, number];
  pedestalScale: number;
  cameraPosition: [number, number, number];
  target: [number, number, number];
  fov: number;
  screenPixelWidth: number;
  minDistance: number;
  maxDistance: number;
  minAzimuthAngle: number;
  maxAzimuthAngle: number;
  minPolarAngle: number;
  maxPolarAngle: number;
};

/**
 * Preserve the complete supplied pedestal, from its feet to its carved crest.
 * Both the poet and the physical chat stay in the room on every viewport.
 * Narrow screens widen the camera framing; reading at a larger size is an
 * explicit UI action, rather than an automatic replacement of the scene.
 */
export function chatLayout(width: number, height: number): ChatLayout {
  const viewportWidth = Math.max(1, width);
  const viewportHeight = Math.max(1, height);
  const aspect = viewportWidth / viewportHeight;
  const fov = 40;
  const halfFovTangent = Math.tan(MathUtils.degToRad(fov / 2));
  const pedestalScale = 1.3;
  const pedestalX = 1.9;
  const pedestalY = -0.003 * pedestalScale;
  const pedestalZ = 0.15;
  const screenWidth = 0.96 * pedestalScale;
  const screenZ = pedestalZ + 0.11 * pedestalScale;
  const frameTop = pedestalY + 2.259 * pedestalScale;
  const frameFront = pedestalZ + 0.13 * pedestalScale;
  const baseFront = pedestalZ + 0.335 * pedestalScale;
  // Balance the crest and the nearer front feet, rather than framing only the
  // screen plane. Extra space also protects both ends during a small orbit.
  let cameraY = (frameTop + halfFovTangent * (frameFront - baseFront)) / 2;
  const left = -0.7;
  const right = pedestalX + 0.594 * pedestalScale;
  const cameraX = (left + right) / 2;
  let verticalDistance = baseFront + (cameraY + 0.12) / halfFovTangent;
  if (viewportWidth <= 900) {
    // Keep the complete model above the two explicit mobile control rows.
    const topLimit = 1 - 2 * 24 / viewportHeight;
    const bottomLimit = Math.max(0.05, 1 - 2 * 164 / viewportHeight);
    verticalDistance = (frameTop / halfFovTangent + topLimit * frameFront + bottomLimit * baseFront) / Math.max(0.1, topLimit + bottomLimit);
    cameraY = bottomLimit * halfFovTangent * (verticalDistance - baseFront);
  }
  const horizontalDistance = 0.6 + ((right - left) / 2 + 0.14) / (halfFovTangent * aspect);
  const cameraZ = Math.max(verticalDistance, horizontalDistance);
  return {
    pedestalPosition: [pedestalX, pedestalY, pedestalZ],
    pedestalScale,
    cameraPosition: [cameraX, cameraY, cameraZ],
    target: [cameraX, cameraY, 0],
    fov,
    screenPixelWidth: screenWidth * viewportHeight / (2 * (cameraZ - screenZ) * halfFovTangent),
    minDistance: cameraZ * 0.995,
    maxDistance: cameraZ * 1.005,
    // Detailed exploration remains available in the room and avatar views.
    minAzimuthAngle: -0.018,
    maxAzimuthAngle: 0.018,
    minPolarAngle: Math.PI / 2 - 0.008,
    maxPolarAngle: Math.PI / 2 + 0.008,
  };
}