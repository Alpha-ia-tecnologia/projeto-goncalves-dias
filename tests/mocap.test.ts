import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { Bone, Group, Quaternion, Vector3 } from "three";
import { loadMocapClips, MocapClip, type MocapClipData } from "../lib/avatar/mocap";

type ExportedBone = { name: string; translation: number[]; rotation: number[]; scale: number[]; children: number[]; nodeIndex: number };

const clipData = (name: string) =>
  JSON.parse(readFileSync(new URL(`../public/models/clips/${name}.json`, import.meta.url), "utf8")) as MocapClipData;

/** The scanned skeleton, as every other rig test builds it. */
function skeleton() {
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
  return model;
}

/** Poses the skeleton from a clip and puts its root where the caller says. */
function pose(model: Group, clip: MocapClip, seconds: number, at = new Vector3()) {
  const offset = clip.rootAt(seconds, new Vector3());
  clip.pose(seconds, (name, rotation) => {
    const bone = model.getObjectByName(name);
    if (bone) bone.quaternion.copy(rotation);
  });
  model.position.copy(at).add(offset);
  model.updateMatrixWorld(true);
}

describe("clipes de captura", () => {
  it("decodifica os dois clipes sobre ossos que o esqueleto realmente tem", () => {
    const model = skeleton();
    for (const name of ["cumprimento", "caminhada"]) {
      const clip = new MocapClip(clipData(name));
      expect(clip.frames).toBeGreaterThan(100);
      expect(clip.bones.length).toBe(29);
      for (const bone of clip.bones) expect(model.getObjectByName(bone), bone).toBeTruthy();
    }
  });

  it("fecha o laço: a pose no fim do clipe é a mesma do começo", () => {
    for (const name of ["cumprimento", "caminhada"]) {
      const clip = new MocapClip(clipData(name));
      const start = new Map<string, Quaternion>();
      clip.pose(0, (bone, rotation) => start.set(bone, rotation.clone()));
      const period = clip.frames / clip.fps;
      let worst = 0;
      clip.pose(period, (bone, rotation) => { worst = Math.max(worst, rotation.angleTo(start.get(bone)!)); });
      // Quantisation to int16 is worth 3e-5 rad; anything above that would be a
      // seam the eye catches every time the clip repeats.
      expect(worst, name).toBeLessThan(0.002);
    }
  });

  it("mantém o pé no chão quando a caminhada é tocada por distância, em qualquer velocidade", () => {
    const clip = new MocapClip(clipData("caminhada"));
    const model = skeleton();
    for (const speed of [0.18, 0.42, 0.82]) {
      const slips: number[] = [];
      let previous: { d: Vector3; e: Vector3 } | null = null;
      for (let step = 0; step <= 6 * 60; step++) {
        const seconds = step / 60;
        const travelled = speed * seconds;
        pose(model, clip, clip.timeForDistance(travelled), new Vector3(0, 0, travelled));
        const feet = {
          d: model.getObjectByName("Pe.D")!.getWorldPosition(new Vector3()),
          e: model.getObjectByName("Pe.E")!.getWorldPosition(new Vector3()),
        };
        if (previous) {
          // Whichever foot is lower is the one carrying weight; that is the one
          // that must not travel.
          const planted = feet.d.y <= feet.e.y ? "d" : "e";
          slips.push(feet[planted].clone().sub(previous[planted]).setY(0).length() * 60);
        }
        previous = feet;
      }
      slips.sort((a, b) => a - b);
      const median = slips[Math.floor(slips.length / 2)];
      // A foot that keeps up with the ground reads as walking; one that drags
      // at a large fraction of the travel speed reads as skating. The median is
      // what the eye integrates - single frames around a heel strike are
      // allowed to be quick.
      expect(median, `${speed} m/s`).toBeLessThan(speed * 0.25);
    }
  });

  it("o cumprimento traz o próprio deslocamento e não arrasta os pés", () => {
    const clip = new MocapClip(clipData("cumprimento"));
    const model = skeleton();
    const slips: number[] = [];
    let previous: Vector3 | null = null;
    for (let step = 0; step <= clip.duration * 60; step++) {
      pose(model, clip, step / 60);
      const foot = model.getObjectByName("Pe.E")!.getWorldPosition(new Vector3());
      if (previous) slips.push(foot.clone().sub(previous).setY(0).length() * 60);
      previous = foot;
    }
    slips.sort((a, b) => a - b);
    expect(slips[Math.floor(slips.length / 2)]).toBeLessThan(0.05);
  });

  it("anda para trás e para frente pela mesma curva: distância é uma função monótona do tempo", () => {
    const clip = new MocapClip(clipData("caminhada"));
    let previous = -Infinity;
    for (let metres = 0; metres < clip.travelled * 2; metres += 0.05) {
      const time = clip.timeForDistance(metres);
      expect(time).toBeGreaterThanOrEqual(previous);
      previous = time;
    }
  });
});

