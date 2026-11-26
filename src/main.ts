import * as BABYLON from 'babylonjs';
import 'babylonjs-loaders';
import { Environment } from './core/Environment';
import { HavokWorld } from './core/HavokWorld';
import { Input } from './core/Input';
import { CameraRig } from './core/CameraRig';
import { Character, DEFAULT_COLORS, AnimState, MoveDir } from './character/Character';
import { MixamoController } from './character/Mixamo';
import { Polish } from './core/Polish';
import { GameAudio } from './core/GameAudio';
import { Materials } from './world/Materials';
import { World, Pickup, ZoneMarker, SlopeCollider } from './world/World';
import { UI } from './ui/UI';
import { Minimap } from './ui/Minimap';
import { Drone } from './world/Drone';
import { Footprints } from './world/Footprints';
import { PixelPortal } from './world/PixelPortal';
import { SciFiCity } from './world/SciFiCity';

type Mode = 'welcome' | 'explore';

class App {
  private canvas!: HTMLCanvasElement;
  private engine!: BABYLON.Engine;
  private scene!: BABYLON.Scene;
  private env!: Environment;
  private havok!: HavokWorld;
  private input!: Input;
  private camera!: CameraRig;
  private character!: Character;
  private mixamo!: MixamoController;
  private assetLoads: Promise<any>[] = [];
  private polish!: Polish;
  private audio!: GameAudio;
  private materials!: Materials;
  private world!: World;
  private ui!: UI;
  private minimap!: Minimap;
  private drone!: Drone;
  private footprints!: Footprints;
  private footSide = 1;
  private pixelPortal!: PixelPortal;
  private exploreTime = 0;
  private droneTriggered = false;
  private mode: Mode = 'welcome';
  private facing = Math.PI / 2; // screen-right (+X) at start
  private lastTime = 0;
  private fpsAcc = 0; private fpsFrames = 0;
  private pickupCount = 0;
  private debug = false;
  private keys = new Set<string>();

  // Deterministic kinematic player — position in FEET world coordinates
  private ppos = new BABYLON.Vector3(0, 0, 0);
  private pvel = new BABYLON.Vector3(0, 0, 0);
  private grounded = false;
  private coyote = 0;
  private jumpBuffer = 0;
  private jumpsUsed = 0;      // 0 grounded, 1 first jump, 2 double jump
  private doubleJumpFx = 0;   // keeps the "doubleJump" state alive briefly
  private tripleJumpFx = 0;   // 3rd-jump hang-time window (reduced gravity)
  private debugMeshes: BABYLON.Mesh[] = [];

  constructor() {
    this.canvas = document.getElementById('renderCanvas') as HTMLCanvasElement;
    this.init();
  }

