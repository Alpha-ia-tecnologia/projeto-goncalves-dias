import { describe, expect, it } from "vitest";
import { Box3, Group, Mesh, MeshStandardMaterial, PerspectiveCamera, Texture, Vector3 } from "three";
import { createSchoolPlaque, SCHOOL_PLAQUE } from "../lib/avatar/school-branding";
import { stageFraming, STUDY_ROTATION } from "../lib/avatar/stage-framing";
import { chatLayout } from "../lib/avatar/chat-layout";

/**
 * Measured from the supplied gabinete GLB, in room metres: the patch of back
 * wall that carries no geometry, high and to the left of the picture rail.
 */
const CLEAR_PATCH = { minX: -3.92, maxX: -2.1, minY: 2.45, maxY: 3.78 };
const BACK_WALL_Z = -3.6;

/** Measured from goncalves-dias.glb; the avatar stands at the world origin. */
const POET = new Box3(new Vector3(-0.41, 0, -0.22), new Vector3(0.41, 1.9, 0.22));

function plaqueInRoom() {
  const plaque = createSchoolPlaque({ texture: new Texture() });
  // The gabinete root carries the placement; measuring it here mirrors that.
  const room = new Group();
  room.add(plaque.root);
  room.updateMatrixWorld(true);
  const artwork = plaque.root.getObjectByName("Logo_Educa_Prime")!;
  return {
    plaque,
    box: new Box3().setFromObject(plaque.root),
    logoBox: new Box3().setFromObject(artwork),
  };
}

/** The room is rotated under the camera, so measure where the visitor sees it. */
function toWorld(box: Box3) {
  const up = new Vector3(0, 1, 0);
  const points: Vector3[] = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    points.push(new Vector3(x, y, z).applyAxisAngle(up, STUDY_ROTATION));
  }
  return new Box3().setFromPoints(points);
}

type Screen = { x0: number; x1: number; y0: number; y1: number };

function project(camera: PerspectiveCamera, box: Box3): Screen {
  const points: Vector3[] = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    points.push(new Vector3(x, y, z).project(camera));
  }
  return {
    x0: Math.min(...points.map(p => p.x)), x1: Math.max(...points.map(p => p.x)),
    y0: Math.min(...points.map(p => p.y)), y1: Math.max(...points.map(p => p.y)),
  };
}

const area = (s: Screen) => Math.max(0, s.x1 - s.x0) * Math.max(0, s.y1 - s.y0);
const overlap = (a: Screen, b: Screen) =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

/**
 * The two framings the visitor actually gets. They use different cameras: the
 * conversation view is offset sideways by chatLayout to make room for the chat
 * pedestal, while the immersive view centres a much closer camera on the poet
 * and hides the pedestal. A plaque has to survive both.
 */
function framings(width: number, height: number) {
  const aspect = width / height;
  const layout = chatLayout(width, height);
  const conversation = new PerspectiveCamera(layout.fov, aspect, 0.03, 40);
  conversation.position.fromArray(layout.cameraPosition);
  conversation.lookAt(new Vector3().fromArray(layout.target));
  conversation.updateMatrixWorld(true);
  conversation.updateProjectionMatrix();

  const [pedestalX, , pedestalZ] = layout.pedestalPosition;
  const half = 0.594 * layout.pedestalScale;
  const pedestal = new Box3(
    new Vector3(pedestalX - half, 0, pedestalZ - 0.13 * layout.pedestalScale),
    new Vector3(pedestalX + half, 2.259 * layout.pedestalScale, pedestalZ + 0.17 * layout.pedestalScale),
  );

  const frame = stageFraming("full", aspect, 1.9);
  const immersive = new PerspectiveCamera(frame.fov, aspect, 0.03, 40);
  immersive.position.set(0, frame.targetY, frame.distance + 0.075);
  immersive.lookAt(0, frame.targetY, 0.075);
  immersive.updateMatrixWorld(true);
  immersive.updateProjectionMatrix();

  return [
    { name: `conversa ${width}x${height}`, camera: conversation, occluders: [POET, pedestal] },
    { name: `imersivo ${width}x${height}`, camera: immersive, occluders: [POET] },
  ];
}

const VIEWPORTS: [number, number][] = [[1440, 810], [1331, 1035], [900, 1200]];

