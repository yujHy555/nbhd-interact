import * as BABYLON from 'babylonjs';

/** Shared cached material factory for the prototype world. */
export class Materials {
  private scene: BABYLON.Scene;
  private cache = new Map<string, BABYLON.Material>();
  constructor(scene: BABYLON.Scene) { this.scene = scene; }

  emissive(name: string, rgb: [number, number, number], alpha = 1) {
    const key = `em-${name}-${rgb.join('-')}-${alpha}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    const m = new BABYLON.StandardMaterial(name, this.scene);
    const c = new BABYLON.Color3(rgb[0], rgb[1], rgb[2]);
    m.diffuseColor = c;
    m.emissiveColor = c;
    m.disableLighting = true;
    m.alpha = alpha;
    this.cache.set(key, m);
    return m;
  }

  concrete(name: string) {
    const key = `concrete-${name}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    const m = new BABYLON.PBRMaterial(name, this.scene);
    m.albedoColor = new BABYLON.Color3(0.28, 0.32, 0.38);
    m.metallic = 0.08; m.roughness = 0.78;
    m.environmentIntensity = 0.75;
    this.cache.set(key, m);
    return m;
  }
}
