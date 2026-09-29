"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import {
  ACESFilmicToneMapping, AmbientLight, Box3, Color, DirectionalLight, HemisphereLight, Group, Material,
  Mesh, MeshBasicMaterial, Object3D, PCFShadowMap, PerspectiveCamera, Raycaster, RingGeometry,
  Scene, SkinnedMesh, SRGBColorSpace, Texture,
  Vector2, Vector3, WebGLRenderer,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS3DObject, CSS3DRenderer } from "three/examples/jsm/renderers/CSS3DRenderer.js";
import { createChatPedestal, type ChatPedestal } from "@/lib/avatar/chat-pedestal";
import { chatLayout, CHAT_SURFACE_WIDTH, CHAT_SURFACE_HEIGHT } from "@/lib/avatar/chat-layout";
import { bindMouth, smoothMouthFrame, type MouthFrame } from "@/lib/avatar/mouth";
import { AvatarRig, type AttentionInput, type AttentionMode } from "@/lib/avatar/rig";
import { loadMocapClips } from "@/lib/avatar/mocap";
import { prepareAvatarSurface } from "@/lib/avatar/appearance";
import { AvatarEyes } from "@/lib/avatar/eyes";
import { createStudyEnvironment, type StudyEnvironment } from "@/lib/avatar/study-environment";
import { stageFraming, STAGE_FOV, STUDY_ROTATION, type AvatarView } from "@/lib/avatar/stage-framing";

import { AvatarWalker } from "@/lib/avatar/walking";
import { planWalkPath } from "@/lib/avatar/walk-navigation";
import { walkFraming } from "@/lib/avatar/walk-framing";

export type { AttentionMode, AvatarView };
export type WalkStatus = { state: "idle" | "walking" | "arrived" | "stopped" | "blocked"; active: boolean; destination: readonly [number, number] | null };

export type AvatarHandle = {
  setMouth(frame: MouthFrame): void;
  gesture(kind: "wave" | "nod"): void;
  stopGesture(): void;
  /** What the character attends to between replies; `level` is the visitor's voice while listening. */
  attend(mode: AttentionMode, level?: number): void;
  resetView(): void;
  walkTo(point: readonly [number, number]): boolean;
  stopWalking(): void;
};

type Props = {
  view: AvatarView;
  motionEnabled: boolean;
  showChatPedestal: boolean;
  walkEnabled: boolean;
  onWalkStatus?: (status: WalkStatus) => void;
  onChatSurface?: (element: HTMLDivElement | null) => void;
  onReady?: () => void;
  onError?: (message: string) => void;
};

