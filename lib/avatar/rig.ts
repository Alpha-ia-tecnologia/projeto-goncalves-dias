import { Bone, MathUtils, Object3D, Quaternion, Vector3 } from "three";

type RestBone = {
  bone: Bone;
  local: Quaternion;
  world: Quaternion;
  inverseWorld: Quaternion;
  direction: Vector3;
  scale: Vector3;
};

const normalizeName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
const smooth = (start: number, end: number, value: number) => MathUtils.smoothstep(value, start, end);
const AXIS_X = new Vector3(1, 0, 0);
const AXIS_Y = new Vector3(0, 1, 0);
const AXIS_Z = new Vector3(0, 0, 1);

/** Procedural gestures preserve each exported rest transform; no baked mouth loop runs. */
export class AvatarRig {
  private bones = new Map<string, RestBone>();
  private swing = new Quaternion();
  private localDelta = new Quaternion();
  private targetRotation = new Quaternion();
  private parentInverse = new Quaternion();
  private direction = new Vector3();
  private waveStarted = -Infinity;
  private nodStarted = -Infinity;

  constructor(private model: Object3D) {
    model.updateMatrixWorld(true);
    model.traverse((object) => {
      if (!(object instanceof Bone)) return;
      const world = object.getWorldQuaternion(new Quaternion());
      this.bones.set(normalizeName(object.name), {
        bone: object,
        local: object.quaternion.clone(),
        world,
        inverseWorld: world.clone().invert(),
        direction: new Vector3(0, 1, 0).applyQuaternion(world),
        scale: object.scale.clone(),
      });
    });
    for (const name of ["Braco.D", "Antebraco.D", "Mao.D", "Cabeca", "Peito"]) {
      if (!this.get(name)) throw new Error("O esqueleto do personagem está incompleto.");
    }
  }

  gesture(kind: "wave" | "nod", now: number) {
    if (kind === "wave") this.waveStarted = now;
    else this.nodStarted = now;
  }

  private get(name: string) {
    return this.bones.get(normalizeName(name));
  }

  private rotate(name: string, axis: Vector3, angle: number) {
    const rest = this.get(name);
    if (!rest) return;
    this.swing.setFromAxisAngle(axis, angle);
    this.localDelta.copy(rest.inverseWorld).multiply(this.swing).multiply(rest.world);
    rest.bone.quaternion.multiply(this.localDelta);
  }

  private aim(name: string, x: number, y: number, z: number, weight: number) {
    const rest = this.get(name);
    if (!rest) return;
    this.direction.set(x, y, z).normalize();
    this.swing.setFromUnitVectors(rest.direction, this.direction);
    this.targetRotation.copy(this.swing).multiply(rest.world);
    if (rest.bone.parent) {
      rest.bone.parent.getWorldQuaternion(this.parentInverse).invert();
      this.targetRotation.premultiply(this.parentInverse);
    }
    rest.bone.quaternion.slerp(this.targetRotation, weight);
    rest.bone.updateWorldMatrix(false, true);
  }

  update(now: number, motionEnabled: boolean) {
    for (const rest of this.bones.values()) {
      rest.bone.quaternion.copy(rest.local);
      rest.bone.scale.copy(rest.scale);
    }
    if (!motionEnabled) {
      this.waveStarted = this.nodStarted = -Infinity;
      this.model.updateMatrixWorld(true);
      return;
    }

    const breath = Math.sin(now * Math.PI * 0.48);
    this.rotate("Coluna", AXIS_Z, Math.sin(now * 0.45) * 0.0028);
    this.rotate("Peito", AXIS_X, breath * 0.0028);
    this.rotate("Cabeca", AXIS_Y, Math.sin(now * 0.48) * 0.009);
    const chest = this.get("Peito");
    if (chest) chest.bone.scale.y *= 1 + breath * 0.0015;

    const nodTime = now - this.nodStarted;
    if (nodTime >= 0 && nodTime < 1.65) {
      const envelope = smooth(0, 0.22, nodTime) * (1 - smooth(1.25, 1.65, nodTime));
      this.rotate("Cabeca", AXIS_X, Math.sin(nodTime * Math.PI * 2 / 1.4) * 0.085 * envelope);
      this.rotate("Pescoco", AXIS_X, Math.sin(nodTime * Math.PI * 2 / 1.4) * 0.020 * envelope);
    }

    this.model.updateMatrixWorld(true);
    const waveTime = now - this.waveStarted;
    if (waveTime >= 0 && waveTime < 3.25) {
      const envelope = smooth(0, 0.75, waveTime) * (1 - smooth(2.5, 3.25, waveTime));
      const oscillation = Math.sin((waveTime - 0.65) * Math.PI * 2 * 1.45)
        * smooth(0.55, 0.95, waveTime) * (1 - smooth(2.25, 2.65, waveTime));
      this.aim("Braco.D", -0.70, -0.55, 0.44, envelope);
      this.aim("Antebraco.D", -0.13 + oscillation * 0.14, 0.96, 0.24, envelope);
      this.aim("Mao.D", -0.16 + oscillation * 0.38, 0.94, 0.26, envelope);
    }
  }
}
