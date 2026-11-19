import * as BABYLON from 'babylonjs';
import 'babylonjs-loaders';
import { Environment } from './core/Environment';
import { HavokWorld } from './core/HavokWorld';
import { Input } from './core/Input';
import { CameraRig } from './core/CameraRig';
import { Character, DEFAULT_COLORS, CharacterColors, AnimState, MoveDir } from './character/Character';
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
  private jumpsUsed = 0;
  private flipTimer = 0;
  private materials!: Materials;
  private world!: World;
  private ui!: UI;
  private mode: Mode = 'welcome';
  private turntableOn = false;
  private turntableAngle = 0;
  private facing = 0;           // heading in radians (0 = -Z forward)
  private lastTime = 0;
  private fpsAcc = 0; private fpsFrames = 0;
  private pickupCount = 0;
  private debug = false;
  private keys = new Set<string>();

  // Deterministic kinematic player (single source of truth — no Havok fights)
  private playerProxy!: BABYLON.Mesh; // visual-only transform the rest reads
  private ppos: BABYLON.Vector3 = new BABYLON.Vector3(0, 0, 0); // feet position
  private pvel: BABYLON.Vector3 = new BABYLON.Vector3(0, 0, 0);
  private grounded = false;
  private coyote = 0;
  private jumpBuffer = 0;

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
    // Neutral exposure + punchier contrast preserves the HDRI's colors under ACES
    this.scene.imageProcessingConfiguration.exposure = 1.0;
    this.scene.imageProcessingConfiguration.contrast = 1.28;

    this.audio = new GameAudio();
    window.addEventListener('pointerdown', () => this.audio.unlock(), { once: true });
    window.addEventListener('keydown', () => this.audio.unlock(), { once: true });

    this.ui = new UI(DEFAULT_COLORS, {
      customize: (c: CharacterColors) => this.character.applyColors(c),
      rotate: (on: boolean) => { this.turntableOn = on; },
      explore: () => this.startExploring(),
    });

    this.ui.setLoading(12);

    // ---- Havok physics ----
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
    // Mixamo pipeline: ONE skinned character with 4 shared-skeleton clips
    this.mixamo = new MixamoController(this.scene);
    this.mixamo.load('/models/', 'BlobothanChar.glb').then((ok) => {
      if (ok) {
        this.character.bindMixamo(this.mixamo);
        // Real accurate cast shadow from the skinned hero mesh
        for (const m of this.mixamo.root.getChildMeshes(false)) {
          if (m instanceof BABYLON.Mesh) this.env.registerShadowCaster(m);
        }
      }
    });
    for (const m of this.character.getMeshes()) this.env.registerShadowCaster(m);
    this.character.setPosition(0, 0.3, 0);

    // ---- Havok static colliders for every platform/ramp ----
    this.buildPhysicsColliders();
    // ---- Havok dynamic player capsule ----
    this.buildPlayerPhysics();

    // ---- All surfaces receive shadows ----
    this.enableShadowReceivers();

    this.ui.setLoading(85);

    this.input = new Input();
    this.camera = new CameraRig(this.scene, this.canvas);
    // TRIPLE-AAA polish layer (post-FX, atmosphere, rim light, contact shadow)
    this.polish = new Polish(this.scene, this.camera.getCamera());
    // Restrict camera so it can never rotate under the ground
    const arc = this.camera.getCamera() as BABYLON.ArcRotateCamera;
    arc.lowerBetaLimit = 0.25;      // never directly overhead
    arc.upperBetaLimit = 1.42;      // never below the horizon / through ground
    arc.lowerRadiusLimit = 6;
    arc.upperRadiusLimit = 26;
    arc.panningSensibility = 0;     // disable panning through geometry
    this.camera.snap(new BABYLON.Vector3(0, 1.2, 0));

    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (e.code === 'Backquote') { this.debug = !this.debug; this.toggleDebug(); }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));

    await new Promise(r => setTimeout(r, 400));
    this.ui.setLoading(100);
    this.ui.hideLoading();
    (window as any).__nbhd = this;
    this.lastTime = performance.now();
    this.engine.runRenderLoop(() => this.frame());
    window.addEventListener('resize', () => this.engine.resize());
  }

  /** Static Havok bodies from the world's box colliders. */
  private buildPhysicsColliders() {
    // Ground plane as a thin static box (the visual ground is infinite-ish)
    const groundBody = BABYLON.MeshBuilder.CreateBox('physGround', { width: 400, height: 0.5, depth: 80 }, this.scene);
    groundBody.position.set(90, -0.25, 0);
    groundBody.isVisible = false;
    this.havok.staticBody(groundBody, this.havok.boxShape(400, 0.5, 80));
    for (const c of this.world.colliders) {
      const proxy = BABYLON.MeshBuilder.CreateBox('physProxy', { width: c.w, height: c.h, depth: c.d }, this.scene);
      proxy.position.set(c.x, c.y, c.z);
      proxy.isVisible = false;
      const body = this.havok.staticBody(proxy, this.havok.boxShape(c.w, c.h, c.d));
      void body;
    }
  }

  /** Kinematic player transform (deterministic controller owns ppos/pvel). */
  private buildPlayerPhysics() {
    this.playerProxy = new BABYLON.TransformNode('playerProxy', this.scene) as any;
    this.ppos.set(2.4, 0, 0);
    this.pvel.set(0, 0, 0);
    this.syncProxy();
  }
  private syncProxy() { this.playerProxy.position.set(this.ppos.x, this.ppos.y, this.ppos.z); }

  /** Register every platform / surface mesh as a shadow receiver. */
  private enableShadowReceivers() {
    for (const m of this.scene.meshes) {
      if (m === this.playerProxy || m.name.startsWith('physProxy') || m.name === 'skyBox') continue;
      // Every solid surface receives shadows
      if (m.name === 'platform' || m.name === 'ramp' || m.name === 'turntable' || m.name === 'platEdge' ||
          m.name === 'protoCube' || m.name.startsWith('zone') || m.name.includes('Ball') ||
          m.name.includes('BallPedestal') || m.name === 'macbethChart' || m.name === 'macbethFrame' ||
          m.name === 'ground' || m.name === 'gridLine' || m.name === 'gridLineZ') {
        m.receiveShadows = true;
        if (m.name === 'platform' || m.name === 'ramp' || m.name === 'turntable' || m.name === 'protoCube') {
          this.env.registerShadowCaster(m as BABYLON.Mesh);
        }
      }
    }
    this.env.ground.receiveShadows = true;
  }

  private debugMeshes: BABYLON.Mesh[] = [];
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
    (ring.material as BABYLON.Material)?.dispose?.();
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
    this.turntableOn = false;
    this.ppos.set(2.4, 0, 0);
    this.pvel.set(0, 0, 0);
    this.syncProxy();
    this.camera.snap(new BABYLON.Vector3(2.4, 0.9, 0));
    this.facing = Math.PI / 2; // face +X (right) — the way we explore
  }

  /** Highest solid surface directly beneath the player's feet. */
  private surfaceUnder(x: number, z: number, feetY: number): number {
    let best = 0; // ground
    const R = 0.28;
    for (const c of this.world.colliders) {
      const top = c.y + c.h / 2;
      if (top > feetY + 0.28) continue; // above the feet → not standable from here
      if (x > c.x - c.w / 2 - R && x < c.x + c.w / 2 + R &&
          z > c.z - c.d / 2 - R && z < c.z + c.d / 2 + R) {
        if (top > best) best = top;
      }
    }
    return best;
  }

  private updateController(dt: number) {
    this.input.update(dt);
    const s = this.input.state;
    const GRAVITY = 22;
    const MAX = 4.2 * (this.keys.has('ShiftLeft') ? 1.4 : 1);
    const v = this.pvel;
    const p = this.ppos;

    // ---- Horizontal movement (snappy, all directions) ----
    const ax = s.axisX, az = s.axisZ;
    if (Math.abs(ax) > 0.05) v.x += (ax * MAX - v.x) * Math.min(1, dt * 18);
    else v.x *= Math.pow(0.0008, dt);
    if (Math.abs(az) > 0.05) v.z += (az * MAX * 0.6 - v.z) * Math.min(1, dt * 18);
    else v.z *= Math.pow(0.02, dt);

    // ---- Jump (explicit press only; coyote + buffer). Double jump = flip ----
    this.coyote = this.grounded ? 0.12 : Math.max(0, this.coyote - dt);
    this.jumpBuffer = s.jumpPressed ? 0.14 : Math.max(0, this.jumpBuffer - dt);
    if (this.grounded) this.jumpsUsed = 0;
    let jumped = false;
    if (this.jumpBuffer > 0 && (this.coyote > 0 || (!this.grounded && this.jumpsUsed === 1))) {
      if (this.coyote > 0 && this.jumpsUsed === 0) {
        v.y = 8.6;
        this.audio.jump();
      } else {
        v.y = 7.8;
        this.jumpsUsed = 2;
        this.flipTimer = 0.5;
        this.audio.doubleJump(); this.audio.flip();
        this.polish?.sparkle(new BABYLON.Vector3(p.x, p.y + 1, p.z));
      }
      this.jumpBuffer = 0; this.coyote = 0; this.grounded = false;
      if (this.jumpsUsed < 2) this.jumpsUsed = 1;
      jumped = true;
    }

    // ---- Sub-stepped integration (tight, no tunneling) ----
    const wasGrounded = this.grounded;
    let landed = false;
    const steps = Math.max(2, Math.min(10, Math.ceil((Math.abs(v.x) + Math.abs(v.y) + Math.abs(v.z)) * dt / 0.18)));
    const sdt = dt / steps;
    const radius = 0.3;
    for (let i = 0; i < steps; i++) {
      v.y -= GRAVITY * sdt;
      if (v.y < -30) v.y = -30;
      const nextX = p.x + v.x * sdt;
      const nextZ = p.z + v.z * sdt;
      const nextY = p.y + v.y * sdt;

      // Ground / platform landing: only when descending
      const surf = this.surfaceUnder(nextX, nextZ, p.y);
      if (v.y <= 0 && nextY <= surf) {
        p.y = surf;
        p.x = nextX; p.z = nextZ;
        if (!wasGrounded && v.y < -1.5) landed = true;
        v.y = 0;
        this.grounded = true;
        break;
      }

      // Horizontal wall collision: resolve against boxes overlapping our height
      let blocked = false;
      for (const c of this.world.colliders) {
        const top = c.y + c.h / 2, bot = c.y - c.h / 2;
        if (p.y >= top - 0.05 || p.y + 1.7 <= bot) continue;
        if (nextX + radius > c.x - c.w / 2 && nextX - radius < c.x + c.w / 2 &&
            nextZ + radius > c.z - c.d / 2 && nextZ - radius < c.z + c.d / 2) {
          blocked = true; break;
        }
      }
      if (!blocked) { p.x = nextX; p.z = nextZ; }
      else { v.x *= 0.2; v.z *= 0.2; }
      p.y = Math.max(nextY, 0);
      if (p.y <= 0) { p.y = 0; v.y = 0; this.grounded = true; }
    }

    // Fell into the void (safety)
    if (p.y < -8) { p.set(2.4, 0, 0); v.set(0, 0, 0); }

    // ---- Flip about the waist pivot ----
    if (this.flipTimer > 0) {
      this.flipTimer = Math.max(0, this.flipTimer - dt);
      this.character.setFlip((1 - this.flipTimer / 0.5) * Math.PI * 2);
    } else if (this.character.getFlip() !== 0) {
      const f = this.character.getFlip() * Math.pow(0.0005, dt);
      this.character.setFlip(Math.abs(f) < 0.01 ? 0 : f);
    }

    // Landing feedback (once)
    if (landed) { this.audio.land(Math.abs(v.y) + 4); this.character.landingImpact(-8); this.camera.punch(3); }

    // ---- Sync visuals ----
    this.syncProxy();
    this.character.setPosition(p.x, p.y, p.z);

    // Heading from movement direction
    if (Math.abs(s.axisX) > 0.1 || Math.abs(s.axisZ) > 0.1) {
      this.facing = Math.atan2(-s.axisX, -s.axisZ);
    }

    const crouching = (this.keys.has('ControlLeft') || this.keys.has('KeyC')) && this.grounded;
    const planSpeed = Math.hypot(v.x, v.z);
    let state: AnimState;
    let dir: MoveDir = 'idle';
    if (!this.grounded) state = this.flipTimer > 0 ? 'flip' : (v.y > 0.8 ? 'jump' : 'fall');
    else if (crouching) { state = 'crouch'; }
    else if (planSpeed > 0.3) {
      const fx = -Math.sin(this.facing), fz = -Math.cos(this.facing);
      const dot = (v.x * fx + v.z * fz) / Math.max(planSpeed, 0.001);
      if (dot > 0.55) { state = planSpeed > 2.6 ? 'run' : 'walk'; dir = 'forward'; }
      else if (dot < -0.55) { state = 'walk'; dir = 'back'; }
      else { state = 'strafe'; dir = v.x > 0 ? 'right' : 'left'; }
    } else state = 'idle';

    this.character.setState(state, v.y, dir);
    this.character.update(dt, planSpeed, this.facing);
    this.audio.updateFootsteps(dt, planSpeed, this.character.getCyclePhase(), !this.grounded, state);
  }

  private frame() {
    const dt = Math.min(this.engine.getDeltaTime() / 1000, 0.05);
    // Explicit Havok step (kept deterministic & in sync with gameplay)
    // Gamepad left stick orbits the camera (clamped — never through the ground)
    if (Math.abs(this.input.state.cameraX) > 0.05 || Math.abs(this.input.state.cameraZ) > 0.05) {
      this.camera.addOrbit(-this.input.state.cameraX * dt * 1.6, -this.input.state.cameraZ * dt * 1.2);
    }

    if (this.mode === 'welcome') {
      this.input.update(dt);
      this.character.setState('idle', 0, 'idle');
      this.character.update(dt, 0, this.turntableAngle);
      if (this.turntableOn) this.turntableAngle += dt * 0.7;
      const tt = this.world.getTurntable();
      if (tt) tt.rotation.y = this.turntableAngle;
      this.character.root.rotation.y = this.turntableAngle;
      this.character.setPosition(0, 0.42, 0); // turntable top 0.3 + 0.12 foot clearance
      this.camera.update(dt, new BABYLON.Vector3(0, 1.2, 0));
    } else {
      this.updateController(dt);
      const p = this.playerProxy.position;
      this.world.update(dt, p.x);
      this.camera.update(dt, new BABYLON.Vector3(p.x, p.y + 1, p.z), this.pvel.x * 0.3);
    }

    // AAA polish — rim light follows the hero (real cast shadow via ShadowGenerator)
    const pp = this.mode === 'welcome' ? new BABYLON.Vector3(0, 0, 0) : this.ppos;
    this.polish.update(dt, pp, pp.y,
      this.mode === 'explore' && this.pvel.length() > 0.5);

    this.fpsAcc += dt; this.fpsFrames++;
    if (this.fpsAcc >= 0.5) {
      this.ui.setFps(Math.round(this.fpsFrames / this.fpsAcc));
      this.fpsAcc = 0; this.fpsFrames = 0;
    }
    this.scene.render();
  }
}

new App();
