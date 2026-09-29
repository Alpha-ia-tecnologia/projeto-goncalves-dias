import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Bone, Group, Quaternion, Vector3 } from "three";
import { AvatarRig } from "../lib/avatar/rig";
import { AvatarWalker } from "../lib/avatar/walking";
import { MocapClip, type MocapClipData } from "../lib/avatar/mocap";

type ExportedBone = { name: string; translation: number[]; rotation: number[]; scale: number[]; children: number[]; nodeIndex: number };

function avatar(withClips = true) {
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
  const clips = new Map<string, MocapClip>();
  for (const name of ["cumprimento", "caminhada"]) {
    clips.set(name, new MocapClip(JSON.parse(readFileSync(new URL(`../public/models/clips/${name}.json`, import.meta.url), "utf8")) as MocapClipData));
  }
  if (withClips) rig.setClips(clips);
  return { model, rig, clips, bone: (name: string) => model.getObjectByName(name) as Bone };
}

/** Runs the rig at 60 fps from `from` to `to`, returning the last pose. */
function run(rig: AvatarRig, from: number, to: number, visit?: (time: number) => void) {
  for (let time = from; time <= to + 1e-9; time += 1 / 60) {
    rig.update(time, true, 0);
    visit?.(time);
  }
}

describe("o cumprimento capturado", () => {
  it("leva a mão mais longe que o aceno construído", () => {
    const captured = avatar(true), procedural = avatar(false);
    run(captured.rig, 0, 1); run(procedural.rig, 0, 1);
    // The wave is the procedural one on both: a captured handshake is not a
    // wave, and standing in for one only made the greeting stop looking like a
    // greeting. The clip is played deliberately instead.
    captured.rig.playClip("cumprimento", 1);
    procedural.rig.gesture("wave", 1);
    expect(captured.rig.clipPlaying).toBe(false);   // nothing has been drawn yet
    const travel = (a: typeof captured) => {
      const points: Vector3[] = [];
      run(a.rig, 1 + 1 / 60, 4.5, () => points.push(a.bone("Mao.D").getWorldPosition(new Vector3())));
      let far = 0;
      for (const point of points) for (const other of points) far = Math.max(far, point.distanceTo(other));
      return far;
    };
    const capturedTravel = travel(captured), proceduralTravel = travel(procedural);
    expect(captured.rig.clipPlaying).toBe(true);
    expect(procedural.rig.clipPlaying).toBe(false);
    // The captured greeting reaches out; the built one raises a forearm and
    // oscillates the wrist. The hand covering more ground is the whole point.
    expect(capturedTravel).toBeGreaterThan(proceduralTravel);
    expect(capturedTravel).toBeGreaterThan(0.2);
  });

  it("move o corpo todo, não só o braço: tronco, cabeça e pernas participam", () => {
    const { rig, bone } = avatar();
    run(rig, 0, 1);
    const rest = new Map<string, Quaternion>();
    for (const name of ["Peito", "Cabeca", "Coxa.D", "Quadril"]) rest.set(name, bone(name).getWorldQuaternion(new Quaternion()));
    const worst = new Map<string, number>();
    rig.playClip("cumprimento", 1);
    run(rig, 1 + 1 / 60, 4.5, () => {
      for (const [name, start] of rest) {
        worst.set(name, Math.max(worst.get(name) ?? 0, bone(name).getWorldQuaternion(new Quaternion()).angleTo(start)));
      }
    });
    // Idle alone moves the chest by about a degree. A captured greeting steps
    // forward and leans in, and every one of these has to show it.
    for (const [name, angle] of worst) expect(angle * 180 / Math.PI, name).toBeGreaterThan(4);
  });

  it("entrega a pose de volta ao repouso quando termina", () => {
    const { rig, bone } = avatar();
    run(rig, 0, 1);
    rig.playClip("cumprimento", 1);
    run(rig, 1 + 1 / 60, 9);
    const after = ["Braco.D", "Antebraco.D", "Mao.D", "Peito", "Cabeca"].map(name => bone(name).getWorldQuaternion(new Quaternion()));
    // The same rig, never given a greeting, arriving at the same moment.
    const quiet = avatar();
    run(quiet.rig, 0, 9);
    const expected = ["Braco.D", "Antebraco.D", "Mao.D", "Peito", "Cabeca"].map(name => quiet.bone(name).getWorldQuaternion(new Quaternion()));
    after.forEach((rotation, index) => expect(rotation.angleTo(expected[index])).toBeLessThan(0.01));
  });

  it("segue a captura de perto: as camadas procedurais acompanham sem disputar", () => {
    const { rig, bone, clips } = avatar();
    const clip = clips.get("cumprimento")!;
    run(rig, 0, 1);
    rig.playClip("cumprimento", 1);
    let worst = 0, worstBone = "";
    const wanted = new Map<string, Quaternion>();
    run(rig, 1 + 1 / 60, 4.2, (time) => {
      const elapsed = time - 1;
      if (elapsed < 0.4 || elapsed > clip.duration - 0.4) return;   // past the fades
      clip.pose(elapsed, (name, rotation) => wanted.set(name, rotation.clone()));
      for (const [name, rotation] of wanted) {
        const angle = bone(name).quaternion.angleTo(rotation);
        if (angle > worst) { worst = angle; worstBone = name; }
      }
    });
    // Breathing, gaze and the inertial layer all still run on top, so the pose
    // is never the clip exactly - but the clip has to be what one sees. What
    // they add, measured: a degree on the head, under half of one everywhere
    // else. The captured greeting is not being argued with.
    expect(worst * 180 / Math.PI, worstBone).toBeLessThan(2);
  });
});

