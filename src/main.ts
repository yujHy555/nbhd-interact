import * as BABYLON from 'babylonjs';
import 'babylonjs-loaders';
import { Environment } from './core/Environment';
import { Input } from './core/Input';
import { CameraRig } from './core/CameraRig';
import { Character, DEFAULT_COLORS, CharacterColors, AnimState } from './character/Character';
import { Materials } from './world/Materials';
import { World, BoxCollider, Pickup, ZoneMarker } from './world/World';
import { UI } from './ui/UI';

type Mode = 'welcome' | 'explore';

class App {
  private canvas!: HTMLCanvasElement;
  private engine!: BABYLON.Engine;
  private scene!: BABYLON.Scene;
  private env!: Environment;
  private input!: Input;
  private camera!: CameraRig;
  private character!: Character;
  private materials!: Materials;
  private world!: World;
  private ui!: UI;
  private mode: Mode = 'welcome';
  private turntableOn = false;
  private turntableAngle = 0;
  private pos = new BABYLON.Vector3(0, 0.3, 0);
  private vel = new BABYLON.Vector3(0, 0, 0);
  private grounded = true;
  private facing = 1;
  private lastTime = 0;
  private fpsAcc = 0; private fpsFrames = 0;
  private pickupCount = 0;
  private debug = false;
  private keys = new Set<string>();

  constructor() {
    this.canvas = document.getElementById('renderCanvas') as HTMLCanvasElement;
    this.init();
  }

