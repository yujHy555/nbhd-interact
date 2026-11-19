import * as BABYLON from 'babylonjs';

/**
 * TRIPLE-AAA polish layer:
 *  - DefaultRenderingPipeline: bloom, FXAA, DOF, vignette, chromatic aberration, grain
 *  - Cinematic rim + fill lights
 *  - Atmospheric floating motes with gentle wind
 *  - Ground contact shadow under the character
 *  - Collectible sparkle bursts
 */
export class Polish {
  private scene: BABYLON.Scene;
  private camera: BABYLON.Camera;
  private pipeline: BABYLON.DefaultRenderingPipeline;
  private motes: BABYLON.ParticleSystem;
  private contactShadow: BABYLON.Mesh;
  private shadowMat: BABYLON.StandardMaterial;
  private rim!: BABYLON.PointLight;
  private fill!: BABYLON.HemisphericLight;
  private t = 0;

  constructor(scene: BABYLON.Scene, camera: BABYLON.Camera) {
    this.scene = scene;
    this.camera = camera;

    // ---- Cinematic post-processing ----
    this.pipeline = new BABYLON.DefaultRenderingPipeline('aaaPipeline', true, scene, [camera as BABYLON.Camera]);
    this.pipeline.fxaaEnabled = true;
    this.pipeline.samples = 4;
    this.pipeline.bloomEnabled = true;
    this.pipeline.bloomThreshold = 0.72;
    this.pipeline.bloomWeight = 0.35;
    this.pipeline.bloomKernel = 48;
    this.pipeline.bloomScale = 0.5;
    this.pipeline.imageProcessingEnabled = true;
    // Subtle vignette for cinematic framing
    this.pipeline.imageProcessing.vignetteEnabled = true;
    this.pipeline.imageProcessing.vignetteWeight = 2.2;
    this.pipeline.imageProcessing.vignetteStretch = 0.35;
    this.pipeline.imageProcessing.vignetteColor = new BABYLON.Color4(0.04, 0.07, 0.1, 1);
    this.pipeline.imageProcessing.vignetteCameraFov = 0.9;
    // Gentle chromatic aberration at edges
    (this.pipeline as any).chromaticAberrationEnabled = true;
    if (this.pipeline.chromaticAberration) {
      this.pipeline.chromaticAberration.aberrationAmount = 8;
      this.pipeline.chromaticAberration.radialIntensity = 0.6;
    }
    // Film grain for texture
    (this.pipeline as any).grainEnabled = true;
    if (this.pipeline.grain) {
      this.pipeline.grain.intensity = 4;
      this.pipeline.grain.animated = true;
    }
    // Depth of field — subtle, focuses on the character distance
    (this.pipeline as any).depthOfFieldEnabled = true;
    if (this.pipeline.depthOfField) {
      this.pipeline.depthOfField.focusDistance = 13000; // mm
      this.pipeline.depthOfField.fStop = 8;
      this.pipeline.depthOfField.focalLength = 42;
    }

    // ---- Cinematic accent lights ----
    this.rim = new BABYLON.PointLight('rimLight', new BABYLON.Vector3(0, 5, 8), scene);
    this.rim.diffuse = new BABYLON.Color3(0.4, 0.85, 1.0);
    this.rim.intensity = 1.4;
    this.rim.range = 22;
    this.fill = new BABYLON.HemisphericLight('fillLight', new BABYLON.Vector3(-0.4, 0.6, 0.3), scene);
    this.fill.diffuse = new BABYLON.Color3(0.5, 0.65, 0.9);
    this.fill.groundColor = new BABYLON.Color3(0.12, 0.1, 0.08);
    this.fill.intensity = 0.28;

    // ---- Contact shadow (soft blob under the character) ----
    this.shadowMat = new BABYLON.StandardMaterial('contactShadowMat', scene);
    this.shadowMat.diffuseColor = BABYLON.Color3.Black();
    this.shadowMat.emissiveColor = BABYLON.Color3.Black();
    this.shadowMat.alpha = 0.34;
    this.shadowMat.disableLighting = true;
    this.shadowMat.backFaceCulling = false;
    // Radial-gradient alpha texture for a soft falloff
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const ctx = cv.getContext('2d')!;
    const g = ctx.createRadialGradient(64, 64, 2, 64, 64, 62);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(0.5, 'rgba(0,0,0,0.6)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
    const tex = new BABYLON.Texture(cv.toDataURL('image/png'), scene);
    tex.hasAlpha = true;
    this.shadowMat.opacityTexture = tex;
    this.contactShadow = BABYLON.MeshBuilder.CreateGround('contactShadow', { width: 1.5, height: 1.1 }, scene);
    this.contactShadow.material = this.shadowMat;
    this.contactShadow.isPickable = false;
    this.contactShadow.renderingGroupId = 0;

    // ---- Atmospheric floating motes ----
    this.motes = new BABYLON.ParticleSystem('atmosphere', 320, scene);
    const moteCv = document.createElement('canvas'); moteCv.width = moteCv.height = 32;
    const mctx = moteCv.getContext('2d')!;
    const mg = mctx.createRadialGradient(16, 16, 1, 16, 16, 15);
    mg.addColorStop(0, 'rgba(255,255,255,1)');
    mg.addColorStop(1, 'rgba(255,255,255,0)');
    mctx.fillStyle = mg; mctx.fillRect(0, 0, 32, 32);
    this.motes.particleTexture = new BABYLON.Texture(moteCv.toDataURL('image/png'), scene);
    this.motes.emitter = new BABYLON.Vector3(90, 0, 0);
    this.motes.minEmitBox = new BABYLON.Vector3(-110, 0.5, -18);
    this.motes.maxEmitBox = new BABYLON.Vector3(110, 7, 18);
    this.motes.color1 = new BABYLON.Color4(0.75, 0.9, 1, 0.5);
    this.motes.color2 = new BABYLON.Color4(1, 0.9, 0.7, 0.35);
    this.motes.colorDead = new BABYLON.Color4(1, 1, 1, 0);
    this.motes.minSize = 0.04; this.motes.maxSize = 0.13;
    this.motes.minLifeTime = 4; this.motes.maxLifeTime = 9;
    this.motes.emitRate = 42;
    this.motes.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD;
    this.motes.direction1 = new BABYLON.Vector3(0.25, 0.06, 0);
    this.motes.direction2 = new BABYLON.Vector3(0.55, 0.2, 0.05);
    this.motes.minEmitPower = 0.05; this.motes.maxEmitPower = 0.2;
    this.motes.updateSpeed = 0.012;
    this.motes.start();
  }

  /** Update the contact shadow + rim light to follow the player. */
  public update(dt: number, playerPos: BABYLON.Vector3, groundY: number, moving: boolean) {
    this.t += dt;
    const lift = Math.max(0, playerPos.y - groundY);
    this.contactShadow.position.set(playerPos.x, groundY + 0.02, playerPos.z);
    const scale = 1 + Math.min(0.8, lift * 0.12);
    this.contactShadow.scaling.set(scale, scale, 1);
    this.shadowMat.alpha = moving ? 0.24 + Math.sin(this.t * 10) * 0.03 : 0.32;
    this.rim.position.set(playerPos.x - 2, playerPos.y + 3.5, playerPos.z + 5);
    this.motes.emitter = new BABYLON.Vector3(playerPos.x, 0, 0);
    // keep motes centered on the player as he explores
    this.motes.minEmitBox = new BABYLON.Vector3(-55, 0.5, -18);
    this.motes.maxEmitBox = new BABYLON.Vector3(55, 7, 18);
  }

  /** One-shot sparkle burst at a collectible position. */
  public sparkle(pos: BABYLON.Vector3, color = new BABYLON.Color4(1, 0.85, 0.3, 1)) {
    const ps = new BABYLON.ParticleSystem('sparkle', 36, this.scene);
    ps.particleTexture = this.motes.particleTexture;
    ps.emitter = pos.clone();
    ps.color1 = color; ps.color2 = new BABYLON.Color4(1, 1, 1, 1);
    ps.colorDead = new BABYLON.Color4(1, 1, 1, 0);
    ps.minSize = 0.05; ps.maxSize = 0.16;
    ps.minLifeTime = 0.35; ps.maxLifeTime = 0.75;
    ps.emitRate = 400; ps.manualEmitCount = 36;
    ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD;
    ps.direction1 = new BABYLON.Vector3(-2, 1, -2);
    ps.direction2 = new BABYLON.Vector3(2, 3, 2);
    ps.minEmitPower = 1; ps.maxEmitPower = 3;
    ps.updateSpeed = 0.02;
    ps.start();
    setTimeout(() => { ps.stop(); setTimeout(() => ps.dispose(), 900); }, 60);
  }

  public getPipeline() { return this.pipeline; }
  public dispose() {
    this.motes.dispose();
    this.contactShadow.dispose();
    this.shadowMat.dispose();
    this.rim.dispose(); this.fill.dispose();
    this.pipeline.dispose();
  }
}
