import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { Bone, Group, Quaternion, Vector3 } from "three";
import { AvatarRig } from "../lib/avatar/rig";
import { MocapClip, type MocapClipData } from "../lib/avatar/mocap";

type ExportedBone = {
  name: string; translation: number[]; rotation: number[]; scale: number[];
  children: number[]; nodeIndex: number;
};
type ClipName = "fala-1" | "fala-2";
const FPS = 60;
const DEGREES = 180 / Math.PI;
const OBSERVED = ["Cabeca", "Braco.D", "Antebraco.D", "Mao.D", "Braco.E", "Antebraco.E", "Mao.E"];
const manifest = JSON.parse(readFileSync(new URL("../public/models/avatar-manifest.json", import.meta.url), "utf8")) as { bones: ExportedBone[] };
const clips = new Map((["fala-1", "fala-2"] as const).map(name => [name,
  JSON.parse(readFileSync(new URL(`../public/models/clips/${name}.json`, import.meta.url), "utf8")) as MocapClipData,
]));

/** Test each shipped performance on the actual exported skeleton, independently. */
function avatar(name: ClipName) {
  const bones = new Map<number, Bone>();
  for (const data of manifest.bones) {
    const bone = new Bone();
    bone.name = data.name;
    bone.position.fromArray(data.translation);
    bone.quaternion.fromArray(data.rotation);
    bone.scale.fromArray(data.scale);
    bones.set(data.nodeIndex, bone);
  }
  for (const data of manifest.bones) for (const child of data.children) {
    if (bones.has(child)) bones.get(data.nodeIndex)!.add(bones.get(child)!);
  }
  const model = new Group();
  for (const bone of bones.values()) if (!bone.parent) model.add(bone);
  model.updateMatrixWorld(true);
  const rig = new AvatarRig(model);
  rig.setClips(new Map([[name, new MocapClip(clips.get(name)!)]]));
  return { rig, bone: (name: string) => model.getObjectByName(name) as Bone };
}

type Avatar = ReturnType<typeof avatar>;
type Frame = { head: Vector3; world: Quaternion[]; local: Quaternion[]; pelvis: Vector3 };
function sample(avatar: Avatar): Frame {
  return {
    head: avatar.bone("Cabeca").getWorldPosition(new Vector3()),
    world: OBSERVED.map(name => avatar.bone(name).getWorldQuaternion(new Quaternion()).normalize()),
    local: OBSERVED.map(name => avatar.bone(name).quaternion.clone().normalize()),
    pelvis: avatar.bone("Quadril").position.clone(),
  };
}

// Short word gaps must not turn into a sequence of starts and stops.
const syllables = (time: number) => time % 1.3 < 1.1 ? 0.45 + 0.35 * Math.max(0, Math.sin(time * 7.3)) : 0;
const speech = (time: number) => time >= 3 && time < 15 ? syllables(time) : 0;
const rotationApart = (a: Frame, b: Frame) => Math.max(...a.world.map((q, index) => q.angleTo(b.world[index]))) * DEGREES;

function extent(points: Vector3[]) {
  const low = points[0].clone(), high = points[0].clone();
  for (const point of points) { low.min(point); high.max(point); }
  return high.sub(low);
}

function peakSpeeds(frames: Frame[], from: number, to: number) {
  const peaks = OBSERVED.map(() => 0);
  for (let step = Math.max(1, Math.round(from * FPS)); step <= Math.round(to * FPS); step++) {
    frames[step].world.forEach((q, index) => {
      peaks[index] = Math.max(peaks[index], q.angleTo(frames[step - 1].world[index]) * FPS * DEGREES);
    });
  }
  return peaks;
}

