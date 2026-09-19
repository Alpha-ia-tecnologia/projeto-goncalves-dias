import { MathUtils, Mesh, MeshStandardMaterial, Object3D } from "three";

export type MouthFrame = { open: number; round: number; wide: number };

type MorphBinding = {
  mesh: Mesh;
  open: number;
  round: number;
  wide: number;
};

const bounded = (value: number) => Number.isFinite(value) ? MathUtils.clamp(value, 0, 1) : 0;

/** The exported seam uses Blender's original, undeformed scalar distances. */
export function bindMouth(model: Object3D) {
  const bindings: MorphBinding[] = [];
  const opening = { value: 0 };
  const patched = new Set<MeshStandardMaterial>();

  model.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const dictionary = object.morphTargetDictionary;
    if (dictionary && object.morphTargetInfluences) {
      object.morphTargetInfluences.fill(0);
      const open = dictionary["Boca - abrir"];
      const round = dictionary["Labios - arredondar"];
      const wide = dictionary["Labios - alargar"];
      if (open !== undefined && round !== undefined && wide !== undefined) {
        bindings.push({ mesh: object, open, round, wide });
      }
    }

    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!(material instanceof MeshStandardMaterial) || !material.userData.mouthInterior) continue;
      if (!object.geometry.hasAttribute("_mouth_shape") || !object.geometry.hasAttribute("_mouth_corner")) {
        throw new Error("O modelo não contém os atributos necessários para animar a boca.");
      }
      if (patched.has(material)) continue;
      patched.add(material);
      material.onBeforeCompile = (shader) => {
        shader.uniforms.uMouthOpen = opening;
        shader.vertexShader = shader.vertexShader.replace(
          "#include <common>",
          `#include <common>
          attribute vec3 _mouth_shape;
          attribute float _mouth_corner;
          varying vec3 vMouthShape;
          varying float vMouthCorner;`,
        ).replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          vMouthShape = _mouth_shape;
          vMouthCorner = _mouth_corner;`,
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <common>",
          `#include <common>
          uniform float uMouthOpen;
          varying vec3 vMouthShape;
          varying float vMouthCorner;`,
        ).replace(
          "#include <map_fragment>",
          `#include <map_fragment>
          float mouthCurrent = vMouthShape.x + vMouthShape.y * uMouthOpen;
          float mouthLower = mouthCurrent - vMouthShape.z * uMouthOpen;
          float mouthMask = (1.0 - smoothstep(-0.00025, 0.00020, mouthCurrent))
            * smoothstep(-0.00020, 0.00025, mouthLower)
            * vMouthCorner * min(7.0 * uMouthOpen, 1.0);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.009, 0.0016, 0.0022), mouthMask);`,
        );
      };
      material.customProgramCacheKey = () => "goncalves-mouth-analytic-v1";
      material.needsUpdate = true;
    }
  });

  if (!bindings.length) throw new Error("O modelo não contém os movimentos dos lábios.");

  return (frame: MouthFrame) => {
    const open = bounded(frame.open);
    opening.value = open;
    for (const binding of bindings) {
      const weights = binding.mesh.morphTargetInfluences!;
      weights[binding.open] = open;
      weights[binding.round] = bounded(frame.round);
      weights[binding.wide] = bounded(frame.wide);
    }
  };
}
