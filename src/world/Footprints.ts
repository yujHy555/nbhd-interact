import * as BABYLON from 'babylonjs';

/**
 * FOOTPRINTS — soft ground decals that appear under each footfall and fade
 * away after one second. A small fixed pool of textured planes keeps it cheap;
 * the artwork is a painted canvas (no geometry cost, no shadow casting).
 */
export class Footprints {
  private scene: BABYLON.Scene;
  private groundAt: (x: number, z: number) => number;
  private pool: { mesh: BABYLON.Mesh; mat: BABYLON.StandardMaterial; life: number }[] = [];
  private idx = 0;

  constructor(scene: BABYLON.Scene, groundAt: (x: number, z: number) => number) {
    this.scene = scene;
    this.groundAt = groundAt;

    // Painted shoe-print: dark soft oval with a wider toe and a small heel,
    // feathered edges so it blends into the concrete grid.
    const S = 64;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, S, S);
    const paint = (cx: number, cy: number, rx: number, ry: number) => {
      const g = ctx.createRadialGradient(cx, cy, 1, cx, cy, Math.max(rx, ry));
      g.addColorStop(0, 'rgba(18,24,30,0.85)');
      g.addColorStop(0.6, 'rgba(18,24,30,0.55)');
      g.addColorStop(1, 'rgba(18,24,30,0)');
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(rx / Math.max(rx, ry), ry / Math.max(rx, ry));
      ctx.translate(-cx, -cy);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, Math.max(rx, ry), 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    };
    paint(S * 0.5, S * 0.36, 9, 13); // toe
    paint(S * 0.5, S * 0.68, 7, 8);  // heel
    const tex = new BABYLON.Texture(cv.toDataURL(), this.scene, false, true);
    tex.hasAlpha = true;

    for (let i = 0; i < 28; i++) {
      const mat = new BABYLON.StandardMaterial(`footprintMat${i}`, this.scene);
      mat.diffuseTexture = tex;
      mat.emissiveTexture = tex;
      mat.opacityTexture = tex;
      (mat.opacityTexture as BABYLON.Texture).getAlphaFromRGB = false;
      mat.useAlphaFromDiffuseTexture = true;
      mat.diffuseColor = BABYLON.Color3.Black();
      mat.emissiveColor = BABYLON.Color3.Black();
      mat.disableLighting = true;
      mat.backFaceCulling = false;
      mat.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
      mat.alpha = 0;
      const mesh = BABYLON.MeshBuilder.CreateGround(`footprint${i}`, { width: 0.42, height: 0.26 }, this.scene);
      mesh.material = mat;
      mesh.isPickable = false;
      mesh.receiveShadows = false;
      mesh.applyFog = false;
      mesh.setEnabled(false);
      this.pool.push({ mesh, mat, life: 0 });
    }
  }

  /** Spawn one footprint. `facing` is the player's heading angle; `side` is
   *  +1 for the right foot, -1 for the left. */
  public spawn(x: number, z: number, facing: number, side = 1) {
    const p = this.pool[this.idx++ % this.pool.length];
    // Perpendicular to travel direction (forward = sin/cos of facing).
    const rx = Math.cos(facing), rz = -Math.sin(facing);
    const fx = x + rx * 0.22 * side;
    const fz = z + rz * 0.22 * side;
    p.mesh.position.set(fx, this.groundAt(fx, fz) + 0.03, fz);
    p.mesh.rotation.y = -facing;
    p.mesh.scaling.setAll(1);
    p.mat.alpha = 0.85;
    p.life = 1;
    p.mesh.setEnabled(true);
  }

  public update(dt: number) {
    for (const p of this.pool) {
      if (p.life <= 0) continue;
      p.life = Math.max(0, p.life - dt);
      p.mat.alpha = 0.85 * p.life;
      if (p.life <= 0) p.mesh.setEnabled(false);
    }
  }

  public dispose() {
    for (const p of this.pool) { p.mesh.dispose(); p.mat.dispose(); }
    this.pool = [];
  }
}
