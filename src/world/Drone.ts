import * as BABYLON from 'babylonjs';

/**
 * Cinematic scan drone — a one-shot encounter that arrives 30 s into the
 * level, sweeps the player with a red holographic emission-cone, then departs
 * and removes itself completely from the scene.
 *
 * Showcases Babylon.js emission: a custom ShaderMaterial scan beam with
 * animated scanlines/fresnel, pulsing emissive LEDs and a GlowLayer.
 */

// ---- Emission shader for the scan cone ------------------------------------
BABYLON.Effect.ShadersStore['droneScanVertexShader'] = `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
uniform mat4 worldViewProjection;
uniform mat4 world;
varying vec2 vUV;
varying vec3 vNormalW;
varying vec3 vPosW;
void main(void) {
  vUV = uv;
  vNormalW = normalize(vec3(world * vec4(normal, 0.0)));
  vec4 wp = world * vec4(position, 1.0);
  vPosW = wp.xyz;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}`;

BABYLON.Effect.ShadersStore['droneScanFragmentShader'] = `
precision highp float;
varying vec2 vUV;
varying vec3 vNormalW;
varying vec3 vPosW;
uniform float time;
uniform float strength;
uniform vec3 beamColor;
void main(void) {
  // Vertical scan bands that travel down the cone
  float bands = sin(vUV.y * 46.0 - time * 9.0) * 0.5 + 0.5;
  bands = pow(bands, 3.0);
  // Fine moving scanlines
  float lines = sin(vUV.x * 80.0 + time * 4.0) * 0.5 + 0.5;
  // Fresnel edge glow makes the cone silhouette pop
  vec3 viewDir = normalize(cameraPosition - vPosW);
  float fres = pow(1.0 - abs(dot(normalize(vNormalW), viewDir)), 2.2);
  // Fade toward the base so it melts into the floor
  float fade = smoothstep(0.0, 0.28, vUV.y) * (1.0 - smoothstep(0.86, 1.0, vUV.y));
  float pulse = 0.78 + 0.22 * sin(time * 6.0);
  float a = (0.14 + bands * 0.42 + fres * 0.55 + lines * 0.08) * fade * strength * pulse;
  vec3 c = beamColor * (0.75 + bands * 0.9 + fres * 1.5);
  gl_FragColor = vec4(c, clamp(a, 0.0, 1.0));
}`;

type Phase = 'dormant' | 'arrive' | 'hover' | 'scan' | 'depart' | 'done';

export class Drone {
  private scene: BABYLON.Scene;
  private root: BABYLON.TransformNode;
  private body!: BABYLON.Mesh;
  private rotors: BABYLON.Mesh[] = [];
  private leds: BABYLON.Mesh[] = [];
  private cpuLeds: { mesh: BABYLON.Mesh; mat: BABYLON.StandardMaterial; phase: number; freq: number; hex: string }[] = [];
  private ledMat!: BABYLON.StandardMaterial;
  private coreMat!: BABYLON.StandardMaterial;
  private cone!: BABYLON.Mesh;
  private scanMat!: BABYLON.ShaderMaterial;
  private ring!: BABYLON.Mesh;
  private ringMat!: BABYLON.StandardMaterial;
  private halo!: BABYLON.Mesh;
  private haloMat!: BABYLON.StandardMaterial;
  private glow: BABYLON.GlowLayer;
  private phase: Phase = 'dormant';
  private phaseT = 0;
  private time = 0;
  private startPos = BABYLON.Vector3.Zero();
  private hoverPos = BABYLON.Vector3.Zero();
  private target = BABYLON.Vector3.Zero();
  private bank = 0;
  private disposed = false;
  private onCue?: () => void;

  constructor(scene: BABYLON.Scene, onCue?: () => void) {
    this.scene = scene;
    this.onCue = onCue;
    this.root = new BABYLON.TransformNode('scanDrone', scene);
    this.root.setEnabled(false);
    this.glow = new BABYLON.GlowLayer('droneGlow', scene, { blurKernelSize: 48, mainTextureFixedSize: 512 });
    this.glow.intensity = 1.15;
    this.build();
  }

  private emissive(name: string, hex: string) {
    const m = new BABYLON.StandardMaterial(name, this.scene);
    const c = BABYLON.Color3.FromHexString(hex);
    m.diffuseColor = BABYLON.Color3.Black();
    m.specularColor = BABYLON.Color3.Black();
    m.emissiveColor = c;
    m.disableLighting = true;
    return m;
  }

