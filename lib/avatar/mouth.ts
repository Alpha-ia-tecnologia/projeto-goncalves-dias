import { MathUtils, Mesh, MeshStandardMaterial, Object3D } from "three";

export type MouthFrame = { open: number; round: number; wide: number; level?: number };

/** Follow the audio envelope without amplifying sample-to-sample lip flutter. */
export function smoothMouthFrame(current: MouthFrame, target: MouthFrame, delta: number) {
  const elapsed = Number.isFinite(delta) ? Math.max(0, Math.min(delta, 0.1)) : 0;
  const open = bounded(target.open);
  for (const key of ["open", "round", "wide"] as const) {
    const value = open < 0.005 ? 0 : bounded(target[key]);
    current[key] = bounded(current[key]);
    // A quicker attack retains short syllables; the softer release rejects
    // rapid flutter. Silence still closes promptly at phrase boundaries.
    const speed = value === 0 ? 42 : key === "open" ? (value > current[key] ? 32 : 22) : 20;
    current[key] += (value - current[key]) * -Math.expm1(-elapsed * speed);
    if (value === 0 && current[key] < 0.001) current[key] = 0;
  }
}

type MorphBinding = {
  mesh: Mesh;
  open: number;
  round: number;
  wide: number;
};

const bounded = (value: number) => Number.isFinite(value) ? MathUtils.clamp(value, 0, 1) : 0;

/** These seam attributes contain source-space scalar distances, not directions. */
export function bindMouth(model: Object3D) {
  const bindings: MorphBinding[] = [];
  const opening = { value: 0 };
  const patched = new Set<MeshStandardMaterial>();

  model.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const dictionary = object.morphTargetDictionary;
    if (dictionary && object.morphTargetInfluences) {
      const open = dictionary["Boca - abrir"];
      const round = dictionary["Labios - arredondar"];
      const wide = dictionary["Labios - alargar"];
      if (open !== undefined && round !== undefined && wide !== undefined) {
        for (const index of [open, round, wide]) object.morphTargetInfluences[index] = 0;
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
          "#include <common>\nattribute vec3 _mouth_shape;\nattribute float _mouth_corner;\nvarying vec3 vMouthShape;\nvarying float vMouthCorner;",
        ).replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\nvMouthShape = _mouth_shape;\nvMouthCorner = _mouth_corner;",
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <common>",
          "#include <common>\nuniform float uMouthOpen;\nvarying vec3 vMouthShape;\nvarying float vMouthCorner;",
        ).replace(
          "#include <map_fragment>",
          "#include <map_fragment>\n"
          + "float mouthCurrent = vMouthShape.x + vMouthShape.y * uMouthOpen;\n"
          + "float mouthLower = mouthCurrent - vMouthShape.z * uMouthOpen;\n"
          + "float mouthMask = (1.0 - smoothstep(-0.00065, 0.00035, mouthCurrent))\n"
          + "  * smoothstep(-0.00035, 0.00065, mouthLower)\n"
          + "  * vMouthCorner * min(10.0 * uMouthOpen, 1.0);\n"
          + "float mouthDepth = clamp(-mouthCurrent / max(-vMouthShape.z * uMouthOpen, 0.0001), 0.0, 1.0);\n"
          + "vec3 mouthInterior = mix(vec3(0.0025, 0.0010, 0.0008), vec3(0.022, 0.007, 0.006), smoothstep(0.25, 0.95, mouthDepth));\n"
          + "diffuseColor.rgb = mix(diffuseColor.rgb, mouthInterior, mouthMask);",
        ).replace(
          "#include <opaque_fragment>",
          // The cavity should not inherit facial normal-map highlights or metal
          // reflections: the inside stays recessed while the original lips light normally.
          "outgoingLight = mix(outgoingLight, mouthInterior, mouthMask);\n#include <opaque_fragment>",
        );
      };
      material.customProgramCacheKey = () => "goncalves-mouth-analytic-v2";
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
      weights[binding.round] = open < 0.005 ? 0 : bounded(frame.round);
      weights[binding.wide] = open < 0.005 ? 0 : bounded(frame.wide);
    }
  };
}
