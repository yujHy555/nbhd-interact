import * as BABYLON from 'babylonjs';

/** Shared cached material factory for the prototype world. */
export class Materials {
  private scene: BABYLON.Scene;
  private cache = new Map<string, BABYLON.Material>();
  constructor(scene: BABYLON.Scene) { this.scene = scene; }

  /** Lit StandardMaterial (Lambert-style) with a subtle emissive tint —
   *  never flat/unlit, so sun + shadows always shape the surface. */
  emissive(name: string, rgb: [number, number, number], alpha = 1) {
    const key = `em-${name}-${rgb.join('-')}-${alpha}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    const m = new BABYLON.StandardMaterial(name, this.scene);
    const c = new BABYLON.Color3(rgb[0], rgb[1], rgb[2]);
    m.diffuseColor = c;
    m.specularColor = new BABYLON.Color3(0.05, 0.05, 0.05);
    m.emissiveColor = c.scale(0.12); // subtle accent — keeps shadows readable
    m.disableLighting = false;      // lighting ENABLED → real shading
    m.alpha = alpha;
    this.cache.set(key, m);
    return m;
  }

  /** Matte StandardMaterial for colored platforms — NO specular/highlights. */
  matte(name: string, rgb: [number, number, number]) {
    const key = `matte-${name}-${rgb.join('-')}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    const m = new BABYLON.StandardMaterial(name, this.scene);
    m.diffuseColor = new BABYLON.Color3(rgb[0], rgb[1], rgb[2]);
    m.specularColor = BABYLON.Color3.Black(); // zero reflections
    m.emissiveColor = new BABYLON.Color3(0, 0, 0);
    m.disableLighting = false;
    this.cache.set(key, m);
    return m;
  }

  /** Proper lit StandardMaterial for all platforms / surfaces. */
  concrete(name: string) {
    const key = `concrete-${name}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    const m = new BABYLON.StandardMaterial(name, this.scene);
    m.diffuseColor = new BABYLON.Color3(0.38, 0.43, 0.5);
    m.specularColor = new BABYLON.Color3(0.03, 0.035, 0.04); // near-zero — matte
    m.specularPower = 8;
    m.emissiveColor = new BABYLON.Color3(0.0, 0.0, 0.0); // no flat lift
    m.disableLighting = false;
    this.cache.set(key, m);
    return m;
  }

  /** PBR metallic-roughness material for hero props / showcase objects. */
  pbr(name: string, rgb: [number, number, number], metallic: number, roughness: number) {
    const key = `pbr-${name}-${rgb.join('-')}-${metallic}-${roughness}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    const m = new BABYLON.PBRMaterial(name, this.scene);
    m.albedoColor = new BABYLON.Color3(rgb[0], rgb[1], rgb[2]);
    m.metallic = metallic;
    m.roughness = roughness;
    m.environmentIntensity = 1.0;
    this.cache.set(key, m);
    return m;
  }
}
