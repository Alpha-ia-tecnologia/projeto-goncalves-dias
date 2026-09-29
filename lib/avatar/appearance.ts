import { Mesh, MeshStandardMaterial, Object3D } from "three";

/** Preserve the eyes' highlights and the skin/fabric settings baked into the avatar. */
export function prepareAvatarSurface(model: Object3D, maxAnisotropy: number) {
  const visited = new Set<MeshStandardMaterial>();
  model.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!(material instanceof MeshStandardMaterial) || visited.has(material)) continue;
      visited.add(material);
      material.metalness = 0;
      if (material.map) material.map.anisotropy = Math.max(1, Math.min(4, maxAnisotropy));
      const eye = Boolean(object.userData.avatarEye || material.userData.avatarEye);
      if (!eye) material.roughness = Math.max(material.roughness, 0.68);
    }
  });
}
