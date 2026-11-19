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
    this.character.root.rotation.y = Math.PI / 2;
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
    this.loadCows();

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

  /** Background Holstein cows — a small herd placed deep in the level so they
   *  frame the side-scrolling route without ever blocking the player. */
  private async loadCows() {
    try {
      const res = await BABYLON.SceneLoader.ImportMeshAsync('', '/models/cow/', 'cow.glb', this.scene);
      const source = res.meshes.find((m) => m instanceof BABYLON.Mesh && m.getTotalVertices() > 0) as BABYLON.Mesh | undefined;
      if (!source) return;

      // The source is 1 m long (Y-up, head toward +X). Scale to a real cow:
      // ~2.4 m long / ~1.5 m tall / ~0.7 m wide.
      const scale = 2.4;
      const feetOffset = -source.getBoundingInfo().boundingBox.minimum.y * scale;
      const spots = [
        { x: 15, z: 11, face: 0 }, { x: 41, z: 14, face: Math.PI },
        { x: 82, z: 12, face: 0 }, { x: 124, z: 15, face: Math.PI },
        { x: 168, z: 11, face: 0 },
      ];
      source.setEnabled(false); // hide the import origin; instances are the herd
      spots.forEach((s, i) => {
        const cow = source.createInstance(`cow${i}`);
        cow.position.set(s.x, feetOffset, s.z);
        cow.scaling.setAll(scale);
        cow.rotation.y = s.face;
        cow.isPickable = false;
        cow.receiveShadows = true;
        this.env.registerShadowCaster(cow);
      });
    } catch (e) {
      console.warn('[Cow] background herd failed to load:', e);
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
    this.facing = Math.PI / 2;
    this.character.root.rotation.y = Math.PI / 2;
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

    // ---- Camera-relative movement basis ----
    // A/D are always screen-left/right and W/S always into/out of the screen,
    // even after the left stick orbits the camera. This is the standard for a
    // third-person controller (the old world-locked axes broke after orbiting).
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

    // ---- Acceleration & crisp braking (locks to position on release) ----
    // moveTowards gives a linear, predictable stop — no exponential drift.
    const accel = this.grounded ? 30 : 10;
    const step = accel * dt;
    const tx = moveInput ? dx * maxSpeed : 0;
    const tz = moveInput ? dz * maxSpeed : 0;
    v.x += Math.max(-step, Math.min(step, tx - v.x));
    v.z += Math.max(-step, Math.min(step, tz - v.z));
    if (!moveInput) {
      if (Math.abs(v.x) < 0.02) v.x = 0;
      if (Math.abs(v.z) < 0.02) v.z = 0;
    }

    // ---- Single jump (coyote + input buffer) ----
    this.coyote = this.grounded ? 0.12 : Math.max(0, this.coyote - dt);
    this.jumpBuffer = s.jumpPressed ? 0.14 : Math.max(0, this.jumpBuffer - dt);
    if (this.jumpBuffer > 0 && this.coyote > 0) {
      v.y = 8.6;
      this.audio.jump();
      this.jumpBuffer = 0; this.coyote = 0; this.grounded = false;
    }

    // ---- Sub-stepped integration: wall blocks + ground snap ----
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

      let cx = p.x, cz = p.z;
      if (this.wallAt(nx, p.z, p.y, radius)) v.x *= 0.15; else cx = nx;
      if (this.wallAt(cx, nz, p.y, radius)) v.z *= 0.15; else cz = nz;

      const surf = this.surfaceAt(cx, cz, p.y);
      if (v.y <= 0 && ny <= surf) {
        if (!wasGrounded && v.y < -1.5) landed = true;
        p.y = surf; v.y = 0; this.grounded = true;
      } else {
        p.y = Math.max(0, ny);
        if (p.y <= 0) { p.y = 0; v.y = 0; this.grounded = true; }
      }
      p.x = cx; p.z = cz;
    }
    if (p.y < -8) { p.set(2.4, 0, 0); v.set(0, 0, 0); }
    p.x = Math.max(-3, Math.min(198, p.x));
    p.z = Math.max(-3.2, Math.min(3.2, p.z));

    this.character.setFlip(0);
    if (landed) { this.audio.land(6); this.character.landingImpact(-8); this.camera.punch(3); }

    // Visual root sits at the FEET
    this.character.setPosition(p.x, p.y, p.z);

    // ---- Facing ----
    // The Mixamo rig faces +Z at rotation 0 (verified visually: at yaw 0 the
    // camera at -Z sees her BACK). atan2(dx,dz) therefore points her exactly
    // along the desired camera-relative travel direction.
    if (moveInput) this.facing = Math.atan2(dx, dz);

    const crouching = (this.keys.has('ControlLeft') || this.keys.has('KeyC')) && this.grounded;
    const planSpeed = Math.hypot(v.x, v.z);
    // Hysteresis stops idle/walk flipping back and forth at the threshold,
    // which was restarting the clip mid-stride ("freezing" animation).
    const idleThreshold = this.character.state === 'idle' ? 0.38 : 0.16;
    let state: AnimState;
    let dir: MoveDir = 'idle';
    if (!this.grounded) state = v.y > 0.6 ? 'jump' : 'fall';
    else if (crouching) state = 'crouch';
    else if (planSpeed > idleThreshold) {
      const fx = Math.sin(this.facing), fz = Math.cos(this.facing); // model forward = (sinθ, cosθ)
      const dot = (v.x * fx + v.z * fz) / Math.max(planSpeed, 0.001);
      if (dot > 0.45) { state = running ? 'run' : 'walk'; dir = 'forward'; }
      else if (dot < -0.45) { state = 'walk'; dir = 'back'; }
      else { state = 'walk'; dir = (v.x * right.x + v.z * right.z) > 0 ? 'right' : 'left'; }
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
      this.character.update(dt, 0, Math.PI / 2); // idle facing screen-right
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