  private build() {
    // Chassis — dark metallic PBR
    const shell = new BABYLON.PBRMaterial('droneShell', this.scene);
    shell.albedoColor = new BABYLON.Color3(0.055, 0.065, 0.075);
    shell.metallic = 0.9; shell.roughness = 0.3;
    shell.environmentIntensity = 1.1;

    this.body = BABYLON.MeshBuilder.CreateCylinder('droneBody', { diameterTop: 1.25, diameterBottom: 0.95, height: 0.34, tessellation: 6 }, this.scene);
    this.body.material = shell;
    this.body.parent = this.root;
    this.glow.addExcludedMesh(this.body);

    const canopy = BABYLON.MeshBuilder.CreateSphere('droneCanopy', { diameter: 0.72, segments: 20 }, this.scene);
    canopy.scaling.y = 0.55;
    canopy.position.y = 0.16;
    canopy.material = shell;
    canopy.parent = this.root;
    this.glow.addExcludedMesh(canopy);

    // Glowing eye / core
    this.coreMat = this.emissive('droneCore', '#20d7ff');
    const core = BABYLON.MeshBuilder.CreateSphere('droneCore', { diameter: 0.3, segments: 18 }, this.scene);
    core.position.set(0, 0.18, 0.32);
    core.material = this.coreMat;
    core.parent = this.root;
    this.leds.push(core);

    // Four arms + rotor assemblies
    const armMat = shell;
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + i * Math.PI / 2;
      const dx = Math.cos(a), dz = Math.sin(a);
      const arm = BABYLON.MeshBuilder.CreateBox('droneArm', { width: 0.92, height: 0.08, depth: 0.12 }, this.scene);
      arm.position.set(dx * 0.62, 0.02, dz * 0.62);
      arm.rotation.y = -a;
      arm.material = armMat;
      arm.parent = this.root;

      const ring = BABYLON.MeshBuilder.CreateTorus('droneRotorRing', { diameter: 0.62, thickness: 0.055, tessellation: 28 }, this.scene);
      ring.position.set(dx * 1.08, 0.1, dz * 1.08);
      ring.material = shell;
      ring.parent = this.root;

      const rotor = BABYLON.MeshBuilder.CreateBox('droneRotor', { width: 0.54, height: 0.015, depth: 0.07 }, this.scene);
      rotor.position.copyFrom(ring.position);
      rotor.position.y += 0.02;
      rotor.material = this.emissive('droneBlade', '#5ce1e6');
      rotor.parent = this.root;
      this.rotors.push(rotor);
    }

