import * as BABYLON from 'babylonjs';

/**
 * State-of-the-art prototype environment:
 *  - Procedural equirectangular HDRI-style environment (IBL + reflections)
 *  - Directional "sun" light with soft shadows
 *  - Large ground plane (metric scale)
 *  - Reflection test balls (PBR mirror + standard matte)
 *  - Macbeth color calibration chart
 */
export class Environment {
  public sun: BABYLON.DirectionalLight;
  public hemi: BABYLON.HemisphericLight;
  public ground: BABYLON.Mesh;
  public envTexture: BABYLON.BaseTexture | null = null;
  private scene: BABYLON.Scene;
  private shadowGen: BABYLON.ShadowGenerator;
  private root: BABYLON.TransformNode;

  constructor(scene: BABYLON.Scene) {
    this.scene = scene;
    this.root = new BABYLON.TransformNode('environmentRoot', scene);

    // ---- Real HDRI environment (vintage measuring lab) ----
    // .hdr files are LINEAR radiance data — gammaSpace must be false or the
    // image gets double-gamma'd (the washed-out, milky look).
    this.envTexture = new BABYLON.HDRCubeTexture('/hdri/vintage_measuring_lab_2k.hdr', scene, 256);
    this.envTexture.gammaSpace = false;
    scene.environmentTexture = this.envTexture as any;
    scene.environmentIntensity = 0.85;
    scene.ambientColor = new BABYLON.Color3(0.08, 0.09, 0.11);

    // ---- Skybox showing the SAME HDRI as the background ----
    // Use a dedicated texture instance so the skybox exposure is independent
    // from the IBL intensity (no gray emissive tint — that desaturates it).
    const skyTex = new BABYLON.HDRCubeTexture('/hdri/vintage_measuring_lab_2k.hdr', scene, 256);
    skyTex.gammaSpace = false;
    skyTex.coordinatesMode = BABYLON.Texture.SKYBOX_MODE;
    skyTex.level = 0.85; // tone-mapped by ACES → rich, not blown out
    const sky = BABYLON.MeshBuilder.CreateBox('skyBox', { size: 2000 }, scene);
    const skyMat = new BABYLON.StandardMaterial('skyMat', scene);
    skyMat.backFaceCulling = false;
    skyMat.disableLighting = true;
    skyMat.reflectionTexture = skyTex;
    skyMat.diffuseColor = BABYLON.Color3.Black();
    skyMat.specularColor = BABYLON.Color3.Black();
    sky.material = skyMat;
    sky.isPickable = false;
    sky.infiniteDistance = true;
    sky.applyFog = false;

    // ---- Sun (directional) with shadows ----
    this.sun = new BABYLON.DirectionalLight('sun', new BABYLON.Vector3(-0.55, -1, 0.35), scene);
    this.sun.position = new BABYLON.Vector3(60, 120, -60);
    this.sun.intensity = 2.6;
    this.sun.diffuse = new BABYLON.Color3(1.0, 0.96, 0.88);
    this.sun.specular = new BABYLON.Color3(1, 0.98, 0.92);
    this.shadowGen = new BABYLON.ShadowGenerator(2048, this.sun);
    this.shadowGen.useBlurExponentialShadowMap = true;
    this.shadowGen.blurKernel = 32;
    this.shadowGen.darkness = 0.35;
    this.shadowGen.bias = 0.0015;
    this.shadowGen.normalBias = 0.02;

    // ---- Fill light ----
    this.hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0), scene);
    this.hemi.intensity = 0.55;
    this.hemi.diffuse = new BABYLON.Color3(0.65, 0.78, 0.95);
    this.hemi.groundColor = new BABYLON.Color3(0.18, 0.16, 0.14);

    // ---- Ground (real-world metric scale) ----
    this.ground = BABYLON.MeshBuilder.CreateGround('ground', { width: 400, height: 80 }, scene);
    const groundMat = new BABYLON.PBRMaterial('groundMat', scene);
    groundMat.albedoColor = new BABYLON.Color3(0.24, 0.26, 0.3);
    groundMat.metallic = 0.05;
    groundMat.roughness = 0.82;
    groundMat.environmentIntensity = 0.6;
    this.ground.material = groundMat;
    this.ground.receiveShadows = true;
    this.ground.position.x = 90; // centre of the horizontal world

    // Subtle grid lines for scale reference
    const gridMat = new BABYLON.StandardMaterial('gridMat', scene);
    gridMat.diffuseColor = new BABYLON.Color3(0.35, 0.4, 0.45);
    gridMat.emissiveColor = new BABYLON.Color3(0.06, 0.08, 0.1);
    gridMat.alpha = 0.4;
    for (let x = -100; x <= 300; x += 5) {
      const line = BABYLON.MeshBuilder.CreateBox('gridLine', { width: 0.02, height: 0.005, depth: 80 }, scene);
      line.position.set(x, 0.011, 0);
      line.material = gridMat;
      line.isPickable = false;
    }
    for (let z = -40; z <= 40; z += 5) {
      const line = BABYLON.MeshBuilder.CreateBox('gridLineZ', { width: 400, height: 0.005, depth: 0.02 }, scene);
      line.position.set(90, 0.012, z);
      line.material = gridMat;
      line.isPickable = false;
    }

    this.buildMaterialBalls();
    this.buildMacbethChart();
  }

  public registerShadowCaster(mesh: BABYLON.Mesh) { this.shadowGen.addShadowCaster(mesh, true); }

  /** Equirectangular canvas → cube texture used as IBL + sky. */
  private createProceduralEnv(): BABYLON.BaseTexture {
    const cv = document.createElement('canvas');
    cv.width = 1024; cv.height = 512;
    const ctx = cv.getContext('2d')!;
    // Vertical sky gradient
    const grad = ctx.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0.0, '#1b3a63');   // zenith
    grad.addColorStop(0.35, '#4e7bb0');
    grad.addColorStop(0.5, '#cdd8dd');   // horizon
    grad.addColorStop(0.62, '#8a8070');
    grad.addColorStop(1.0, '#24262a');   // ground
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 1024, 512);
    // Warm sun glow + disc
    const sx = 720, sy = 190;
    const glow = ctx.createRadialGradient(sx, sy, 5, sx, sy, 150);
    glow.addColorStop(0, 'rgba(255,246,214,1)');
    glow.addColorStop(0.08, 'rgba(255,228,160,0.95)');
    glow.addColorStop(0.35, 'rgba(255,200,120,0.35)');
    glow.addColorStop(1, 'rgba(255,190,110,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(sx - 160, sy - 160, 320, 320);
    ctx.fillStyle = '#fff8e0';
    ctx.beginPath(); ctx.arc(sx, sy, 22, 0, Math.PI * 2); ctx.fill();
    // Soft clouds
    for (let i = 0; i < 9; i++) {
      const cx = (i * 137) % 1024, cy = 140 + (i % 3) * 26;
      const cg = ctx.createRadialGradient(cx, cy, 2, cx, cy, 60);
      cg.addColorStop(0, 'rgba(255,255,255,0.32)');
      cg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = cg;
      ctx.fillRect(cx - 60, cy - 30, 120, 60);
    }
    const url = cv.toDataURL('image/png');
    try {
      return new BABYLON.EquiRectangularCubeTexture(url, this.scene, 256);
    } catch {
      // Fallback: a simple dynamic cube-ish texture (should not be reached)
      const tex = new BABYLON.Texture(url, this.scene);
      return tex;
    }
  }

  private createSkyTexture(): BABYLON.Texture {
    const cv = document.createElement('canvas');
    cv.width = 16; cv.height = 512;
    const ctx = cv.getContext('2d')!;
    const g = ctx.createLinearGradient(0, 0, 0, 512);
    g.addColorStop(0, '#1b3a63');
    g.addColorStop(0.48, '#b9cfdd');
    g.addColorStop(0.52, '#8a8070');
    g.addColorStop(1, '#24262a');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 16, 512);
    return new BABYLON.Texture(cv.toDataURL('image/png'), this.scene);
  }

  /** Reflection / material test balls at the welcome zone. */
  private buildMaterialBalls() {
    const specs = [
      { name: 'MirrorBall', x: -6, rough: 0.02, metal: 1, color: new BABYLON.Color3(0.9, 0.92, 0.95) },
      { name: 'GlossBall', x: -3.2, rough: 0.15, metal: 0.7, color: new BABYLON.Color3(0.2, 0.55, 0.95) },
      { name: 'MatteBall', x: -0.4, rough: 0.85, metal: 0, color: new BABYLON.Color3(0.95, 0.35, 0.25) },
    ];
    for (const s of specs) {
      const ball = BABYLON.MeshBuilder.CreateSphere(s.name, { diameter: 1.6, segments: 32 }, this.scene);
      ball.position.set(s.x, 0.8, -6);
      const pbr = new BABYLON.PBRMaterial(s.name + 'Mat', this.scene);
      pbr.albedoColor = s.color;
      pbr.metallic = s.metal;
      pbr.roughness = s.rough;
      pbr.environmentIntensity = 1.1;
      ball.material = pbr;
      ball.receiveShadows = true;
      this.shadowGen.addShadowCaster(ball);
      const pedestal = BABYLON.MeshBuilder.CreateCylinder(s.name + 'Pedestal', { diameter: 1.9, height: 0.25, tessellation: 32 }, this.scene);
      pedestal.position.set(s.x, 0.125, -6);
      const pm = new BABYLON.PBRMaterial(s.name + 'PedMat', this.scene);
      pm.albedoColor = new BABYLON.Color3(0.12, 0.13, 0.15);
      pm.metallic = 0.3; pm.roughness = 0.5;
      pedestal.material = pm;
    }
  }

  /** Macbeth ColorChecker-style calibration chart (24 patches). */
  private buildMacbethChart() {
    const cv = document.createElement('canvas');
    cv.width = 512; cv.height = 384;
    const ctx = cv.getContext('2d')!;
    const patches = [
      '#735244','#c29682','#627a9d','#565c29','#8073ac','#b5828c',
      '#c9c2b6','#858078','#d6b483','#9c8b62','#5a7184','#8e9b72',
      '#9a7b78','#6b6e69','#8a7b58','#3e5f6e','#a4957d','#75819a',
      '#69915f','#603a37','#7a5a3a','#39445e','#536e61','#a49686',
    ];
    const pw = 512 / 6, ph = 384 / 4;
    for (let i = 0; i < 24; i++) {
      ctx.fillStyle = patches[i];
      ctx.fillRect((i % 6) * pw, Math.floor(i / 6) * ph, pw, ph);
    }
    const tex = new BABYLON.Texture(cv.toDataURL('image/png'), this.scene);
    tex.hasAlpha = false;

    const chart = BABYLON.MeshBuilder.CreatePlane('macbethChart', { width: 2.4, height: 1.8 }, this.scene);
    chart.position.set(2.5, 1.6, -6);
    chart.rotation.y = -0.25;
    const mat = new BABYLON.PBRMaterial('macbethMat', this.scene);
    mat.albedoTexture = tex;
    mat.metallic = 0; mat.roughness = 0.8;
    chart.material = mat;
    chart.receiveShadows = true;
    const frame = BABYLON.MeshBuilder.CreateBox('macbethFrame', { width: 2.55, height: 1.95, depth: 0.06 }, this.scene);
    frame.position.copyFrom(chart.position);
    frame.position.z -= 0.04;
    frame.rotation.y = chart.rotation.y;
    const fm = new BABYLON.PBRMaterial('macbethFrameMat', this.scene);
    fm.albedoColor = new BABYLON.Color3(0.08, 0.09, 0.11);
    fm.metallic = 0.4; fm.roughness = 0.4;
    frame.material = fm;
  }
}
