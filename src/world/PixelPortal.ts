import * as BABYLON from 'babylonjs';

/**
 * Pixel-art transition portal. A sci-fi arch placed after the road section.
 * When the player walks through it, a custom post-process pixelates + colour-
 * quantises the ENTIRE scene into the reference pixel-art look, and a warm
 * desert-style pixel environment fades in. A second "realistic" door inside
 * the pixel world returns the player to the standard high-fidelity scene.
 */

// ---- Pixelation + palette-quantisation post-process ------------------------
BABYLON.Effect.ShadersStore['pixelateFragmentShader'] = `
precision highp float;
varying vec2 vUV;
uniform sampler2D textureSampler;
uniform vec2 resolution;
uniform float amount;      // 0 = full res, 1 = full pixel art
uniform float palette;     // number of colour buckets
uniform float dither;
void main(void) {
  // When inactive, pass through untouched (no colour quantisation at all).
  if (amount < 0.01) {
    gl_FragColor = texture2D(textureSampler, vUV);
    return;
  }
  // Big chunky pixels (reference style ≈ 3-6 screen px blocks)
  float block = mix(1.0, 5.0, amount);
  vec2 texel = block / resolution;
  vec2 uv = (floor(vUV / texel) + 0.5) * texel;
  vec3 c = texture2D(textureSampler, uv).rgb;

  // Ordered Bayer-style dither for the retro look
  vec2 p = floor(vUV / texel);
  float bayer = fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  c += (bayer - 0.5) * dither * amount;

  // Colour quantisation — limited palette
  c = floor(c * palette + 0.5) / palette;

  // Slight warm shift toward the reference's sun-baked palette
  c.r *= 1.04; c.g *= 1.01; c.b *= 0.96;

  gl_FragColor = vec4(c, 1.0);
}`;

type PortalState = 'idle' | 'armed' | 'engaged' | 'pixel' | 'returning';

export class PixelPortal {
  private scene: BABYLON.Scene;
  private camera: BABYLON.Camera;
  private root: BABYLON.TransformNode;
  private pixelPP: BABYLON.PostProcess;
  private amount = 0;
  private targetAmount = 0;
  private state: PortalState = 'idle';
  private arch!: BABYLON.Mesh;
  private glowMat!: BABYLON.StandardMaterial;
  private returnDoor!: BABYLON.Mesh;
  private returnGlow!: BABYLON.StandardMaterial;
  private veil!: BABYLON.Mesh;
  private veilMat!: BABYLON.StandardMaterial;
  private prevX = 0;
  private isPixel = false;
  private onModeChange?: (pixel: boolean) => void;
  private static readonly PORTAL_X = 192;
  private static readonly OPEN_Z = 2.0; // half-width of the walkable opening