describe("a placa da Escola Educa Prime no gabinete", () => {
  it("fica no trecho alto da parede que está livre de geometria", () => {
    const { box } = plaqueInRoom();
    expect(box.min.x).toBeGreaterThan(CLEAR_PATCH.minX);
    expect(box.max.x).toBeLessThan(CLEAR_PATCH.maxX);
    expect(box.min.y).toBeGreaterThan(CLEAR_PATCH.minY);
    expect(box.max.y).toBeLessThan(CLEAR_PATCH.maxY);
    // Above the poet's head, which is what keeps him from covering it.
    expect(box.min.y).toBeGreaterThan(POET.max.y);
  });

  it("encosta na parede do fundo e avança para dentro da sala, sem atravessar o reboco", () => {
    const { box } = plaqueInRoom();
    expect(box.min.z).toBeGreaterThan(BACK_WALL_Z - 1e-6);
    expect(box.min.z - BACK_WALL_Z).toBeLessThan(0.01);
    // Shallow enough to read as a hanging plaque instead of a pillar.
    expect(box.max.z - box.min.z).toBeLessThan(0.08);
  });

  it("preserva a proporção da arte e empilha moldura, fundo e logo sem z-fighting", () => {
    const { plaque } = plaqueInRoom();
    expect(SCHOOL_PLAQUE.logoWidth / SCHOOL_PLAQUE.logoHeight).toBeCloseTo(1024 / 182, 2);
    expect(SCHOOL_PLAQUE.logoWidth).toBeLessThan(SCHOOL_PLAQUE.panelWidth);
    expect(SCHOOL_PLAQUE.panelWidth).toBeLessThan(SCHOOL_PLAQUE.frameWidth);
    const depths = ["Moldura_Educa_Prime", "Fundo_Educa_Prime", "Logo_Educa_Prime"].map((name) => {
      const part = plaque.root.getObjectByName(name);
      expect(part).toBeInstanceOf(Mesh);
      return part!.position.z;
    });
    expect(depths[1]).toBeGreaterThan(depths[0]);
    expect(depths[2]).toBeGreaterThan(depths[1]);
    expect(depths[2] - depths[1]).toBeGreaterThan(0.0005);
  });

  it.each(VIEWPORTS)("mostra a arte inteira, sem o poeta nem o quadro por cima, em %ix%i", (width, height) => {
    const { logoBox } = plaqueInRoom();
    const artwork = toWorld(logoBox);
    for (const view of framings(width, height)) {
      const screen = project(view.camera, artwork);
      const covered = view.occluders.reduce((sum, box) => sum + overlap(screen, project(view.camera, box)), 0);
      // This is the whole point of hanging it high: nothing may sit in front.
      expect(`${view.name}: ${(covered / area(screen) * 100).toFixed(0)}% coberto`).toBe(`${view.name}: 0% coberto`);
    }
  });

  it.each(VIEWPORTS)("mantém a moldura inteira dentro do enquadramento em %ix%i", (width, height) => {
    const { box } = plaqueInRoom();
    const frame = toWorld(box);
    for (const view of framings(width, height)) {
      const screen = project(view.camera, frame);
      // Clip space runs to 1; 0.98 leaves a sliver of margin at the picture edge.
      // The board sits high, so its top edge is the one that gets close.
      for (const [edge, value] of Object.entries(screen)) {
        const clamped = Math.max(-0.98, Math.min(0.98, value));
        expect(`${view.name} ${edge}=${value.toFixed(2)}`).toBe(`${view.name} ${edge}=${clamped.toFixed(2)}`);
      }
    }
  });

  it("marca a logo como cor e devolve a textura ao descartar a placa", () => {
    const texture = new Texture();
    const plaque = createSchoolPlaque({ texture });
    const logo = plaque.root.getObjectByName("Logo_Educa_Prime") as Mesh;
    const material = logo.material as MeshStandardMaterial;
    expect(material.map).toBe(texture);
    expect(material.transparent).toBe(true);
    expect(material.alphaTest).toBeGreaterThan(0);

    let released = 0;
    texture.addEventListener("dispose", () => { released += 1; });
    plaque.dispose();
    plaque.dispose();
    expect(released).toBe(1);
    expect(plaque.root.children).toHaveLength(0);
  });
});
