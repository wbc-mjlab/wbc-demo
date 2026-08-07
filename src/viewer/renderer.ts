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
  CanvasTexture,
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
  RepeatWrapping,
  Scene,
  SRGBColorSpace,
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

/** 64² canvas: solid floor + 1 m cell lines (minor every cell, major every 5). */
function makeFloorGridTexture(
  floorHex: string,
  minorHex: string,
  majorHex: string,
): CanvasTexture {
  const n = 64;
  const canvas = document.createElement('canvas');
  canvas.width = n;
  canvas.height = n;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = floorHex;
  ctx.fillRect(0, 0, n, n);
  ctx.strokeStyle = minorHex;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0.5, 0);
  ctx.lineTo(0.5, n);
  ctx.moveTo(0, 0.5);
  ctx.lineTo(n, 0.5);
  ctx.stroke();
  // Stronger edge for the 5-cell major (drawn on every tile corner → every 5th world cell
  // when tiled; GridHelper carries the true major cadence).
  ctx.strokeStyle = majorHex;
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  ctx.moveTo(0.5, 0);
  ctx.lineTo(0.5, n);
  ctx.moveTo(0, 0.5);
  ctx.lineTo(n, 0.5);
  ctx.stroke();
  ctx.globalAlpha = 1;
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
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
  /** Visual ground plane — snapped under the camera so it never runs out. */
  private floor: Mesh | null = null;
  private grid: GridHelper | null = null;
  private readonly groundSnap = new Vector3();
  /** World-space cell size for floor texture + grid (metres). */
  private static readonly GROUND_CELL = 1;
  /** Half-extent of the visible ground patch (metres); re-centered each frame. */
  private static readonly GROUND_SIZE = 120;

  constructor(container: HTMLElement, options: ViewerOptions = {}) {
    this.container = container;
    this.shadowsEnabled = !options.lowQuality;

    this.scene = new Scene();
    const bg = new Color(token('--color-viewport-bg', '#16283a'));
    this.scene.background = bg;
    // Soft depth falloff — far enough that the re-centered ground never shows an edge.
    this.scene.fog = new Fog(bg, 28, 70);

    const { clientWidth: w, clientHeight: h } = this.sizedContainer();
    this.camera = new PerspectiveCamera(50, w / h, 0.01, 200);
    this.camera.position.set(2.5, 1.8, 3.0);

    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(
      options.lowQuality ? 1 : Math.min(window.devicePixelRatio, 2),
    );
    this.renderer.setSize(w, h);
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
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

  /** Soft IBL — blurred room bounce, low intensity for natural matte surfaces. */
  private addEnvironment(): void {
    const pmrem = new PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.1).texture;
    this.scene.environmentIntensity = 0.1;
    pmrem.dispose();
  }

  /** Soft natural daylight: sky dome + gentle sun + generous bounce fill. */
  private addLights(): void {
    // Broad sky/ground bounce — softens contrast like overcast / late-morning light.
    this.scene.add(new HemisphereLight(0xc5d6ea, 0x4a4540, 0.48));
    // Lift deep shadow wells without flattening form.
    this.scene.add(new AmbientLight(0x9aabbb, 0.12));

    const sun = new DirectionalLight(0xfff1e4, 0.55);
    sun.position.set(4, 11, 5);
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
      sun.shadow.normalBias = 0.03;
      sun.shadow.radius = 5.5;
    }
    this.scene.add(sun);

    // Cool sky fill + warm ground bounce — softens the lit/shadow edge.
    const fill = new DirectionalLight(0xd0e0f2, 0.28);
    fill.position.set(-5, 5, -3);
    this.scene.add(fill);

    const bounce = new DirectionalLight(0xe8dcc8, 0.1);
    bounce.position.set(1, 1.5, -4);
    this.scene.add(bounce);
  }

  private addGround(receiveShadow: boolean): void {
    const size = Viewer.GROUND_SIZE;
    const cell = Viewer.GROUND_CELL;
    const floorColor = token('--color-floor', '#2a455c');
    const major = token('--color-grid-major', '#429eb0');
    const minor = token('--color-grid-minor', '#2f7a8a');

    // One repeating cell → identical floor pattern everywhere (no finite edge).
    const tex = makeFloorGridTexture(floorColor, minor, major);
    tex.wrapS = RepeatWrapping;
    tex.wrapT = RepeatWrapping;
    tex.repeat.set(size / cell, size / cell);
    tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    tex.needsUpdate = true;

    const floor = new Mesh(
      new PlaneGeometry(size, size),
      new MeshStandardMaterial({
        map: tex,
        color: new Color(0xffffff),
        roughness: 0.96,
        metalness: 0,
        envMapIntensity: 0.02,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = receiveShadow;
    floor.name = 'floor';
    this.scene.add(floor);
    this.floor = floor;

    const divisions = Math.round(size / cell);
    const grid = new GridHelper(
      size,
      divisions,
      new Color(major),
      new Color(minor),
    );
    grid.position.y = 0.002;
    // Slight transparency so the textured floor still reads under the lines.
    const mats = Array.isArray(grid.material) ? grid.material : [grid.material];
    for (const mat of mats) {
      mat.transparent = true;
      mat.opacity = 0.55;
      mat.depthWrite = false;
    }
    this.scene.add(grid);
    this.grid = grid;
  }

  /** Re-read CSS tokens after light/dark theme switch (viewport + ground). */
  applyThemeColors(): void {
    const bg = new Color(token('--color-viewport-bg', '#16283a'));
    this.scene.background = bg;
    if (this.scene.fog instanceof Fog) {
      this.scene.fog.color.copy(bg);
    } else {
      this.scene.fog = new Fog(bg, 28, 70);
    }

    const floorColor = token('--color-floor', '#2a455c');
    const major = token('--color-grid-major', '#429eb0');
    const minor = token('--color-grid-minor', '#2f7a8a');

    if (this.floor) {
      const mat = this.floor.material as MeshStandardMaterial;
      const old = mat.map;
      const size = Viewer.GROUND_SIZE;
      const cell = Viewer.GROUND_CELL;
      const tex = makeFloorGridTexture(floorColor, minor, major);
      tex.wrapS = RepeatWrapping;
      tex.wrapT = RepeatWrapping;
      tex.repeat.set(size / cell, size / cell);
      tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      tex.needsUpdate = true;
      mat.map = tex;
      mat.needsUpdate = true;
      old?.dispose();
    }

    if (this.grid) {
      const mats = Array.isArray(this.grid.material)
        ? this.grid.material
        : [this.grid.material];
      // GridHelper: [0]=major, [1]=minor when two materials.
      if (mats[0] && 'color' in mats[0]) {
        (mats[0] as { color: Color }).color.set(major);
      }
      if (mats[1] && 'color' in mats[1]) {
        (mats[1] as { color: Color }).color.set(minor);
      } else if (mats[0] && 'color' in mats[0] && mats.length === 1) {
        (mats[0] as { color: Color }).color.set(minor);
      }
    }

    const placeholder = this.robotRoot.getObjectByName('placeholder-robot');
    if (placeholder instanceof Mesh) {
      const mat = placeholder.material as MeshStandardMaterial;
      mat.color.set(token('--color-accent', '#5b8def'));
    }
  }

  /** Keep floor + grid under the look-at point so Gen locomotion never leaves the patch. */
  private snapGround(): void {
    if (!this.floor || !this.grid) return;
    const cell = Viewer.GROUND_CELL;
    const tx = this.controls.target.x;
    const tz = this.controls.target.z;
    this.groundSnap.set(
      Math.round(tx / cell) * cell,
      0,
      Math.round(tz / cell) * cell,
    );
    this.floor.position.x = this.groundSnap.x;
    this.floor.position.z = this.groundSnap.z;
    this.grid.position.x = this.groundSnap.x;
    this.grid.position.z = this.groundSnap.z;
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
    this.snapGround();
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
