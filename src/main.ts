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

  // Havok player
  private playerBody!: BABYLON.PhysicsBody;
  private playerProxy!: BABYLON.Mesh;
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
    // Mixamo pipeline: drop a converted .glb at /models/character.glb to auto-load
    this.mixamo = new MixamoController(this.scene);
    this.mixamo.load('/models/character.glb').then((ok) => {
      if (ok) this.character.bindMixamo(this.mixamo);
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

  /** Capsule physics body for the player — AAA grounded movement via Havok. */
  private buildPlayerPhysics() {
    this.playerProxy = BABYLON.MeshBuilder.CreateCylinder('playerProxy', { diameter: 0.64, height: 1.0, tessellation: 12 }, this.scene);
    this.playerProxy.isVisible = false;
    // Capsule centre must be 0.82 m above the surface (half-height 0.5 + radius 0.32)
    this.playerProxy.position.set(2.4, 0.82, 0);
    const shape = this.havok.capsuleShape(0.32, 1.0);
    this.playerBody = this.havok.dynamicBody(this.playerProxy, shape, { mass: 72, linearDamping: 0.02, angularDamping: 1 });
    // Lock rotation so the capsule never tips over
    this.playerBody.setMassProperties({ ...this.playerBody.computeMassProperties(), inertia: BABYLON.Vector3.Zero(), inertiaOrientation: BABYLON.Quaternion.Identity() });
    (this.playerBody as any).setGravityFactor?.(1);
  }

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
    this.havok.teleport(this.playerBody, new BABYLON.Vector3(2.4, 0.82, 0));
    this.camera.snap(new BABYLON.Vector3(2.4, 0.9, 0));
    this.facing = Math.PI / 2; // face +X (right) — the way we explore
  }

  /** Downward raycast for ground detection (works with Havok static bodies). */
  private checkGround(): boolean {
    const origin = this.playerProxy.position.clone();
    const ray = new BABYLON.Ray(origin, new BABYLON.Vector3(0, -1, 0), 0.9);
    const hit = this.scene.pickWithRay(ray, (m) => m.isEnabled() && (m.name === 'platform' || m.name === 'ramp' || m.name === 'turntable' || m.name === 'ground' || m.name === 'protoCube'));
    return !!(hit && hit.hit && hit.pickedPoint);
  }

  private updateController(dt: number) {
    this.input.update(dt);
    const s = this.input.state;

    const accel = 46;
    const maxSpeed = 3.8 * (this.keys.has('ShiftLeft') ? 1.4 : 1); // tighter, no tunneling
    const v = this.havok.getVelocity(this.playerBody);

    // Desired planar velocity from input
    const desiredX = s.axisX * maxSpeed;
    const desiredZ = s.axisZ * maxSpeed * 0.6;
    let nvx = v.x, nvz = v.z;
    if (Math.abs(s.axisX) > 0.05) nvx += (desiredX - v.x) * Math.min(1, accel * dt / Math.max(maxSpeed, 0.1));
    else nvx *= Math.pow(0.002, dt);
    if (Math.abs(s.axisZ) > 0.05) nvz += (desiredZ - v.z) * Math.min(1, accel * dt / Math.max(maxSpeed, 0.1));
    else nvz *= Math.pow(0.02, dt);

    // NO auto-jump; jump strictly on press. 2 jumps: 2nd is an air FLIP.
    this.coyote = this.grounded ? 0.12 : Math.max(0, this.coyote - dt);
    this.jumpBuffer = s.jumpPressed ? 0.14 : Math.max(0, this.jumpBuffer - dt);
    let nvy = v.y;
    if (this.grounded) this.jumpsUsed = 0;
    if (this.jumpBuffer > 0 && (this.coyote > 0 || (this.jumpsUsed === 1 && !this.grounded))) {
      if (this.coyote > 0 && this.jumpsUsed === 0) {
        nvy = 8.4;
        this.audio.jump();
      } else {
        // Double jump — flip!
        nvy = 7.6;
        this.jumpsUsed = 2;
        this.flipTimer = 0.55;
        this.audio.doubleJump();
        this.audio.flip();
        this.polish?.sparkle(this.playerProxy.position);
      }
      this.jumpBuffer = 0; this.coyote = 0; this.grounded = false;
      if (this.jumpsUsed < 2) this.jumpsUsed = 1;
    }
    // Flip rotation
    if (this.flipTimer > 0) {
      this.flipTimer = Math.max(0, this.flipTimer - dt);
      this.character.root.rotation.x = (1 - this.flipTimer / 0.55) * Math.PI * 2;
      this.character.setState('flip', nvy);
    } else if (this.character.root.rotation.x !== 0) {
      this.character.root.rotation.x *= Math.pow(0.001, dt);
    }

    this.havok.setVelocity(this.playerBody, new BABYLON.Vector3(nvx, nvy, nvz));

    // Keep within world bounds
    const p = this.playerProxy.position;
    if (p.x < -3) { p.x = -3; }
    if (p.x > 198) { p.x = 198; }
    if (p.y < -6) { this.havok.teleport(this.playerBody, new BABYLON.Vector3(2.4, 1.0, 0)); }

    // Ground check — use the NEW vertical velocity (not stale pre-jump v)
    const wasGrounded = this.grounded;
    this.grounded = this.checkGround() && nvy <= 0.4;
    if (this.grounded && !wasGrounded && v.y < -1.5) {
      this.audio.land(Math.abs(v.y));
      this.character.landingImpact(v.y);
    }

    // Crouch when holding Ctrl / C while grounded
    const crouching = (this.keys.has('ControlLeft') || this.keys.has('KeyC')) && this.grounded;

    // Sync visual character to physics capsule. Feet extend ~0.12 below the
    // character root, so lift it to keep shoes on the ground surface.
    this.character.setPosition(p.x, p.y - 0.58, p.z);

    // Heading from movement direction (character faces -Z at heading 0)
    let targetHeading = this.facing;
    if (Math.abs(s.axisX) > 0.1 || Math.abs(s.axisZ) > 0.1) {
      targetHeading = Math.atan2(-s.axisX, -s.axisZ);
      this.facing = targetHeading;
    }

    // Determine animation + directional variant
    const planSpeed = Math.hypot(nvx, nvz);
    const vertical = nvy;
    let state: AnimState;
    let dir: MoveDir = 'idle';
    if (!this.grounded) state = vertical > 0.8 ? 'jump' : 'fall';
    else if (crouching) { state = 'crouch'; this.audio.crouch(); }
    else if (planSpeed > 0.3) {
      // Direction relative to heading
      const facingX = -Math.sin(this.facing), facingZ = -Math.cos(this.facing);
      const dot = (nvx * facingX + nvz * facingZ) / Math.max(planSpeed, 0.001);
      if (dot > 0.55) { state = planSpeed > 3.0 ? 'run' : 'walk'; dir = 'forward'; }
      else if (dot < -0.55) { state = 'walk'; dir = 'back'; }
      else { state = 'strafe'; dir = nvx > 0 ? 'right' : 'left'; }
    } else state = 'idle';

    this.character.setState(state, vertical, dir);
    this.character.update(dt, planSpeed, this.facing);
    // Footsteps perfectly synced to the animation cycle
    this.audio.updateFootsteps(dt, planSpeed, this.character.getCyclePhase(), !this.grounded, state);
  }

  private frame() {
    const dt = Math.min(this.engine.getDeltaTime() / 1000, 0.05);
    // Explicit Havok step (kept deterministic & in sync with gameplay)
    // Gamepad left stick orbits the camera (clamped — never through the ground)
    if (Math.abs(this.input.state.cameraX) > 0.05 || Math.abs(this.input.state.cameraZ) > 0.05) {
      this.camera.addOrbit(-this.input.state.cameraX * dt * 1.6, -this.input.state.cameraZ * dt * 1.2);
    }
    // Sub-stepped physics (3× per frame) — super tight collisions, no tunneling
    if (this.mode === 'explore') {
      const sub = Math.min(dt, 1 / 30) / 3;
      const pe = this.scene.getPhysicsEngine();
      for (let i = 0; i < 3; i++) pe?._step(sub);
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
      this.camera.update(dt, new BABYLON.Vector3(p.x, p.y - 0.4, p.z), this.havok.getVelocity(this.playerBody).x * 0.3);
    }

    // AAA polish — contact shadow + rim light follow the hero
    const pp = this.mode === 'welcome' ? new BABYLON.Vector3(0, 0.3, 0) : this.playerProxy.position;
    this.polish.update(dt, pp, pp.y - (this.mode === 'welcome' ? 0.3 : 0.7),
      this.mode === 'explore' && this.havok.getVelocity(this.playerBody).length() > 0.5);

    this.fpsAcc += dt; this.fpsFrames++;
    if (this.fpsAcc >= 0.5) {
      this.ui.setFps(Math.round(this.fpsFrames / this.fpsAcc));
      this.fpsAcc = 0; this.fpsFrames = 0;
    }
    this.scene.render();
  }
}

new App();
