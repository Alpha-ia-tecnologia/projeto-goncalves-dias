"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import {
  ACESFilmicToneMapping, AmbientLight, DirectionalLight, HemisphereLight, Material,
  Mesh, MeshStandardMaterial, Object3D, PCFSoftShadowMap, PerspectiveCamera,
  PlaneGeometry, Scene, ShadowMaterial, SkinnedMesh, SRGBColorSpace, Texture,
  Vector3, WebGLRenderer,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { bindMouth, type MouthFrame } from "@/lib/avatar/mouth";
import { AvatarRig } from "@/lib/avatar/rig";

export type AvatarHandle = {
  setMouth(frame: MouthFrame): void;
  gesture(kind: "wave" | "nod"): void;
  resetView(): void;
};

type Props = {
  view: "portrait" | "full";
  motionEnabled: boolean;
  onReady?: () => void;
  onError?: (message: string) => void;
};

type Runtime = {
  setMouth(frame: MouthFrame): void;
  gesture(kind: "wave" | "nod"): void;
  frameView(view: Props["view"], immediate?: boolean): void;
};

function disposeModel(root: Object3D) {
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  const skeletons = new Set<SkinnedMesh["skeleton"]>();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.geometry.dispose();
    if (object instanceof SkinnedMesh) skeletons.add(object.skeleton);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
  });
  for (const material of materials) {
    for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
    material.dispose();
  }
  for (const texture of textures) {
    texture.dispose();
    const image = texture.source.data;
    if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) image.close();
  }
  for (const skeleton of skeletons) skeleton.dispose();
}

