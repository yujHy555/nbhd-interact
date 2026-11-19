import * as BABYLON from 'babylonjs';
import { Materials } from './Materials';

export interface BoxCollider { x: number; y: number; z: number; w: number; h: number; d: number; }
/** A walkable ramp rising along +X. Its top surface is EXACTLY y0→y1. */
export interface SlopeCollider { x: number; z: number; w: number; d: number; y0: number; y1: number; }
export interface Pickup { mesh: BABYLON.Mesh; pos: BABYLON.Vector3; collected: boolean; phase: number; }
export interface ZoneMarker { x: number; name: string; }
/** A conveyor belt that carries the player along +X when standing on it. */
export interface Travelator { x: number; z: number; w: number; d: number; top: number; speed: number; }

/** Continuous horizontal prototype world — three zones, metric scale. */
export class World {
  public colliders: BoxCollider[] = [];
  public slopes: SlopeCollider[] = [];
  public travelators: Travelator[] = [];
  public pickups: Pickup[] = [];
  public zones: ZoneMarker[] = [
    { x: 0, name: 'WELCOME' },
    { x: 78, name: 'WHAT WE DO' },
    { x: 156, name: 'CONTACT' },
  ];
  private scene: BABYLON.Scene;
  private mats: Materials;
  private root: BABYLON.TransformNode;
  private signs: BABYLON.Mesh[] = [];
  private t = 0;
  public onPickup?: (p: Pickup) => void;
  public onZone?: (zone: ZoneMarker) => void;
  private lastZone = -1;

  constructor(scene: BABYLON.Scene, mats: Materials) {
    this.scene = scene;
    this.mats = mats;
    this.root = new BABYLON.TransformNode('worldRoot', scene);
    this.build();
  }

  private addPlatform(x: number, y: number, z: number, w: number, h: number, d: number, color?: [number, number, number]) {
    const box = BABYLON.MeshBuilder.CreateBox('platform', { width: w, height: h, depth: d }, this.scene);
    box.position.set(x, y, z);
    box.material = color ? this.mats.matte('platAccent', color) : this.mats.concrete('platConcrete');
    box.receiveShadows = true;
    this.colliders.push({ x, y, z, w, h, d });
    // No decorative top slab — a raised slab made shoes visibly sink into it.
    return box;
  }

  /** Solid industrial wedge ramp. The top plane is built from exact vertices
   *  from (x0,y0) to (x1,y1), so the visible tread and the collision surface
   *  are the SAME plane — no shearing approximation, unmistakably angled. */
  private addRamp(x0: number, y0: number, x1: number, y1: number, z: number, d: number) {
    const w = x1 - x0;
    const cx = (x0 + x1) / 2;
    const z0 = z - d / 2, z1 = z + d / 2;
    const base = y0 - 0.12;

    // Ribbed tread texture
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 128;
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = '#969da3'; ctx.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 128; i += 8) {
      ctx.fillStyle = i % 16 === 0 ? '#666e76' : '#b0b7bd';
      ctx.fillRect(i, 0, 3, 128);
    }
    const treadTex = new BABYLON.Texture(cv.toDataURL(), this.scene);
    const tread = new BABYLON.PBRMaterial('rampTread', this.scene);
    tread.albedoTexture = treadTex;
    tread.metallic = 0.35; tread.roughness = 0.62;

    // Solid wedge: sloped top, flat base, vertical high end, triangular sides.
    const P = [
      x0, y0, z0,  x1, y1, z0,  x1, base, z0,   // 0,1,2 front
      x0, y0, z1,  x1, y1, z1,  x1, base, z1,   // 3,4,5 back
    ];
    const I = [
      0, 2, 1, 3, 4, 5,             // triangular sides
      0, 1, 4, 0, 4, 3,             // sloped top tread
      0, 3, 5, 0, 5, 2,             // flat base
      1, 2, 5, 1, 5, 4,             // vertical high end
    ];
    const uv: number[] = [];
    for (let i = 0; i < P.length; i += 3) uv.push((P[i] - x0) / w * 3, (P[i + 2] - z0) / d);
    const vd = new BABYLON.VertexData();
    vd.positions = P; vd.indices = I; vd.uvs = uv; vd.normals = [];
    BABYLON.VertexData.ComputeNormals(P, I, vd.normals);
    const deck = new BABYLON.Mesh('ramp', this.scene);
    vd.applyToMesh(deck);
    deck.material = tread;
    deck.receiveShadows = true;
    deck.convertToFlatShadedMesh();