describe("o que a pele deste scan aguenta", () => {
  /**
   * Bends measured on the mesh itself by work/mocap-skin-budget.mjs: where two
   * bones share vertices the skin is a blend of both, and past these angles it
   * collapses inward. Neck and head share 9286 of them - the jaw and the base
   * of the face - and the sources ask that joint for 52 degrees, at which the
   * worst of those vertices caves in by 14 mm.
   */
  // The one table the generator builds to and the rig enforces, read here too
  // rather than copied: a copy is how a limit quietly drifts apart.
  const BUDGET: Record<string, number> = JSON.parse(readFileSync(new URL("../lib/avatar/bend-budget.json", import.meta.url), "utf8"));

  it("nenhum clipe dobra uma junta além do que a pele suporta", () => {
    const model = skeleton();
    const rest = new Map<string, Quaternion>();
    model.traverse(object => { if ((object as Bone).isBone) rest.set(object.name, (object as Bone).quaternion.clone()); });
    for (const name of ["cumprimento", "caminhada"]) {
      const clip = new MocapClip(clipData(name));
      for (let frame = 0; frame < clip.frames; frame++) {
        clip.pose(frame / clip.fps, (bone, rotation) => {
          const limit = BUDGET[bone];
          if (limit === undefined) return;
          // A tenth of a degree of slack for the int16 quantisation.
          expect(rest.get(bone)!.angleTo(rotation) * 180 / Math.PI, `${name}/${bone}`).toBeLessThan(limit + 0.1);
        });
      }
    }
  });

  it("cabe no orçamento encolhendo o gesto inteiro, sem deixar junta presa no teto", () => {
    // Clamped frame by frame, a joint sat on its limit while the body around it
    // kept moving, then let go at once: the talking clips held a wrist there 45
    // percent of the time and the walk held the spine 72. Motion that stops in
    // the middle of living motion is what read as awkward. Scaled, a joint
    // reaches its largest bend for an instant, as real motion does, and moves on.
    const model = skeleton();
    const rest = new Map<string, Quaternion>();
    model.traverse(object => { if ((object as Bone).isBone) rest.set(object.name, (object as Bone).quaternion.clone().normalize()); });
    for (const name of ["cumprimento", "caminhada", "fala-1", "fala-2"]) {
      const data = clipData(name) as unknown as MocapClipData & { bends: Record<string, { scale: number }> };
      const clip = new MocapClip(data);
      const bends = new Map<string, number[]>();
      for (let frame = 0; frame < clip.frames; frame++) {
        clip.pose(frame / clip.fps, (bone, rotation) => {
          // Only the joints the budget acted on. A joint left alone keeps any
          // hold the actor made - the greeting holds its neck for 0.3 s - and
          // that is the capture, not a limit.
          if (BUDGET[bone] === undefined || !(data.bends[bone]?.scale < 1)) return;
          if (!bends.has(bone)) bends.set(bone, []);
          bends.get(bone)!.push(rest.get(bone)!.angleTo(rotation.clone().normalize()) * 180 / Math.PI);
        });
      }
      for (const [bone, series] of bends) {
        const largest = Math.max(...series);
        const parked = series.filter(bend => bend > largest - 0.1).length / series.length;
        expect(parked, `${name}/${bone}`).toBeLessThan(0.05);
      }
    }
  });

  it("e o limite é o que segura, não um número que nunca se alcança", () => {
    // If a source stopped asking for more than the budget the guard above would
    // pass while proving nothing, so what each clip wanted is recorded with it.
    for (const name of ["cumprimento", "caminhada"]) {
      const bends = (clipData(name) as unknown as { bends: Record<string, { asked: number; budget: number }> }).bends;
      expect(bends).toBeTruthy();
      const held = Object.entries(bends).filter(([, bend]) => bend.asked > bend.budget);
      expect(held.length, name).toBeGreaterThan(0);
      for (const [bone, bend] of held) expect(bend.budget, `${name}/${bone}`).toBe(BUDGET[bone]);
    }
    // The head is the one that was seen: both sources bend it far past its budget.
    expect((clipData("caminhada") as unknown as { bends: Record<string, { asked: number }> }).bends.Cabeca.asked).toBeGreaterThan(40);
  });
});

