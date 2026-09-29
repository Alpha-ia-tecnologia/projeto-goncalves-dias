// Pulls the skeleton and its animation out of a Mixamo FBX as world-space
// rotations per frame. Nothing here knows about our avatar yet.
import { readFbx, child, childrenNamed } from "./mocap-fbx.mjs";
import { Euler, Quaternion, Vector3, Matrix4 } from "three";

const FBX_SECOND = 46186158000;
const nameOf = node => String(node.properties[1]).split("\u0000\u0001")[0];
/**
 * FBX's default rotation order, eEulerXYZ, composes the matrix as Rz.Ry.Rx,
 * which three.js spells "ZYX". Reading it as "XYZ" agrees closely while the
 * angles are small and diverges completely near gimbal: the walk turns a full
 * circle, its hips sit at Y = -83 degrees, and the whole body inverted there.
 * The check that settles it is the rest pose - rebuilt from these Euler
 * properties it must equal the BindPose matrices, which the file stores raw,
 * and it does, to within a hundredth of a centimetre.
 */
const euler = (degrees) => new Quaternion().setFromEuler(
  new Euler(degrees[0] * Math.PI / 180, degrees[1] * Math.PI / 180, degrees[2] * Math.PI / 180, "ZYX"));

export function extract(path) {
  const { root } = readFbx(path);
  const objects = child(root, "Objects");
  const connections = child(root, "Connections").children.map(c => c.properties);

  // id -> node, for every object we care about
  const byId = new Map();
  for (const node of objects.children) byId.set(node.properties[0], node);

  // Bones, with their rest transform read from the node defaults.
  const bones = new Map();
  for (const model of childrenNamed(objects, "Model")) {
    if (model.properties[2] !== "LimbNode") continue;
    const props = child(model, "Properties70");
    const read = (key, fallback) => {
      const found = (props ? props.children : []).find(p => p.properties[0] === key);
      return found ? found.properties.slice(4).map(Number) : fallback;
    };
    bones.set(model.properties[0], {
      id: model.properties[0], name: nameOf(model), parent: null, children: [],
      translation: new Vector3(...read("Lcl Translation", [0, 0, 0])),
      preRotation: euler(read("PreRotation", [0, 0, 0])),
      restRotation: euler(read("Lcl Rotation", [0, 0, 0])),
      curves: {},
    });
  }
  // Parenting comes from the object-object connections (child, parent).
  for (const [kind, from, to] of connections) {
    if (kind !== "OO") continue;
    const parent = bones.get(to), node = bones.get(from);
    if (parent && node) { node.parent = parent; parent.children.push(node); }
  }
  const roots = [...bones.values()].filter(bone => !bone.parent);

  // Curves reach a bone through an AnimationCurveNode: curve -> curveNode -> bone property.
  const curveNodes = new Map();
  for (const node of childrenNamed(objects, "AnimationCurveNode")) {
    // A curve node carries a default per axis. An axis with no curve of its own
    // holds that default for the whole clip - it is not zero, and reading it as
    // zero tears the limb off its rest: the right foot of the walk rose to
    // 1.78 m before this was read.
    const defaults = {};
    for (const property of (child(node, "Properties70")?.children || [])) {
      const axis = String(property.properties[0]);
      if (axis.startsWith("d|")) defaults[axis.slice(2)] = Number(property.properties[4]);
    }
    curveNodes.set(node.properties[0], { kind: nameOf(node), channels: {}, defaults });
  }
  for (const [kind, from, to, property] of connections) {
    if (kind !== "OP") continue;
    const curveNode = curveNodes.get(from);
    if (curveNode) { const bone = bones.get(to); if (bone) bone.curves[property] = curveNode; continue; }
    const curve = byId.get(from);
    const target = curveNodes.get(to);
    if (curve && target && curve.name === "AnimationCurve") {
      target.channels[String(property).replace("d|", "")] = {
        times: child(curve, "KeyTime").properties[0],
        values: child(curve, "KeyValueFloat").properties[0],
      };
    }
  }

  // The node defaults are not the rest pose: there Mixamo leaves the arms
  // swung forward. The BindPose is the pose the mesh was skinned in, and it is
  // the only basis against which a rotation delta means anything.
  const bind = new Map();
  const poseNode = childrenNamed(objects, "Pose")[0];
  for (const entry of childrenNamed(poseNode, "PoseNode")) {
    const bone = bones.get(child(entry, "Node").properties[0]);
    if (bone) bind.set(bone.name, new Matrix4().fromArray(child(entry, "Matrix").properties[0]));
  }

  const stack = childrenNamed(objects, "AnimationStack")[0];
  const stop = (child(stack, "Properties70").children.find(p => p.properties[0] === "LocalStop")?.properties[4]) ?? 0;
  const duration = stop / FBX_SECOND;

  /** Linear read of one FBX curve at a time in seconds. */
  const sample = (channel, fallback) => {
    if (!channel) return fallback;
    const { times, values } = channel;
    return (seconds) => {
      const stamp = seconds * FBX_SECOND;
      if (stamp <= times[0]) return values[0];
      if (stamp >= times[times.length - 1]) return values[values.length - 1];
      let low = 0, high = times.length - 1;
      while (high - low > 1) { const middle = (low + high) >> 1; if (times[middle] <= stamp) low = middle; else high = middle; }
      const span = times[high] - times[low];
      const blend = span === 0 ? 0 : (stamp - times[low]) / span;
      return values[low] + (values[high] - values[low]) * blend;
    };
  };

  for (const bone of bones.values()) {
    const rotation = bone.curves["Lcl Rotation"], translation = bone.curves["Lcl Translation"];
    /** Reads the three axes of a curve node, falling back to its own defaults. */
    const channelReader = (curveNode, fallback) => (seconds) => ["X", "Y", "Z"].map((axis, index) => {
      const reader = sample(curveNode.channels[axis], null);
      if (reader) return reader(seconds);
      const stored = curveNode.defaults[axis];
      return stored === undefined ? fallback(index) : stored;
    });
    const readRotation = rotation ? channelReader(rotation, () => 0) : null;
    const readTranslation = translation ? channelReader(translation, index => bone.translation.getComponent(index)) : null;
    bone.rotationAt = (seconds) => readRotation ? euler(readRotation(seconds)) : bone.restRotation.clone();
    bone.translationAt = (seconds) => readTranslation ? new Vector3(...readTranslation(seconds)) : bone.translation.clone();
    bone.animated = Boolean(rotation || translation);
  }

  /** World transform of every bone at a time; pass null for the rest pose. */
  function poseAt(seconds) {
    const out = new Map();
    const walk = (bone, parentMatrix) => {
      const rotation = seconds === null ? bone.restRotation : bone.rotationAt(seconds);
      const translation = seconds === null ? bone.translation : bone.translationAt(seconds);
      const local = new Matrix4().compose(translation, bone.preRotation.clone().multiply(rotation), new Vector3(1, 1, 1));
      const world = parentMatrix.clone().multiply(local);
      out.set(bone.name, world);
      for (const node of bone.children) walk(node, world);
    };
    for (const bone of roots) walk(bone, new Matrix4());
    return out;
  }

  return { bones, roots, duration, poseAt, bind, frames: Math.round(duration * 30) + 1 };
}
