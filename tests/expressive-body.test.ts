import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Bone, Box3, Group, PerspectiveCamera, Quaternion, Vector3 } from "three";
import { AvatarRig } from "../lib/avatar/rig";
import { chatLayout } from "../lib/avatar/chat-layout";

type ExportedBone = { name: string; translation: number[]; rotation: number[]; scale: number[]; children: number[]; nodeIndex: number };

/** The scanned skeleton, exactly as the other rig tests build it. */
function avatar() {
  const manifest = JSON.parse(readFileSync(new URL("../public/models/avatar-manifest.json", import.meta.url), "utf8")) as { bones: ExportedBone[] };
  const map = new Map<number, Bone>();
  for (const data of manifest.bones) {
    const bone = new Bone(); bone.name = data.name;
    bone.position.fromArray(data.translation); bone.quaternion.fromArray(data.rotation); bone.scale.fromArray(data.scale);
    map.set(data.nodeIndex, bone);
  }
  for (const data of manifest.bones) for (const child of data.children) {
    const bone = map.get(child); if (bone) map.get(data.nodeIndex)!.add(bone);
  }
  const model = new Group();
  for (const bone of map.values()) if (!bone.parent) model.add(bone);
  model.updateMatrixWorld(true);
  const rig = new AvatarRig(model);
  const bone = (name: string) => model.getObjectByName(name) as Bone;
  return { model, rig, bone };
}

/** Syllable-like bursts: a voice level that rises and falls about once a second. */
const voice = (time: number) => 0.35 + 0.3 * Math.max(0, Math.sin(time * 7.3));

type Trace = { pelvis: Vector3[]; knee: Quaternion[] };

/** Runs the rig at 60 fps and records pelvis position and right knee rotation after a warm-up. */
function trace(speechLevel: (time: number) => number, seconds = 8, warmUp = 2): Trace {
  const { rig, bone } = avatar();
  const pelvis = bone("Quadril"), knee = bone("Canela.D");
  const out: Trace = { pelvis: [], knee: [] };
  for (let step = 0; step < seconds * 60; step++) {
    const time = step / 60;
    rig.update(time, true, speechLevel(time));
    if (time < warmUp) continue;
    out.pelvis.push(pelvis.getWorldPosition(new Vector3()));
    out.knee.push(knee.getWorldQuaternion(new Quaternion()));
  }
  return out;
}

const travel = (points: Vector3[]) => {
  const box = { min: points[0].clone(), max: points[0].clone() };
  for (const point of points) { box.min.min(point); box.max.max(point); }
  return box.max.distanceTo(box.min);
};
const rotation = (samples: Quaternion[]) => Math.max(...samples.map(sample => sample.angleTo(samples[0])));

describe("expressão do corpo durante a fala", () => {
  it("mantém a pelve viva enquanto fala, em vez de congelá-la até a próxima frase", () => {
    const speaking = trace(voice);
    const silent = trace(() => 0);
    // Postural life must not switch off with the voice. It may be quieter than
    // when waiting, but it must remain a clear fraction of it, and be visible.
    expect(travel(speaking.pelvis)).toBeGreaterThan(0.0025);
    expect(travel(speaking.pelvis)).toBeGreaterThan(travel(silent.pelvis) * 0.4);
    // And still a standing person, not a dancer.
    expect(travel(speaking.pelvis)).toBeLessThan(0.05);
  });

  it("articula os joelhos enquanto fala: as pernas absorvem o que a pelve faz", () => {
    const speaking = trace(voice);
    expect(rotation(speaking.knee)).toBeGreaterThan(0.002);
    expect(rotation(speaking.knee)).toBeLessThan(0.25);
  });

  it("responde às sílabas tônicas com um pulso no tronco, não só na cabeça", () => {
    const flat = trace(() => 0.5);
    const stressed = trace(voice);
    // A stress is a quick dip, not a larger excursion: a flat voice level gives
    // a constant emphasis and therefore a pelvis that does not dip at all, so
    // the mean vertical speed of the pelvis is what separates the two.
    const verticalSpeed = (points: Vector3[]) => points.slice(1)
      .reduce((sum, point, index) => sum + Math.abs(point.y - points[index].y), 0) / (points.length - 1);
    expect(verticalSpeed(stressed.pelvis)).toBeGreaterThan(verticalSpeed(flat.pelvis) * 2);
  });
});