describe("a caminhada tocada no compasso de outras pernas", () => {
  it("põe cada passada inteira sobre um toque de calcanhar do próprio clipe", () => {
    const data = clipData("caminhada");
    const clip = new MocapClip(data);
    expect(clip.hasFootfalls).toBe(true);
    const falls = data.footfalls!;
    // 26 strikes on "Walk In Circle", alternating without a slip - read from
    // how far one foot is ahead of the other, the standard gait-event signal.
    expect(falls.length).toBe(26);
    for (let index = 0; index < falls.length; index++) {
      expect(falls[index].side).not.toBe(falls[(index + 1) % falls.length].side);
      expect(clip.timeForStride(index)).toBeCloseTo(falls[index].t, 9);
    }
    // And onward past the loop, one lap later.
    expect(clip.timeForStride(falls.length)).toBeCloseTo(falls[0].t + clip.frames / clip.fps, 9);
  });

  it("avança sempre para a frente, e sem saltos entre um passo e o seguinte", () => {
    const clip = new MocapClip(clipData("caminhada"));
    let previous = clip.timeForStride(0);
    for (let phase = 0.01; phase < 60; phase += 0.01) {
      const time = clip.timeForStride(phase);
      expect(time).toBeGreaterThan(previous);
      // A step lasts at most 0.8 s in this clip, so a hundredth of one is
      // never more than 8 ms of clip.
      expect(time - previous).toBeLessThan(0.0081);
      previous = time;
    }
  });

  it("escolhe o deslocamento que põe o mesmo pé no chão no clipe e no andarilho", () => {
    const data = clipData("caminhada");
    const clip = new MocapClip(data);
    const falls = data.footfalls!;
    for (let landing = 0; landing < 60; landing++) {
      for (const side of ["D", "E"] as const) {
        const shift = clip.stepShiftFor(landing, side);
        expect([0, 1]).toContain(shift);
        expect(falls[(landing + shift) % falls.length].side).toBe(side);
      }
    }
  });

  it("recusa um mapa de toques que não alterna", () => {
    const data = clipData("caminhada");
    const broken = { ...data, footfalls: data.footfalls!.map((fall, index) => index === 3 ? { ...fall, side: data.footfalls![2].side } : fall) };
    expect(() => new MocapClip(broken)).toThrow(/alternating/);
  });
});

describe("o carregamento dos clipes", () => {
  it("instala os que chegam, mesmo quando outro falha", async () => {
    // They used to be all or nothing: one clip that failed to arrive rejected
    // the lot, and a missing greeting took the walk down with it.
    const walk = readFileSync(new URL("../public/models/clips/caminhada.json", import.meta.url), "utf8");
    vi.stubGlobal("fetch", async (url: string) => url.includes("caminhada")
      ? new Response(walk, { status: 200 })
      : new Response("ausente", { status: 404 }));
    try {
      const { clips, failed } = await loadMocapClips(["cumprimento", "caminhada"], "teste");
      expect([...clips.keys()]).toEqual(["caminhada"]);
      expect(clips.get("caminhada")!.hasFootfalls).toBe(true);
      expect(failed.map(failure => failure.name)).toEqual(["cumprimento"]);
      expect(String(failed[0].error)).toMatch(/404/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
