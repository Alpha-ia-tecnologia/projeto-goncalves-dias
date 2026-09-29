import {
  DirectionalLight,
  Group,
  Material,
  Mesh,
  PointLight,
  Texture,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createSchoolPlaque, loadSchoolLogo, type SchoolPlaque } from "./school-branding";

export const STUDY_ENVIRONMENT_URL =
  "/scenes/gabinete/gabinete-goncalves-dias.glb?v=gabinete-1";

export interface StudyEnvironmentOptions {
  signal?: AbortSignal;
  anisotropy?: number;
}

export interface StudyEnvironment {
  /** Metres, Y up. The top of the original floor is at Y = 0.02 m. */
  root: Group;
  dispose(): void;
}

function assertActive(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("Carregamento do cenário cancelado.", "AbortError");
  }
}

/**
 * Reuses the room from Visualizar_Cenario.html: 8.8 × 7.2 × 4.15 m, with
 * 124,636 triangles merged from 2,218 source meshes into 44 static meshes.
 * All thirteen images are embedded in the GLB; no remote imports or textures.
 * The host retains its camera, renderer, hemisphere and avatar lighting.
 * The EDUCAPRIME plaque is built here rather than baked into the GLB, so the
 * supplied room asset and its manifest stay untouched.
 */
export async function createStudyEnvironment(
  options: StudyEnvironmentOptions = {},
): Promise<StudyEnvironment> {
  const { signal } = options;
  assertActive(signal);
  const response = await fetch(STUDY_ENVIRONMENT_URL, { signal });
  if (!response.ok) {
    throw new Error(`Não foi possível carregar o gabinete (${response.status}).`);
  }
  const bytes = await response.arrayBuffer();
  assertActive(signal);

  const logo = await loadSchoolLogo({ signal, anisotropy: options.anisotropy });
  // Decoding embedded images cannot be interrupted by GLTFLoader. If unmounted
  // during decode, finish collecting them and dispose before returning anything.
  let gltf;
  try {
    gltf = await new GLTFLoader().parseAsync(bytes, "");
  } catch (error) {
    // The artwork decoded first; a failed room must not strand it on the GPU.
    logo.dispose();
    throw error;
  }
  const root = gltf.scene;
  root.name = "Gabinete_Goncalves_Dias";
  const geometries = new Set<Mesh["geometry"]>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    geometries.add(object.geometry);
    const meshMaterials: Material[] = Array.isArray(object.material)
      ? object.material
      : [object.material];
    // Retain individual transparent windows and lamp glass for correct sorting.
    object.castShadow = meshMaterials.every((material) => !material.transparent);
    object.receiveShadow = true;
    for (const material of meshMaterials) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof Texture) textures.add(value);
      }
    }
  });
  for (const texture of textures) {
    texture.anisotropy = Math.max(1, Math.min(options.anisotropy ?? 4, 8));
  }

  const lights = new Group();
  lights.name = "Iluminacao_do_gabinete";
  const sun = new DirectionalLight(0xffe0b0, 3.4);
  sun.name = "Sol_fim_de_tarde";
  sun.position.set(8, 4.3, 3.7);
  sun.target.position.set(-3.5, 0.2, -3.4);
  // Keep the target in room coordinates. Parenting it to the light would move it
  // twice and change the illumination whenever the environment is translated.
  lights.add(sun, sun.target);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, {
    left: -7,
    right: 7,
    top: 7,
    bottom: -7,
    near: 0.1,
    far: 30,
  });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;

  const bouncedLights: [string, number, number, number, number, number][] = [
    ["Luz_rebatida_central", 0, 3.5, 0.4, 35, 0xffe5c4],
    ["Luz_janela_1", 3.9, 2.9, -1.5, 22, 0xffe8cc],
    ["Luz_janela_2", 3.9, 2.9, 1.5, 22, 0xffe8cc],
    ["Luz_rebatida_livros", -2.9, 2.5, 2.7, 18, 0xbacbdc],
  ];
  for (const [name, x, y, z, intensity, color] of bouncedLights) {
    const light = new PointLight(color, intensity, 12, 2);
    light.name = name;
    light.position.set(x, y, z);
    // Four six-face point shadow maps would multiply the avatar skinning cost.
    light.castShadow = false;
    lights.add(light);
  }
  root.add(lights);

  // Room coordinates, so the plaque follows the gabinete placement and rotation.
  const plaque: SchoolPlaque = createSchoolPlaque({ texture: logo });
  root.add(plaque.root);

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    root.removeFromParent();
    plaque.dispose();
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    const images = new Set<unknown>();
    for (const texture of textures) {
      const image = texture.source.data as { close?: () => void } | undefined;
      if (image && !images.has(image)) {
        images.add(image);
        image.close?.();
      }
      texture.dispose();
    }
    sun.shadow.dispose();
    root.clear();
  };

  if (signal?.aborted) {
    dispose();
    assertActive(signal);
  }
  return { root, dispose };
}