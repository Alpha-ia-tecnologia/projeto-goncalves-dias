import { Group, Material, Mesh, MeshBasicMaterial, Object3D, Texture } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export const CHAT_PEDESTAL_URL = "/scenes/gabinete/quadro-chat.glb?v=quadro-chat-1";
export const CHAT_PEDESTAL_SCREEN = {
  width: 0.96,
  height: 1.2,
  center: [0, 1.48, 0.11] as const,
} as const;

export interface ChatPedestalOptions {
  signal?: AbortSignal;
  anisotropy?: number;
}

export interface ChatPedestal {
  /** Original dimensions in metres; Y up, front +Z and origin at the floor. */
  root: Group;
  /** Original screen plane. The host can attach its functional HTML interface. */
  screen: Object3D;
  dispose(): void;
}

function assertActive(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("Carregamento do quadro cancelado.", "AbortError");
  }
}

/** Load the carved frame supplied in Visualizar_Cenario (1).html, without its demo chat. */
export async function createChatPedestal(
  options: ChatPedestalOptions = {},
): Promise<ChatPedestal> {
  const { signal } = options;
  assertActive(signal);
  const response = await fetch(CHAT_PEDESTAL_URL, { signal });
  if (!response.ok) {
    throw new Error(`Não foi possível carregar o quadro (${response.status}).`);
  }
  const bytes = await response.arrayBuffer();
  assertActive(signal);

  // All images are embedded. Complete in-flight decoding before disposing an
  // aborted load, so StrictMode/unmount cannot strand textures or ImageBitmaps.
  const gltf = await new GLTFLoader().parseAsync(bytes, "");
  const root = gltf.scene;
  const geometries = new Set<Mesh["geometry"]>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    geometries.add(object.geometry);
    const meshMaterials: Material[] = Array.isArray(object.material)
      ? object.material
      : [object.material];
    object.castShadow = object.name !== "Tela_Chat";
    object.receiveShadow = object.name !== "Tela_Chat";
    for (const material of meshMaterials) {
      materials.add(material);
      if (material instanceof MeshBasicMaterial) material.toneMapped = false;
      for (const value of Object.values(material)) {
        if (value instanceof Texture) textures.add(value);
      }
    }
  });
  for (const texture of textures) {
    texture.anisotropy = Math.max(1, Math.min(options.anisotropy ?? 4, 8));
  }

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    root.removeFromParent();
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
    root.clear();
  };

  if (signal?.aborted) {
    dispose();
    assertActive(signal);
  }
  const screen = root.getObjectByName("Tela_Chat");
  if (!(screen instanceof Mesh)) {
    dispose();
    throw new Error("A superfície do quadro não foi encontrada.");
  }
  return { root, screen, dispose };
}