import * as BABYLON from 'babylonjs';
import { Materials } from './Materials';

export interface BoxCollider { x: number; y: number; z: number; w: number; h: number; d: number; }
/** A walkable ramp rising along +X. Its top surface is EXACTLY y0→y1. */
export interface SlopeCollider { x: number; z: number; w: number; d: number; y0: number; y1: number; }
export interface Pickup { mesh: BABYLON.Mesh; pos: BABYLON.Vector3; collected: boolean; phase: number; }
export interface ZoneMarker { x: number; name: string; }

/** Continuous horizontal prototype world — three zones, metric scale. */
export class World {
  public colliders: BoxCollider[] = [];
  public slopes: SlopeCollider[] = [];
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
    // Glowing top edge
    const edge = BABYLON.MeshBuilder.CreateBox('platEdge', { width: w, height: 0.05, depth: d }, this.scene);
    edge.position.set(x, y + h / 2 + 0.03, z);
    edge.material = this.mats.emissive('platEdge', color ?? [0.2, 0.9, 1]);
    edge.isPickable = false;
    return box;
  }

  /** Build a ramp whose visible top surface and collision surface are the
   *  SAME plane — no approximation. The box is sheared (not rotated) so the
   *  run stays horizontal and the slope angle matches atan2(rise, run). */
  private addRamp(x0: number, y0: number, x1: number, y1: number, z: number, d: number) {
    const w = x1 - x0;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const T = 0.22; // slab thickness
    const ramp = BABYLON.MeshBuilder.CreateBox('ramp', { width: w, height: T, depth: d }, this.scene);
    ramp.position.set(cx, cy - T / 2, z);
    // Shear: shift each vertex's Y by its X position × gradient.
    const positions = ramp.getVerticesData(BABYLON.VertexBuffer.PositionKind)!;
    const rise = y1 - y0;
    for (let i = 0; i < positions.length; i += 3) positions[i + 1] += (positions[i] / w) * rise;
    ramp.updateVerticesData(BABYLON.VertexBuffer.PositionKind, positions);
    const indices = ramp.getIndices()!;
    const normals: number[] = [];
    BABYLON.VertexData.ComputeNormals(positions, indices, normals);
    ramp.updateVerticesData(BABYLON.VertexBuffer.NormalKind, normals);
    ramp.material = this.mats.concrete('rampMat');
    ramp.receiveShadows = true;
    this.slopes.push({ x: cx, z, w, d, y0, y1 });
    return ramp;
  }

  private build() {
    // ---- Welcome zone (0..70): material test area, hero starts on ground ----
    // Welcome zone stepping platforms
    this.addPlatform(10, 0.5, 0, 4, 1, 4, [0.2, 0.9, 1]);      // top 1.0
    this.addPlatform(18, 1.1, 0, 4, 1, 4, [0.2, 0.9, 1]);      // top 1.6
    this.addPlatform(26, 1.8, 0, 5, 1, 4, [0.2, 0.9, 1]);      // top 2.3
    // Single showcase incline: exactly 30° (rise = 4·tan30° ≈ 2.309 m)
    this.addRamp(30, 0, 34, 2.3094, 0, 6);
    this.addPlatform(47, 2.2, 0, 6, 1, 4, [0.2, 0.9, 1]);      // top 2.7
    this.addPlatform(58, 2.8, 0, 6, 1, 4, [0.2, 0.9, 1]);      // top 3.3

    // ---- What We Do zone (78..150): content cubes + platforms ----
    this.addPlatform(72, 1.0, 0, 6, 1, 5, [1, 0.78, 0.2]);
    this.addPlatform(84, 1.8, 0, 5, 1, 5, [1, 0.78, 0.2]);      // top 2.3
    this.addPlatform(96, 2.6, 0, 5, 1, 5, [1, 0.78, 0.2]);      // top 3.1
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

  public update(dt: number, playerX: number) {
    this.t += dt;
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
