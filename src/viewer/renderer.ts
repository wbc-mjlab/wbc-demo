/**
 * Three.js viewport — the shared rendering core.
 *
 * The ONE place scene/camera/lights/grid/controls live. The live engine
 * (`src/engine/live-engine.ts`) constructs a Viewer, drops the placeholder, and
 * drives the robot's body nodes under `robotRoot` from its physics step. Until
 * the engine attaches its meshes the viewport shows a labelled placeholder box.
 */

import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  BoxGeometry,
  Color,
  DirectionalLight,
  Fog,
  GridHelper,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
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
  /**
   * Trim cost for many simultaneous viewports (gallery cards): cap pixel ratio
   * at 1 and skip the PMREM image-based-lighting pass (3-point lights only).
   */
  lowQuality?: boolean;
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
   * meshes land the loaded GLTF scene is parented here instead.
   * Playback and the live engine pose the children of this node.
   */
  readonly robotRoot: Group;

  private container: HTMLElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly shadowsEnabled: boolean;
  private rafId = 0;
  private disposed = false;

  constructor(container: HTMLElement, options: ViewerOptions = {}) {
    this.container = container;
    this.shadowsEnabled = !options.lowQuality;

    this.scene = new Scene();
    const bg = new Color(token('--color-viewport-bg', '#16283a'));
    this.scene.background = bg;
    // Soft depth falloff — same idea as mujoco_wasm's haze fog.
    this.scene.fog = new Fog(bg, 12, 22);

    const { clientWidth: w, clientHeight: h } = this.sizedContainer();
    this.camera = new PerspectiveCamera(50, w / h, 0.01, 100);
    this.camera.position.set(2.5, 1.8, 3.0);

    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(
      options.lowQuality ? 1 : Math.min(window.devicePixelRatio, 2),
    );
    this.renderer.setSize(w, h);
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.85;
    if (this.shadowsEnabled) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = PCFSoftShadowMap;
    }
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 0.8, 0);

    if (!options.lowQuality) this.addEnvironment();
    this.addLights();
    this.addGround(this.shadowsEnabled);

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

  /** Subtle IBL — just enough ambient reflection without a studio look. */
  private addEnvironment(): void {
    const pmrem = new PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.08;
    pmrem.dispose();
  }

  /** Soft overcast-daylight: sky dome + warm sun + faint bounce fill. */
  private addLights(): void {
    // Sky/ground bounce — cool sky, warm floor reflection.
    this.scene.add(new HemisphereLight(0xb8cce8, 0x3a3530, 0.32));
    // Lift deep shadows slightly without flattening the scene.
    this.scene.add(new AmbientLight(0x8899aa, 0.06));

    const sun = new DirectionalLight(0xfff2e6, 0.82);
    sun.position.set(5, 9, 4);
    if (this.shadowsEnabled) {
      sun.castShadow = true;
      sun.shadow.mapSize.set(1024, 1024);
      sun.shadow.camera.near = 0.5;
      sun.shadow.camera.far = 14;
      const extent = 4.5;
      sun.shadow.camera.left = -extent;
      sun.shadow.camera.right = extent;
      sun.shadow.camera.top = extent;
      sun.shadow.camera.bottom = -extent;
      sun.shadow.bias = -0.0002;
      sun.shadow.normalBias = 0.025;
      sun.shadow.radius = 2.5;
    }
    this.scene.add(sun);

    // Opposite-side sky fill — keeps the shadow side readable, not studio-flat.
    const fill = new DirectionalLight(0xc8daf0, 0.14);
    fill.position.set(-5, 4, -3);
    this.scene.add(fill);
  }

  private addGround(receiveShadow: boolean): void {
    const floor = new Mesh(
      new PlaneGeometry(40, 40),
      new MeshStandardMaterial({
        color: new Color(token('--color-floor', '#2a455c')),
        roughness: 0.88,
        metalness: 0,
        envMapIntensity: 0.04,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = receiveShadow;
    floor.name = 'floor';
    this.scene.add(floor);

    const grid = new GridHelper(
      20,
      40,
      new Color(token('--color-grid-major', '#429eb0')),
      new Color(token('--color-grid-minor', '#2f7a8a')),
    );
    grid.position.y = 0.002;
    this.scene.add(grid);
  }

  /**
   * Load the robot GLB if a URL is given AND it loads; otherwise fall back to a
   * labelled placeholder box. Robot meshes don't exist yet — tracked by
   * issue **** (robot mesh pending).
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

  /** Placeholder until real robot meshes exist. */
  private addPlaceholderRobot(): void {
    const accent = token('--color-accent', '#5b8def');
    const box = new Mesh(
      new BoxGeometry(0.6, 1.6, 0.4),
      new MeshStandardMaterial({ color: new Color(accent), roughness: 0.6, metalness: 0.1 }),
    );
    box.position.y = 0.8;
    box.name = 'placeholder-robot';
    box.userData.note = 'robot mesh pending';
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

  /**
   * Move this viewport's canvas into a new container (engine-pool reuse): the
   * gallery reassigns a fixed pool of viewers across many cards instead of
   * spawning one WebGL context per card. Re-points the ResizeObserver + resizes.
   */
  reparent(container: HTMLElement): void {
    this.resizeObserver.unobserve(this.container);
    this.container = container;
    container.appendChild(this.renderer.domElement);
    this.resizeObserver.observe(container);
    this.resize();
  }

  private animate = (): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

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
