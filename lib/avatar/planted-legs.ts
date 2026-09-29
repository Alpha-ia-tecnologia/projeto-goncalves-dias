import { Bone, Object3D, Quaternion, Vector3 } from "three";
import type { WalkingFeet, WalkingSide } from "./walking";

const FOOT_PITCH_AXIS = new Vector3(1, 0, 0);
const FOOT_YAW_AXIS = new Vector3(0, 1, 0);

type Leg = {
  side: WalkingSide;
  thigh: Bone;
  shin: Bone;
  foot: Bone;
  anchor: Vector3;
  pole: Vector3;
  orientation: Quaternion;
};

/** Keeps planted shoes fixed, or solves the walking controller's world-anchored foot targets. */
export class PlantedLegs {
  private legs: Leg[] = [];
  private rootRotation = new Quaternion();
  private inverseRootRotation = new Quaternion();
  private parentInverse = new Quaternion();
  private currentRotation = new Quaternion();
  private rotation = new Quaternion();
  private start = new Vector3();
  private knee = new Vector3();
  private ankle = new Vector3();
  private target = new Vector3();
  private axis = new Vector3();
  private pole = new Vector3();
  private aimOrigin = new Vector3();
  private currentDirection = new Vector3();
  private desiredDirection = new Vector3();

  constructor(private model: Object3D) {
    const bones = new Map<string, Bone>();
    model.updateMatrixWorld(true);
    model.traverse(object => {
      if (object instanceof Bone) bones.set(object.name.toLowerCase().replace(/[^a-z0-9]/g, ""), object);
    });
    this.inverseRootRotation.copy(model.getWorldQuaternion(this.rootRotation)).invert();
    if (!bones.has("quadril")) return;
    for (const side of ["d", "e"]) {
      const thigh = bones.get("coxa" + side);
      const shin = bones.get("canela" + side);
      const foot = bones.get("pe" + side);
      if (!thigh || !shin || !foot || shin.parent !== thigh || foot.parent !== shin) return;
      thigh.getWorldPosition(this.start);
      shin.getWorldPosition(this.knee);
      foot.getWorldPosition(this.ankle);
      this.axis.copy(this.ankle).sub(this.start).normalize();
      this.pole.copy(this.knee).sub(this.start);
      this.pole.addScaledVector(this.axis, -this.pole.dot(this.axis));
      if (this.pole.lengthSq() < 0.000001) this.pole.set(0, 0, 1).applyQuaternion(this.rootRotation);
      this.legs.push({
        side: side.toUpperCase() as WalkingSide, thigh, shin, foot,
        anchor: model.worldToLocal(this.ankle.clone()),
        pole: this.pole.clone().normalize().applyQuaternion(this.inverseRootRotation),
        orientation: foot.getWorldQuaternion(new Quaternion()).premultiply(this.inverseRootRotation).normalize(),
      });
    }
    if (this.legs.length !== 2) this.legs = [];
  }

  get available() {
    return this.legs.length === 2;
  }

  private aim(bone: Bone, child: Bone, destination: Vector3) {
    bone.getWorldPosition(this.aimOrigin);
    child.getWorldPosition(this.desiredDirection).sub(this.aimOrigin).normalize();
    this.currentDirection.copy(destination).sub(this.aimOrigin).normalize();
    this.rotation.setFromUnitVectors(this.desiredDirection, this.currentDirection);
    bone.getWorldQuaternion(this.currentRotation).premultiply(this.rotation);
    if (bone.parent) this.currentRotation.premultiply(bone.parent.getWorldQuaternion(this.parentInverse).invert());
    bone.quaternion.copy(this.currentRotation).normalize();
    bone.updateWorldMatrix(false, true);
  }

  update(targets?: WalkingFeet) {
    if (!this.available) return;
    this.model.getWorldQuaternion(this.rootRotation);
    for (const leg of this.legs) {
      leg.thigh.getWorldPosition(this.start);
      leg.shin.getWorldPosition(this.knee);
      leg.foot.getWorldPosition(this.ankle);
      const upper = this.start.distanceTo(this.knee);
      const lower = this.knee.distanceTo(this.ankle);
      const target = targets?.[leg.side];
      if (target) this.target.fromArray(target.position);
      else this.target.copy(leg.anchor);
      this.target.applyMatrix4(this.model.matrixWorld);
      this.axis.copy(this.target).sub(this.start);
      const distance = this.axis.length();
      if (distance < 0.00001 || upper < 0.00001 || lower < 0.00001) continue;
      this.axis.divideScalar(distance);
      // Anatomical two-bone IK: the knee keeps its original forward bend;
      // neither segment is stretched to reach the planted ankle.
      const reach = Math.min(upper + lower - 0.0000001, Math.max(Math.abs(upper - lower) + 0.0000001, distance));
      const along = (upper * upper - lower * lower + reach * reach) / (2 * reach);
      const forward = Math.sqrt(Math.max(0, upper * upper - along * along));
      this.pole.copy(leg.pole).applyQuaternion(this.rootRotation);
      this.pole.addScaledVector(this.axis, -this.pole.dot(this.axis)).normalize();
      this.knee.copy(this.start).addScaledVector(this.axis, along).addScaledVector(this.pole, forward);
      this.aim(leg.thigh, leg.shin, this.knee);
      this.aim(leg.shin, leg.foot, this.target);
      // Counter-rotate the ankle as well: anchoring its origin alone would
      // still let the heel and toes lift or skate along the floor.
      this.currentRotation.copy(leg.orientation);
      if (target) {
        this.rotation.setFromAxisAngle(FOOT_PITCH_AXIS, target.pitch);
        this.currentRotation.premultiply(this.rotation);
        this.rotation.setFromAxisAngle(FOOT_YAW_AXIS, target.yaw);
        this.currentRotation.premultiply(this.rotation);
      }
      this.currentRotation.premultiply(this.rootRotation);
      if (leg.foot.parent) this.currentRotation.premultiply(leg.foot.parent.getWorldQuaternion(this.parentInverse).invert());
      leg.foot.quaternion.copy(this.currentRotation).normalize();
      leg.foot.updateWorldMatrix(false, true);
    }
  }
}