describe.each<ClipName>(["fala-1", "fala-2"])("fala contida e repouso vivo: %s", name => {
  let spoken: Frame[], quiet: Frame[];
  beforeAll(() => {
    const speaker = avatar(name), listener = avatar(name);
    spoken = []; quiet = [];
    for (let step = 0; step <= 25 * FPS; step++) {
      const time = step / FPS;
      speaker.rig.update(time, true, speech(time));
      listener.rig.update(time, true, 0);
      spoken.push(sample(speaker));
      quiet.push(sample(listener));
    }
  });

  it("mantém rosto e braços expressivos sem os impulsos rápidos da captura integral", () => {
    // Observe world rotations: a wrist inherits motion from all its ancestors.
    // The unattenuated clips reached 97 deg/s at the head and 560 at an elbow.
    const peaks = peakSpeeds(spoken, 3, 20);
    expect(peaks[0], "velocidade da cabeça em graus/s").toBeLessThan(65);
    peaks.slice(1).forEach((speed, index) => expect(speed, OBSERVED[index + 1]).toBeLessThan(350));

    const talking = spoken.slice(5 * FPS, 15 * FPS);
    const movement = extent(talking.map(frame => frame.head));
    // A visible performance is still required; freezing the rig cannot pass.
    expect(movement.length()).toBeGreaterThan(0.025);
    expect(movement.x, "balanço lateral do rosto, em metros").toBeLessThan(0.14);
    expect(movement.z, "balanço em profundidade, em metros").toBeLessThan(0.09);
    expect(Math.max(...peaks.slice(1))).toBeGreaterThan(20);
  });

  it("conclui o gesto após a voz e retorna gradualmente ao repouso que continua vivo", () => {
    const at = (seconds: number) => Math.round(seconds * FPS);
    // There is still a held conversational pose just after the last word.
    expect(rotationApart(spoken[at(15.2)], quiet[at(15.2)])).toBeGreaterThan(3);
    const release = spoken.slice(at(15), at(15.5) + 1);
    let continuingMotion = 0;
    for (let index = 1; index < release.length; index++) {
      continuingMotion += rotationApart(release[index], release[index - 1]);
    }
    expect(continuingMotion, "o fim da fala não congela a última pose").toBeGreaterThan(1);
    const speeds = peakSpeeds(spoken, 15, 19);
    expect(speeds[0]).toBeLessThan(65);
    expect(Math.max(...speeds.slice(1))).toBeLessThan(350);
    expect(rotationApart(spoken[at(19)], quiet[at(19)])).toBeLessThan(0.5);
    expect(rotationApart(spoken[at(25)], quiet[at(25)])).toBeLessThan(0.01);
    expect(spoken[at(25)].pelvis.distanceTo(quiet[at(25)].pelvis)).toBeLessThan(0.00001);
  });

  it.each([12.2, 13.1, 14.3])("retorna ao repouso sem impulsos ao terminar em %s s", end => {
    const speaker = avatar(name), listener = avatar(name);
    const frames: Frame[] = [];
    for (let step = 0; step <= Math.round((end + 4) * FPS); step++) {
      const time = step / FPS;
      speaker.rig.update(time, true, time >= 3 && time < end ? syllables(time) : 0);
      listener.rig.update(time, true, 0);
      frames.push(sample(speaker));
    }
    // Ending on different captured poses must not turn the fade itself into
    // a fast arm stroke. A single chosen end time can miss that regression.
    const speeds = peakSpeeds(frames, end - 0.5, end + 4);
    expect(speeds[0], "head release speed in degrees/s").toBeLessThan(65);
    speeds.slice(1).forEach((speed, index) => expect(speed, OBSERVED[index + 1]).toBeLessThan(350));
    expect(rotationApart(frames[frames.length - 1], sample(listener))).toBeLessThan(0.5);
  });

  it("mantém ajustes discretos dos antebraços entre os gestos maiores do repouso", () => {
    const speaker = avatar(name);
    const windows: Frame[][] = [[], [], []];
    for (let step = 0; step < 59 * FPS; step++) {
      const time = step / FPS;
      speaker.rig.update(time, true, speech(time));
      // The occasional forearms-forward event has finished in these windows.
      // Local rotations distinguish living arms from arms merely carried by a sway.
      if (time >= 50) windows[Math.floor((time - 50) / 3)].push(sample(speaker));
    }
    for (const frames of windows) for (const index of [2, 5]) {
      const movement = Math.max(...frames.map(frame => frame.local[index].angleTo(frames[0].local[index]))) * DEGREES;
      expect(movement, `${OBSERVED[index]} continua vivo`).toBeGreaterThan(0.05);
      expect(movement, `${OBSERVED[index]} permanece discreto`).toBeLessThan(3);
    }
  });

  it("retoma a fala durante a soltura sem saltar nem ficar preso no repouso", () => {
    const returning = avatar(name), stopped = avatar(name);
    const resumed: Frame[] = [];
    let response = 0;
    for (let step = 0; step <= 19 * FPS; step++) {
      const time = step / FPS;
      returning.rig.update(time, true, time >= 16 ? syllables(time) : speech(time));
      stopped.rig.update(time, true, speech(time));
      const frame = sample(returning);
      resumed.push(frame);
      if (time >= 16.5 && time <= 17.5) response = Math.max(response, rotationApart(frame, sample(stopped)));
    }
    expect(response, "a nova fala volta a envolver o corpo").toBeGreaterThan(5);
    const speeds = peakSpeeds(resumed, 15.5, 19);
    expect(speeds[0]).toBeLessThan(65);
    expect(Math.max(...speeds.slice(1))).toBeLessThan(350);
  });

  it("respeita a desativação de movimentos durante a fala e durante o repouso", () => {
    const speaker = avatar(name);
    for (let step = 0; step <= 8 * FPS; step++) speaker.rig.update(step / FPS, true, speech(step / FPS));
    expect(speaker.rig.clipPlaying).toBe(true);
    for (const time of [8 + 1 / FPS, 20]) {
      speaker.rig.update(time, false, time < 15 ? syllables(time) : 0);
      for (const data of manifest.bones) {
        const bone = speaker.bone(data.name);
        expect(bone.quaternion.clone().normalize().angleTo(new Quaternion().fromArray(data.rotation).normalize()), data.name).toBeLessThan(1e-7);
        expect(bone.position.distanceTo(new Vector3().fromArray(data.translation)), data.name).toBeLessThan(1e-9);
        expect(bone.scale.distanceTo(new Vector3().fromArray(data.scale)), data.name).toBeLessThan(1e-9);
      }
    }
  });
});