describe("a caminhada capturada", () => {
  /** Walks the poet down a straight path and reports what his body did. */
  function stroll(withClips: boolean) {
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
    const model = new Group(), locomotion = new Group();
    locomotion.add(model);
    for (const bone of map.values()) if (!bone.parent) model.add(bone);
    model.updateMatrixWorld(true);
    const rig = new AvatarRig(model);
    if (withClips) {
      rig.setClips(new Map([["caminhada", new MocapClip(JSON.parse(
        readFileSync(new URL("../public/models/clips/caminhada.json", import.meta.url), "utf8")) as MocapClipData)]]));
    }
    const walker = new AvatarWalker(model);
    walker.setPath([[0, 1.5], [0, 3], [0, 4.5]]);

    const slips: number[] = [], chest: Vector3[] = [];
    let previous: { D: Vector3; E: Vector3 } | null = null;
    for (let step = 0; step < 10 * 60; step++) {
      const frame = walker.update(1 / 60);
      locomotion.position.set(0, 0, 0); locomotion.rotation.set(0, 0, 0);
      locomotion.updateMatrixWorld(true);
      rig.update(step / 60, true, 0, undefined, undefined, frame);
      locomotion.position.set(frame.x, 0, frame.z); locomotion.rotation.y = frame.yaw;
      locomotion.updateMatrixWorld(true);
      if (frame.weight < 0.9) { previous = null; continue; }
      chest.push(model.getObjectByName("Peito")!.getWorldPosition(new Vector3())
        .sub(model.getObjectByName("Quadril")!.getWorldPosition(new Vector3())));
      const feet = {
        D: model.getObjectByName("Pe.D")!.getWorldPosition(new Vector3()),
        E: model.getObjectByName("Pe.E")!.getWorldPosition(new Vector3()),
      };
      if (previous) {
        const planted = feet.D.y <= feet.E.y ? "D" : "E";
        slips.push(feet[planted].clone().sub(previous[planted]).setY(0).length() * 60);
      }
      previous = feet;
    }
    slips.sort((a, b) => a - b);
    const life = Math.max(...chest.map((point, index) => index ? point.distanceTo(chest[index - 1]) * 60 : 0));
    return { slip: slips[Math.floor(slips.length / 2)], worstSlip: slips[Math.floor(slips.length * 0.9)], life };
  }

  it("entra sozinha ao andar e traz o tronco vivo, sem tirar o pé do chão", () => {
    const plain = stroll(false), captured = stroll(true);
    // The foot solver still owns the ground. Driving the legs from the clip as
    // well drags the planted foot about 7 cm every second; lending only the
    // upper body leaves it exactly where the procedural walk leaves it.
    // What is left is the residual of the foot solve, half a micrometre per
    // second, and it is the same residual the procedural walk leaves.
    expect(captured.slip).toBeLessThan(1e-5);
    expect(captured.worstSlip).toBeLessThan(Math.max(plain.worstSlip, 1e-5) * 1.5);
    // And what it came for: a torso that moves like a walking person's.
    expect(captured.life).toBeGreaterThan(plain.life * 3);
  });

  it("solta a caminhada ao chegar e devolve o corpo ao repouso", () => {
    const walked = avatar(), still = avatar();
    const walker = new AvatarWalker(walked.model);
    const locomotion = new Group();
    walked.model.parent?.remove(walked.model);
    locomotion.add(walked.model);
    walker.setPath([[0, 1.2]]);

    let playing = false;
    for (let step = 0; step < 16 * 60; step++) {
      const frame = walker.update(1 / 60);
      locomotion.position.set(0, 0, 0); locomotion.rotation.set(0, 0, 0);
      locomotion.updateMatrixWorld(true);
      walked.rig.update(step / 60, true, 0, undefined, undefined, frame);
      locomotion.position.set(frame.x, 0, frame.z); locomotion.rotation.y = frame.yaw;
      locomotion.updateMatrixWorld(true);
      playing = playing || walked.rig.clipPlaying;
      still.rig.update(step / 60, true, 0);
    }
    // It engaged on its own while he walked, and let go once he arrived.
    expect(playing).toBe(true);
    expect(walked.rig.clipPlaying).toBe(false);
    for (const name of ["Peito", "Cabeca", "Braco.D"]) {
      const angle = walked.bone(name).getWorldQuaternion(new Quaternion())
        .angleTo(still.bone(name).getWorldQuaternion(new Quaternion()));
      expect(angle * 180 / Math.PI, name).toBeLessThan(2);
    }
  });
});

