import * as BABYLON from 'babylonjs';

// Equirectangular sky shader — samples the HDRI panorama with true spherical
// UVs. StandardMaterial's emissiveTexture path rendered this sky as flat grey.
BABYLON.Effect.ShadersStore['nbhdSkyVertexShader'] = `
precision highp float;
attribute vec3 position;
uniform mat4 worldViewProjection;
varying vec2 vUV;
void main(void) {
  vec3 n = normalize(position);
  vUV = vec2(atan(n.z, n.x) / 6.2831853 + 0.5, acos(n.y) / 3.1415927);
  gl_Position = worldViewProjection * vec4(position, 1.0);
}`;
BABYLON.Effect.ShadersStore['nbhdSkyFragmentShader'] = `
precision highp float;
varying vec2 vUV;
uniform sampler2D skyTexture;
uniform float level;
void main(void) {
  vec3 c = texture2D(skyTexture, vUV).rgb * level;
  gl_FragColor = vec4(c, 1.0);
}`;

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
  public sky: BABYLON.Mesh;
  public envTexture: BABYLON.BaseTexture | null = null;
  private scene: BABYLON.Scene;
  private shadowGen: BABYLON.ShadowGenerator;
  private root: BABYLON.TransformNode;

  constructor(scene: BABYLON.Scene) {
    this.scene = scene;
    this.root = new BABYLON.TransformNode('environmentRoot', scene);

    // ---- HDRI lighting test: original vintage measuring lab HDR ----
    // A true linear .hdr gives far more luminance range than the LDR JPEG,
    // so direct-sun shadows read with much stronger contrast.
    const hdrUrl = '/hdri/vintage_measuring_lab_2k.hdr';
    this.envTexture = new BABYLON.HDRCubeTexture(hdrUrl, scene, 256);
    this.envTexture.gammaSpace = false;
    scene.environmentTexture = this.envTexture as any;
    scene.environmentIntensity = 0.75; // lower ambient → shadows stand out
    scene.ambientColor = new BABYLON.Color3(0.08, 0.09, 0.11);

    // Visible background: the full 4096×2048 blue-desert panorama mapped
    // directly onto a sphere, independent of the HDR lighting IBL.
    const skyTex = new BABYLON.Texture('/hdri/blue_desert/textures/Scene_-_Root_diffuse.jpeg', scene);
    skyTex.level = 0.95;
    skyTex.anisotropicFilteringLevel = 8;
    const sky = BABYLON.MeshBuilder.CreateSphere('skyBox', { diameter: 4000, segments: 48 }, scene);
    // Custom shader samples the equirectangular HDRI panorama with true
    // spherical UVs — the visible background is the real sky, not flat grey.
    const skyMat = new BABYLON.ShaderMaterial('skyMat', scene,
      { vertex: 'nbhdSky', fragment: 'nbhdSky' },
      { attributes: ['position'], uniforms: ['worldViewProjection', 'level'], samplers: ['skyTexture'] });
    skyMat.setTexture('skyTexture', skyTex);
    skyMat.setFloat('level', 0.95);
    skyMat.backFaceCulling = false;
    skyMat.disableDepthWrite = true;
    sky.material = skyMat;
    sky.isPickable = false;
    sky.applyFog = false;
    // infiniteDistance keeps the sky centred on the camera at every position
    // (verified at x=2300). Never frustum-cull it.
    sky.infiniteDistance = true;
    sky.alwaysSelectAsActiveMesh = true;
    sky.renderingGroupId = 0;
    this.sky = sky;

    // ---- Sun (directional) with shadows ----
    // 11am sun — higher than 9am, so a moderately long shadow still falls
    // toward the camera (-Z) and screen-left, clearly visible in front.
    this.sun = new BABYLON.DirectionalLight('sun', new BABYLON.Vector3(-0.48, -0.78, -0.45), scene);
    this.sun.position = new BABYLON.Vector3(48, 78, 45);
    this.sun.intensity = 3.6;
    this.sun.diffuse = new BABYLON.Color3(1.0, 0.96, 0.88);
    this.sun.specular = new BABYLON.Color3(1, 0.98, 0.92);
    // High-res PCF: soft-edged but never blocky or pixelated.
    this.shadowGen = new BABYLON.ShadowGenerator(2048, this.sun);
    this.shadowGen.usePercentageCloserFiltering = true;
    this.shadowGen.filteringQuality = BABYLON.ShadowGenerator.QUALITY_HIGH;
    this.shadowGen.setDarkness(0.12);     // slightly softer than before
    this.shadowGen.bias = 0.00035;
    this.shadowGen.normalBias = 0.008;
    // Tight shadow volume around the player. Auto-fitting a level-long caster
    // list made the map so coarse that the hero's contact shadow vanished.
    this.sun.autoUpdateExtends = false;
    this.sun.orthoLeft = -22; this.sun.orthoRight = 22;
    this.sun.orthoTop = 22; this.sun.orthoBottom = -22;
    this.sun.shadowMinZ = 1;
    this.sun.shadowMaxZ = 120;

    // ---- Fill light ----
    this.hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0), scene);
    this.hemi.intensity = 0.42; // moderate fill — strong shadow contrast
    this.hemi.diffuse = new BABYLON.Color3(0.65, 0.78, 0.95);
    this.hemi.groundColor = new BABYLON.Color3(0.18, 0.16, 0.14);

    // ---- Ground (real-world metric scale) ----
    this.ground = BABYLON.MeshBuilder.CreateGround('ground', { width: 440, height: 200 }, scene);
    const groundMat = new BABYLON.PBRMaterial('groundMat', scene);
    groundMat.albedoColor = new BABYLON.Color3(0.56, 0.58, 0.62); // lighter grey
    groundMat.metallic = 0.05;
    groundMat.roughness = 0.82;
    groundMat.environmentIntensity = 0.6;
    // ---- 1 m × 1 m metric grid (single tiled texture — cheap, crisp) ----
    // One 64px tile = exactly 1 m. uScale/vScale map tiles to the 400×80 m plane.
    const TILE = 64;
    const gridTex = new BABYLON.DynamicTexture('gridTile', { width: TILE, height: TILE }, scene, true);
    const gctx = gridTex.getContext();
    gctx.fillStyle = '#9aa0a6'; // lighter grey floor
    gctx.fillRect(0, 0, TILE, TILE);
    gctx.strokeStyle = 'rgba(120,130,140,0.55)';
    gctx.lineWidth = 2;
    gctx.strokeRect(1, 1, TILE - 2, TILE - 2);
    gridTex.update();
    gridTex.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
    gridTex.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    gridTex.uScale = 440; // level now ends at the portal (~x=200)
    gridTex.vScale = 200;
    groundMat.albedoTexture = gridTex;
    groundMat.albedoColor = new BABYLON.Color3(1, 1, 1);

    this.ground.material = groundMat;
    this.ground.receiveShadows = true;
    this.ground.position.x = 100; // covers the level from x=-120 to x=320

    // Start area kept clean — no calibration chart or material test balls.
  }

  public registerShadowCaster(mesh: BABYLON.AbstractMesh) {
    const rl = this.shadowGen.getShadowMap()!.renderList as BABYLON.AbstractMesh[];
    if (rl.indexOf(mesh) >= 0) return; // never double-register
    this.shadowGen.addShadowCaster(mesh, true);
  }
  public unregisterShadowCaster(mesh: BABYLON.AbstractMesh) {
    try { this.shadowGen.removeShadowCaster(mesh, true); } catch (e) { void e; }
    // Also prune directly — clones may be registered under a descendant name.
    const rl = this.shadowGen.getShadowMap()!.renderList as BABYLON.AbstractMesh[];
    const keep = rl.filter((m) => m !== mesh && !(m.name && mesh.name && m.name.indexOf(mesh.name) === 0));
    rl.length = 0;
    for (const m of keep) rl.push(m);
  }

  /** Keep the sun's shadow volume centred on the action. Position is QUANTIZED
   *  to 40 m steps so the light only jumps occasionally instead of sliding
   *  every frame — continuous movement caused swimming/glitchy shadows. */
  private sunCellX = NaN;
  private sunCellZ = NaN;
  public focusSun(target: BABYLON.Vector3) {
    const cellX = Math.round(target.x / 40) * 40;
    const cellZ = Math.round(target.z / 40) * 40;
    if (cellX !== this.sunCellX || cellZ !== this.sunCellZ) {
      this.sunCellX = cellX; this.sunCellZ = cellZ;
      this.sun.position.set(cellX + 48, target.y + 78, cellZ + 45);
    }
    this.sun.direction.set(-0.48, -0.78, -0.45);
    // Wide fixed frustum so shadows stay stable and cover the play area.
    this.sun.orthoLeft = -40; this.sun.orthoRight = 40;
    this.sun.orthoTop = 40; this.sun.orthoBottom = -40;
  }

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
