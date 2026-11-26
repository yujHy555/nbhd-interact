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
    { x: 192, name: 'PIXEL PORTAL' },
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
      // Solid barrier so the player can't walk through the silver side rails.
      // Slightly taller than the visual rail so the step-up allowance in
      // wallAt() doesn't skip it while climbing the ramp.
      this.colliders.push({
        x: cx, y: (y0 + y1) / 2 + 0.25, z: zz,
        w, h: 0.9, d: 0.16,
      });
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

    // Belt — crosswise slats on a rich rubber surface with subtle tread speckle.
    // Vertical canvas bands (constant U) run across the belt and scroll along X.
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 128;
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = '#24292e'; ctx.fillRect(0, 0, 128, 128); // dark rubber
    for (let i = 0; i < 1400; i++) {
      ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.05)';
      ctx.fillRect(Math.random() * 128, Math.random() * 128, 2, 2);
    }
    for (let i = 0; i < 128; i += 32) {
      ctx.fillStyle = '#586571';            // bright slat
      ctx.fillRect(i, 0, 9, 128);
      ctx.fillStyle = '#15191d';            // soft shadow groove
      ctx.fillRect(i + 9, 0, 5, 128);
    }
    const tex = new BABYLON.Texture(cv.toDataURL(), this.scene);
    tex.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
    tex.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    tex.uScale = w / 1.5;
    this.beltTextures.push(tex);
    const belt = new BABYLON.PBRMaterial('travelatorBelt', this.scene);
    belt.albedoTexture = tex;
    belt.metallic = 0.05; belt.roughness = 0.92; // matte rubber
    deck.material = belt;
    deck.receiveShadows = true;

    // End rollers + hazard side rails
    const metal = this.mats.pbr('travelatorMetal', [0.16, 0.2, 0.24], 0.7, 0.4);
    [-1, 1].forEach((side) => {
      // Rollers sit OUTSIDE the deck ends (no coplanar overlap → no z-fighting).
      const roller = BABYLON.MeshBuilder.CreateCylinder('travelatorRoller', { diameter: top * 1.5, height: d + 0.12, tessellation: 20 }, this.scene);
      roller.position.set(x + side * (w / 2 + 0.06), top / 2 + 0.005, z);
      roller.rotation.x = Math.PI / 2;
      roller.material = metal;
      roller.receiveShadows = true;
      // Rails float above the belt edge with clear separation.
      const rail = BABYLON.MeshBuilder.CreateBox('travelatorRail', { width: w + 0.12, height: 0.14, depth: 0.14 }, this.scene);
      rail.position.set(x, top + 0.28, z + side * (d / 2 + 0.04));
      rail.material = this.mats.matte('travelatorRailMat', [0.95, 0.72, 0.12]);
      rail.receiveShadows = true;
      // Exact collider for the rail — acts as a solid barrier at the belt edge.
      this.colliders.push({
        x: x,
        y: top + 0.28,
        z: rail.position.z,
        w: w + 0.12,
        h: 0.14,
        d: 0.14,
      });
    });
    this.travelators.push({ x, z, w, d, top, speed });
  }

  private beltTextures: BABYLON.Texture[] = [];
  private toonMats!: { cardboard: BABYLON.Material; tape: BABYLON.Material; ink: BABYLON.Material };

  /** Painted cardboard texture generated on a canvas — clean, no stray
   *  geometry. Tape, flap seams and a cute face are all painted into the
   *  texture, so the box is ONE mesh with no overlapping black shapes. */
  private initToonShader() {
    if (this.toonMats) return;
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 256;
    const c = cv.getContext('2d')!;
    // Warm cardboard base with subtle fibre speckle
    c.fillStyle = '#c89455';
    c.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 900; i++) {
      c.fillStyle = i % 3 ? 'rgba(120,80,40,0.05)' : 'rgba(255,230,180,0.05)';
      c.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
    }
    // Painted top flaps + tape (top face = UV region around y<.33 on a box)
    c.fillStyle = '#b5834a';
    c.fillRect(0, 0, 256, 60);
    c.fillStyle = '#dcb079';
    c.fillRect(112, 0, 32, 60); // tape strip on top
    // Soft painted face — warm brown, no hard black lines
    c.fillStyle = '#6b4426';
    c.beginPath(); c.arc(34, 150, 7, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.arc(62, 150, 7, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#8a5a34';
    c.beginPath(); c.ellipse(48, 166, 12, 7, 0, 0, Math.PI * 2); c.fill();
    // Rosy cheeks
    c.fillStyle = 'rgba(220,130,100,0.25)';
    c.beginPath(); c.arc(20, 160, 6, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.arc(76, 160, 6, 0, Math.PI * 2); c.fill();

    const tex = new BABYLON.Texture(cv.toDataURL(), this.scene);
    const m = new BABYLON.StandardMaterial('pickupCardboard', this.scene);
    m.diffuseTexture = tex;
    m.specularColor = new BABYLON.Color3(0.04, 0.04, 0.04);
    m.emissiveColor = new BABYLON.Color3(0.14, 0.1, 0.05); // soft lift, keeps toon look
    m.disableLighting = false;
    this.toonMats = { cardboard: m, tape: m, ink: m };
  }

  private build() {
    // ---- Welcome zone (0..70): material test area, hero starts on ground ----
    // Long starting travelator (x=2..26) — a proper opening conveyor run.
    // The first two small stepping platforms were removed so nothing
    // intersects it; the next surface is the 30° ramp after x=26.
    this.addTravelator(14, 0, 24, 5, 6.5);
    // Single 30° ramp: rises from the ground to meet the platform at x=44
    // exactly at its top (2.7 m), so slope detection and alignment line up.
    this.addRamp(39.3231, 0, 44, 2.7, 0, 6);
    this.addPlatform(47, 2.2, 0, 6, 1, 4, [0.2, 0.9, 1]);      // top 2.7
    // Road section occupies x=52..92 — no platforms on or with the road.

    // ---- Travelator (conveyor) section x=94..108 — after the road ----
    this.addTravelator(101, 0, 14, 5, 7.5); // fast conveyor — clearly carries the player

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

    // Everything beyond the pixel portal (x=192) is intentionally empty —
    // the world ends at the portal and new zones will be added deliberately.

    // AAA STYLIZED collectibles — cute little cardboard boxes with toon
    // shading, tape strips, flaps and a happy face. Placed high above the
    // highest nearby surface so they NEVER intersect anything.
    this.initToonShader();

    for (let i = 0; i < 60; i++) {
      const x = 12 + i * 38;
      if (x > 188) break; // nothing past the pixel portal
      const z = 0;
      let base = 0;
      for (let dx = -3; dx <= 3; dx += 1.5) {
        for (let dz = -3; dz <= 3; dz += 1.5) base = Math.max(base, this.surfaceHeightAt(x + dx, z + dz));
      }
      const y = base + 2.0;
      const root = new BABYLON.TransformNode(`pickup${i}`, this.scene);
      root.position.set(x, y, z);

      // Cardboard box body (toon shaded)
      const body = BABYLON.MeshBuilder.CreateBox('pickupBox', { size: 0.42 }, this.scene);
      body.material = this.toonMats.cardboard;
      body.parent = root;
      // Top tape strip
      const tape = BABYLON.MeshBuilder.CreateBox('pickupTape', { width: 0.1, height: 0.012, depth: 0.43 }, this.scene);
      tape.position.y = 0.216;
      tape.material = this.toonMats.tape;
      tape.parent = root;
      // Flap seam line across the top
      const seam = BABYLON.MeshBuilder.CreateBox('pickupSeam', { width: 0.43, height: 0.008, depth: 0.012 }, this.scene);
      seam.position.y = 0.213;
      seam.material = this.toonMats.ink;
      seam.parent = root;
      // Cute face — two eyes + smile on the front (+Z) face
      [-0.09, 0.09].forEach((ex) => {
        const eye = BABYLON.MeshBuilder.CreateBox('pickupEye', { width: 0.055, height: 0.075, depth: 0.015 }, this.scene);
        eye.position.set(ex, 0.05, 0.216);
        eye.material = this.toonMats.ink;
        eye.parent = root;
      });
      const smile = BABYLON.MeshBuilder.CreateBox('pickupSmile', { width: 0.11, height: 0.02, depth: 0.015 }, this.scene);
      smile.position.set(0, -0.02, 0.216);
      smile.material = this.toonMats.ink;
      smile.parent = root;

      this.pickups.push({ mesh: root as any, pos: root.position.clone(), collected: false, phase: i * 0.7 });
    }

    // Zone sign posts (skip the start area — keep it clean)
    // Sign boards / poles removed — they were the source of the long hairline
    // shadows that shifted with the camera. Zone names still appear in the HUD.
  }

  /** Highest surface at (x,z) — platforms, ramps, travelators, ground. */
  public surfaceHeightAt(x: number, z: number): number {
    let h = 0;
    for (const c of this.colliders) {
      const top = c.y + c.h / 2;
      if (top > h && x > c.x - c.w / 2 && x < c.x + c.w / 2 && z > c.z - c.d / 2 && z < c.z + c.d / 2) h = top;
    }
    for (const s of this.slopes) {
      if (x >= s.x - s.w / 2 && x <= s.x + s.w / 2 && z >= s.z - s.d / 2 && z <= s.z + s.d / 2) {
        const t = (x - (s.x - s.w / 2)) / s.w;
        h = Math.max(h, s.y0 + (s.y1 - s.y0) * t);
      }
    }
    return h;
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
    // Original belt scroll: uOffset -= dt * speed / 1.5
    for (let i = 0; i < this.beltTextures.length; i++) {
      this.beltTextures[i].uOffset -= dt * this.travelators[i].speed / 1.5;
    }
    for (const p of this.pickups) {
      if (p.collected) continue;
      const bob = Math.sin(this.t * 2 + p.phase);
      p.mesh.rotation.y += dt * 0.9;
      p.mesh.position.y = p.pos.y + bob * 0.16;
      // Squash & stretch: stretch when rising, squash at the top of the bob.
      // Volume-preserving: when Y grows, X/Z shrink and vice versa.
      const phase = this.t * 3 + p.phase;
      const sy = 1 + Math.sin(phase) * 0.13;
      const sxz = 1 / Math.sqrt(sy);
      (p.mesh as any).scaling.set(sxz, sy, sxz);
      const kids = p.mesh.getChildren() as BABYLON.AbstractMesh[];
      if (kids[0]) kids[0].rotation.y += dt * 1.4;
      if (kids[1]) kids[1].scaling.setAll(0.9 + Math.sin(this.t * 4 + p.phase) * 0.15);
      for (let k = 2; k < kids.length; k++) kids[k].rotation.z += dt * (k % 2 ? 1.6 : -1.3);
      if (BABYLON.Vector3.Distance(p.mesh.position, new BABYLON.Vector3(playerX, p.pos.y, 0)) < 1.3) {
        p.collected = true;
        p.mesh.setEnabled(false);
        this.onPickup?.(p);
      }
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