const AvatarStage = forwardRef<AvatarHandle, Props>(function AvatarStage(props, ref) {
  const container = useRef<HTMLDivElement>(null);
  const runtime = useRef<Runtime | null>(null);
  const latest = useRef(props);
  useEffect(() => { latest.current = props; }, [props]);

  useImperativeHandle(ref, () => ({
    setMouth(frame) { runtime.current?.setMouth(frame); },
    gesture(kind) { runtime.current?.gesture(kind); },
    resetView() { runtime.current?.frameView(latest.current.view); },
  }), []);

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    } catch {
      latest.current.onError?.("Não foi possível iniciar o 3D. Ative a aceleração gráfica do navegador e recarregue a página.");
      return;
    }

    let disposed = false;
    let contextLost = false;
    let model: Object3D | null = null;
    let rig: AvatarRig | null = null;
    let applyMouth: ReturnType<typeof bindMouth> | null = null;
    let lastMouthAt = -Infinity;
    const mouthTarget: MouthFrame = { open: 0, round: 0, wide: 0 };
    const mouthCurrent: MouthFrame = { open: 0, round: 0, wide: 0 };
    const scene = new Scene();
    const camera = new PerspectiveCamera(33, 1, 0.03, 25);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";
    renderer.domElement.setAttribute("aria-label", "Modelo 3D de Gonçalves Dias. Arraste para girar e use a roda do mouse para aproximar.");
    renderer.domElement.setAttribute("role", "img");
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.rotateSpeed = 0.55;
    controls.zoomSpeed = 0.65;
    controls.minAzimuthAngle = -Math.PI / 3;
    controls.maxAzimuthAngle = Math.PI / 3;
    controls.minPolarAngle = Math.PI * 0.36;
    controls.maxPolarAngle = Math.PI * 0.56;

    const key = new DirectionalLight(0xfff3e2, 3.0);
    key.position.set(-2.6, 4.2, 3.5);
    key.target.position.set(0, 1.05, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -1.3;
    key.shadow.camera.right = 1.3;
    key.shadow.camera.top = 2.2;
    key.shadow.camera.bottom = -1;
    key.shadow.camera.near = 0.1;
    key.shadow.camera.far = 9;
    key.shadow.bias = -0.0002;
    key.shadow.normalBias = 0.012;
    key.shadow.radius = 4;
    const fill = new DirectionalLight(0xe7efff, 1.15);
    fill.position.set(2.5, 2.1, 2.8);
    const rim = new DirectionalLight(0xffe0b1, 1.65);
    rim.position.set(0.8, 3.1, -2.3);
    scene.add(key, key.target, fill, rim, new HemisphereLight(0xfff7e9, 0x787c83, 1.75), new AmbientLight(0xffffff, 0.2));
    const floor = new Mesh(new PlaneGeometry(12, 12), new ShadowMaterial({ opacity: 0.18 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.003;
    floor.receiveShadow = true;
    scene.add(floor);

    const desiredPosition = new Vector3();
    const desiredTarget = new Vector3();
    let framing = true;
    const frameView = (view: Props["view"], immediate = false) => {
      const portrait = view === "portrait";
      const height = portrait ? 1.48 : 2.14;
      // Keep the raised hand within the frame even in a narrow mobile viewport.
      const distance = Math.max(height, 1.22 / Math.max(camera.aspect, 0.3)) / (2 * Math.tan(camera.fov * Math.PI / 360));
      desiredTarget.set(0, portrait ? 1.27 : 0.96, 0);
      desiredPosition.set(0.035, desiredTarget.y + 0.055, distance);
      controls.minDistance = distance * 0.68;
      controls.maxDistance = distance * 1.42;
      framing = true;
      if (immediate || !latest.current.motionEnabled) {
        camera.position.copy(desiredPosition);
        controls.target.copy(desiredTarget);
        controls.update();
        framing = false;
      }
    };
    const stopFraming = () => { framing = false; };
    controls.addEventListener("start", stopFraming);

    const resize = () => {
      const width = Math.max(host.clientWidth, 1);
      const height = Math.max(host.clientHeight, 1);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      frameView(latest.current.view, true);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    const controller = new AbortController();
    runtime.current = {
      frameView,
      setMouth(frame) {
        for (const key of ["open", "round", "wide"] as const) {
          mouthTarget[key] = Number.isFinite(frame[key]) ? Math.max(0, Math.min(1, frame[key])) : 0;
        }
        lastMouthAt = performance.now();
      },
      gesture(kind) {
        if (latest.current.motionEnabled) rig?.gesture(kind, performance.now() / 1000);
      },
    };

    const onContextLost = (event: Event) => {
      event.preventDefault();
      contextLost = true;
      renderer.setAnimationLoop(null);
      latest.current.onError?.("A conexão com o 3D foi interrompida. Recarregue a página para abrir o personagem novamente.");
    };
    renderer.domElement.addEventListener("webglcontextlost", onContextLost);

    let previousTime = performance.now();
    renderer.setAnimationLoop(() => {
      if (disposed || contextLost || document.hidden) return;
      const now = performance.now();
      const delta = Math.min((now - previousTime) / 1000, 0.05);
      previousTime = now;
      if (now - lastMouthAt > 250) mouthTarget.open = mouthTarget.round = mouthTarget.wide = 0;
      for (const key of ["open", "round", "wide"] as const) {
        const speed = mouthTarget[key] > mouthCurrent[key] ? 36 : 23;
        mouthCurrent[key] += (mouthTarget[key] - mouthCurrent[key]) * (1 - Math.exp(-delta * speed));
        if (mouthTarget[key] === 0 && mouthCurrent[key] < 0.001) mouthCurrent[key] = 0;
      }
      applyMouth?.(mouthCurrent);
      rig?.update(now / 1000, latest.current.motionEnabled);
      if (framing) {
        const fraction = 1 - Math.exp(-delta * 7);
        camera.position.lerp(desiredPosition, fraction);
        controls.target.lerp(desiredTarget, fraction);
        if (camera.position.distanceToSquared(desiredPosition) < 0.00001 && controls.target.distanceToSquared(desiredTarget) < 0.00001) framing = false;
      }
      controls.update();
      renderer.render(scene, camera);
    });

    void (async () => {
      try {
        const response = await fetch("/models/goncalves-dias.glb", { signal: controller.signal });
        if (!response.ok) throw new Error(`Não foi possível carregar o personagem (HTTP ${response.status}).`);
        const gltf = await new GLTFLoader().parseAsync(await response.arrayBuffer(), "/models/");
        if (disposed) { disposeModel(gltf.scene); return; }
        model = gltf.scene;
        model.traverse((object) => {
          if (!(object instanceof Mesh)) return;
          object.castShadow = true;
          object.receiveShadow = true;
          // Gestures extend beyond the scan's original bounding box.
          if (object instanceof SkinnedMesh) object.frustumCulled = false;
          for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
            if (material instanceof MeshStandardMaterial) {
              material.roughness = Math.max(material.roughness, 0.68);
              material.metalness = 0;
              if (material.map) material.map.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
            }
          }
        });
        rig = new AvatarRig(model);
        applyMouth = bindMouth(model);
        applyMouth({ open: 0, round: 0, wide: 0 });
        scene.add(model);
        await renderer.compileAsync(scene, camera);
        if (!disposed && !contextLost) latest.current.onReady?.();
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : "Falha ao carregar o modelo 3D.";
        latest.current.onError?.(`${message} Recarregue a página para tentar novamente.`);
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
      runtime.current = null;
      observer.disconnect();
      renderer.setAnimationLoop(null);
      controls.removeEventListener("start", stopFraming);
      controls.dispose();
      renderer.domElement.removeEventListener("webglcontextlost", onContextLost);
      if (model && !model.parent) disposeModel(model);
      disposeModel(scene);
      key.shadow.map?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, []);

  useEffect(() => { runtime.current?.frameView(props.view); }, [props.view]);

  return <div className="avatar-canvas" ref={container} style={{ width: "100%", height: "100%" }} />;
});

export default AvatarStage;