    // Side rails along the sloping top edges
    const railMat = this.mats.pbr('rampRail', [0.16, 0.18, 0.2], 0.6, 0.45);
    [-1, 1].forEach((side) => {
      const zz = z + side * (d / 2 - 0.1);
      const rail = BABYLON.MeshBuilder.CreateBox('rampRail', { width: w, height: 0.16, depth: 0.16 }, this.scene);
      rail.position.set(cx, (y0 + y1) / 2 + 0.08, zz);
      rail.rotation.z = Math.atan2(y1 - y0, w); // matches the tread gradient
      rail.material = railMat;
      rail.receiveShadows = true;
    });

    // Bolted low edge
    for (let i = 0; i < 6; i++) {
      const bolt = BABYLON.MeshBuilder.CreateCylinder('rampBolt', { diameter: 0.09, height: 0.04, tessellation: 10 }, this.scene);
      bolt.position.set(x0 + (w * (i + 0.5)) / 6, y0 + 0.05, z0 - 0.04);
      bolt.rotation.x = Math.PI / 2;
      bolt.material = railMat;
    }

    this.slopes.push({ x: cx, z, w, d, y0, y1 });
    return deck;
  }

  /** Conveyor belt: a low slab with a scrolling chevron belt material and
   *  end rollers. Standing on it carries the player along +X. */
  private addTravelator(x: number, z: number, w: number, d: number, speed: number) {
    const top = 0.22;
    const deck = BABYLON.MeshBuilder.CreateBox('travelator', { width: w, height: top, depth: d }, this.scene);
    deck.position.set(x, top / 2, z);
    deck.receiveShadows = true;
    this.colliders.push({ x, y: top / 2, z, w, h: top, d });

    // Belt material with animated scrolling stripes
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 128;
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = '#2b3238'; ctx.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 128; i += 32) {
      ctx.fillStyle = '#48525b';
      ctx.fillRect(i, 0, 6, 128);
      ctx.fillStyle = '#1c2126';
      ctx.fillRect(i + 6, 0, 4, 128);
    }
    const tex = new BABYLON.Texture(cv.toDataURL(), this.scene);
    tex.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
    tex.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    tex.uScale = w / 1.5;
    this.beltTextures.push(tex);
    const belt = new BABYLON.PBRMaterial('travelatorBelt', this.scene);
    belt.albedoTexture = tex;
    belt.metallic = 0.2; belt.roughness = 0.7;
    deck.material = belt;

    // End rollers + hazard side rails
    const metal = this.mats.pbr('travelatorMetal', [0.16, 0.2, 0.24], 0.7, 0.4);
    [-1, 1].forEach((side) => {
      const roller = BABYLON.MeshBuilder.CreateCylinder('travelatorRoller', { diameter: top * 1.5, height: d, tessellation: 20 }, this.scene);
      roller.position.set(x + side * w / 2, top / 2, z);
      roller.rotation.x = Math.PI / 2;
      roller.material = metal;
      roller.receiveShadows = true;
      const rail = BABYLON.MeshBuilder.CreateBox('travelatorRail', { width: w, height: 0.14, depth: 0.14 }, this.scene);
      rail.position.set(x, top + 0.24, z + side * (d / 2 - 0.07));
      rail.material = this.mats.matte('travelatorRailMat', [0.95, 0.72, 0.12]);
      rail.receiveShadows = true;
    });
    this.travelators.push({ x, z, w, d, top, speed });
  }

  private beltTextures: BABYLON.Texture[] = [];

  private build() {
    // ---- Welcome zone (0..70): material test area, hero starts on ground ----
    // Welcome zone stepping platforms
    this.addPlatform(10, 0.5, 0, 4, 1, 4, [0.2, 0.9, 1]);      // top 1.0
    this.addPlatform(18, 1.1, 0, 4, 1, 4, [0.2, 0.9, 1]);      // top 1.6
    this.addPlatform(26, 1.8, 0, 5, 1, 4, [0.2, 0.9, 1]);      // top 2.3
    // Single 30° ramp: rises from the ground to meet the platform at x=44
    // exactly at its top (2.7 m), so slope detection and alignment line up.
    this.addRamp(39.3231, 0, 44, 2.7, 0, 6);
    this.addPlatform(47, 2.2, 0, 6, 1, 4, [0.2, 0.9, 1]);      // top 2.7
    // Road section occupies x=52..92 — no platforms on or with the road.

    // ---- Travelator (conveyor) section x=94..108 — after the road ----
    this.addTravelator(101, 0, 14, 5, 4.6); // slightly faster than a walk (3.0)

    // ---- What We Do zone (78..150): content cubes + platforms ----
    // Keep x=52..92 clear for the modular road.
    this.addPlatform(116, 2.6, 0, 5, 1, 5, [1, 0.78, 0.2]);     // top 3.1
    this.addPlatform(120, 3.0, 0, 6, 1, 5, [1, 0.78, 0.2]);     // top 3.5
    this.addPlatform(134, 3.6, 0, 6, 1, 5, [1, 0.78, 0.2]);     // top 4.1
    this.addPlatform(146, 3.0, 0, 6, 1, 5, [1, 0.78, 0.2]);     // top 3.5

    // ---- Contact zone (156..200) ----
    this.addPlatform(158, 2.2, 0, 6, 1, 5, [0.95, 0.4, 0.75]);
    this.addPlatform(170, 1.6, 0, 6, 1, 5, [0.95, 0.4, 0.75]);
    this.addPlatform(182, 1.0, 0, 8, 1, 5, [0.95, 0.4, 0.75]);

    // Prototype cubes scattered along the route
    for (let i = 0; i < 12; i++) {
      const x = 8 + i * 15;
      if (x >= 52 && x <= 92) continue; // keep the road section completely clear
      const s = 0.8 + (i % 3) * 0.35;
      const cube = BABYLON.MeshBuilder.CreateBox('protoCube', { size: s }, this.scene);
      cube.position.set(x, s / 2 + (i % 2 ? 0.6 : 0), -5 - (i % 3));
      cube.material = this.mats.emissive('protoCubeMat', [0.35 + (i % 4) * 0.12, 0.6, 0.95]);
      cube.rotation.y = i * 0.4;
      cube.isPickable = false;
      this.colliders.push({ x: cube.position.x, y: cube.position.y, z: cube.position.z, w: s, h: s, d: s });
    }

    // Pickups
    for (let i = 0; i < 16; i++) {
      const x = 12 + i * 10.5;
      const y = 2.6 + Math.sin(i * 0.8) * 0.8;
      const orb = BABYLON.MeshBuilder.CreateSphere('pickup', { diameter: 0.55, segments: 14 }, this.scene);
      orb.position.set(x, y, 0);
      orb.material = this.mats.emissive('pickupMat', [1, 0.82, 0.2]);
      this.pickups.push({ mesh: orb, pos: orb.position.clone(), collected: false, phase: i * 0.7 });
    }

    // Zone sign posts (skip the start area — keep it clean)
    for (const z of this.zones) if (z.x > 0) this.addZoneSign(z);
  }

  private addZoneSign(zone: ZoneMarker) {
    const post = BABYLON.MeshBuilder.CreateCylinder('zonePost', { diameter: 0.25, height: 7, tessellation: 12 }, this.scene);
    post.position.set(zone.x, 3.5, -5);
    post.material = this.mats.concrete('zonePostMat');
    const panel = BABYLON.MeshBuilder.CreateBox('zonePanel', { width: 4.5, height: 1.4, depth: 0.2 }, this.scene);
    panel.position.set(zone.x, 6.2, -5);
    panel.material = this.mats.emissive('zonePanelMat', [0.2, 0.9, 1]);
    this.signs.push(panel);
  }

  /** Belt speed affecting the player at the given feet position (world +X). */
  public travelatorSpeedAt(x: number, z: number, feetY: number): number {
    for (const t of this.travelators) {
      if (x > t.x - t.w / 2 && x < t.x + t.w / 2 &&
          z > t.z - t.d / 2 && z < t.z + t.d / 2 &&
          Math.abs(feetY - t.top) < 0.25) return t.speed;
    }
    return 0;
  }

  public update(dt: number, playerX: number) {
    this.t += dt;
    for (const tex of this.beltTextures) tex.uOffset -= dt * this.travelators[0].speed / 1.5;
    for (const p of this.pickups) {
      if (p.collected) continue;
      p.mesh.rotation.y += dt * 1.8;
      p.mesh.position.y = p.pos.y + Math.sin(this.t * 2 + p.phase) * 0.22;
      if (BABYLON.Vector3.Distance(p.mesh.position, new BABYLON.Vector3(playerX, p.pos.y, 0)) < 1.2) {
        p.collected = true;
        p.mesh.setEnabled(false);
        this.onPickup?.(p);
      }
    }
    for (let i = 0; i < this.signs.length; i++) {
      this.signs[i].scaling.y = 1 + Math.sin(this.t * 3 + i) * 0.04;
    }
    // Zone detection
    let current = 0;
    for (let i = 0; i < this.zones.length; i++) if (playerX >= this.zones[i].x - 4) current = i;
    if (current !== this.lastZone) {
      this.lastZone = current;
      this.onZone?.(this.zones[current]);
    }
  }

  public dispose() { this.root.dispose(false, false); }
}