describe("expressão das mãos durante o aceno", () => {
  it("os dedos respiram com cada balanço da palma, em vez de ficarem presos abertos", () => {
    const { rig, bone } = avatar();
    const tip = bone("Indicador.03.D"), palm = bone("Mao.D");
    rig.update(0, true, 0);
    rig.gesture("wave", 1);
    // Measured in the palm frame. A flexing finger moves its tip across the
    // line from wrist to tip, so the scalar distance to the wrist is blind to
    // it (it reported 1.8 mm for a 10 mm motion); the 3D extent is not.
    const points: Vector3[] = [];
    for (let step = 0; step <= 3.25 * 120; step++) {
      const time = 1 + step / 120;
      rig.update(time, true, 0);
      const waveTime = time - 1;
      if (waveTime < 0.9 || waveTime > 2.6) continue;      // the swing window
      points.push(palm.worldToLocal(tip.getWorldPosition(new Vector3())));
    }
    const box = new Box3().setFromPoints(points);
    // Before this the fingertip travelled 1.3 mm over the whole swing, which is
    // why the hand read as static. Ten millimetres is a hand that breathes;
    // three centimetres would be waving the fingers themselves.
    const amplitude = box.max.distanceTo(box.min);
    expect(amplitude).toBeGreaterThan(0.005);
    expect(amplitude).toBeLessThan(0.03);
    // And it must follow the palm. Project onto the dominant direction of the
    // motion and count reversals: the swing is fully on from 1.08 to 2.15 s at
    // about one hertz, roughly 1.7 swings here, so at least four reversals.
    const axis = box.max.clone().sub(box.min).normalize();
    const along = points.map(point => point.dot(axis));
    let reversals = 0;
    for (let index = 2; index < along.length; index++) {
      const before = along[index - 1] - along[index - 2];
      const after = along[index] - along[index - 1];
      if (before !== 0 && after !== 0 && Math.sign(before) !== Math.sign(after)) reversals++;
    }
    expect(reversals).toBeGreaterThanOrEqual(4);
    // Moving, but never flattened against a joint clamp for a whole stretch.
    let longestPlateau = 0, plateau = 0;
    for (let index = 1; index < along.length; index++) {
      plateau = Math.abs(along[index] - along[index - 1]) < 1e-7 ? plateau + 1 : 0;
      longestPlateau = Math.max(longestPlateau, plateau);
    }
    expect(longestPlateau).toBeLessThan(12);
  });
});

/** Total rotation a bone covers, in degrees: the largest angle between any two frames. */
function swing(samples: Quaternion[]) {
  let worst = 0;
  for (const sample of samples) for (const other of samples) worst = Math.max(worst, sample.angleTo(other));
  return worst * 180 / Math.PI;
}

/** Runs the rig and records the world rotation of each named bone after a warm-up. */
function trunkTrace(speechLevel: (time: number) => number, seconds = 24, warmUp = 3) {
  const { rig, bone } = avatar();
  const names = ["Coluna", "Peito", "Pescoco", "Cabeca"];
  const out = new Map<string, Quaternion[]>(names.map(name => [name, []]));
  for (let step = 0; step < seconds * 60; step++) {
    const time = step / 60;
    rig.update(time, true, speechLevel(time));
    if (time < warmUp) continue;
    for (const name of names) out.get(name)!.push(bone(name).getWorldQuaternion(new Quaternion()));
  }
  return out;
}

describe("tronco e pescoço durante a fala", () => {
  it("não ficam parados: falar move o tronco muitas vezes mais do que o silêncio", () => {
    const quiet = trunkTrace(() => 0);
    const speaking = trunkTrace(voice);
    // Measured before this layer existed: over twenty seconds of speech the
    // forearm swung 45 degrees and the spine 0.86. Gesturing arms on a trunk
    // that does not move is what reads as a puppet.
    expect(swing(speaking.get("Coluna")!)).toBeGreaterThan(swing(quiet.get("Coluna")!) * 5);
    expect(swing(speaking.get("Peito")!)).toBeGreaterThan(swing(quiet.get("Peito")!) * 5);
    expect(swing(speaking.get("Pescoco")!)).toBeGreaterThan(swing(quiet.get("Pescoco")!) * 2.5);
    // And visible in absolute terms, not merely relative to a very still pose.
    expect(swing(speaking.get("Peito")!)).toBeGreaterThan(4);
    expect(swing(speaking.get("Pescoco")!)).toBeGreaterThan(3);
  });

  it("respondem ao volume da voz, e não apenas à sua presença", () => {
    // The trunk weight the rig had was a flag - any sound within 0.58 s - and
    // saturated at a level of 0.32, so a loud passage and a murmured one moved
    // the body identically, to the second decimal.
    const soft = trunkTrace(time => 0.35 + 0.3 * Math.max(0, Math.sin(time * 6.1)));
    const loud = trunkTrace(time => 0.55 + 0.4 * Math.max(0, Math.sin(time * 6.1)));
    for (const name of ["Coluna", "Peito", "Pescoco"]) {
      expect(swing(loud.get(name)!), name).toBeGreaterThan(swing(soft.get(name)!) * 1.04);
    }
  });

  it("continuam dentro do que a pele deste scan aguenta", () => {
    // The same budget the captured clips are held to, measured on this mesh by
    // work/mocap-skin-budget.mjs: past it the skin between two bones collapses.
    const budget: Record<string, number> = { Coluna: 12, Peito: 12, Pescoco: 15, Cabeca: 15 };
    const { rig, bone } = avatar();
    const rest = new Map([...Object.keys(budget)].map(name => [name, bone(name).quaternion.clone()]));
    for (let step = 0; step < 40 * 60; step++) {
      const time = step / 60;
      rig.update(time, true, 0.55 + 0.4 * Math.max(0, Math.sin(time * 6.1)));
      for (const [name, limit] of Object.entries(budget)) {
        expect(bone(name).quaternion.angleTo(rest.get(name)!) * 180 / Math.PI, name).toBeLessThan(limit);
      }
    }
  });

  it("devolvem o corpo à pose de quem nunca falou, depois de calar", () => {
    const spoke = avatar(), quiet = avatar();
    for (let step = 0; step < 30 * 60; step++) {
      const time = step / 60;
      spoke.rig.update(time, true, time < 12 ? voice(time) : 0);
      quiet.rig.update(time, true, 0);
    }
    for (const name of ["Coluna", "Peito", "Pescoco", "Cabeca"]) {
      const apart = spoke.bone(name).getWorldQuaternion(new Quaternion())
        .angleTo(quiet.bone(name).getWorldQuaternion(new Quaternion()));
      expect(apart, name).toBeLessThan(1e-3);
    }
  });

  it("chegam à mesma pose a 30 e a 120 quadros por segundo", () => {
    const at = (fps: number) => {
      const { rig, bone } = avatar();
      for (let step = 0; step <= fps * 14; step++) {
        const time = step / fps;
        rig.update(time, true, 0.55 + 0.4 * Math.max(0, Math.sin(time * 6.1)));
      }
      return ["Coluna", "Peito", "Pescoco", "Cabeca"].map(name => bone(name).getWorldQuaternion(new Quaternion()));
    };
    const slow = at(30), fast = at(120);
    slow.forEach((rotation, index) => expect(rotation.angleTo(fast[index]) * 180 / Math.PI).toBeLessThan(0.3));
  });
});