  constructor(scene: BABYLON.Scene, camera: BABYLON.Camera, onModeChange?: (pixel: boolean) => void) {
    this.scene = scene;
    this.camera = camera;
    this.onModeChange = onModeChange;
    this.root = new BABYLON.TransformNode('pixelPortal', scene);
    this.pixelPP = new BABYLON.PostProcess('pixelate', 'pixelate',
      ['resolution', 'amount', 'palette', 'dither'], null, 1.0, camera);
    this.pixelPP.onApply = (effect) => {
      effect.setFloat2('resolution', scene.getEngine().getRenderWidth(), scene.getEngine().getRenderHeight());
      effect.setFloat('amount', this.amount);
      effect.setFloat('palette', 12.0);
      effect.setFloat('dither', 0.09);
    };
    this.buildArch();
    this.buildReturnDoor();
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

  private buildArch() {
    // Sci-fi arch: two pillars + top beam + glowing inner rim
    const metal = new BABYLON.PBRMaterial('portalMetal', this.scene);
    metal.albedoColor = new BABYLON.Color3(0.08, 0.1, 0.14);
    metal.metallic = 0.85; metal.roughness = 0.32;
    const X = 192, Z = 0;
    [-1, 1].forEach((side) => {
      const pillar = BABYLON.MeshBuilder.CreateBox('portalPillar', { width: 0.5, height: 4.6, depth: 0.9 }, this.scene);
      pillar.position.set(X, 2.3, Z + side * 1.9);
      pillar.material = metal;
      pillar.parent = this.root;
      pillar.receiveShadows = true;
    });
    const beam = BABYLON.MeshBuilder.CreateBox('portalBeam', { width: 0.5, height: 0.6, depth: 4.3 }, this.scene);
    beam.position.set(X, 4.5, Z);
    beam.material = metal;
    beam.parent = this.root;

    this.glowMat = this.emissive('portalGlow', '#00e5ff');
    const rim = BABYLON.MeshBuilder.CreateTorus('portalRim', { diameter: 3.6, thickness: 0.09, tessellation: 48 }, this.scene);
    rim.rotation.x = Math.PI / 2;
    rim.rotation.z = Math.PI / 2;
    rim.position.set(X, 2.3, Z);
    rim.scaling.set(1, 1.2, 1);
    rim.material = this.glowMat;
    rim.parent = this.root;
    this.arch = rim;

    // Energy veil inside the arch
    const veilMat = this.emissive('portalVeil', '#0aa6c8');
    veilMat.alpha = 0.22;
    const veil = BABYLON.MeshBuilder.CreatePlane('portalVeil', { width: 0.1, height: 4.2 }, this.scene);
    veil.position.set(X, 2.3, Z);
    veil.rotation.y = Math.PI / 2;
    veil.scaling.z = 3.4;
    veil.material = veilMat;
    veil.parent = this.root;
  }

  private buildReturnDoor() {
    // Ultra-realistic return door (hidden until pixel mode)
    const door = BABYLON.MeshBuilder.CreateBox('returnDoor', { width: 0.24, height: 2.7, depth: 1.6 }, this.scene);
    door.position.set(206, 1.35, 0);
    const dm = new BABYLON.PBRMaterial('returnDoorMat', this.scene);
    dm.albedoColor = new BABYLON.Color3(0.16, 0.11, 0.07);
    dm.metallic = 0.15; dm.roughness = 0.28;
    door.material = dm;
    door.parent = this.root;
    door.receiveShadows = true;
    door.setEnabled(false);
    this.returnDoor = door;

    this.returnGlow = this.emissive('returnGlow', '#ffd27f');
    const frame = BABYLON.MeshBuilder.CreateTorus('returnFrame', { diameter: 2.4, thickness: 0.07, tessellation: 40 }, this.scene);
    frame.rotation.x = Math.PI / 2; frame.rotation.z = Math.PI / 2;
    frame.position.set(206, 1.35, 0);
    frame.material = this.returnGlow;
    frame.parent = this.root;
    frame.setEnabled(false);
  }

  public update(dt: number, player: BABYLON.Vector3) {
    // Pulse the arch glow
    const t = performance.now() / 1000;
    this.glowMat.emissiveColor = BABYLON.Color3.FromHexString('#00e5ff').scale(0.7 + Math.sin(t * 4) * 0.35);
    this.arch.rotation.z = Math.PI / 2 + Math.sin(t * 0.8) * 0.02;

    // Transition the pixelation amount smoothly
    this.amount += (this.targetAmount - this.amount) * Math.min(1, dt * 2.5);

    const X = PixelPortal.PORTAL_X, Z = 0;
    const inOpening = Math.abs(player.z - Z) < PixelPortal.OPEN_Z;
    // "Armed" when standing before the opening; the world only flips when the
    // player actually crosses the arch plane (x < X → x >= X) inside the opening.
    if ((this.state === 'idle' || this.state === 'armed') && !this.isPixel) {
      if (Math.abs(player.x - X) < 5 && inOpening && player.x < X) this.state = 'armed';
      const crossed = this.prevX < X && player.x >= X && inOpening && this.state === 'armed';
      if (crossed) {
        this.state = 'engaged';
        this.targetAmount = 1;
        this.returnDoor.setEnabled(true);
        const frame = this.scene.getMeshByName('returnFrame');
        if (frame) frame.setEnabled(true);
        this.onModeChange?.(true);
      }
    } else if (this.state === 'pixel' || this.isPixel) {
      // Walk through the return door to restore the standard world
      const crossedBack = this.prevX > 206 && player.x <= 206 && Math.abs(player.z) < 2;
      if (crossedBack) {
        this.state = 'returning';
        this.isPixel = false;
        this.targetAmount = 0;
        this.returnDoor.setEnabled(false);
        const frame = this.scene.getMeshByName('returnFrame');
        if (frame) frame.setEnabled(false);
        this.onModeChange?.(false);
      }
    }

    if (this.state === 'engaged' && this.amount > 0.97) { this.state = 'pixel'; this.isPixel = true; }
    if (this.state === 'returning' && this.amount < 0.03) this.state = 'idle';
    this.prevX = player.x;
  }

  public dispose() {
    this.pixelPP.dispose();
    this.root.dispose(false, true);
  }
}
