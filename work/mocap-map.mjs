// Mixamo bone -> our bone. Bones with no counterpart (clavicles, toes, the
// extra spine link, the finger tips) are absent on purpose: because the
// retarget carries world-space rotation deltas, whatever a missing bone did is
// already inside the world rotation of the bone below it.
export const BONE_MAP = {
  "mixamorig:Hips": "Quadril",
  "mixamorig:Spine": "Coluna",
  "mixamorig:Spine2": "Peito",
  "mixamorig:Neck": "Pescoco",
  "mixamorig:Head": "Cabeca",
  "mixamorig:RightArm": "Braco.D", "mixamorig:RightForeArm": "Antebraco.D", "mixamorig:RightHand": "Mao.D",
  "mixamorig:LeftArm": "Braco.E", "mixamorig:LeftForeArm": "Antebraco.E", "mixamorig:LeftHand": "Mao.E",
  "mixamorig:RightUpLeg": "Coxa.D", "mixamorig:RightLeg": "Canela.D", "mixamorig:RightFoot": "Pe.D",
  "mixamorig:LeftUpLeg": "Coxa.E", "mixamorig:LeftLeg": "Canela.E", "mixamorig:LeftFoot": "Pe.E",
};
for (const [side, ours] of [["Right", "D"], ["Left", "E"]]) {
  for (const [finger, name] of [["Thumb", "Polegar"], ["Index", "Indicador"]]) {
    for (const joint of [1, 2, 3]) {
      BONE_MAP[`mixamorig:${side}Hand${finger}${joint}`] = `${name}.0${joint}.${ours}`;
    }
  }
}