  private async init() {
    this.engine = new BABYLON.Engine(this.canvas, true, { stencil: true, preserveDrawingBuffer: false });
    this.scene = new BABYLON.Scene(this.engine);
    this.scene.clearColor = new BABYLON.Color4(0.11, 0.15, 0.19, 1);
    this.scene.imageProcessingConfiguration.toneMappingEnabled = true;
    this.scene.imageProcessingConfiguration.toneMappingType = BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES;
    this.scene.imageProcessingConfiguration.exposure = 1.0;
    this.scene.imageProcessingConfiguration.contrast = 1.28;

    this.audio = new GameAudio();
    window.addEventListener('pointerdown', () => this.audio.unlock(), { once: true });
    window.addEventListener('keydown', () => this.audio.unlock(), { once: true });

    this.ui = new UI(DEFAULT_COLORS, {
      play: () => this.startExploring(),
      menu: () => this.returnToMenu(),
      sfx: (kind: any) => this.audio.button(kind),
    });
    this.ui.setLoading(12);

    this.havok = new HavokWorld(this.scene);
    await this.havok.init(-24);
    this.ui.setLoading(35);

    this.env = new Environment(this.scene);
    this.ui.setLoading(55);

    this.materials = new Materials(this.scene);
    this.world = new World(this.scene, this.materials);
    this.world.onPickup = (p: Pickup) => {
      this.pickupCount++;
      this.ui.setPickups(this.pickupCount, this.world.pickups.length);
      this.camera.punch(3);
      this.flashPickup(p);
      this.polish?.sparkle(p.mesh.position);
      this.audio.pickup();
    };
    this.world.onZone = (z: ZoneMarker) => { this.ui.setZone(z.name); this.audio.zone(); };
    const mapCanvas = document.getElementById('minimap') as HTMLCanvasElement | null;
    if (mapCanvas) this.minimap = new Minimap(mapCanvas, this.world);

    // Fading ground footprints — placed on the exact sampled surface.
    this.footprints = new Footprints(this.scene, (x, z) => this.surfaceAt(x, z, this.ppos.y + 0.6));

    this.character = new Character(this.scene);
    // Foot IK samples the exact surface under each shoe — including the
    // analytic ramp plane, so the foot pin is precise even while climbing.
    this.character.groundSampler = (x, z) => {
      let h = this.surfaceAt(x, z, this.ppos.y + 0.6);
      for (const s of this.world.slopes) {
        if (x >= s.x - s.w / 2 && x <= s.x + s.w / 2 && z >= s.z - s.d / 2 && z <= s.z + s.d / 2) {
          h = Math.max(h, this.slopeHeight(s, x));
        }
      }
      return h;
    };
    // Face screen-right from the very first frame (idle at start)
    this.character.headingPivot.rotation.y = Math.PI / 2;
    this.mixamo = new MixamoController(this.scene);
    const heroLoad = this.mixamo.load('/models/', 'BlobothanChar.glb').then((ok) => {
      if (ok) {
        this.character.bindMixamo(this.mixamo);
        // The Sketchfab GLB bundles an orphaned 312 m backdrop plane that
        // floated in the sky as a yellow/black barrier. Hide any such plane.
        for (const m of this.scene.meshes) {
          if (/^Plane_Material/.test(m.name) || m.name === 'Plane') m.setEnabled(false);
        }
        // Bind the newly-loaded hero to the drone scan overlay (if present).
        const hero = this.mixamo.root.getChildMeshes(false).find((m) => m instanceof BABYLON.Mesh) as BABYLON.Mesh | undefined;
        if (hero && this.drone) this.drone.bindTarget(hero);
        for (const m of this.mixamo.root.getChildMeshes(false)) {
          // The GLB root node has no geometry of its own; its oversized stale
          // bounds (and the drone's clone of it) cast a giant long shadow.
          // The real body-part meshes below cast the correct hero shadow.
          if (m instanceof BABYLON.Mesh && m.name !== '__root__' && !/^droneBodyGrid/.test(m.name)) {
            this.env.registerShadowCaster(m);
            // Matte hero — no glossy/specular look.
            const mat = m.material as BABYLON.PBRMaterial;
            if (mat && mat.metallic !== undefined) {
              mat.metallic = 0;
              mat.roughness = 1;
              if (mat.metallicTexture) mat.metallicTexture = null;
              if (mat.microSurfaceTexture) mat.microSurfaceTexture = null;
            }
          }
        }
      } else {
        // Only reveal the procedural fallback if the real model truly fails.
        this.character.unbindMixamo();
      }
    });
    // Slide + crouch-walk are merged into BlobothanChar.glb via NLA strips, so
    // they share the hero's skeleton and animate it correctly (no T-pose).
    this.assetLoads.push(heroLoad);
    for (const m of this.character.getMeshes()) this.env.registerShadowCaster(m);
    this.enableShadowReceivers();
    this.loadRoad();
    // Background sci-fi city with landable colliders.
    const city = new SciFiCity(this.scene);
    const cityLoad = city.load((c) => {
      this.world.colliders.push(c);
    }).then(() => {
      for (const m of this.scene.meshes) {
        if (m.name.indexOf('sciFiBuilding') === 0) {
          m.receiveShadows = true;
          // Only the visible building instances cast; the disabled source
          // meshes at the origin must not throw shadows over the start area.
          if (m.name.indexOf('sciFiBuilding_part') === 0) this.env.registerShadowCaster(m);
        }
      }
    });
    this.assetLoads.push(cityLoad);

    this.input = new Input();
    this.camera = new CameraRig(this.scene, this.canvas);
    // Parent the sky to the camera: the most robust way to keep the dome
    // centred on the view at every position/angle (no infiniteDistance quirks).
    this.env.sky.parent = this.camera.getCamera();
    this.env.sky.position.set(0, 0, 0);
    this.env.sky.infiniteDistance = false;
    this.polish = new Polish(this.scene, this.camera.getCamera());
    const arc = this.camera.getCamera() as BABYLON.ArcRotateCamera;
    arc.lowerBetaLimit = 0.25;
    arc.upperBetaLimit = 1.42;
    arc.lowerRadiusLimit = 6;
    arc.upperRadiusLimit = 26;
    arc.panningSensibility = 0;
    this.camera.snap(new BABYLON.Vector3(0, 1.2, 0));

    // Pixel-art portal placed after the road section
    this.pixelPortal = new PixelPortal(this.scene, this.camera.getCamera(), (pixel) => {
      this.ui.setZone(pixel ? 'PIXEL WORLD' : 'NEIGHBOURHOOD');
    });

    // Scenery: cardboard house billboard beside the sci-fi building + arcade.
    this.loadHouseBillboard();
    this.assetLoads.push(this.loadArcade());

    // Cinematic scan drone — one-shot encounter 30 s into the level
    this.createDrone();

    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (e.code === 'Backquote') { this.debug = !this.debug; this.toggleDebug(); }
      if (e.code === 'KeyF' && !e.repeat) {
        // F toggles fullscreen (browser requires a user gesture — keydown is one).
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen?.().catch(() => {});
        } else {
          document.exitFullscreen?.().catch(() => {});
        }
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));

    // Wait for every GLB and shader to be ready BEFORE revealing the scene.
    // Previously the loading screen hid after a fixed 400 ms while models were
    // still streaming in — the level "staggered" into view and the first
    // camera move hitched while shaders compiled.
    this.ui.setLoading(88);
    await Promise.all(this.assetLoads);
    this.ui.setLoading(94);
    await this.scene.whenReadyAsync();
    // Compile the post-process + shadow shaders off-screen so the first
    // rotation and every frame after are smooth (no compile hitches).
    this.scene.render();
    this.scene.render();
    this.ui.setLoading(100);
    await new Promise((r) => setTimeout(r, 120));
    this.ui.hideLoading();
    (window as any).__nbhd = this;
    // Dev-only tools — stripped entirely from production builds by Vite.
    if (import.meta.env.DEV) {
      import('./ui/DevPanel').then((m) => { (window as any).__devPanel = new m.DevPanel(this); });
    }
    this.lastTime = performance.now();
    this.engine.runRenderLoop(() => this.frame());
    window.addEventListener('resize', () => this.engine.resize());
  }

  private enableShadowReceivers() {
    // Every real scene object both receives and casts sun shadows — platforms,
    // ramps, travelators, rails, sign boards, pickups, portal frame, etc.
    // Excluded: the sky dome, disabled GLB source meshes, the GLB root node
    // (stale giant bounds), and the drone's emissive/glow effect meshes (their
    // additive shaders would throw broken shadows).
    const skip = (n: string) =>
      n === 'skyBox' || n === 'ground' || n === '__root__' || n === 'sciFiBuildingSrc' ||
      n === 'portalVeil' || n === 'zonePost' ||
      // 0.14 m-thin rails cast 24 m hairline shadows that read as a "long
      // strange shadow" and pop as the 40 m shadow cell snaps. The decks and
      // ramps themselves still cast their proper rectangular shadows.
      // The travelator deck is only 0.22 m tall and sits on the ground — its
      // "shadow" is a 24 m hairline that reads as a long strange line.
      // Rollers are 5 m cylinders lying flat at the belt ends — they cast a
      // thin line straight down the view direction (the "long shadow").
      n === 'travelator' || n === 'travelatorRoller' || n === 'travelatorRail' ||
      n === 'rampRail' || n === 'rampBolt' ||
      // 360 tiny collectible sub-meshes — their shadows cost draw calls and
      // add nothing visible. The collectibles themselves stay fully rendered.
      /^pickup/.test(n) ||
      /^drone(BodyGrid|ScanCone|ScanRing|Halo|Lens|LED|CPULED|Core|Rotor|RotorRing)/.test(n);
    for (const m of this.scene.meshes) {
      if (m.name === 'skyBox') continue;
      m.receiveShadows = true;
      if (!(m instanceof BABYLON.Mesh) || !m.isEnabled() || skip(m.name)) continue;
      this.env.registerShadowCaster(m);
      // Static level geometry never moves — freeze its world matrix so the
      // engine skips per-frame transform recomputation (reactive gameplay).
      if (/^(platform|travelator|ramp|road|ground|sciFiBuilding|portal)/.test(m.name)) {
        m.freezeWorldMatrix();
      }
    }
  }

  private toggleDebug() {
    for (const m of this.debugMeshes) m.dispose();
    this.debugMeshes = [];
    if (!this.debug) return;
    const mat = new BABYLON.StandardMaterial('debugMat', this.scene);
    mat.emissiveColor = new BABYLON.Color3(0, 1, 0.4);
    mat.alpha = 0.25; mat.disableLighting = true;
    for (const c of this.world.colliders) {
      const box = BABYLON.MeshBuilder.CreateBox('debugBox', { width: c.w, height: c.h, depth: c.d }, this.scene);
      box.position.set(c.x, c.y, c.z);
      box.material = mat;
      this.debugMeshes.push(box);
    }
  }

  /** Modular road: bake the imported GLB into a clean, normalized segment and
   *  repeat it five times end-to-end after the ramp. Segments are snapped by
   *  using one exact length for both the mesh and the placement step. */
  private async loadRoad() {
    try {
      const res = await BABYLON.SceneLoader.ImportMeshAsync('', '/models/road/', 'road.glb', this.scene);
      const src = res.meshes.find((m) => m instanceof BABYLON.Mesh && m.getTotalVertices() > 0) as BABYLON.Mesh | undefined;
      if (!src) return;
      src.computeWorldMatrix(true);
      const pos = src.getVerticesData(BABYLON.VertexBuffer.PositionKind)!;
      const uv = src.getVerticesData(BABYLON.VertexBuffer.UVKind);
      const idx = src.getIndices()!;
      const wm = src.getWorldMatrix();
      const v = new BABYLON.Vector3();
      const world: number[] = [];
      for (let i = 0; i < pos.length; i += 3) {
        BABYLON.Vector3.TransformCoordinatesToRef(new BABYLON.Vector3(pos[i], pos[i + 1], pos[i + 2]), wm, v);
        world.push(v.x, v.y, v.z);
      }
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < world.length; i += 3) {
        minX = Math.min(minX, world[i]); maxX = Math.max(maxX, world[i]);
        minY = Math.min(minY, world[i + 1]); maxY = Math.max(maxY, world[i + 1]);
        minZ = Math.min(minZ, world[i + 2]); maxZ = Math.max(maxZ, world[i + 2]);
      }
      const LEN = 8;                       // exact modular length along X
      const ROAD_Y = 0.12;                 // lift above the ground to avoid z-fighting
      const longZ = (maxZ - minZ) >= (maxX - minX);
      const span = longZ ? maxZ - minZ : maxX - minX;
      const s = LEN / span;
      const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
      const baked: number[] = [];
      let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
      for (let i = 0; i < world.length; i += 3) {
        let x = world[i] - cx, z = world[i + 2] - cz;
        if (longZ) { const t = x; x = z; z = -t; } // align long axis with world X
        x *= s; z *= s;
        bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x);
        bz0 = Math.min(bz0, z); bz1 = Math.max(bz1, z);
        baked.push(x, (world[i + 1] - maxY) * s + ROAD_Y, z);
      }
      const normals: number[] = [];
      BABYLON.VertexData.ComputeNormals(baked, idx, normals);
      const seg = new BABYLON.Mesh('roadSegment', this.scene);
      const vd = new BABYLON.VertexData();
      vd.positions = baked; vd.indices = idx; vd.normals = normals;
      if (uv) vd.uvs = Array.from(uv);
      vd.applyToMesh(seg);
      seg.material = src.material;
      seg.receiveShadows = true;
      seg.setEnabled(false);
      const START = 52; // after the ramp + platform
      const roadW = bx1 - bx0, roadD = bz1 - bz0;
      const roadCX = (bx0 + bx1) / 2, roadCZ = (bz0 + bz1) / 2;
      for (let i = 0; i < 5; i++) {
        const road = seg.createInstance(`road${i}`);
        road.position.set(START + i * LEN, 0, 0);
        road.isPickable = false;
        road.receiveShadows = true;
        // Collision slab whose top matches the visible road surface exactly.
        this.world.colliders.push({
          x: START + i * LEN + roadCX,
          y: ROAD_Y / 2,
          z: roadCZ,
          w: roadW,
          h: ROAD_Y,
          d: roadD,
        });
      }
    } catch (e) {
      console.warn('[Road] modular road failed to load:', e);
    }
  }

  private flashPickup(p: Pickup) {
    const ring = BABYLON.MeshBuilder.CreateTorus('pickupRing', { diameter: 1, thickness: 0.06, tessellation: 20 }, this.scene);
    ring.position.copyFrom(p.mesh.position);
    const mat = new BABYLON.StandardMaterial('pickupRingMat', this.scene);
    mat.emissiveColor = new BABYLON.Color3(1, 0.85, 0.3);
    mat.disableLighting = true;
    ring.material = mat;
    let life = 0.5;
    const obs = this.scene.onBeforeRenderObservable.add(() => {
      life -= this.engine.getDeltaTime() / 1000;
      ring.scaling.setAll(1 + (0.5 - life) * 4);
      mat.alpha = Math.max(0, life * 2);
      if (life <= 0) { this.scene.onBeforeRenderObservable.remove(obs); ring.dispose(); mat.dispose(); }
    });
  }

  /** Cinematic world collapse: implode every mesh toward the player, flash,
   *  then restore — a dramatic one-shot showcase transition. */
  private collapseWorld() {
    if (this.collapsing) return;
    this.collapsing = true;
    const focus = new BABYLON.Vector3(this.ppos.x, this.ppos.y + 1, this.ppos.z);
    const meshes = this.scene.meshes.filter((m) => m.isEnabled() && m.name !== 'skyBox');
    const saved = meshes.map((m) => ({ m: m, pos: m.position.clone(), scl: m.scaling.clone() }));
    let t = 0;
    const obs = this.scene.onBeforeRenderObservable.add(() => {
      t += this.engine.getDeltaTime() / 1000 / 1.8;
      const k = Math.min(1, t);
      // implode 0→0.5, hold, restore 0.7→1
      let c = k < 0.5 ? k / 0.5 : k > 0.7 ? (1 - k) / 0.3 : 1;
      c = c * c * (3 - 2 * c);
      for (const s of saved) {
        s.m.position.copyFrom(BABYLON.Vector3.Lerp(focus, s.pos, Math.max(0.001, 1 - c * 0.92)));
        s.m.scaling.copyFrom(s.scl.scale(Math.max(0.001, 1 - c * 0.85)));
      }
      this.camera.punch(2 * c);
      if (k >= 1) {
        for (const s of saved) { s.m.position.copyFrom(s.pos); s.m.scaling.copyFrom(s.scl); }
        this.scene.onBeforeRenderObservable.remove(obs);
        this.collapsing = false;
      }
    });
  }
  private collapsing = false;

  /** Cardboard house billboard placed beside the sci-fi building. */
  private loadHouseBillboard() {
    const tex = new BABYLON.Texture('/art/house_alpha_01.png', this.scene, false, true);
    tex.hasAlpha = true;
    const mat = new BABYLON.StandardMaterial('houseBillboardMat', this.scene);
    mat.diffuseTexture = tex;
    mat.emissiveTexture = tex;
    mat.opacityTexture = tex;
    (mat.opacityTexture as BABYLON.Texture).getAlphaFromRGB = false;
    mat.useAlphaFromDiffuseTexture = true;
    mat.diffuseColor = BABYLON.Color3.Black();
    mat.emissiveColor = new BABYLON.Color3(0.85, 0.85, 0.85);
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    mat.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
    // Painted on a flat vertical plane facing the side-scroll camera.
    const billboard = BABYLON.MeshBuilder.CreatePlane('houseBillboard', { width: 6, height: 6 }, this.scene);
    // Opposite side of the road (which runs along z=0) from the arcade.
    billboard.position.set(64, 3, 7);
    billboard.material = mat;
    billboard.isPickable = false;
    billboard.applyFog = false;
  }

  /** Place the arcade cabinet as scenery just past the first travelator. */
  private async loadArcade() {
    try {
      const res = await BABYLON.SceneLoader.ImportMeshAsync('', '/models/arcade/', 'arcade_01.glb', this.scene);
      const root = new BABYLON.TransformNode('arcadeStand', this.scene);
      // Real-world arcade scale — the GLB is already ~0.9 x 2 x 0.86 m.
      root.scaling.setAll(1.0);
      // Sit on the far side of the play strip; rotate so the screen faces the
      // side-scroll camera (which sits at negative Z looking toward +Z).
      root.position.set(34, 0, -7);
      root.rotation.y = Math.PI;
      for (const m of res.meshes) {
        if (!m.parent) m.parent = root;
        m.isPickable = false;
        m.receiveShadows = true;
        m.applyFog = false;
        const mat = m.material as BABYLON.PBRMaterial;
        if (mat && mat.metallic !== undefined) mat.roughness = Math.max(0.6, mat.roughness ?? 0.6);
      }
      for (const n of res.transformNodes) if (!n.parent) n.parent = root;
      // Solid collision box matching the cabinet footprint (0.9 x 2 x 0.86).
      this.world.colliders.push({ x: 34, y: 1.0, z: -7, w: 0.85, h: 2.0, d: 0.8 });
      for (const m of root.getChildMeshes(false)) if (m instanceof BABYLON.Mesh) this.env.registerShadowCaster(m);
    } catch (e) {
      console.warn('[Arcade] load failed:', e);
    }
  }

  private createDrone() {
    this.drone?.dispose();
    this.drone = new Drone(this.scene, () => this.audio.zone(), (m) => this.env.unregisterShadowCaster(m));
    const hero = this.mixamo.root.getChildMeshes(false).find((m) => m instanceof BABYLON.Mesh) as BABYLON.Mesh | undefined;
    if (hero) this.drone.bindTarget(hero);
  }

  private startExploring() {
    this.mode = 'explore';
    this.exploreTime = 0;
    this.droneTriggered = false;
    this.createDrone(); // fresh one-shot encounter for this playthrough
    this.ppos.set(2.4, 0, 0);
    this.pvel.set(0, 0, 0);
    this.grounded = true;
    this.facing = Math.PI / 2;
    this.character.headingPivot.rotation.y = Math.PI / 2;
    this.camera.snap(new BABYLON.Vector3(2.4, 1, 0));
  }

  private returnToMenu() {
    this.drone.dispose();
    this.mode = 'welcome';
    this.exploreTime = 0;
    this.droneTriggered = false;
    this.ppos.set(0, 0, 0);
    this.pvel.set(0, 0, 0);
    this.character.setPosition(0, 0, 0);
    this.camera.snap(new BABYLON.Vector3(0, 1.2, 0));
    this.ui.setZone('WELCOME');
  }

  /** Exact surface height of a ramp at world X. */
  private slopeHeight(s: SlopeCollider, x: number) {
    const t = Math.max(0, Math.min(1, (x - (s.x - s.w / 2)) / s.w));
    return s.y0 + (s.y1 - s.y0) * t;
  }

  /** Highest solid surface at (x,z) the feet can rest on — platforms AND
   *  ramps, using a tight foot radius so shoes land exactly on the surface. */
  private surfaceAt(x: number, z: number, feetY: number): number {
    let best = 0; // ground plane
    const R = 0.1; // foot half-width — precise edge contact
    const STEP = 0.25; // max step-up per substep
    for (const c of this.world.colliders) {
      const top = c.y + c.h / 2;
      if (top > feetY + STEP || top <= best) continue;
      if (x > c.x - c.w / 2 - R && x < c.x + c.w / 2 + R &&
          z > c.z - c.d / 2 - R && z < c.z + c.d / 2 + R) best = top;
    }
    for (const s of this.world.slopes) {
      if (x < s.x - s.w / 2 - R || x > s.x + s.w / 2 + R ||
          z < s.z - s.d / 2 - R || z > s.z + s.d / 2 + R) continue;
      const h = this.slopeHeight(s, x);
      if (h > feetY + STEP || h <= best) continue;
      best = h;
    }
    return best;
  }

  /** Slope pitch under the player's feet (radians). */
  private slopeAngleAt(x: number, z: number, feetY: number): number {
    for (const s of this.world.slopes) {
      if (x < s.x - s.w / 2 || x > s.x + s.w / 2 ||
          z < s.z - s.d / 2 || z > s.z + s.d / 2) continue;
      if (Math.abs(this.slopeHeight(s, x) - feetY) < 0.22) return Math.atan2(s.y1 - s.y0, s.w);
    }
    return 0;
  }

  /** Solid box overlapping the player's body → horizontal move blocked.
   *  Ramps are walkable, so they never block — except when they rise well
   *  above the feet (walking into the raised end from the side). */
  private wallAt(x: number, z: number, feetY: number, radius: number): boolean {
    for (const c of this.world.colliders) {
      const top = c.y + c.h / 2, bot = c.y - c.h / 2;
      // Allow a step-up of 0.3 m — otherwise the platform's side wall blocks
      // the player at the top of a ramp before the surface snap can lift them.
      if (feetY >= top - 0.3 || feetY + 1.75 <= bot) continue;
      if (x + radius > c.x - c.w / 2 && x - radius < c.x + c.w / 2 &&
          z + radius > c.z - c.d / 2 && z - radius < c.z + c.d / 2) return true;
    }
    for (const s of this.world.slopes) {
      if (x < s.x - s.w / 2 - radius || x > s.x + s.w / 2 + radius ||
          z < s.z - s.d / 2 - radius || z > s.z + s.d / 2 + radius) continue;
      if (feetY + 0.3 < this.slopeHeight(s, x)) return true;
    }
    return false;
  }

  private updateController(dt: number) {
    this.input.update(dt);
    const s = this.input.state;
    const v = this.pvel, p = this.ppos;
    const GRAVITY = 22;

    // ---- Camera-relative movement basis ----
    // Movement is relative to where the camera is LOOKING, so after orbiting
    // with the right stick, "right" still moves the player screen-right. The
    // right stick never adds to ax/az — it only rotates the camera — so it
    // cannot move the player by itself.
    const cam = this.camera.getCamera();
    const fwd = cam.getTarget().subtract(cam.position);
    fwd.y = 0;
    if (fwd.lengthSquared() < 1e-6) fwd.set(0, 0, 1);
    fwd.normalize();
    const right = BABYLON.Vector3.Cross(BABYLON.Axis.Y, fwd).normalize();

    const ax = s.axisX, az = s.axisZ;
    let dx = right.x * ax + fwd.x * az;
    let dz = right.z * ax + fwd.z * az;
    const mag = Math.hypot(dx, dz);
    if (mag > 1) { dx /= mag; dz /= mag; }   // no diagonal speed boost
    const moveInput = mag > 0.08;

    const running = moveInput && (s.run || this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'));
    const maxSpeed = running ? 6.2 : 3.0;
    // Slide is a committed running move — only valid at running speed.
    const sliding = s.slide && this.grounded && Math.hypot(v.x, v.z) > 4;

    // ---- Travelator: a real conveyor belt ----
    // On the belt, the ground itself moves at `belt` m/s along +X. When the
    // player gives no input, that IS their target velocity (idle → carried).
    // Player input adds on top, so they can still walk/jump normally on it.
    const belt = this.grounded ? this.world.travelatorSpeedAt(p.x, p.z, p.y) : 0;
    const onBelt = belt > 0;

    // ---- Acceleration & crisp braking ----
    const accel = this.grounded ? 30 : 10;
    const step = accel * dt;
    let tx: number, tz: number;
    if (moveInput) {
      tx = dx * maxSpeed;  // air/ground steering
      tz = dz * maxSpeed;
    } else if (this.grounded) {
      tx = belt;           // on belt → carried; on ground → brake to rest
      tz = 0;
    } else {
      // Airborne with no input → PRESERVE momentum exactly. This keeps the
      // belt's carry speed when the player jumps off the travelator.
      tx = v.x;
      tz = v.z;
    }
    // During a slide, preserve momentum — no braking back toward a walk target.
    if (sliding) {
      tx = v.x; tz = v.z;
    }
    v.x += Math.max(-step, Math.min(step, tx - v.x));
    v.z += Math.max(-step, Math.min(step, tz - v.z));
    if (!moveInput && !onBelt && this.grounded) {
      if (Math.abs(v.x) < 0.02) v.x = 0;
      if (Math.abs(v.z) < 0.02) v.z = 0;
    }

    // ---- Triple jump (coyote + input buffer) ----
    // All three reuse the SAME Mixamo jump clip. Each tier is distinct:
    //  1st: standard jump
    //  2nd: higher + forward burst + camera kick
    //  3rd: highest "sky leap" — big vertical, brief hang-time (lower gravity
    //       pulse), a burst of radial sparks and a deeper camera punch.
    if (this.grounded) this.jumpsUsed = 0;
    this.coyote = this.grounded ? 0.12 : Math.max(0, this.coyote - dt);
    this.jumpBuffer = s.jumpPressed ? 0.14 : Math.max(0, this.jumpBuffer - dt);
    const groundJump = this.coyote > 0 && this.jumpsUsed === 0;
    const airJump = !this.grounded && (this.jumpsUsed === 1 || this.jumpsUsed === 2);
    if (this.jumpBuffer > 0 && (groundJump || airJump)) {
      if (groundJump) {
        v.y = 8.6;
        this.jumpsUsed = 1;
        this.audio.jump();
      } else if (this.jumpsUsed === 1) {
        v.y = 10.8; // 2nd jump — higher
        this.jumpsUsed = 2;
        this.doubleJumpFx = 0.4;
        const len = Math.max(0.001, Math.hypot(v.x, v.z));
        if (len > 0.1) { v.x += (v.x / len) * 1.4; v.z += (v.z / len) * 1.4; }
        this.audio.doubleJump();
        this.camera.punch(4);
        this.polish?.sparkle(new BABYLON.Vector3(p.x, p.y + 0.6, p.z));
      } else {
        v.y = 13.2; // 3rd sky leap — highest, with hang-time below
        this.jumpsUsed = 3;
        this.tripleJumpFx = 0.85;
        this.audio.doubleJump();
        this.audio.whoosh();
        this.camera.punch(7);
        this.polish?.sparkle(new BABYLON.Vector3(p.x, p.y + 1.1, p.z));
        this.polish?.sparkle(new BABYLON.Vector3(p.x + 0.5, p.y + 0.8, p.z));
        this.polish?.sparkle(new BABYLON.Vector3(p.x - 0.5, p.y + 0.8, p.z));
      }
      this.jumpBuffer = 0; this.coyote = 0; this.grounded = false;
    }
    if (this.doubleJumpFx > 0) this.doubleJumpFx = Math.max(0, this.doubleJumpFx - dt);
    if (this.tripleJumpFx > 0) this.tripleJumpFx = Math.max(0, this.tripleJumpFx - dt);

    // ---- Sub-stepped integration: wall blocks + ground snap ----
    const wasGrounded = this.grounded;
    let landed = false;
    const steps = Math.max(2, Math.min(12, Math.ceil((Math.abs(v.x) + Math.abs(v.y) + Math.abs(v.z)) * dt / 0.15)));
    const sdt = dt / steps;
    const radius = 0.28;
    for (let i = 0; i < steps; i++) {
      // 3rd-jump hang-time: reduced gravity at the apex for a floaty, cinematic feel.
      const g = this.tripleJumpFx > 0 && v.y > 0 ? GRAVITY * 0.45 : GRAVITY;
      v.y -= g * sdt;
      if (v.y < -32) v.y = -32;
      const nx = p.x + v.x * sdt;
      const nz = p.z + v.z * sdt;
      const ny = p.y + v.y * sdt;

      let cx = p.x, cz = p.z;
      if (this.wallAt(nx, p.z, p.y, radius)) v.x *= 0.15; else cx = nx;
      if (this.wallAt(cx, nz, p.y, radius)) v.z *= 0.15; else cz = nz;

      const surf = this.surfaceAt(cx, cz, p.y);
      // One-way platforms: jumping up through a platform from beneath must NOT
      // snap us onto its top. Two valid land cases remain:
      //   (a) feet were already at/above the surface (falling onto it), or
      //   (b) a small step-up from the ground (e.g. the 0.22 m travelator belt).
      const cameFromAbove = p.y >= surf - 0.08;
      const steppingUp = wasGrounded && surf - p.y <= 0.25;
      if (v.y <= 0 && ny <= surf && (cameFromAbove || steppingUp)) {
        if (!wasGrounded && v.y < -1.5) landed = true;
        p.y = surf; v.y = 0; this.grounded = true;
      } else {
        p.y = Math.max(0, ny);
        if (p.y <= 0) { p.y = 0; v.y = 0; this.grounded = true; }
      }
      p.x = cx; p.z = cz;
    }
    if (p.y < -8) { p.set(2.4, 0, 0); v.set(0, 0, 0); }
    // The playable level ends just past the pixel portal (x=192). Clamp X so
    // the player never walks off into the empty void beyond it.
    if (p.x > 214) { p.x = 214; if (v.x > 0) v.x = 0; }

    this.character.setFlip(0);
    if (landed) { this.audio.land(6); this.character.landingImpact(-8); this.camera.punch(3); }

    // Visual root at the FEET surface, body tilted to the slope with dynamic
    // compensation so the shoes never sink below the inclined plane.
    this.character.setPosition(p.x, p.y, p.z);

    // ---- Facing ----
    // The Mixamo rig faces +Z at rotation 0 (verified visually: at yaw 0 the
    // camera at -Z sees her BACK). atan2(dx,dz) therefore points her exactly
    // along the desired camera-relative travel direction.
    // Lock facing during a slide — the slide animation has hip/root rotation
    // that would otherwise feed back and spin the player in a wide circle.
    if (moveInput && !sliding) this.facing = Math.atan2(dx, dz);

    const crouching = this.input.state.crouch && this.grounded;
    const planSpeed = Math.hypot(v.x, v.z);
    // Hysteresis stops idle/walk flipping back and forth at the threshold,
    // which was restarting the clip mid-stride ("freezing" animation).
    const idleThreshold = this.character.state === 'idle' ? 0.38 : 0.16;
    let state: AnimState;
    let dir: MoveDir = 'idle';
    if (!this.grounded) state = this.tripleJumpFx > 0 ? 'doubleJump' : (this.doubleJumpFx > 0 ? 'doubleJump' : (v.y > 0.6 ? 'jump' : 'fall'));
    else if (onBelt && !moveInput) state = 'idle'; // carried calmly by the belt
    else if (sliding) state = 'slide';
    else if (crouching) state = planSpeed > 0.4 ? 'crouchwalk' : 'crouch';
    else if (planSpeed > idleThreshold) {
      const fx = Math.sin(this.facing), fz = Math.cos(this.facing); // model forward = (sinθ, cosθ)
      const dot = (v.x * fx + v.z * fz) / Math.max(planSpeed, 0.001);
      if (dot > 0.45) { state = running ? 'run' : 'walk'; dir = 'forward'; }
      else if (dot < -0.45) { state = 'walk'; dir = 'back'; }
      else { state = 'walk'; dir = (v.x * right.x + v.z * right.z) > 0 ? 'right' : 'left'; }
    } else state = 'idle';

    this.character.setState(state, v.y, dir);
    this.character.update(dt, planSpeed, this.facing);
    this.character.setSlopeAngle(this.grounded ? this.slopeAngleAt(p.x, p.z, p.y) : 0);
    const stepped = this.audio.updateFootsteps(dt, planSpeed, this.character.getCyclePhase(), !this.grounded, state);
    if (stepped) {
      this.footSide *= -1;
      this.footprints.spawn(p.x, p.z, this.facing, this.footSide);
    }
  }

  private frame() {
    const dt = Math.min(this.engine.getDeltaTime() / 1000, 0.05);
    if (Math.abs(this.input.state.cameraX) > 0.05 || Math.abs(this.input.state.cameraZ) > 0.05) {
      // Right stick → camera ONLY (never ax/az). Snappy rate for responsive turn.
      this.camera.addOrbit(-this.input.state.cameraX * dt * 3.2, -this.input.state.cameraZ * dt * 2.4);
    }
    if (this.mode === 'welcome') {
      this.input.update(dt);
      this.character.setState('idle', 0, 'idle');
      this.character.update(dt, 0, Math.PI / 2); // idle facing screen-right
      this.character.setPosition(0, 0, 0);
      this.camera.update(dt, new BABYLON.Vector3(0, 1.2, 0));
    } else {
      this.updateController(dt);
      this.world.update(dt, this.ppos.x);
      this.camera.update(dt, new BABYLON.Vector3(this.ppos.x, this.ppos.y + 1, this.ppos.z), this.pvel.x * 0.3);
      this.exploreTime += dt;
      if (!this.droneTriggered && this.exploreTime >= 30) {
        this.droneTriggered = true;
        this.drone.trigger(new BABYLON.Vector3(this.ppos.x, this.ppos.y + 1, this.ppos.z));
      }
    }
    const pp = this.mode === 'welcome' ? new BABYLON.Vector3(0, 0, 0) : this.ppos;
    this.footprints.update(dt);
    this.pixelPortal.update(dt, pp);
    this.env.focusSun(pp);
    this.drone.update(dt, pp);
    this.polish.update(dt, pp, pp.y, this.mode === 'explore' && this.pvel.length() > 0.5);
    this.minimap?.update(pp.x, pp.z, this.mode === 'welcome' ? Math.PI / 2 : this.facing);
    this.fpsAcc += dt; this.fpsFrames++;
    if (this.fpsAcc >= 0.5) {
      this.ui.setFps(Math.round(this.fpsFrames / this.fpsAcc));
      this.fpsAcc = 0; this.fpsFrames = 0;
    }
    this.scene.render();
  }
}

new App();