describe("o aceno envolve o corpo", () => {
  const W = 1920, H = 1080;
  const layout = chatLayout(W, H);
  const camera = new PerspectiveCamera(layout.fov, W / H, 0.01, 100);
  camera.position.fromArray(layout.cameraPosition);
  camera.lookAt(new Vector3().fromArray(layout.target));
  camera.updateMatrixWorld(true);
  const onScreen = (point: Vector3) => { const v = point.clone().project(camera); return new Vector3((v.x + 1) / 2 * W, (1 - v.y) / 2 * H, 0); };

  it("inclina o tronco e responde com o outro braço, visivelmente, e volta ao repouso exato", () => {
    const waving = avatar(), quiet = avatar();
    let face = 0, freeWrist = 0;
    for (let frame = 0; frame <= 7 * 60; frame++) {
      const time = frame / 60;
      if (frame === 180) waving.rig.gesture("wave", time);
      waving.rig.update(time, true, 0);
      quiet.rig.update(time, true, 0);
      const relative = (who: typeof waving) => onScreen(who.bone("Cabeca").getWorldPosition(new Vector3())).sub(onScreen(who.bone("Quadril").getWorldPosition(new Vector3())));
      face = Math.max(face, relative(waving).distanceTo(relative(quiet)));
      const inChest = (who: typeof waving) => who.bone("Peito").worldToLocal(who.bone("Mao.E").getWorldPosition(new Vector3()));
      const depth = waving.bone("Mao.E").getWorldPosition(new Vector3()).distanceTo(camera.position);
      freeWrist = Math.max(freeWrist, inChest(waving).distanceTo(inChest(quiet)) * H / (2 * depth * Math.tan(layout.fov * Math.PI / 360)));
    }
    // At the conversation camera the face used to move 4.7 px against the pelvis
    // (the captured greeting moves it up to 34) and the free arm not at all.
    expect(face).toBeGreaterThan(15);
    expect(face).toBeLessThan(34);
    expect(freeWrist).toBeGreaterThan(10);
    for (const name of ["Coluna", "Peito", "Pescoco", "Cabeca", "Braco.E", "Antebraco.E"]) {
      const apart = waving.bone(name).quaternion.clone().normalize().angleTo(quiet.bone(name).quaternion.clone().normalize());
      expect(apart, name).toBeLessThan(1e-6);
    }
  });

  it("não deixa o braço erguido parado como uma articulação, nem o faz tremer", () => {
    const { rig, bone } = avatar();
    rig.update(0, true, 0);
    rig.gesture("wave", 1);
    const held: Quaternion[] = [];
    for (let step = 0; step <= 4 * 120; step++) {
      const time = 1 + step / 120;
      rig.update(time, true, 0);
      if (time - 1 >= 0.9 && time - 1 <= 2.5) held.push(bone("Braco.D").getWorldQuaternion(new Quaternion()));
    }
    let span = 0;
    for (const one of held) for (const other of held) span = Math.max(span, one.angleTo(other));
    // Through the hold the upper arm used to move 0.006 degrees in all. A held
    // human arm hunts around its target by about half a degree to one.
    expect(span * 180 / Math.PI).toBeGreaterThan(0.4);
    expect(span * 180 / Math.PI).toBeLessThan(1.0);
  });
});