    // Flashing LED beacons around the hull — emission-shader showcase
    this.ledMat = this.emissive('droneLED', '#ff2a3a');
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      const led = BABYLON.MeshBuilder.CreateBox('droneLED', { width: 0.09, height: 0.05, depth: 0.05 }, this.scene);
      led.position.set(Math.cos(a) * 0.55, -0.05, Math.sin(a) * 0.55);
      led.rotation.y = -a;
      led.material = this.ledMat;
      led.parent = this.root;
      this.leds.push(led);
    }

    // CPU "brain" panel with six independently blinking coloured LEDs
    const panel = BABYLON.MeshBuilder.CreateBox('droneCPU', { width: 0.72, height: 0.05, depth: 0.44 }, this.scene);
    panel.position.y = 0.3;
    panel.material = shell;
    panel.parent = this.root;
    const palette = ['#32ff80', '#ffd933', '#ff3355', '#4d99ff', '#ff66e6', '#33ffff'];
    for (let i = 0; i < 6; i++) {
      const col = i % 3, row = Math.floor(i / 3);
      const hex = palette[i];
      const mat = this.emissive(`droneCPULED${i}`, hex);
      const led = BABYLON.MeshBuilder.CreateBox('droneCPULED', { width: 0.12, height: 0.04, depth: 0.12 }, this.scene);
      led.position.set(-0.2 + col * 0.2, 0.34, -0.09 + row * 0.18);
      led.material = mat;
      led.parent = this.root;
      this.cpuLeds.push({ mesh: led, mat, phase: i * 2.1, freq: 9 + i * 1.7, hex });
    }

    // Red eye light + cyan rotor light (Blobothan drone signature)
    const eyeLight = new BABYLON.PointLight('droneEyeLight', new BABYLON.Vector3(0, 0.18, 0.42), this.scene);
    eyeLight.diffuse = BABYLON.Color3.FromHexString('#ff2a3a');
    eyeLight.intensity = 1.2; eyeLight.range = 9;
    eyeLight.parent = this.root;
    const spinLight = new BABYLON.PointLight('droneSpinLight', new BABYLON.Vector3(0, 0.45, 0), this.scene);
    spinLight.diffuse = BABYLON.Color3.FromHexString('#5ce1e6');
    spinLight.intensity = 0.8; spinLight.range = 6;
    spinLight.parent = this.root;

    // Underbody scan lens
    const lens = BABYLON.MeshBuilder.CreateCylinder('droneLens', { diameter: 0.26, height: 0.09, tessellation: 24 }, this.scene);
    lens.position.y = -0.21;
    lens.material = this.emissive('droneLensMat', '#ff2a3a');
    lens.parent = this.root;

    // Red scan cone (custom emission shader, additive)
    this.cone = BABYLON.MeshBuilder.CreateCylinder('droneScanCone', {
      diameterTop: 0.16, diameterBottom: 2.1, height: 1, tessellation: 56, sideOrientation: BABYLON.Mesh.DOUBLESIDE,
    }, this.scene);
    this.scanMat = new BABYLON.ShaderMaterial('droneScanMat', this.scene,
      { vertex: 'droneScan', fragment: 'droneScan' },
      {
        attributes: ['position', 'normal', 'uv'],
        uniforms: ['worldViewProjection', 'world', 'time', 'strength', 'beamColor', 'cameraPosition'],
        needAlphaBlending: true,
      });
    this.scanMat.setColor3('beamColor', new BABYLON.Color3(1.0, 0.09, 0.14));
    this.scanMat.setFloat('strength', 0);
    this.scanMat.setFloat('time', 0);
    this.scanMat.alphaMode = BABYLON.Engine.ALPHA_ADD;
    this.scanMat.backFaceCulling = false;
    this.scanMat.disableDepthWrite = true;
    this.cone.material = this.scanMat;
    this.cone.parent = this.root;
    this.cone.isPickable = false;
    this.cone.setEnabled(false);

    // Expanding ground ring under the target
    this.ringMat = this.emissive('droneRingMat', '#ff2a3a');
    this.ringMat.alpha = 0.85;
    this.ring = BABYLON.MeshBuilder.CreateTorus('droneScanRing', { diameter: 1.6, thickness: 0.035, tessellation: 48 }, this.scene);
    this.ring.material = this.ringMat;
    this.ring.isPickable = false;
    this.ring.setEnabled(false);

    // Soft halo billboard at the lens
    this.haloMat = this.emissive('droneHaloMat', '#ff2a3a');
    this.haloMat.alpha = 0.45;
    this.halo = BABYLON.MeshBuilder.CreatePlane('droneHalo', { size: 1.4 }, this.scene);
    this.halo.material = this.haloMat;
    this.halo.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
    this.halo.parent = this.root;
    this.halo.position.y = -0.3;
    this.halo.isPickable = false;
    this.halo.setEnabled(false);
  }

  public get active() { return this.phase !== 'dormant' && this.phase !== 'done'; }
  public get finished() { return this.phase === 'done'; }

  public trigger(player: BABYLON.Vector3) {
    if (this.phase !== 'dormant') return;
    this.target.copyFrom(player);
    this.startPos.set(player.x + 20, player.y + 9, player.z + 7);
    this.hoverPos.set(player.x + 0.5, player.y + 3.4, player.z + 1.2);
    this.root.position.copyFrom(this.startPos);
    this.root.setEnabled(true);
    this.phase = 'arrive';
    this.phaseT = 0;
    this.onCue?.();
  }

  public update(dt: number, player: BABYLON.Vector3) {
    if (this.phase === 'dormant' || this.phase === 'done') return;
    this.time += dt;
    this.phaseT += dt;

    // Rotors always spin while active
    for (const r of this.rotors) r.rotation.y += dt * (this.phase === 'depart' ? 46 : 30);

    // LED flash pattern — fast during scanning, slow otherwise
    const rate = this.phase === 'scan' ? 18 : 6;
    const flash = (Math.sin(this.time * rate) * 0.5 + 0.5);
    this.ledMat.emissiveColor = BABYLON.Color3.FromHexString('#ff2a3a').scale(0.35 + flash * 1.7);
    this.coreMat.emissiveColor = this.phase === 'scan'
      ? BABYLON.Color3.FromHexString('#ff2a3a').scale(0.6 + flash)
      : BABYLON.Color3.FromHexString('#20d7ff').scale(0.8 + flash * 0.5);
    for (const l of this.cpuLeds) {
      const blink = Math.sin(this.time * l.freq + l.phase) * 0.5 + 0.5;
      l.mat.emissiveColor = BABYLON.Color3.FromHexString(l.hex).scale(0.3 + blink * 0.9);
    }
    this.scanMat.setFloat('time', this.time);

    const ease = (t: number) => t * t * (3 - 2 * t);

    if (this.phase === 'arrive') {
      const t = Math.min(1, this.phaseT / 3.4);
      const k = ease(t);
      this.root.position.copyFrom(BABYLON.Vector3.Lerp(this.startPos, this.hoverPos, k));
      // small hovering bob + banking into the approach
      this.root.position.y += Math.sin(this.time * 3) * 0.16 * (1 - k);
      this.bank = Math.sin(this.time * 2.4) * 0.09 + (1 - k) * 0.22;
      this.root.rotation.z = this.bank;
      this.root.rotation.y = Math.PI + (1 - k) * 0.5;
      if (t >= 1) { this.phase = 'hover'; this.phaseT = 0; }
    } else if (this.phase === 'hover') {
      this.hoverPos.set(player.x + 0.5, player.y + 3.4, player.z + 1.2);
      this.root.position.x += (this.hoverPos.x - this.root.position.x) * Math.min(1, dt * 2.2);
      this.root.position.y = this.hoverPos.y + Math.sin(this.time * 2.2) * 0.13;
      this.root.position.z += (this.hoverPos.z - this.root.position.z) * Math.min(1, dt * 2.2);
      this.root.rotation.z = Math.sin(this.time * 1.8) * 0.04;
      if (this.phaseT > 1.0) {
        this.phase = 'scan'; this.phaseT = 0;
        this.cone.setEnabled(true);
        this.ring.setEnabled(true);
        this.halo.setEnabled(true);
        this.onCue?.();
      }
    } else if (this.phase === 'scan') {
      // Track the player during the sweep
      this.root.position.x += (player.x + 0.4 - this.root.position.x) * Math.min(1, dt * 2.4);
      this.root.position.y = player.y + 3.4 + Math.sin(this.time * 2.6) * 0.08;
      this.root.position.z += (player.z + 0.9 - this.root.position.z) * Math.min(1, dt * 2.4);
      this.root.rotation.z = Math.sin(this.time * 3) * 0.03;

      const T = 5.0;
      const t = Math.min(1, this.phaseT / T);
      // Grow 0→1, hold, retract 1→0
      let beam = 1;
      if (t < 0.22) beam = ease(t / 0.22);
      else if (t > 0.78) beam = 1 - ease((t - 0.78) / 0.22);
      const h = Math.max(0.05, this.root.position.y - 0.1);
      this.cone.scaling.set(1, h, 1);
      this.cone.position.y = -h / 2;
      this.cone.position.x = player.x - this.root.position.x;
      this.cone.position.z = player.z - this.root.position.z;
      this.scanMat.setFloat('strength', beam);
      this.haloMat.alpha = 0.55 * beam;

      // Ground ring expands + pulses in sync
      const rp = (this.phaseT % 1.1) / 1.1;
      this.ring.position.set(player.x, player.y + 0.04, player.z);
      this.ring.scaling.setAll((0.6 + rp * 1.6) * beam);
      this.ringMat.alpha = (1 - rp) * 0.9 * beam;

      if (t >= 1) {
        this.cone.setEnabled(false);
        this.ring.setEnabled(false);
        this.halo.setEnabled(false);
        this.phase = 'depart'; this.phaseT = 0;
        this.departPos = this.root.position.clone();
        this.onCue?.();
      }
    } else if (this.phase === 'depart') {
      const t = Math.min(1, this.phaseT / 2.8);
      const k = t * t; // accelerate away
      this.root.position.x = this.departPos.x + (player.x - 46 - this.departPos.x) * k;
      this.root.position.y = this.departPos.y + 22 * k;
      this.root.position.z = this.departPos.z - 16 * k;
      this.root.rotation.z = -0.5 * k;
      this.root.rotation.y = Math.PI + k * 1.4;
      this.ledMat.emissiveColor.scaleInPlace(1 - dt * 0.8);
      if (t >= 1) this.dispose();
    }
  }

  private departPos = BABYLON.Vector3.Zero();

  public dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.phase = 'done';
    this.glow.dispose();
    this.root.dispose(false, true);
    this.cone.dispose();
    this.ring.dispose();
    this.scanMat.dispose();
    this.ringMat.dispose();
    this.haloMat.dispose();
    this.ledMat.dispose();
    this.coreMat.dispose();
  }
}