describe("a caminhada capturada, osso a osso", () => {
  type Walked = { following: Map<string, number[]>; headYaw: number[]; headBend: number };

  /**
   * Thirty seconds down a straight corridor with the captured walk, recording
   * for every frame how far each bone sits from the clip at the very moment the
   * rig says it laid on the bones - so these tests hold whatever way that moment
   * is chosen, which has its own tests.
   */
  let memo: Walked | null = null;
  function walked(): Walked {
    if (memo) return memo;
    const { model, rig, clips, bone } = avatar();
    const clip = clips.get("caminhada")!;
    const locomotion = new Group();
    model.parent?.remove(model);
    locomotion.add(model);
    const walker = new AvatarWalker(model);
    walker.setPath([[0, 2], [0, 4], [0, 6], [0, 8], [0, 10]]);
    // Normalised: the exported rest quaternions are a hair off unit length, and
    // an angle measured against one reads 0.00066 rad from the bone to itself.
    const rest = bone("Cabeca").quaternion.clone().normalize();
    const following = new Map<string, number[]>();
    const headYaw: number[] = [];
    let headBend = 0;
    const wanted = new Map<string, Quaternion>();
    for (let step = 0; step < 30 * 60; step++) {
      const time = step / 60;
      const frame = walker.update(1 / 60);
      locomotion.position.set(0, 0, 0); locomotion.rotation.set(0, 0, 0);
      locomotion.updateMatrixWorld(true);
      rig.update(time, true, 0, undefined, undefined, frame);
      // Locomotion is still at the origin here, as the stage leaves it while the
      // rig runs, so this yaw is the face's turn away from the path.
      const face = new Vector3(0, 0, 1).applyQuaternion(bone("Cabeca").getWorldQuaternion(new Quaternion())
        .multiply(new Quaternion().copy(rest).invert()));
      headBend = Math.max(headBend, bone("Cabeca").quaternion.clone().normalize().angleTo(rest) * 180 / Math.PI);
      locomotion.position.set(frame.x, 0, frame.z); locomotion.rotation.y = frame.yaw;
      locomotion.updateMatrixWorld(true);
      if (frame.weight < 0.9 || time < 3 || rig.clipTime === null) continue;
      headYaw.push(Math.atan2(face.x, face.z) * 180 / Math.PI);
      clip.pose(rig.clipTime, (name, rotation) => wanted.set(name, rotation.clone()));
      for (const [name, rotation] of wanted) {
        if (!following.has(name)) following.set(name, []);
        following.get(name)!.push(bone(name).quaternion.angleTo(rotation) * 180 / Math.PI);
      }
    }
    memo = { following, headYaw, headBend };
    return memo;
  }
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

  it("dirige o peito e o pescoço, e deixa só o quadril e as pernas com o andarilho", () => {
    const { following } = walked();
    // The exclusion used to be a pattern, /^(...|Pe.)/, whose unescaped dot let
    // "Pe." match Peito and Pescoco: the walk never reached the chest or neck,
    // which sat 4.4 degrees from the clip on average and 7.8 at worst.
    expect(mean(following.get("Peito")!)).toBeLessThan(1.0);
    expect(Math.max(...following.get("Peito")!)).toBeLessThan(1.5);
    expect(mean(following.get("Pescoco")!)).toBeLessThan(0.5);
    expect(Math.max(...following.get("Pescoco")!)).toBeLessThan(1.0);
    // And exactly seven are left to the walker - the pelvis and the legs, whose
    // own pose the foot solver needs - so each of them stays well off the clip.
    for (const name of ["Quadril", "Coxa.D", "Coxa.E", "Canela.D", "Canela.E", "Pe.D", "Pe.E"]) {
      expect(mean(following.get(name)!), name).toBeGreaterThan(2);
    }
  });

  it("não empilha o balanço procedural dos braços sobre o capturado", () => {
    const { following } = walked();
    // The gait's own swing used to be laid on top at the leg cadence: the right
    // arm sat 3.4 degrees off the capture on average and 7.5 at worst, and the
    // forearm a constant 4.0 - the procedural 0.07 rad, to the hundredth.
    for (const name of ["Braco.D", "Braco.E", "Antebraco.D", "Antebraco.E"]) {
      expect(mean(following.get(name)!), name).toBeLessThan(0.3);
      expect(Math.max(...following.get(name)!), name).toBeLessThan(0.5);
    }
  });

  it("firma a cabeça como a de quem anda, e não a dobra além do que a pele aguenta", () => {
    const { headYaw, headBend } = walked();
    // The source walks in a circle and looks into the turn. With the chest and
    // neck following it, the face swung 49.7 degrees across the walk, against
    // 3.6 for the procedural one. Steadied, it is under 20.
    expect(Math.max(...headYaw) - Math.min(...headYaw)).toBeLessThan(20);
    // Clips are built within the bend budget, but the layers on top used to push
    // the head to 15.9 against its 15. The budget now has the last word.
    expect(headBend).toBeLessThanOrEqual(15 + 1e-6);
  });

  it("o cumprimento também respeita o orçamento, depois de todas as camadas", () => {
    const { rig, bone } = avatar();
    const budget: Record<string, number> = JSON.parse(readFileSync(new URL("../lib/avatar/bend-budget.json", import.meta.url), "utf8"));
    const rest = new Map(Object.keys(budget).map(name => [name, bone(name).quaternion.clone().normalize()]));
    run(rig, 0, 1);
    rig.playClip("cumprimento", 1);
    run(rig, 1 + 1 / 60, 5.5, () => {
      for (const [name, limit] of Object.entries(budget)) {
        const bend = bone(name).quaternion.clone().normalize().angleTo(rest.get(name)!) * 180 / Math.PI;
        expect(bend, name).toBeLessThanOrEqual(limit + 1e-6);
      }
    });
  });
});