  private async init() {
    // Engine
    this.engine = new BABYLON.Engine(this.canvas, true, { stencil: true, preserveDrawingBuffer: false });
    this.scene = new BABYLON.Scene(this.engine);
    this.scene.clearColor = new BABYLON.Color4(0.11, 0.15, 0.19, 1);
    this.scene.imageProcessingConfiguration.toneMappingEnabled = true;
    this.scene.imageProcessingConfiguration.toneMappingType = BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES;
    this.scene.imageProcessingConfiguration.exposure = 1.15;
    this.scene.imageProcessingConfiguration.contrast = 1.15;

    this.ui = new UI(DEFAULT_COLORS, {
      customize: (c: CharacterColors) => this.character.applyColors(c),
      rotate: (on: boolean) => { this.turntableOn = on; },
      explore: () => this.startExploring(),
    });

    this.ui.setLoading(20);
    this.env = new Environment(this.scene);
    this.ui.setLoading(55);

    this.materials = new Materials(this.scene);
    this.world = new World(this.scene, this.materials);
    this.world.onPickup = (p: Pickup) => {
      this.pickupCount++;
      this.ui.setPickups(this.pickupCount, this.world.pickups.length);
      this.camera.punch(3);
      this.flashPickup(p);
    };
    this.world.onZone = (z: ZoneMarker) => this.enterZone(z);

    this.character = new Character(this.scene);
    for (const m of this.character.getMeshes()) this.env.registerShadowCaster(m);
    this.character.setPosition(0, 0.3, 0);
    this.ui.setLoading(85);

    this.input = new Input();
    this.camera = new CameraRig(this.scene, this.canvas);
    this.camera.snap(new BABYLON.Vector3(0, 1.2, 0));
    this.camera.distance = 13;

    // Debug toggle — visualise colliders (press `~`)
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (e.code === 'Backquote') { this.debug = !this.debug; this.toggleDebug(); }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));

    // Simulate loading then reveal
    await new Promise(r => setTimeout(r, 500));
    this.ui.setLoading(100);
    this.ui.hideLoading();
    this.lastTime = performance.now();
    (window as any).__nbhd = this;
    this.engine.runRenderLoop(() => this.frame());
    window.addEventListener('resize', () => this.engine.resize());
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
    ring.material = new BABYLON.StandardMaterial('pickupRingMat', this.scene);
    (ring.material as BABYLON.StandardMaterial).emissiveColor = new BABYLON.Color3(1, 0.85, 0.3);
    (ring.material as BABYLON.StandardMaterial).disableLighting = true;
    let life = 0.5;
    const obs = this.scene.onBeforeRenderObservable.add(() => {
      life -= this.engine.getDeltaTime() / 1000;
      ring.scaling.setAll(1 + (0.5 - life) * 4);
      ((ring.material as BABYLON.StandardMaterial).alpha = Math.max(0, life * 2));
      if (life <= 0) { this.scene.onBeforeRenderObservable.remove(obs); ring.dispose(); }
    });
  }

  private startExploring() {
    this.mode = 'explore';
    this.turntableOn = false;
    this.pos.set(2.4, this.groundHeight(2.4, 0), 0);
    this.vel.setAll(0);
    this.camera.snap(new BABYLON.Vector3(this.pos.x, this.pos.y, 0));
  }

  private enterZone(z: ZoneMarker) {
    this.ui.setZone(z.name);
  }

  private groundHeight(x: number, z: number): number {
    let best = 0;
    const r = 0.35;
    for (const c of this.world.colliders) {
      if (x > c.x - c.w / 2 - r && x < c.x + c.w / 2 + r &&
          z > c.z - c.d / 2 - r && z < c.z + c.d / 2 + r) {
        best = Math.max(best, c.y + c.h / 2);
      }
    }
    return best;
  }

  private resolveHorizontal(prevX: number) {
    const r = 0.32;
    for (const c of this.world.colliders) {
      const minY = c.y - c.h / 2, maxY = c.y + c.h / 2;
      // Standing ON this box (feet at/above its top) → no horizontal push
      if (this.pos.y >= maxY - 0.12) continue;
      if (this.pos.y > maxY + 0.05 || this.pos.y + 1.7 < minY) continue;
      const minX = c.x - c.w / 2, maxX = c.x + c.w / 2;
      const minZ = c.z - c.d / 2, maxZ = c.z + c.d / 2;
      if (this.pos.z + r > minZ && this.pos.z - r < maxZ &&
          this.pos.x + r > minX && this.pos.x - r < maxX) {
        // Push out along the axis of least penetration
        const dxL = this.pos.x - (minX - r), dxR = (maxX + r) - this.pos.x;
        if (dxL < dxR) this.pos.x = minX - r;
        else this.pos.x = maxX + r;
        this.vel.x = 0;
      }
    }
    void prevX;
  }

  private updateController(dt: number) {
    this.input.update(dt);
    const s = this.input.state;
    const accel = 42, maxSpeed = 5.2, runBoost = this.keys.has('ShiftLeft') ? 1.55 : 1;

    // Horizontal
    if (Math.abs(s.axisX) > 0.05) {
      this.vel.x += s.axisX * accel * dt;
      this.vel.x = BABYLON.Scalar.Clamp(this.vel.x, -maxSpeed * runBoost, maxSpeed * runBoost);
      this.facing = Math.sign(s.axisX);
    } else {
      this.vel.x *= Math.pow(0.0005, dt);
      if (Math.abs(this.vel.x) < 0.02) this.vel.x = 0;
    }

    // Depth (W/S) — shallow, for exploring the 3D space
    if (Math.abs(s.axisZ) > 0.05) {
      this.vel.z += s.axisZ * 18 * dt;
      this.vel.z = BABYLON.Scalar.Clamp(this.vel.z, -2.6, 2.6);
    } else {
      this.vel.z *= Math.pow(0.02, dt);
    }
    this.vel.z = BABYLON.Scalar.Clamp(this.vel.z, -4, 4);
    this.pos.z = BABYLON.Scalar.Clamp(this.pos.z + this.vel.z * dt, -3.2, 3.2);

    // Jump
    if (s.jumpPressed && this.grounded) {
      this.vel.y = 8.2;
      this.grounded = false;
    }

    // Gravity + integration
    const prevX = this.pos.x;
    this.vel.y -= 24 * dt;
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;

    this.resolveHorizontal(prevX);

    const gh = this.groundHeight(this.pos.x, this.pos.z);
    if (this.pos.y <= gh && this.vel.y <= 0) {
      if (!this.grounded && this.vel.y < -4) this.character.landingImpact(this.vel.y);
      this.pos.y = gh;
      this.vel.y = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }

    // Animation state
    const speed = Math.abs(this.vel.x);
    let state: AnimState;
    if (!this.grounded) state = this.vel.y > 0.5 ? 'jump' : 'fall';
    else if (speed > 3.2) state = 'run';
    else if (speed > 0.35) state = 'walk';
    else state = 'idle';
    this.character.setState(state, this.vel.y);
    this.character.update(dt, speed, this.facing);
    this.character.setPosition(this.pos.x, this.pos.y, this.pos.z);
  }

  private frame() {
    const dt = Math.min(this.engine.getDeltaTime() / 1000, 0.05);
    if (this.mode === 'welcome') {
      this.input.update(dt);
      this.character.setState('idle');
      this.character.update(dt, 0, 1);
      // Turntable spin (character rotates with the set)
      if (this.turntableOn) this.turntableAngle += dt * 0.7;
      const tt = this.world.getTurntable();
      if (tt) tt.rotation.y = this.turntableAngle;
      this.character.root.rotation.y = this.turntableAngle;
      this.character.setPosition(0, 0.3, 0);
    } else {
      this.updateController(dt);
    }

    this.world.update(dt, this.pos.x);
    this.camera.update(dt, new BABYLON.Vector3(this.pos.x, this.pos.y, this.pos.z), this.vel.x * 0.35);

    // FPS
    this.fpsAcc += dt; this.fpsFrames++;
    if (this.fpsAcc >= 0.5) {
      this.ui.setFps(Math.round(this.fpsFrames / this.fpsAcc));
      this.fpsAcc = 0; this.fpsFrames = 0;
    }
    this.scene.render();
  }
}

new App();
