/**
 * Reads the avatar's skin weights straight out of the GLB and asks, for each
 * joint, which vertices a rotation of that joint would drag against vertices
 * held by its neighbour. A clip may bend a joint further than the procedural
 * rig ever did, and where two bones share a vertex the mesh stretches; this is
 * what says how far is too far, instead of guessing.
 *
 *   node work/mocap-skin-budget.mjs
 */
import { readFileSync } from "node:fs";

const path = "./public/models/goncalves-dias.glb";
const data = readFileSync(path);
if (data.toString("utf8", 0, 4) !== "glTF") throw new Error("not a GLB");
let at = 12, json = null, binary = null;
while (at < data.length) {
  const length = data.readUInt32LE(at), type = data.readUInt32LE(at + 4);
  const body = data.subarray(at + 8, at + 8 + length);
  if (type === 0x4e4f534a) json = JSON.parse(body.toString("utf8"));
  else if (type === 0x004e4942) binary = body;
  at += 8 + length + ((4 - (length % 4)) % 4) * 0;
  at += (4 - (at % 4)) % 4;
}
const COMPONENT = { 5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2], 5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4] };
const COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function read(index) {
  const accessor = json.accessors[index];
  const [Kind, size] = COMPONENT[accessor.componentType];
  const items = COUNT[accessor.type];
  const view = json.bufferViews[accessor.bufferView];
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const stride = view.byteStride ?? items * size;
  const out = new Kind(accessor.count * items);
  for (let element = 0; element < accessor.count; element++) {
    const base = start + element * stride;
    for (let component = 0; component < items; component++) {
      const offset = base + component * size;
      out[element * items + component] = size === 4 && Kind === Float32Array ? binary.readFloatLE(offset)
        : size === 4 ? binary.readUInt32LE(offset)
        : size === 2 ? (Kind === Int16Array ? binary.readInt16LE(offset) : binary.readUInt16LE(offset))
        : (Kind === Int8Array ? binary.readInt8(offset) : binary.readUInt8(offset));
    }
  }
  return out;
}

const skin = json.skins[0];
const boneNames = skin.joints.map(node => json.nodes[node].name);
const shared = new Map();   // "A|B" -> how many vertices both bones hold meaningfully
const held = new Map();     // bone -> vertices it holds at all
for (const mesh of json.meshes) {
  for (const primitive of mesh.primitives) {
    if (primitive.attributes.JOINTS_0 === undefined) continue;
    const joints = read(primitive.attributes.JOINTS_0);
    const weights = read(primitive.attributes.WEIGHTS_0);
    const vertices = joints.length / 4;
    for (let vertex = 0; vertex < vertices; vertex++) {
      const influences = [];
      for (let slot = 0; slot < 4; slot++) {
        const weight = weights[vertex * 4 + slot];
        if (weight > 0.08) influences.push([boneNames[joints[vertex * 4 + slot]], weight]);
      }
      for (const [name] of influences) held.set(name, (held.get(name) ?? 0) + 1);
      for (let a = 0; a < influences.length; a++) for (let b = a + 1; b < influences.length; b++) {
        const key = [influences[a][0], influences[b][0]].sort().join("|");
        shared.set(key, (shared.get(key) ?? 0) + 1);
      }
    }
  }
}
console.log("vertices que dois ossos dividem (peso > 0,08), pares que importam:");
void 0;
const interesting = [["Pescoco","Cabeca"],["Peito","Pescoco"],["Antebraco.D","Mao.D"],["Braco.D","Antebraco.D"],["Coluna","Peito"],["Quadril","Coluna"]];
for (const [a, b] of interesting) {
  const key = [a, b].sort().join("|");
  const together = shared.get(key) ?? 0;
  console.log("  " + (a + " + " + b).padEnd(28) + String(together).padStart(6) + " vertices"
    + "   (" + a + " segura " + (held.get(a) ?? 0) + ", " + b + " segura " + (held.get(b) ?? 0) + ")");
}


// ---- How much skin is lost at a given bend ----------------------------------
// Linear blend skinning collapses a vertex held by two bones that have rotated
// apart: the classic "candy wrapper". Here the actual mesh is skinned at a
// range of bend angles and the loss measured, so the budget a clip is given is
// a number read off this avatar rather than a guess.
import { Bone, Group, Matrix4, Quaternion, Vector3 } from "three";

const manifest = JSON.parse(readFileSync("./public/models/avatar-manifest.json", "utf8"));
const bones = new Map();
for (const entry of manifest.bones) {
  const bone = new Bone(); bone.name = entry.name;
  bone.position.fromArray(entry.translation); bone.quaternion.fromArray(entry.rotation); bone.scale.fromArray(entry.scale);
  bones.set(entry.nodeIndex, bone);
}
for (const entry of manifest.bones) for (const child of entry.children) {
  const bone = bones.get(child); if (bone) bones.get(entry.nodeIndex).add(bone);
}
const rig = new Group();
for (const bone of bones.values()) if (!bone.parent) rig.add(bone);
rig.updateMatrixWorld(true);

