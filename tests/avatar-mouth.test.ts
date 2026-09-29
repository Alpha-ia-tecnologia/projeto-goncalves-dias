import { readFileSync } from 'node:fs';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, Mesh, MeshStandardMaterial, Object3D, Texture, Vector3 } from 'three';
import { bindMouth, smoothMouthFrame, type MouthFrame } from '../lib/avatar/mouth';

const closed = (): MouthFrame => ({ open: 0, round: 0, wide: 0 });

describe('natural facial articulation', () => {
  it('follows a syllable promptly while rejecting rapid envelope flutter', () => {
    const frame = closed();
    for (let i = 0; i < 6; i++) smoothMouthFrame(frame, { open: .8, round: .4, wide: .1 }, 1 / 60);
    expect(frame.open).toBeGreaterThan(.70);
    expect(frame.open).toBeLessThan(.8);
    let min = 1, max = 0;
    for (let i = 0; i < 120; i++) {
      smoothMouthFrame(frame, { open: i % 2 ? .4 : .8, round: .2, wide: .1 }, 1 / 60);
      if (i > 60) { min = Math.min(min, frame.open); max = Math.max(max, frame.open); }
    }
    expect(max - min).toBeLessThan(.09);
  });

  it('keeps a short voiced syllable visible without leaving the lips open in its following pause', () => {
    const frame = closed();
    for (let i = 0; i < 4; i++) smoothMouthFrame(frame, { open: .8, round: .2, wide: 0 }, 1 / 60);
    expect(frame.open).toBeGreaterThan(.70);
    for (let i = 0; i < 7; i++) smoothMouthFrame(frame, closed(), 1 / 60);
    expect(frame.open).toBeLessThan(.006);
  });

  it('closes every lip control within 200 ms of silence', () => {
    const frame = { open: .82, round: .6, wide: .5 };
    for (let i = 0; i < 12; i++) smoothMouthFrame(frame, { open: 0, round: 1, wide: 1 }, 1 / 60);
    expect(frame).toEqual(closed());
  });

  it('has the same timed transition at different render frame rates', () => {
    const simulate = (fps: number) => {
      const frame = closed();
      for (let i = 0; i < fps / 5; i++) smoothMouthFrame(frame, { open: .8, round: .5, wide: .2 }, 1 / fps);
      return frame;
    };
    const slow = simulate(30), fast = simulate(120);
    for (const key of ['open', 'round', 'wide'] as const) expect(slow[key]).toBeCloseTo(fast[key], 8);
  });

  it('recovers safely from invalid samples and invalid elapsed time', () => {
    const frame = { open: Number.NaN, round: Number.POSITIVE_INFINITY, wide: -.1 };
    smoothMouthFrame(frame, { open: .8, round: .2, wide: .1 }, Number.NaN);
    expect(frame).toEqual(closed());
    smoothMouthFrame(frame, { open: Number.NaN, round: 1, wide: 1 }, .05);
    expect(frame).toEqual(closed());
  });

  it('preserves independent blink controls when binding and animating the mouth', () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
    geometry.setAttribute('_mouth_shape', new BufferAttribute(new Float32Array(9), 3));
    geometry.setAttribute('_mouth_corner', new BufferAttribute(new Float32Array(3), 1));
    const material = new MeshStandardMaterial();
    material.userData.mouthInterior = true;
    const mesh = new Mesh(geometry, material);
    mesh.morphTargetDictionary = { 'Boca - abrir': 0, 'Labios - alargar': 1, 'Labios - arredondar': 2, 'Olhos - piscar': 3 };
    mesh.morphTargetInfluences = [.7, .3, .2, .65];
    const model = new Object3D();
    model.add(mesh);
    const apply = bindMouth(model);
    expect(mesh.morphTargetInfluences).toEqual([0, 0, 0, .65]);
    apply({ open: .4, round: .2, wide: .1 });
    expect(mesh.morphTargetInfluences).toEqual([.4, .1, .2, .65]);
    apply({ open: 0, round: .8, wide: .8 });
    expect(mesh.morphTargetInfluences).toEqual([0, 0, 0, .65]);
    geometry.dispose();
    material.dispose();
  });
});


it('the exported avatar visibly opens the real lips without moving the chin and returns exactly to rest', async () => {
  const bytes = readFileSync(new URL('../public/models/goncalves-dias.glb', import.meta.url));
  const loader = new GLTFLoader();
  loader.register(() => ({ name: 'MOUTH_TEST_SKIP_TEXTURES', loadTexture: async () => new Texture() }));
  const { scene } = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const apply = bindMouth(scene);
  const meshes: Mesh[] = [];
  scene.traverse(object => {
    if (object instanceof Mesh && object.morphTargetDictionary?.['Boca - abrir'] !== undefined) meshes.push(object);
  });
  expect(meshes.length).toBeGreaterThan(0);
  const initial = meshes.map(mesh => Array.from({ length: mesh.geometry.getAttribute('position').count }, (_, i) => mesh.getVertexPosition(i, new Vector3())));
  apply({ open: .8, round: 0, wide: 0 });
  let largestOpening = 0, chinMovement = 0;
  for (const [meshIndex, mesh] of meshes.entries()) {
    for (const [index, neutral] of initial[meshIndex].entries()) {
      const posed = mesh.getVertexPosition(index, new Vector3());
      const travel = posed.distanceTo(neutral);
      largestOpening = Math.max(largestOpening, travel);
      // The exported neutral mesh uses metres, Y up, front +Z.
      const source = new Vector3().fromBufferAttribute(mesh.geometry.getAttribute('position'), index);
      if (source.y < 1.625 && source.y > 1.565 && Math.abs(source.x) < .075 && source.z > .1) {
        chinMovement = Math.max(chinMovement, travel);
      }
    }
  }
  expect(largestOpening).toBeGreaterThan(.0065);
  expect(largestOpening).toBeLessThan(.0072);
  expect(chinMovement).toBeLessThan(1e-7);
  apply(closed());
  for (const [meshIndex, mesh] of meshes.entries()) {
    for (let index = 0; index < initial[meshIndex].length; index += 23) {
      expect(mesh.getVertexPosition(index, new Vector3()).distanceTo(initial[meshIndex][index])).toBeLessThan(1e-7);
    }
  }
});
