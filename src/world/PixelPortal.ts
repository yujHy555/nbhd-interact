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
  // Chunky pixel blocks — one floor + one texture fetch (AAA-cheap path).
  float block = mix(1.0, 5.0, amount);
  vec2 texel = block / resolution;
  vec2 cell = floor(vUV / texel);
  vec2 uv = (cell + 0.5) * texel;
  vec3 c = texture2D(textureSampler, uv).rgb;

  // Cheap 4x4 ordered dither (no sin/hash — integer arithmetic only).
  vec2 p = mod(cell, 4.0);
  float bayer = (mod(p.x, 2.0) + mod(p.y, 2.0) * 2.0) * 0.25;
  c += (bayer - 0.375) * dither * amount;

  // Colour quantisation to a limited retro palette + warm desert shift.
  c = floor(c * palette + 0.5) / palette;
  c *= vec3(1.04, 1.01, 0.96);
  gl_FragColor = vec4(c, 1.0);
}`;

// Animated portal veil — scrolling holographic grid with energy ripples
BABYLON.Effect.ShadersStore['portalVeilVertexShader'] = `
precision highp float;
attribute vec3 position; attribute vec2 uv;
uniform mat4 worldViewProjection;
varying vec2 vUV;
void main(void){ vUV=uv; gl_Position=worldViewProjection*vec4(position,1.0); }`;
BABYLON.Effect.ShadersStore['portalVeilFragmentShader'] = `
precision highp float;
varying vec2 vUV;
uniform float time;
void main(void){
  vec2 g=abs(fract(vUV*vec2(10.0,14.0)-vec2(0.0,time*0.6))-0.5);
  float grid=smoothstep(0.44,0.5,max(g.x,g.y));
  float scan=exp(-pow((fract(vUV.y-time*0.25)-0.5)*10.0,2.0));
  float glow=0.12+grid*0.5+scan*0.6;
  float edge=smoothstep(0.0,0.1,vUV.x)*smoothstep(1.0,0.9,vUV.x)*smoothstep(0.0,0.08,vUV.y)*smoothstep(1.0,0.92,vUV.y);
  gl_FragColor=vec4(vec3(0.1,0.85,1.0)*(1.0+scan), glow*edge);
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
  private veil!: BABYLON.Mesh;
  private veilMat!: BABYLON.ShaderMaterial;
  private prevX = 0;
  private isPixel = false;
  private ppAttached = false;
  private onModeChange?: (pixel: boolean) => void;
  private static readonly PORTAL_X = 192;
  private static readonly OPEN_Z = 2.0; // half-width of the walkable opening

  constructor(scene: BABYLON.Scene, camera: BABYLON.Camera, onModeChange?: (pixel: boolean) => void) {
    this.scene = scene;
    this.camera = camera;
    this.onModeChange = onModeChange;
    this.root = new BABYLON.TransformNode('pixelPortal', scene);
    this.pixelPP = new BABYLON.PostProcess('pixelate', 'pixelate',
      ['resolution', 'amount', 'palette', 'dither'], null, 1.0, camera, BABYLON.Texture.NEAREST_SAMPLINGMODE);
    // Zero-cost when inactive: detach the pass entirely, reattach on entry.
    camera.detachPostProcess(this.pixelPP);
    this.pixelPP.onApply = (effect) => {
      effect.setFloat2('resolution', scene.getEngine().getRenderWidth(), scene.getEngine().getRenderHeight());
      effect.setFloat('amount', this.amount);
      effect.setFloat('palette', 12.0);
      effect.setFloat('dither', 0.09);
    };
    this.buildArch();
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
    // AAA industrial portal — travelator-grade precision: layered panels,
    // hazard stripes, bolted frames, recessed LED channels, scrolling data.
    const metal = new BABYLON.PBRMaterial('portalMetal', this.scene);
    metal.albedoColor = new BABYLON.Color3(0.09, 0.13, 0.17);
    metal.metallic = 0.88; metal.roughness = 0.28;
    const dark = new BABYLON.PBRMaterial('portalDark', this.scene);
    dark.albedoColor = new BABYLON.Color3(0.02, 0.04, 0.06);
    dark.metallic = 0.5; dark.roughness = 0.6;
    const hazardMat = this.matsHazard();
    const X = 192, Z = 0;

    // Twelve interlocking frame segments around the opening
    const segs = 12;
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const seg = BABYLON.MeshBuilder.CreateBox('portalSeg', { width: 0.62, height: 0.34, depth: 0.26 }, this.scene);
      seg.position.set(X, 2.3 + Math.sin(a) * 2.05, Z + Math.cos(a) * 1.9);
      seg.rotation.x = a;
      seg.material = i % 3 === 0 ? hazardMat : metal;
      seg.parent = this.root;
      seg.receiveShadows = true;
      // Bolt details
      const bolt = BABYLON.MeshBuilder.CreateCylinder('portalBolt', { diameter: 0.09, height: 0.05, tessellation: 8 }, this.scene);
      bolt.position.set(X + 0.34, seg.position.y, seg.position.z);
      bolt.rotation.z = Math.PI / 2;
      bolt.material = dark;
      bolt.parent = this.root;
    }

    // Outer structural pillars
    [-1, 1].forEach((side) => {
      const pillar = BABYLON.MeshBuilder.CreateBox('portalPillar', { width: 0.7, height: 5.2, depth: 0.9 }, this.scene);
      pillar.position.set(X, 2.6, Z + side * 2.25);
      pillar.material = metal;
      pillar.parent = this.root;
      pillar.receiveShadows = true;
      // Recessed LED channel
      const strip = BABYLON.MeshBuilder.CreateBox('portalStrip', { width: 0.06, height: 4.3, depth: 0.1 }, this.scene);
      strip.position.set(X - 0.38, 2.6, Z + side * 2.25);
      strip.material = this.emissive('portalStripMat', '#00e5ff');
      strip.parent = this.root;
    });

    this.glowMat = this.emissive('portalGlow', '#00e5ff');
    const rim = BABYLON.MeshBuilder.CreateTorus('portalRim', { diameter: 3.9, thickness: 0.07, tessellation: 64 }, this.scene);
    rim.rotation.x = Math.PI / 2; rim.rotation.z = Math.PI / 2;
    rim.position.set(X, 2.3, Z);
    rim.scaling.set(1, 1.12, 1);
    rim.material = this.glowMat;
    rim.parent = this.root;
    this.arch = rim;

    // Animated scrolling energy veil (shader-driven scan grid)
    this.veilMat = new BABYLON.ShaderMaterial('portalVeilMat', this.scene,
      { vertex: 'portalVeil', fragment: 'portalVeil' },
      { attributes: ['position', 'uv'], uniforms: ['worldViewProjection', 'world', 'time'],
        needAlphaBlending: true });
    this.veilMat.alphaMode = BABYLON.Engine.ALPHA_ADD;
    this.veilMat.backFaceCulling = false;
    this.veil = BABYLON.MeshBuilder.CreatePlane('portalVeil', { width: 3.7, height: 4.2 }, this.scene);
    this.veil.position.set(X, 2.3, Z);
    this.veil.rotation.y = Math.PI / 2;
    this.veil.material = this.veilMat;
    this.veil.parent = this.root;
    this.veil.setEnabled(false); // only when armed
  }

  private matsHazard() {
    const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64;
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = '#1a1d20'; ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = '#ffc857';
    for (let i = -64; i < 128; i += 24) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + 12, 0); ctx.lineTo(i + 76, 64); ctx.lineTo(i + 64, 64); ctx.fill();
    }
    const tex = new BABYLON.Texture(cv.toDataURL(), this.scene);
    const m = new BABYLON.PBRMaterial('portalHazard', this.scene);
    m.albedoTexture = tex; m.metallic = 0.5; m.roughness = 0.5;
    return m;
  }

  public update(dt: number, player: BABYLON.Vector3) {
    // Pulse the arch glow + animate the holographic veil shader
    const t = performance.now() / 1000;
    this.glowMat.emissiveColor = BABYLON.Color3.FromHexString('#00e5ff').scale(0.7 + Math.sin(t * 4) * 0.35);
    this.arch.rotation.z = Math.PI / 2 + Math.sin(t * 0.8) * 0.02;
    this.veilMat.setFloat('time', t);

    // Transition the pixelation amount smoothly. Attach/detach the pass so it
    // costs nothing in standard mode, and use NEAREST sampling for crisp pixels.
    this.amount += (this.targetAmount - this.amount) * Math.min(1, dt * 4.5);
    if (Math.abs(this.amount - this.targetAmount) < 0.02) this.amount = this.targetAmount; // exact snap
    const needPP = this.amount > 0.001;
    if (needPP && !this.ppAttached) {
      this.camera.attachPostProcess(this.pixelPP, 0);
      this.ppAttached = true;
    } else if (!needPP && this.ppAttached) {
      this.camera.detachPostProcess(this.pixelPP);
      this.ppAttached = false;
    }

    const X = PixelPortal.PORTAL_X, Z = 0;
    const inOpening = Math.abs(player.z - Z) < PixelPortal.OPEN_Z;
    const near = Math.abs(player.x - X) < 5 && inOpening;
    const crossedForward = near && this.prevX < X && player.x >= X;
    const crossedBack = near && this.prevX > X && player.x <= X;
    this.veil.setEnabled(near);

    // The single arch toggles pixel mode on EACH crossing, regardless of how
    // far the fade progressed. Forward → pixel ON, backward → pixel OFF.
    if (crossedForward && this.targetAmount === 0) {
      this.targetAmount = 1;
      this.state = 'engaged';
      this.onModeChange?.(true);
    } else if (crossedBack && this.targetAmount === 1) {
      this.targetAmount = 0;
      this.state = 'returning';
      this.onModeChange?.(false);
    }

    if (this.targetAmount === 1 && this.amount > 0.97) this.state = 'pixel';
    if (this.targetAmount === 0 && this.amount < 0.03) this.state = 'idle';
    this.isPixel = this.targetAmount === 1;
    this.prevX = player.x;
  }

  public dispose() {
    this.pixelPP.dispose();
    this.root.dispose(false, true);
  }
}