const inverseBind = read(skin.inverseBindMatrices);
const boneByName = new Map([...bones.values()].map(bone => [bone.name, bone]));
const restWorld = new Map([...boneByName].map(([name, bone]) => [name, bone.matrixWorld.clone()]));

/** Skins the vertices of every primitive under the current pose. */
function skinned(collect) {
  const out = [];
  for (const mesh of json.meshes) for (const primitive of mesh.primitives) {
    if (primitive.attributes.JOINTS_0 === undefined) continue;
    const joints = read(primitive.attributes.JOINTS_0);
    const weights = read(primitive.attributes.WEIGHTS_0);
    const positions = read(primitive.attributes.POSITION);
    for (let vertex = 0; vertex < positions.length / 3; vertex++) {
      if (!collect(joints, weights, vertex)) continue;
      const rest = new Vector3(positions[vertex*3], positions[vertex*3+1], positions[vertex*3+2]);
      const blended = new Vector3();
      for (let slot = 0; slot < 4; slot++) {
        const weight = weights[vertex*4+slot];
        if (weight <= 0) continue;
        const name = boneNames[joints[vertex*4+slot]];
        const bind = new Matrix4().fromArray(inverseBind, joints[vertex*4+slot]*16);
        const point = rest.clone().applyMatrix4(bind).applyMatrix4(boneByName.get(name).matrixWorld);
        blended.addScaledVector(point, weight);
      }
      out.push(blended);
    }
  }
  return out;
}

const sharedBy = (parent, child) => (joints, weights, vertex) => {
  let outer = 0, inner = 0;
  for (let slot = 0; slot < 4; slot++) {
    const name = boneNames[joints[vertex*4+slot]], weight = weights[vertex*4+slot];
    if (name === parent) outer = weight; else if (name === child) inner = weight;
  }
  return outer > 0.08 && inner > 0.08;
};

/** The bend at which no shared vertex collapses by more than the allowance. */
function budget(parent, child, allowanceMm) {
  const bone = boneByName.get(child);
  const restLocal = bone.quaternion.clone();
  const shares = sharedBy(parent, child);
  const atRest = skinned(shares);
  if (!atRest.length) return null;
  const pivotRest = new Vector3().setFromMatrixPosition(restWorld.get(child));
  const restRadius = atRest.map(point => point.distanceTo(pivotRest));
  const lossAt = (degrees) => {
    bone.quaternion.copy(restLocal).multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), degrees * Math.PI / 180));
    rig.updateMatrixWorld(true);
    const posed = skinned(shares);
    const pivot = bone.getWorldPosition(new Vector3());
    let worst = 0;
    for (let index = 0; index < posed.length; index++) worst = Math.max(worst, restRadius[index] - posed[index].distanceTo(pivot));
    bone.quaternion.copy(restLocal); rig.updateMatrixWorld(true);
    return worst * 1000;
  };
  let low = 0, high = 90;
  for (let step = 0; step < 14; step++) { const mid = (low + high) / 2; if (lossAt(mid) < allowanceMm) low = mid; else high = mid; }
  return { vertices: atRest.length, degrees: low, at30: lossAt(30), at60: lossAt(60) };
}

console.log("");
console.log("quanto cada junta pode dobrar antes de a pele ceder mais que a folga:");
console.log("  junta                  vertices   perda a 30    perda a 60    limite(1,2mm)  limite(4mm)");
for (const [parent, child] of [["Pescoco","Cabeca"],["Peito","Pescoco"],["Coluna","Peito"],["Base","Coluna"],
                               ["Peito","Braco.D"],["Braco.D","Antebraco.D"],["Antebraco.D","Mao.D"],
                               ["Quadril","Coxa.D"],["Coluna","Coxa.D"],["Coxa.D","Canela.D"],["Canela.D","Pe.D"]]) {
  const tight = budget(parent, child, 1.2), loose = budget(parent, child, 4);
  if (!tight) { console.log("  " + (parent + ">" + child).padEnd(24) + "sem vertices partilhados"); continue; }
  console.log("  " + (parent + ">" + child).padEnd(24) + String(tight.vertices).padStart(7)
    + tight.at30.toFixed(1).padStart(12) + " mm" + tight.at60.toFixed(1).padStart(11) + " mm"
    + tight.degrees.toFixed(0).padStart(12) + " graus" + loose.degrees.toFixed(0).padStart(10) + " graus");
}