type Runtime = {
  setMouth(frame: MouthFrame): void;
  gesture(kind: "wave" | "nod"): void;
  stopGesture(): void;
  attend(mode: AttentionMode, level?: number): void;
  frameView(view: Props["view"], immediate?: boolean): void;
  walkTo(point: readonly [number, number]): boolean;
  stopWalking(): void;
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

/** The captured clips the poet plays, and the build they came from. */
const MOCAP_CLIPS = ["cumprimento", "caminhada", "fala-1", "fala-2"] as const;
const MOCAP_REVISION = "mocap-4";

const AvatarStage = forwardRef<AvatarHandle, Props>(function AvatarStage(props, ref) {
  const container = useRef<HTMLDivElement>(null);
  const runtime = useRef<Runtime | null>(null);
  const latest = useRef(props);
  useEffect(() => { latest.current = props; }, [props]);

  useImperativeHandle(ref, () => ({
    setMouth(frame) { runtime.current?.setMouth(frame); },
    gesture(kind) { runtime.current?.gesture(kind); },
    stopGesture() { runtime.current?.stopGesture(); },
    attend(mode, level) { runtime.current?.attend(mode, level); },
    resetView() { runtime.current?.frameView(latest.current.view); },
    walkTo(point) { return runtime.current?.walkTo(point) ?? false; },
    stopWalking() { runtime.current?.stopWalking(); },
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
    let environment: StudyEnvironment | null = null;
    let pedestal: ChatPedestal | null = null;
    let chatSurface: CSS3DObject | null = null;
    const chatProjection = new Vector3();
    let rig: AvatarRig | null = null;
    let walker: AvatarWalker | null = null;
    const walkingRoot = new Group();
    walkingRoot.name = "Deslocamento_do_poeta";
    let walkDestination: readonly [number, number] | null = null;
    let wasWalking = false;
    let walkStopped = false;
    let eyes: AvatarEyes | null = null;
    let applyMouth: ReturnType<typeof bindMouth> | null = null;
    let lastMouthAt = -Infinity;
    const mouthTarget: MouthFrame = { open: 0, round: 0, wide: 0, level: 0 };
    const mouthCurrent: MouthFrame = { open: 0, round: 0, wide: 0 };
    const attention: AttentionInput = { mode: "idle", level: 0 };
    let attentionAt = -Infinity;
    const scene = new Scene();
    scene.background = new Color(0xcbd9dc);
    scene.add(walkingRoot);
    const destinationMarker = new Mesh(new RingGeometry(0.14, 0.18, 48), new MeshBasicMaterial({ color: 0xd4b777, transparent: true, opacity: 0.85, depthWrite: false }));
    destinationMarker.name = "Destino_da_caminhada";
    destinationMarker.rotation.x = -Math.PI / 2;
    destinationMarker.position.y = 0.008;
    destinationMarker.visible = false;
    scene.add(destinationMarker);
    const camera = new PerspectiveCamera(STAGE_FOV, 1, 0.03, 45);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setClearColor(0x231c16, 1);
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";
    renderer.domElement.setAttribute("aria-label", "Gonçalves Dias em seu gabinete 3D. Arraste para explorar e use a roda do mouse para aproximar.");
    renderer.domElement.setAttribute("role", "img");
    renderer.domElement.tabIndex = 0;
    host.appendChild(renderer.domElement);
    const chatRenderer = new CSS3DRenderer();
    chatRenderer.domElement.className = "chat-css-layer";
    Object.assign(chatRenderer.domElement.style, { position: "absolute", inset: "0", pointerEvents: "none" });
    host.appendChild(chatRenderer.domElement);
    const chatElement = document.createElement("div");
    chatElement.className = "chat-surface";
    Object.assign(chatElement.style, { width: CHAT_SURFACE_WIDTH + "px", height: CHAT_SURFACE_HEIGHT + "px", backfaceVisibility: "hidden" });

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

    // A restrained frontal fill keeps the poet readable in the window-lit room.
    const key = new DirectionalLight(0xfff7ef, 1.2);
    key.position.set(-2.5, 3.6, 4.0);
    key.target.position.set(0, 1.38, 0);
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
    const fill = new DirectionalLight(0xe1eaff, 0.35);
    fill.position.set(2.6, 2.3, 4.2);
    fill.target.position.set(0, 1.35, 0);
    scene.add(key, key.target, fill, fill.target,
      new HemisphereLight(0xffecd5, 0x484231, 0.6), new AmbientLight(0xffffff, 0.12));

    const desiredPosition = new Vector3();
    const desiredTarget = new Vector3();
    let framing = true;
    let desiredFov = STAGE_FOV;
    let modelTop = 1.90;
    const frameView = (view: Props["view"], immediate = false) => {
      const layout = chatLayout(host.clientWidth, host.clientHeight);
      const position = walker?.update(0);
      const moved = position && Math.hypot(position.x, position.z) > 0.1;
      const frame = view === "walk" || (view === "room" && moved)
        ? walkFraming(host.clientWidth, host.clientHeight)
        : view === "conversation" ? layout : stageFraming(view, camera.aspect, modelTop);
      desiredFov = frame.fov;
      if ("cameraPosition" in frame) {
        desiredTarget.fromArray(frame.target);
        desiredPosition.fromArray(frame.cameraPosition);
      } else {
        const focus = stageFraming(view, camera.aspect, modelTop);
        const x = view === "room" ? 0 : (position?.x ?? 0);
        const z = view === "room" ? 0.075 : (position?.z ?? 0) + 0.075;
        desiredTarget.set(x, focus.targetY, z);
        desiredPosition.set(x, focus.targetY, focus.distance + z);
      }
      controls.minDistance = frame.minDistance;
      controls.maxDistance = frame.maxDistance;
      controls.minAzimuthAngle = frame.minAzimuthAngle;
      controls.maxAzimuthAngle = frame.maxAzimuthAngle;
      controls.minPolarAngle = frame.minPolarAngle;
      controls.maxPolarAngle = frame.maxPolarAngle;
      framing = true;
      controls.enabled = false;
      if (immediate || !latest.current.motionEnabled) {
        camera.fov = desiredFov;
        camera.updateProjectionMatrix();
        camera.position.copy(desiredPosition);
        controls.target.copy(desiredTarget);
        controls.update();
        controls.enabled = true;
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
      chatRenderer.setSize(width, height);
      const layout = chatLayout(width, height);
      if (pedestal) {
        pedestal.root.position.fromArray(layout.pedestalPosition);
        pedestal.root.scale.setScalar(layout.pedestalScale);
      }
      frameView(latest.current.view, true);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    const notifyWalk = (state: WalkStatus["state"]) => latest.current.onWalkStatus?.({ state, active: walker?.update(0).active ?? false, destination: walkDestination });
    const walkTo = (point: readonly [number, number]) => {
      if (!walker || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return false;
      const current = walker.update(0);
      const path = planWalkPath([current.x, current.z], point);
      if (!path) { notifyWalk("blocked"); return false; }
      walker.setPath(path);
      walkDestination = [point[0], point[1]];
      walkStopped = false;
      wasWalking = walker.frame.active;
      destinationMarker.position.set(point[0], 0.008, point[1]);
      destinationMarker.visible = wasWalking;
      notifyWalk(wasWalking ? "walking" : "arrived");
      return true;
    };
    const stopWalking = () => {
      if (!walker) return;
      walker.stop();
      walkStopped = true;
      destinationMarker.visible = false;
      notifyWalk("stopped");
    };
    const raycaster = new Raycaster();
    const pointer = new Vector2();
    const floorNormal = new Vector3();
    let press: { id: number; x: number; y: number; time: number; dragged: boolean } | null = null;
    const pointerDown = (event: PointerEvent) => {
      if (!latest.current.walkEnabled || !event.isPrimary || event.button !== 0) { press = null; return; }
      press = { id: event.pointerId, x: event.clientX, y: event.clientY, time: performance.now(), dragged: false };
    };
    const pointerMove = (event: PointerEvent) => {
      if (press && (event.pointerId !== press.id || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 7)) press.dragged = true;
    };
    const pointerCancel = () => { press = null; };
    const pointerUp = (event: PointerEvent) => {
      const started = press;
      press = null;
      if (!started || started.id !== event.pointerId || started.dragged || performance.now() - started.time > 650 || !latest.current.walkEnabled || !latest.current.motionEnabled || !environment) return;
      const bounds = renderer.domElement.getBoundingClientRect();
      pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const obstacles: Object3D[] = [environment.root];
      if (pedestal?.root.visible) obstacles.push(pedestal.root);
      if (model) obstacles.push(model);
      const hit = raycaster.intersectObjects(obstacles, true)[0];
      if (!hit?.face || Math.abs(hit.point.y) > 0.035 || floorNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld).y < 0.9) { notifyWalk("blocked"); return; }
      walkTo([hit.point.x, hit.point.z]);
    };
    const walkingKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && latest.current.walkEnabled) { event.preventDefault(); stopWalking(); }
    };
    renderer.domElement.addEventListener("pointerdown", pointerDown);
    renderer.domElement.addEventListener("pointermove", pointerMove);
    renderer.domElement.addEventListener("pointerup", pointerUp);
    renderer.domElement.addEventListener("pointercancel", pointerCancel);
    renderer.domElement.addEventListener("keydown", walkingKey);

    const controller = new AbortController();
    runtime.current = {
      frameView, walkTo, stopWalking,
      setMouth(frame) {
        for (const key of ["open", "round", "wide"] as const) {
          mouthTarget[key] = Number.isFinite(frame[key]) ? Math.max(0, Math.min(1, frame[key])) : 0;
        }
        mouthTarget.level = Number.isFinite(frame.level)
          ? Math.max(0, Math.min(1, frame.level!)) : mouthTarget.open * 0.6;
        lastMouthAt = performance.now();
      },
      gesture(kind) {
        if (latest.current.motionEnabled) rig?.gesture(kind, performance.now() / 1000);
      },
      stopGesture() { rig?.stopGesture(performance.now() / 1000); },
      attend(mode, level) {
        attention.mode = mode;
        attention.level = Number.isFinite(level) ? Math.max(0, Math.min(1, level!)) : 0;
        attentionAt = performance.now();
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
      const elapsed = (now - previousTime) / 1000;
      const delta = elapsed >= 0 && elapsed <= 0.25 ? Math.min(elapsed, 0.05) : 0;
      previousTime = now;
      if (now - lastMouthAt > 160) {
        mouthTarget.open = mouthTarget.round = mouthTarget.wide = mouthTarget.level = 0;
      }
      smoothMouthFrame(mouthCurrent, mouthTarget, delta);
      applyMouth?.(mouthCurrent);
      // A visitor voice level that stopped arriving counts as silence.
      if (now - attentionAt > 400) attention.level = 0;
      // The head follows the previous frame's glance; the eyes then compensate
      // this frame's head rotation so the gaze stays on the visitor.
      const walk = walker?.update(delta);
      // Existing gestures solve in the exported rest frame. Apply navigation
      // only after the skeleton and eyes are posed, preserving their axes.
      walkingRoot.position.set(0, 0, 0);
      walkingRoot.rotation.y = 0;
      walkingRoot.updateMatrixWorld(true);
      rig?.update(now / 1000, latest.current.motionEnabled || Boolean(walk?.active), mouthTarget.level, eyes?.glance, attention, walk);
      eyes?.update(now / 1000, latest.current.motionEnabled, mouthTarget.level ?? 0, rig?.headOffset, attention.mode);
      if (walk) {
        walkingRoot.position.set(walk.x, 0, walk.z);
        walkingRoot.rotation.y = walk.yaw;
        walkingRoot.updateMatrixWorld(true);
        if (wasWalking && !walk.active) {
          wasWalking = false;
          destinationMarker.visible = false;
          notifyWalk(walkStopped ? "stopped" : "arrived");
        }
      }
      if (framing) {
        const fraction = 1 - Math.exp(-delta * 7);
        camera.fov += (desiredFov - camera.fov) * fraction;
        camera.updateProjectionMatrix();
        camera.position.lerp(desiredPosition, fraction);
        controls.target.lerp(desiredTarget, fraction);
        camera.lookAt(controls.target);
        if (camera.position.distanceToSquared(desiredPosition) < 0.00001 && controls.target.distanceToSquared(desiredTarget) < 0.00001 && Math.abs(camera.fov - desiredFov) < 0.01) {
          camera.fov = desiredFov;
          camera.updateProjectionMatrix();
          camera.position.copy(desiredPosition);
          controls.target.copy(desiredTarget);
          controls.enabled = true;
          framing = false;
        }
      }
      // During framing the camera interpolates freely; final orbit limits
      // must not snap it to the destination on the first animation frame.
      if (!framing) controls.update();
      if (pedestal) pedestal.root.visible = latest.current.showChatPedestal;
      renderer.render(scene, camera);
      if (chatSurface && pedestal) {
        // Offscreen controls must not receive keyboard focus during an avatar close-up.
        const center = pedestal.screen.getWorldPosition(chatProjection).project(camera);
        const visible = pedestal.root.visible && center.z > -1 && center.z < 1 && Math.abs(center.x) < 1.2 && Math.abs(center.y) < 1.2;
        chatElement.inert = !visible;
        chatSurface.visible = visible;
      }
      chatRenderer.render(scene, camera);
    });

    const environmentReady = createStudyEnvironment({
      signal: controller.signal,
      anisotropy: renderer.capabilities.getMaxAnisotropy(),
    }).then((study) => {
      if (disposed) { study.dispose(); return; }
      environment = study;
      study.root.position.y = -0.02;
      study.root.rotation.y = STUDY_ROTATION;
      scene.add(study.root);
    });
    const pedestalReady = createChatPedestal({
      signal: controller.signal,
      anisotropy: renderer.capabilities.getMaxAnisotropy(),
    }).then((stand) => {
      if (disposed) { stand.dispose(); return; }
      pedestal = stand;
      const layout = chatLayout(host.clientWidth, host.clientHeight);
      stand.root.position.fromArray(layout.pedestalPosition);
      stand.root.scale.setScalar(layout.pedestalScale);
      stand.root.visible = latest.current.showChatPedestal;
      scene.add(stand.root);
      chatSurface = new CSS3DObject(chatElement);
      chatElement.style.userSelect = "text";
      chatSurface.scale.set(0.96 / CHAT_SURFACE_WIDTH, 1.2 / CHAT_SURFACE_HEIGHT, 1);
      chatSurface.position.z = 0.001;
      stand.screen.add(chatSurface);
      latest.current.onChatSurface?.(chatElement);
    });
    // Attach rejection handlers immediately while the avatar is still decoding.
    const surroundingsReady = Promise.all([environmentReady, pedestalReady]);
    void surroundingsReady.catch(() => {});

    void (async () => {
      try {
        const response = await fetch("/models/goncalves-dias.glb?v=attentive-presence-1", { signal: controller.signal });
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

        });
        walkingRoot.add(model);
        walkingRoot.updateMatrixWorld(true);
        rig = new AvatarRig(model);
        // Captured motion, if it arrives: the greeting and the walk are played
        // from clips rather than built. It is deliberately not awaited before
        // the poet appears, and a failure leaves him with the procedural
        // gestures instead of leaving him missing.
        // Each clip arrives or fails on its own, so a missing greeting does not
        // take the walk with it.
        void loadMocapClips(MOCAP_CLIPS, MOCAP_REVISION, controller.signal)
          .then(({ clips, failed }) => {
            if (disposed || controller.signal.aborted) return;
            rig?.setClips(clips);
            for (const { name, error } of failed) console.error(`movimento capturado "${name}" indisponível`, error);
          })
          .catch((error) => {
            if (controller.signal.aborted) return;
            console.error("movimento capturado indisponível", error);
          });
        walker = new AvatarWalker(model);
        eyes = new AvatarEyes(model);
        applyMouth = bindMouth(model);
        prepareAvatarSurface(model, renderer.capabilities.getMaxAnisotropy());
        applyMouth({ open: 0, round: 0, wide: 0 });
        modelTop = new Box3().setFromObject(model).max.y;
        frameView(latest.current.view, true);
        await surroundingsReady;
        if (disposed || contextLost) return;
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
      renderer.domElement.removeEventListener("pointerdown", pointerDown);
      renderer.domElement.removeEventListener("pointermove", pointerMove);
      renderer.domElement.removeEventListener("pointerup", pointerUp);
      renderer.domElement.removeEventListener("pointercancel", pointerCancel);
      renderer.domElement.removeEventListener("keydown", walkingKey);
      controls.removeEventListener("start", stopFraming);
      controls.dispose();
      renderer.domElement.removeEventListener("webglcontextlost", onContextLost);
      eyes?.reset();
      latest.current.onChatSurface?.(null);
      chatSurface?.removeFromParent();
      pedestal?.dispose();
      pedestal = null;
      chatRenderer.domElement.remove();
      environment?.dispose();
      environment = null;
      if (model && !model.parent) disposeModel(model);
      disposeModel(scene);
      key.shadow.map?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, []);

  useEffect(() => { runtime.current?.frameView(props.view); }, [props.view]);

  useEffect(() => {
    if (!props.walkEnabled || !props.motionEnabled) runtime.current?.stopWalking();
  }, [props.walkEnabled, props.motionEnabled]);

  return <div className={"avatar-canvas" + (props.walkEnabled ? " walk-enabled" : "")} ref={container} style={{ width: "100%", height: "100%" }} />;
});

export default AvatarStage;