describe("o compasso da marcha", () => {
  it("conta os toques de calcanhar: inteira a cada pouso, contínua entre eles", () => {
    const walker = new AvatarWalker();
    walker.setPath([[0, 4]]);
    let previous = walker.update(0).stridePhase, previousSide = walker.update(0).landingSide;
    const landings: number[] = [];
    for (let step = 1; step < 16 * 120; step++) {
      const frame = walker.update(1 / 120);
      expect(frame.stridePhase).toBeGreaterThanOrEqual(previous);
      // At most one fixed 120 Hz step of a 0.54 s step between readings.
      expect(frame.stridePhase - previous).toBeLessThan(1 / 120 / 0.54 + 1e-9);
      if (Math.floor(frame.stridePhase) > Math.floor(previous)) {
        landings.push(frame.stridePhase);
        // Each landing is the other foot.
        expect(frame.landingSide).not.toBe(previousSide);
      }
      previous = frame.stridePhase; previousSide = frame.landingSide;
    }
    expect(landings.length).toBeGreaterThan(8);
  });

  it("marca o mesmo compasso a 30 e a 120 quadros por segundo, e não salta com a aba oculta", () => {
    const at = (fps: number) => {
      const walker = new AvatarWalker();
      walker.setPath([[0, 3]]);
      const phases = new Map<number, number>();
      for (let step = 0; step <= fps * 8; step++) {
        const frame = walker.update(step === 0 ? 0 : 1 / fps);
        if (step % (fps / 30) === 0) phases.set(Math.round(step * 30 / fps), frame.stridePhase);
      }
      return phases;
    };
    const slow = at(30), fast = at(120);
    for (const [key, phase] of slow) expect(fast.get(key)).toBe(phase);
    const walker = new AvatarWalker();
    walker.setPath([[0, 3]]);
    for (let step = 0; step < 60; step++) walker.update(1 / 60);
    const before = walker.update(0).stridePhase;
    expect(walker.update(30).stridePhase).toBe(before);   // a 30 s hidden tab
  });

  /** Walks with the captured walk and records local rotations at the given rate. */
  function traceWalk(withClips: boolean, path: [number, number][], seconds: number, finalYaw?: number, fps = 60) {
    const { model, rig, bone } = avatar(withClips);
    const locomotion = new Group();
    model.parent?.remove(model);
    locomotion.add(model);
    const walker = new AvatarWalker(model);
    if (finalYaw === undefined) walker.setPath(path); else walker.setPath(path, finalYaw);
    const frames: { time: number; weight: number; phase: number; local: Map<string, Quaternion>; world: Map<string, Quaternion> }[] = [];
    for (let step = 0; step <= seconds * fps; step++) {
      const time = step / fps;
      const frame = walker.update(step === 0 ? 0 : 1 / fps);
      locomotion.position.set(0, 0, 0); locomotion.rotation.set(0, 0, 0);
      locomotion.updateMatrixWorld(true);
      rig.update(time, true, 0, undefined, undefined, frame);
      const local = new Map<string, Quaternion>(), world = new Map<string, Quaternion>();
      for (const name of ["Coluna", "Cabeca", "Braco.D", "Antebraco.D", "Mao.D"]) {
        local.set(name, bone(name).quaternion.clone());
        world.set(name, bone(name).getWorldQuaternion(new Quaternion()));
      }
      frames.push({ time, weight: frame.weight, phase: frame.stridePhase, local, world });
      locomotion.position.set(frame.x, 0, frame.z); locomotion.rotation.y = frame.yaw;
      locomotion.updateMatrixWorld(true);
    }
    return frames;
  }

  it("move tronco e braços capturados no ritmo das pernas, e não no seu próprio", () => {
    const frames = traceWalk(true, [[0, 16]], 36).filter(frame => frame.weight > 0.99 && frame.time > 5 && frame.time < 33);
    const span = frames[frames.length - 1].time - frames[0].time;
    const legs = (frames[frames.length - 1].phase - frames[0].phase) / 2 / span;
    // Power spectrum of the local rotation, all three components, Hann window.
    const spectrum = (name: string) => {
      const count = frames.length, bins: { hz: number; power: number }[] = [];
      for (let k = 1; k / span <= 3; k++) {
        let power = 0;
        for (const part of ["x", "y", "z"] as const) {
          const values = frames.map(frame => frame.local.get(name)![part]);
          const mean = values.reduce((sum, value) => sum + value, 0) / count;
          let re = 0, im = 0;
          for (let index = 0; index < count; index++) {
            const sample = (values[index] - mean) * (0.5 - 0.5 * Math.cos(2 * Math.PI * index / (count - 1)));
            re += sample * Math.cos(2 * Math.PI * k * index / count);
            im -= sample * Math.sin(2 * Math.PI * k * index / count);
          }
          power += re * re + im * im;
        }
        bins.push({ hz: k / span, power });
      }
      return bins;
    };
    for (const name of ["Coluna", "Braco.D", "Antebraco.D"]) {
      const bins = spectrum(name);
      const peak = bins.reduce((best, bin) => bin.power > best.power ? bin : best);
      // Driven by distance, the clip played at 0.39 Hz over legs striding at
      // 0.91: two rhythms on one body. Now its peak is the stride of the legs.
      expect(Math.abs(peak.hz - legs), name).toBeLessThan(1.5 / span);
      const slow = bins.filter(bin => bin.hz >= 0.30 && bin.hz <= 0.45).reduce((most, bin) => Math.max(most, bin.power), 0);
      expect(slow / peak.power, name).toBeLessThan(0.10);
    }
  });

  it("não congela o tronco ao girar no lugar, onde os pés andam mas o corpo não se desloca", () => {
    const speed = (withClips: boolean) => {
      const frames = traceWalk(withClips, [[0, 0.001]], 10, Math.PI).filter(frame => frame.weight > 0.5 && frame.time > 0.5);
      let angle = 0;
      for (let index = 1; index < frames.length; index++) angle += frames[index].world.get("Coluna")!.angleTo(frames[index - 1].world.get("Coluna")!);
      return angle / (frames[frames.length - 1].time - frames[0].time);
    };
    // By distance, a turn on the spot covered none and the captured trunk stood
    // still: 0.3 degrees a second on the head, against 2.3 without the clip.
    expect(speed(true)).toBeGreaterThan(speed(false));
  });

  it("chega à mesma pose a 30 e a 120 quadros por segundo, clipe incluído", () => {
    const slow = traceWalk(true, [[0, 8]], 16, undefined, 30), fast = traceWalk(true, [[0, 8]], 16, undefined, 120);
    let worst = 0;
    for (const frame of slow) {
      const twin = fast.find(other => Math.abs(other.time - frame.time) < 1e-9);
      if (!twin) continue;
      for (const [name, rotation] of frame.local) worst = Math.max(worst, rotation.angleTo(twin.local.get(name)!));
    }
    // The fade used to run on the clock from whichever frame first saw the walk
    // - 8 ms in at 120 fps, 33 ms at 30 - and the right hand sat 4.3 degrees
    // apart through it. Driven by the weight of the walk itself it is the same
    // curve. The tolerance is the one the wave test of the inertial layer uses.
    expect(worst).toBeLessThan(0.01);
  });
});

