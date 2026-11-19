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
import { World, Pickup, ZoneMarker } from './world/World';
import { UI } from './ui/UI';

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
  private polish!: Polish;
  private audio!: GameAudio;
  private materials!: Materials;
  private world!: World;
  private ui!: UI;
  private mode: Mode = 'welcome';
  private facing = -Math.PI / 2; // screen-right (+X) at start
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

    this.ui = new UI(DEFAULT_COLORS, { explore: () => this.startExploring() });
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

    this.character = new Character(this.scene);
    // Face screen-right from the very first frame (idle at start)
    this.character.root.rotation.y = -Math.PI / 2;
    this.mixamo = new MixamoController(this.scene);
    this.mixamo.load('/models/', 'BlobothanChar.glb').then((ok) => {
      if (ok) {
        this.character.bindMixamo(this.mixamo);
        for (const m of this.mixamo.root.getChildMeshes(false)) {
          if (m instanceof BABYLON.Mesh) this.env.registerShadowCaster(m);
        }
      }
    });
    for (const m of this.character.getMeshes()) this.env.registerShadowCaster(m);
    this.enableShadowReceivers();

    this.input = new Input();
    this.camera = new CameraRig(this.scene, this.canvas);
    this.polish = new Polish(this.scene, this.camera.getCamera());
    const arc = this.camera.getCamera() as BABYLON.ArcRotateCamera;
    arc.lowerBetaLimit = 0.25;
    arc.upperBetaLimit = 1.42;
    arc.lowerRadiusLimit = 6;
    arc.upperRadiusLimit = 26;
    arc.panningSensibility = 0;
    this.camera.snap(new BABYLON.Vector3(0, 1.2, 0));

    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (e.code === 'Backquote') { this.debug = !this.debug; this.toggleDebug(); }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));

    this.ui.setLoading(85);
    await new Promise((r) => setTimeout(r, 400));
    this.ui.setLoading(100);
    this.ui.hideLoading();
    (window as any).__nbhd = this;
    this.lastTime = performance.now();
    this.engine.runRenderLoop(() => this.frame());
    window.addEventListener('resize', () => this.engine.resize());
  }

  private enableShadowReceivers() {
    for (const m of this.scene.meshes) {
      if (m.name === 'skyBox') continue;
      if (m.name === 'platform' || m.name === 'ramp' || m.name === 'platEdge' ||
          m.name === 'protoCube' || m.name.startsWith('zone') || m.name.includes('Ball') ||
          m.name.includes('BallPedestal') || m.name === 'macbethChart' || m.name === 'macbethFrame' ||
          m.name === 'ground' || m.name.startsWith('grid')) {
        m.receiveShadows = true;
        if (m.name === 'platform' || m.name === 'ramp' || m.name === 'protoCube') {
          this.env.registerShadowCaster(m as BABYLON.Mesh);
        }
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

  private startExploring() {
    this.mode = 'explore';
    this.ppos.set(2.4, 0, 0);
    this.pvel.set(0, 0, 0);
    this.grounded = true;
    this.facing = -Math.PI / 2;
    this.character.root.rotation.y = -Math.PI / 2;
    this.camera.snap(new BABYLON.Vector3(2.4, 1, 0));
  }

  /** Highest solid surface at (x,z) at or just below the feet (feet-relative). */
  private surfaceAt(x: number, z: number, feetY: number): number {
    let best = 0; // ground plane
    const R = 0.24;
    for (const c of this.world.colliders) {
      const top = c.y + c.h / 2;
      if (top > feetY + 0.4 || top <= best) continue;
      if (x > c.x - c.w / 2 - R && x < c.x + c.w / 2 + R &&
          z > c.z - c.d / 2 - R && z < c.z + c.d / 2 + R) {
        best = top;
      }
    }
    return best;
  }

  /** Solid box overlapping the player's body → horizontal move blocked. */
  private wallAt(x: number, z: number, feetY: number, radius: number): boolean {
    for (const c of this.world.colliders) {
      const top = c.y + c.h / 2, bot = c.y - c.h / 2;
      if (feetY >= top - 0.08 || feetY + 1.75 <= bot) continue; // above/below
      if (x + radius > c.x - c.w / 2 && x - radius < c.x + c.w / 2 &&
          z + radius > c.z - c.d / 2 && z - radius < c.z + c.d / 2) return true;
    }
    return false;
  }

  private updateController(dt: number) {
    this.input.update(dt);
    const s = this.input.state;
    const v = this.pvel, p = this.ppos;
    const GRAVITY = 22;
    const walking = s.axisX !== 0 || s.axisZ !== 0;
    const running = walking && (s.run || this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'));
    const maxSpeed = (running ? 6.2 : walking ? 3.0 : 0) * 1;

    // ---- Planar movement (camera-relative: A/D world X, W/S depth) ----
    const ax = s.axisX, az = s.axisZ;
    const accel = this.grounded ? 20 : 10;
    if (Math.abs(ax) > 0.05) v.x += (ax * maxSpeed - v.x) * Math.min(1, accel * dt);
    else v.x *= Math.pow(0.001, dt);
    if (Math.abs(az) > 0.05) v.z += (az * maxSpeed * 0.7 - v.z) * Math.min(1, accel * dt);
    else v.z *= Math.pow(0.02, dt);

    // ---- SINGLE JUMP (coyote + buffer) ----
    this.coyote = this.grounded ? 0.12 : Math.max(0, this.coyote - dt);
    this.jumpBuffer = s.jumpPressed ? 0.14 : Math.max(0, this.jumpBuffer - dt);
    if (this.jumpBuffer > 0 && this.coyote > 0) {
      v.y = 8.6;
      this.audio.jump();
      this.jumpBuffer = 0; this.coyote = 0; this.grounded = false;
    }

    // ---- Sub-stepped integration: ground snap + wall blocks ----
    const wasGrounded = this.grounded;
    let landed = false;
    const steps = Math.max(2, Math.min(12, Math.ceil((Math.abs(v.x) + Math.abs(v.y) + Math.abs(v.z)) * dt / 0.15)));
    const sdt = dt / steps;
    const radius = 0.28;
    for (let i = 0; i < steps; i++) {
      v.y -= GRAVITY * sdt;
      if (v.y < -32) v.y = -32;
      const nx = p.x + v.x * sdt;
      const nz = p.z + v.z * sdt;
      const ny = p.y + v.y * sdt;

      // Horizontal collision FIRST — applies while grounded too (the old code
      // let the landing branch teleport p.x/p.z past platform walls).
      let cx = p.x, cz = p.z;
      if (this.wallAt(nx, p.z, p.y, radius)) v.x *= 0.15;
      else cx = nx;
      if (this.wallAt(cx, nz, p.y, radius)) v.z *= 0.15;
      else cz = nz;

      // Landing: only while descending, snap feet to the highest surface below
      const surf = this.surfaceAt(cx, cz, p.y);
      if (v.y <= 0 && ny <= surf) {
        if (!wasGrounded && v.y < -1.5) landed = true;
        p.y = surf;
        v.y = 0; this.grounded = true;
      } else {
        // Ground clamp (never below floor)
        p.y = Math.max(0, ny);
        if (p.y <= 0) { p.y = 0; v.y = 0; this.grounded = true; }
      }
      p.x = cx; p.z = cz;
    }
    // Safety
    if (p.y < -8) { p.set(2.4, 0, 0); v.set(0, 0, 0); }
    p.x = Math.max(-3, Math.min(198, p.x));
    p.z = Math.max(-3.2, Math.min(3.2, p.z));

    // Reset flip (single jump only)
    this.character.setFlip(0);

    // Landing feedback
    if (landed) { this.audio.land(6); this.character.landingImpact(-8); this.camera.punch(3); }

    // Sync visual — root at FEET, so shoes sit exactly on the surface
    this.character.setPosition(p.x, p.y, p.z);

    // Facing: +X is screen-right (confirmed via camera view matrix)
    if (Math.abs(s.axisX) > 0.1 || Math.abs(s.axisZ) > 0.1) {
      this.facing = Math.atan2(-s.axisX, -s.axisZ);
    }

    const crouching = (this.keys.has('ControlLeft') || this.keys.has('KeyC')) && this.grounded;
    const planSpeed = Math.hypot(v.x, v.z);
    let state: AnimState;
    let dir: MoveDir = 'idle';
    if (!this.grounded) state = v.y > 0.8 ? 'jump' : 'fall';
    else if (crouching) state = 'crouch';
    else if (planSpeed > 0.25) {
      const fx = -Math.sin(this.facing), fz = -Math.cos(this.facing);
      const dot = (v.x * fx + v.z * fz) / Math.max(planSpeed, 0.001);
      if (dot > 0.5) { state = running ? 'run' : 'walk'; dir = 'forward'; }
      else if (dot < -0.5) { state = 'walk'; dir = 'back'; }
      else { state = 'strafe'; dir = v.x > 0 ? 'right' : 'left'; }
    } else state = 'idle';

    this.character.setState(state, v.y, dir);
    this.character.update(dt, planSpeed, this.facing);
    this.audio.updateFootsteps(dt, planSpeed, this.character.getCyclePhase(), !this.grounded, state);
  }

  private frame() {
    const dt = Math.min(this.engine.getDeltaTime() / 1000, 0.05);
    if (Math.abs(this.input.state.cameraX) > 0.05 || Math.abs(this.input.state.cameraZ) > 0.05) {
      this.camera.addOrbit(-this.input.state.cameraX * dt * 1.6, -this.input.state.cameraZ * dt * 1.2);
    }
    if (this.mode === 'welcome') {
      this.input.update(dt);
      this.character.setState('idle', 0, 'idle');
      this.character.update(dt, 0, -Math.PI / 2); // idle facing screen-right
      this.character.setPosition(0, 0, 0);
      this.camera.update(dt, new BABYLON.Vector3(0, 1.2, 0));
    } else {
      this.updateController(dt);
      this.world.update(dt, this.ppos.x);
      this.camera.update(dt, new BABYLON.Vector3(this.ppos.x, this.ppos.y + 1, this.ppos.z), this.pvel.x * 0.3);
    }
    const pp = this.mode === 'welcome' ? new BABYLON.Vector3(0, 0, 0) : this.ppos;
    this.polish.update(dt, pp, pp.y, this.mode === 'explore' && this.pvel.length() > 0.5);
    this.fpsAcc += dt; this.fpsFrames++;
    if (this.fpsAcc >= 0.5) {
      this.ui.setFps(Math.round(this.fpsFrames / this.fpsAcc));
      this.fpsAcc = 0; this.fpsFrames = 0;
    }
    this.scene.render();
  }
}

new App();
