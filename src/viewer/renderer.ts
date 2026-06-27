/**
 * Three.js viewport — the shared rendering core.
 *
 * This is the ONE place scene/camera/lights/grid/controls live. It is built to
 * be reused unchanged by:
 *   • the playback page          (issue wbc-mjlab-3ne) — swaps robot pose per
 *     frame from a recorded clip, and
 *   • the M2 live engine         (mujoco-wasm + onnxruntime-web) — drives the
 *     same robot mesh from a physics step + policy inference loop.
 *
 * Neither of those is implemented yet. The robot is a placeholder box until
 * real meshes exist (issue wbc-mjlab-9as), and the live engine attaches at the
 * documented `mountLiveEngine()` seam below.
 */

import {
  ACESFilmicToneMapping,
  Box3,
  BoxGeometry,
  Color,
  DirectionalLight,
  GridHelper,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/** Read a CSS custom property (design token) off :root, with a fallback. */
function token(name: string, fallback: string): string {
  if (typeof getComputedStyle !== 'function') return fallback;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

export interface ViewerOptions {
  /** URL of a GLB/GLTF robot to load. If absent/unloadable → placeholder box. */
  robotUrl?: string;
}

/**
 * A self-contained Three.js viewport mounted into `container`.
 *
 * Lifecycle: `new Viewer(el)` → renders immediately via its own RAF loop.
 * Call `dispose()` when tearing down the page to free GL resources & listeners.
 */
export class Viewer {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly renderer: WebGLRenderer;
  readonly controls: OrbitControls;

  /**
   * The robot's root node. The placeholder box is parented here now; when real
   * meshes land (wbc-mjlab-9as) the loaded GLTF scene is parented here instead.
   * Playback (wbc-mjlab-3ne) and the live engine pose the children of this node.
   */
  readonly robotRoot: Group;

  private readonly container: HTMLElement;
  private readonly resizeObserver: ResizeObserver;
  private rafId = 0;
  private disposed = false;

  constructor(container: HTMLElement, options: ViewerOptions = {}) {
    this.container = container;

    this.scene = new Scene();
    this.scene.background = new Color(token('--color-viewport-bg', '#0a0d12'));

    const { clientWidth: w, clientHeight: h } = this.sizedContainer();
    this.camera = new PerspectiveCamera(50, w / h, 0.01, 100);
    this.camera.position.set(2.5, 1.8, 3.0);

    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    // Filmic tone mapping + a touch of exposure: gives the PBR robot materials a
    // photographic roll-off instead of the flat, clipped look of raw output.
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 0.8, 0);

    this.addEnvironment();
    this.addLights();
    this.addGround();

    this.robotRoot = new Group();
    this.scene.add(this.robotRoot);
    void this.loadRobot(options.robotUrl);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);

    this.animate();
  }

  private sizedContainer(): { clientWidth: number; clientHeight: number } {
    // Guard against a zero-sized container (e.g. display:none on first paint).
    return {
      clientWidth: this.container.clientWidth || 1,
      clientHeight: this.container.clientHeight || 1,
    };
  }

  /**
   * Image-based lighting: render three.js' procedural RoomEnvironment to a PMREM
   * and use it as `scene.environment`. This gives every PBR material soft, real
   * reflections + ambient occlusion-like grounding for free — no remote HDR, no
   * external asset (CSP-safe). The biggest single win for how the robot reads.
   */
  private addEnvironment(): void {
    const pmrem = new PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
  }

  private addLights(): void {
    // Sky/ground hemisphere for a soft directional ambient gradient (cool slate
    // up top, dark below) on top of the IBL.
    this.scene.add(new HemisphereLight(0xcfe0f2, 0x0b1119, 0.5));
    // Key light — warm-neutral, high and to the right; the main shaping light.
    const key = new DirectionalLight(0xffffff, 2.2);
    key.position.set(4, 7, 5);
    this.scene.add(key);
    // Fill — dim, opposite side, lifts the shadow side without flattening.
    const fill = new DirectionalLight(0xffffff, 0.5);
    fill.position.set(-4, 2, -3);
    this.scene.add(fill);
    // Cyan-tinted rim from behind for edge separation against the slate bg —
    // echoes the brand accent and makes the silhouette pop.
    const rim = new DirectionalLight(0x8fe3f0, 1.0);
    rim.position.set(-3, 5, -7);
    this.scene.add(rim);
  }

  private addGround(): void {
    const grid = new GridHelper(
      20,
      40,
      new Color(token('--color-grid-major', '#2a3340')),
      new Color(token('--color-grid-minor', '#1a2027')),
    );
    this.scene.add(grid);
  }

  /**
   * Load the robot GLB if a URL is given AND it loads; otherwise fall back to a
   * labelled placeholder box. Robot meshes don't exist yet — tracked by
   * issue **wbc-mjlab-9as** (robot mesh pending).
   */
  private async loadRobot(robotUrl?: string): Promise<void> {
    if (robotUrl) {
      try {
        const gltf = await new GLTFLoader().loadAsync(robotUrl);
        this.robotRoot.add(gltf.scene);
        this.frameObject(gltf.scene);
        return;
      } catch (err) {
        console.warn(`[viewer] GLB load failed (${robotUrl}); using placeholder:`, err);
      }
    }
    this.addPlaceholderRobot();
  }

  /** Placeholder until real robot meshes exist (issue wbc-mjlab-9as). */
  private addPlaceholderRobot(): void {
    const accent = token('--color-accent', '#5b8def');
    const box = new Mesh(
      new BoxGeometry(0.6, 1.6, 0.4),
      new MeshStandardMaterial({ color: new Color(accent), roughness: 0.6, metalness: 0.1 }),
    );
    box.position.y = 0.8;
    box.name = 'placeholder-robot';
    box.userData.note = 'robot mesh pending (issue wbc-mjlab-9as)';
    this.robotRoot.add(box);
  }

  /** Reframe camera/controls so `object` fills a reasonable portion of view. */
  private frameObject(object: Object3D): void {
    const box = new Box3().setFromObject(object);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    const radius = Math.max(size.x, size.y, size.z) || 1;
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(new Vector3(radius * 1.4, radius * 1.0, radius * 1.6));
    this.camera.near = radius / 100;
    this.camera.far = radius * 100;
    this.camera.updateProjectionMatrix();
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.sizedContainer();
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  private animate = (): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  // ===========================================================================
  // M2 LIVE-ENGINE MOUNT POINT — RESERVED. DO NOT BUILD THE ENGINE HERE.
  // ===========================================================================
  //
  // In Milestone M2 the live, in-browser inference loop attaches here:
  //
  //   1. mujoco-wasm        — load the robot's MJCF/XML + assets, build the
  //                           physics model, and step the simulation.
  //   2. onnxruntime-web    — load `policy.onnx`, run inference each control
  //                           step (obs → action) feeding mujoco's actuators.
  //   3. bind               — map mujoco body/joint transforms onto
  //                           `this.robotRoot`'s children each frame (the same
  //                           node the GLB / placeholder lives under), so the
  //                           viewport "just works" with no scene changes.
  //
  // Design intent: the engine is a SEPARATE module (e.g. src/engine/live.ts)
  // that receives this Viewer instance and reads/writes `robotRoot`. Keep all
  // wasm/ort plumbing OUT of this file — renderer.ts stays pure Three.js so the
  // playback page (wbc-mjlab-3ne) and live engine share it unchanged.
  //
  // Signature is intentionally a stub; M2 will define the real engine handle.
  /**
   * Reserved seam for the M2 live engine. No-op today.
   * @param _opts engine config (MJCF url, onnx url, control rate, …) — TBD in M2.
   * @returns a teardown handle once implemented; `undefined` for now.
   */
  mountLiveEngine(_opts?: unknown): undefined {
    console.info('[viewer] mountLiveEngine() is a stub — live engine arrives in M2.');
    return undefined;
  }

  /** Free GL resources and listeners. Call on page teardown. */
  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