describe("a fala capturada", () => {
  /** The skeleton with every clip installed, as the stage installs them. */
  function talker(withTalk = true) {
    const built = avatar(false);
    const clips = new Map<string, MocapClip>();
    for (const name of withTalk ? ["cumprimento", "caminhada", "fala-1", "fala-2"] : ["cumprimento", "caminhada"]) {
      clips.set(name, new MocapClip(JSON.parse(readFileSync(new URL(`../public/models/clips/${name}.json`, import.meta.url), "utf8")) as MocapClipData));
    }
    built.rig.setClips(clips);
    return built;
  }
  /** Speech from 3 s to 13 s with syllables and short gaps between words. */
  const speech = (time: number) => time < 3 || time > 13 ? 0
    : (time % 1.3 < 1.1 ? 0.45 + 0.35 * Math.max(0, Math.sin(time * 7.3)) : 0);

  it("move o corpo todo de forma visível enquanto fala, e não só os braços", () => {
    const travel = (withTalk: boolean) => {
      const { rig, bone } = talker(withTalk);
      const restHead = bone("Cabeca").getWorldQuaternion(new Quaternion());
      const points: Vector3[] = [];
      for (let step = 0; step < 14 * 60; step++) {
        const time = step / 60;
        rig.update(time, true, speech(time));
        if (time < 3.5 || time > 13) continue;
        // a point on the face, ahead of and above the joint a nod turns about
        const turn = bone("Cabeca").getWorldQuaternion(new Quaternion()).multiply(restHead.clone().invert());
        points.push(bone("Cabeca").getWorldPosition(new Vector3()).add(new Vector3(0, 0.10, 0.09).applyQuaternion(turn)));
      }
      const low = points[0].clone(), high = points[0].clone();
      for (const point of points) { low.min(point); high.max(point); }
      return high.sub(low);
    };
    const procedural = travel(false), captured = travel(true);
    // With the recorded voice of the poet the face moved 15 px across and 2 px
    // up and down at the conversation camera; the talking clip takes it to 82
    // and 25. Here, in metres, the same kind of margin.
    expect(captured.x).toBeGreaterThan(procedural.x * 3);
    expect(captured.y).toBeGreaterThan(procedural.y * 3);
  });

  it("fala para quem conversa: o rosto não se desvia para o lado", () => {
    const { rig, bone } = talker();
    const restHead = bone("Cabeca").getWorldQuaternion(new Quaternion());
    const turns: number[] = [];
    for (let step = 0; step < 14 * 60; step++) {
      const time = step / 60;
      rig.update(time, true, speech(time));
      if (time < 3.5 || time > 13) continue;
      const face = new Vector3(0, 0, 1).applyQuaternion(bone("Cabeca").getWorldQuaternion(new Quaternion()).multiply(restHead.clone().invert()));
      turns.push(Math.abs(Math.atan2(face.x, face.z)) * 180 / Math.PI);
    }
    turns.sort((a, b) => a - b);
    expect(turns[Math.floor(turns.length / 2)]).toBeLessThan(6);
    expect(turns[turns.length - 1]).toBeLessThan(15);
  });

  it("transfere o peso de uma perna para a outra sem tirar os pés do chão", () => {
    const { rig, bone } = talker();
    let start: Vector3[] = [], lift = 0, slide = 0, pelvis = 0;
    for (let step = 0; step < 14 * 60; step++) {
      const time = step / 60;
      rig.update(time, true, speech(time));
      const feet = [bone("Pe.D").getWorldPosition(new Vector3()), bone("Pe.E").getWorldPosition(new Vector3())];
      const hips = bone("Quadril").getWorldPosition(new Vector3());
      if (time < 3) { start = feet; continue; }
      pelvis = Math.max(pelvis, Math.abs(hips.x));
      feet.forEach((foot, index) => {
        lift = Math.max(lift, foot.y - start[index].y);
        slide = Math.max(slide, foot.clone().setY(0).distanceTo(start[index].clone().setY(0)));
      });
    }
    expect(pelvis).toBeGreaterThan(0.02);   // the captured transfer of weight reaches the pelvis
    expect(lift).toBeLessThan(0.001);
    expect(slide).toBeLessThan(0.001);
  });

  it("atravessa as pausas entre palavras sem sair da postura de fala", () => {
    const { rig } = talker();
    const weights: number[] = [];
    const internal = rig as unknown as { clipWeight: number };
    for (let step = 0; step < 14 * 60; step++) {
      const time = step / 60;
      rig.update(time, true, speech(time));
      if (time > 4.5 && time < 13) weights.push(internal.clipWeight);
    }
    // Following the syllable envelope, the posture fell halfway out in every
    // 0.2 s gap between words: a body pumping in and out of talking.
    expect(Math.min(...weights)).toBeGreaterThan(0.9);
  });

  it("devolve o corpo à pose de quem nunca falou, depois de calar", () => {
    const spoke = talker(), quiet = talker();
    for (let step = 0; step < 30 * 60; step++) {
      const time = step / 60;
      spoke.rig.update(time, true, speech(time));
      quiet.rig.update(time, true, 0);
    }
    expect(spoke.rig.clipPlaying).toBe(false);
    for (const name of ["Quadril", "Coluna", "Peito", "Pescoco", "Cabeca", "Braco.D", "Antebraco.D", "Mao.D", "Braco.E"]) {
      const apart = spoke.bone(name).quaternion.clone().normalize().angleTo(quiet.bone(name).quaternion.clone().normalize());
      expect(apart, name).toBeLessThan(1e-6);
    }
    expect(spoke.bone("Quadril").position.distanceTo(quiet.bone("Quadril").position)).toBeLessThan(1e-6);
  });

  it("segue o protocolo de taxa de quadros do autor, clipe incluído", () => {
    // Constant voice for 22 s, compared at the end, as the rig test does it.
    const at = (fps: number) => {
      const { rig, bone } = talker();
      for (let frame = 0; frame <= fps * 22; frame++) rig.update(frame / fps, true, 0.42);
      return ["Quadril", "Coluna", "Peito", "Pescoco", "Cabeca", "Braco.D", "Antebraco.D", "Mao.D", "Braco.E"]
        .map(name => bone(name).quaternion.clone().normalize());
    };
    const slow = at(30), fast = at(120);
    slow.forEach((rotation, index) => expect(rotation.angleTo(fast[index])).toBeLessThan(0.004));
  });

  it("dá o corpo à caminhada quando o poeta anda enquanto fala", () => {
    const { model, rig } = talker();
    const locomotion = new Group();
    model.parent?.remove(model);
    locomotion.add(model);
    const walker = new AvatarWalker(model);
    walker.setPath([[0, 3]]);
    const internal = rig as unknown as { clip: { name: string } | null };
    const seen = new Set<string>();
    for (let step = 0; step < 6 * 60; step++) {
      const time = step / 60;
      const frame = walker.update(step === 0 ? 0 : 1 / 60);
      locomotion.position.set(0, 0, 0); locomotion.rotation.set(0, 0, 0);
      locomotion.updateMatrixWorld(true);
      rig.update(time, true, 0.5, undefined, undefined, frame);
      if (frame.weight > 0.5 && internal.clip) seen.add(internal.clip.name);
      locomotion.position.set(frame.x, 0, frame.z); locomotion.rotation.y = frame.yaw;
      locomotion.updateMatrixWorld(true);
    }
    expect([...seen]).toEqual(["caminhada"]);
  });
});
