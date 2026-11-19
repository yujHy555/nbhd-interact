import * as BABYLON from 'babylonjs';

export type AnimState = 'idle' | 'walk' | 'run' | 'jump' | 'fall' | 'land';

export interface CharacterColors {
  skin: [number, number, number];
  outfit: [number, number, number];
  accent: [number, number, number];
  shoes: [number, number, number];
  hair: [number, number, number];
}

export const DEFAULT_COLORS: CharacterColors = {
  skin: [0.86, 0.65, 0.48],
  outfit: [0.12, 0.42, 0.78],
  accent: [0.95, 0.78, 0.18],
  shoes: [0.1, 0.12, 0.16],
  hair: [0.18, 0.12, 0.09],
};

/**
 * AAA procedural humanoid — ~1.8 m real-world scale, hierarchical rig,
 * hand-authored procedural animation states (idle/walk/run/jump/fall/land),
 * full PBR materials, cosmetics, facial detail and secondary motion.
 *
 * A .gltf character can be swapped in later without touching the game API.
 */
export class Character {
  public root: BABYLON.TransformNode;
  public state: AnimState = 'idle';
  public colors: CharacterColors = { ...DEFAULT_COLORS };
  public onLand?: () => void;
  private scene: BABYLON.Scene;
  private t = 0;
  private phase = 0;
  private blend = 1;
  private prevState: AnimState = 'idle';
  private verticalVel = 0;
  private squash = 0;

  // Rig nodes
  private pelvis!: BABYLON.TransformNode;
  private torso!: BABYLON.TransformNode;
  private chest!: BABYLON.TransformNode;
  private head!: BABYLON.TransformNode;
  private armL!: BABYLON.TransformNode; private elbowL!: BABYLON.TransformNode;
  private armR!: BABYLON.TransformNode; private elbowR!: BABYLON.TransformNode;
  private legL!: BABYLON.TransformNode; private kneeL!: BABYLON.TransformNode;
  private legR!: BABYLON.TransformNode; private kneeR!: BABYLON.TransformNode;
  private footL!: BABYLON.TransformNode; private footR!: BABYLON.TransformNode;

  // Materials
  private skinMat!: BABYLON.PBRMaterial;
  private outfitMat!: BABYLON.PBRMaterial;
  private accentMat!: BABYLON.PBRMaterial;
  private shoesMat!: BABYLON.PBRMaterial;
  private hairMat!: BABYLON.PBRMaterial;
  private eyeMat!: BABYLON.StandardMaterial;
  private pupilMat!: BABYLON.StandardMaterial;
  private meshes: BABYLON.Mesh[] = [];

  constructor(scene: BABYLON.Scene) {
    this.scene = scene;
    this.root = new BABYLON.TransformNode('characterRoot', scene);
    this.buildMaterials();
    this.buildRig();
  }

  private buildMaterials() {
    const mk = (name: string) => {
      const m = new BABYLON.PBRMaterial(name, this.scene);
      m.metallic = 0.05; m.roughness = 0.62;
      m.environmentIntensity = 0.9;
      return m;
    };
    this.skinMat = mk('charSkin');
    this.outfitMat = mk('charOutfit');
    this.accentMat = mk('charAccent');
    this.shoesMat = mk('charShoes'); this.shoesMat.roughness = 0.85;
    this.hairMat = mk('charHair'); this.hairMat.roughness = 0.9;
    this.applyColors(this.colors);

    this.eyeMat = new BABYLON.StandardMaterial('charEyeWhite', this.scene);
    this.eyeMat.diffuseColor = BABYLON.Color3.White();
    this.eyeMat.emissiveColor = new BABYLON.Color3(0.25, 0.25, 0.25);
    this.eyeMat.disableLighting = true;
    this.pupilMat = new BABYLON.StandardMaterial('charPupil', this.scene);
    this.pupilMat.diffuseColor = new BABYLON.Color3(0.06, 0.08, 0.12);
    this.pupilMat.emissiveColor = new BABYLON.Color3(0.01, 0.02, 0.03);
    this.pupilMat.disableLighting = true;
  }

  public applyColors(c: CharacterColors) {
    this.colors = { ...c };
    const set = (m: BABYLON.PBRMaterial, c3: [number, number, number]) =>
      m.albedoColor = new BABYLON.Color3(c3[0], c3[1], c3[2]);
    set(this.skinMat, c.skin);
    set(this.outfitMat, c.outfit);
    set(this.accentMat, c.accent);
    set(this.shoesMat, c.shoes);
    set(this.hairMat, c.hair);
  }

  private node(name: string, parent: BABYLON.TransformNode, x: number, y: number, z: number) {
    const n = new BABYLON.TransformNode(name, this.scene);
    n.parent = parent; n.position.set(x, y, z);
    return n;
  }

  private mesh(name: string, parent: BABYLON.TransformNode, opts: any, mat: BABYLON.Material,
               pos?: [number, number, number], rot?: [number, number, number], scl?: [number, number, number]) {
    let mesh: BABYLON.Mesh;
    if (name.includes('Sphere') || name.includes('Cap')) mesh = BABYLON.MeshBuilder.CreateSphere(name, opts, this.scene);
    else if (name.includes('Cyl')) mesh = BABYLON.MeshBuilder.CreateCylinder(name, opts, this.scene);
    else mesh = BABYLON.MeshBuilder.CreateBox(name, opts, this.scene);
    mesh.parent = parent;
    if (pos) mesh.position.set(pos[0], pos[1], pos[2]);
    if (rot) mesh.rotation.set(rot[0], rot[1], rot[2]);
    if (scl) mesh.scaling.set(scl[0], scl[1], scl[2]);
    mesh.material = mat;
    this.meshes.push(mesh);
    return mesh;
  }

  private buildRig() {
    // Pelvis at 0.95m — total height ~1.8m
    this.pelvis = this.node('pelvis', this.root, 0, 0.95, 0);
    this.mesh('pelvisSphere', this.pelvis, { diameter: 0.42, segments: 16 }, this.outfitMat, [0, 0, 0], undefined, [1.25, 0.7, 0.8]);

    // Torso + chest
    this.torso = this.node('torso', this.pelvis, 0, 0.16, 0);
    this.mesh('torsoSphere', this.torso, { diameter: 0.5, segments: 16 }, this.outfitMat, [0, 0.16, 0], undefined, [1.15, 1.35, 0.75]);
    // Accent stripe / belt
    this.mesh('beltCyl', this.pelvis, { diameter: 0.46, height: 0.09, tessellation: 20 }, this.accentMat, [0, 0.05, 0]);

    this.chest = this.node('chest', this.torso, 0, 0.34, 0);
    this.mesh('chestSphere', this.chest, { diameter: 0.54, segments: 16 }, this.outfitMat, [0, 0.02, 0], undefined, [1.2, 0.9, 0.8]);
    // Chest emblem
    this.mesh('accentCyl', this.chest, { diameter: 0.14, height: 0.03, tessellation: 6 }, this.accentMat, [0, 0.04, -0.24], [Math.PI / 2, 0, 0]);

    // Head
    this.head = this.node('head', this.chest, 0, 0.34, 0);
    this.mesh('headSphere', this.head, { diameter: 0.32, segments: 20 }, this.skinMat, [0, 0.12, 0], undefined, [1, 1.08, 0.95]);
    // Hair cap
    this.mesh('hairCap', this.head, { diameter: 0.34, segments: 20, slice: 0.55 }, this.hairMat, [0, 0.15, 0], undefined, [1.02, 1.05, 1]);
    // Eyes + pupils (face -Z)
    for (const sx of [-1, 1]) {
      const eye = BABYLON.MeshBuilder.CreateSphere('eye' + sx, { diameter: 0.085, segments: 10 }, this.scene);
      eye.parent = this.head; eye.position.set(sx * 0.07, 0.14, -0.145);
      eye.material = this.eyeMat; this.meshes.push(eye);
      const pupil = BABYLON.MeshBuilder.CreateSphere('pupil' + sx, { diameter: 0.042, segments: 8 }, this.scene);
      pupil.parent = eye; pupil.position.set(0, 0, -0.035);
      pupil.material = this.pupilMat; this.meshes.push(pupil);
    }
    // Nose + mouth hint
    this.mesh('noseSphere', this.head, { diameter: 0.06, segments: 8 }, this.skinMat, [0, 0.08, -0.17]);
    this.mesh('mouthBox', this.head, { width: 0.08, height: 0.015, depth: 0.01 }, this.pupilMat, [0, 0.01, -0.16]);

    // Arms
    const buildArm = (side: number) => {
      const shoulder = this.node('shoulder' + side, this.chest, side * 0.32, 0.14, 0);
      this.mesh('shoulderSphere' + side, shoulder, { diameter: 0.16, segments: 12 }, this.outfitMat);
      return shoulder;
    };
    this.armL = buildArm(-1);
    this.armR = buildArm(1);
    this.elbowL = this.node('elbowL', this.armL, 0, -0.3, 0);
    this.elbowR = this.node('elbowR', this.armR, 0, -0.3, 0);
    for (const [arm, elbow, side] of [[this.armL, this.elbowL, -1], [this.armR, this.elbowR, 1]] as any[]) {
      this.mesh('upperArmCyl' + side, arm, { diameter: 0.12, height: 0.32, tessellation: 12 }, this.skinMat, [0, -0.16, 0]);
      this.mesh('lowerArmCyl' + side, elbow, { diameter: 0.1, height: 0.3, tessellation: 12 }, this.skinMat, [0, -0.15, 0]);
      this.mesh('handSphere' + side, elbow, { diameter: 0.13, segments: 10 }, this.skinMat, [0, -0.32, 0]);
    }

    // Legs
    const buildLeg = (side: number) => {
      const hip = this.node('hip' + side, this.pelvis, side * 0.15, -0.1, 0);
      const knee = this.node('knee' + side, hip, 0, -0.44, 0);
      const foot = this.node('foot' + side, knee, 0, -0.44, 0);
      this.mesh('upperLegCyl' + side, hip, { diameter: 0.17, height: 0.46, tessellation: 14 }, this.outfitMat, [0, -0.22, 0]);
      this.mesh('lowerLegCyl' + side, knee, { diameter: 0.14, height: 0.44, tessellation: 14 }, this.outfitMat, [0, -0.22, 0]);
      // Shoe points forward (-Z)
      this.mesh('shoeBox' + side, foot, { width: 0.18, height: 0.12, depth: 0.34 }, this.shoesMat, [0, -0.02, -0.07]);
      this.mesh('soleBox' + side, foot, { width: 0.19, height: 0.04, depth: 0.35 }, this.accentMat, [0, -0.08, -0.07]);
      return { hip, knee, foot };
    };
    const L = buildLeg(-1), R = buildLeg(1);
    this.legL = L.hip; this.kneeL = L.knee; this.footL = L.foot;
    this.legR = R.hip; this.kneeR = R.knee; this.footR = R.foot;
  }

  public getMeshes() { return this.meshes; }

  public setPosition(x: number, y: number, z: number) { this.root.position.set(x, y, z); }
  public get position() { return this.root.position; }

  /** Drive an animation state; speed in m/s for walk/run cycle rate. */
  public setState(s: AnimState, verticalVel = 0) {
    if (s !== this.state) {
      this.prevState = this.state;
      this.state = s;
      this.blend = 0;
      if (s === 'land') this.onLand?.();
    }
    this.verticalVel = verticalVel;
  }

  public update(dt: number, speed: number, facing = 1) {
    this.t += dt;
    this.blend = Math.min(1, this.blend + dt * 10);
    const targetFacing = facing >= 0 ? -Math.PI / 2 : Math.PI / 2;
    let d = targetFacing - this.root.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.root.rotation.y += d * Math.min(1, dt * 10);

    const moving = this.state === 'walk' || this.state === 'run';
    const rate = this.state === 'run' ? 10 : this.state === 'walk' ? 6.5 : 0;
    if (moving) this.phase += dt * rate;
    else this.phase = 0;

    // Target pose values (lerped for smooth transitions)
    let swing = 0, kneeBend = 0, armSwing = 0, bodyBob = 0, lean = 0, headTilt = 0;
    switch (this.state) {
      case 'idle': {
        const breathe = Math.sin(this.t * 1.8);
        bodyBob = breathe * 0.012;
        armSwing = breathe * 0.04;
        headTilt = Math.sin(this.t * 0.7) * 0.05;
        break;
      }
      case 'walk':
        swing = Math.sin(this.phase) * 0.5;
        armSwing = -Math.sin(this.phase) * 0.45;
        kneeBend = Math.max(0, -Math.sin(this.phase)) * 0.55;
        bodyBob = Math.abs(Math.sin(this.phase)) * 0.035;
        lean = 0.05;
        break;
      case 'run':
        swing = Math.sin(this.phase) * 0.85;
        armSwing = -Math.sin(this.phase) * 0.8;
        kneeBend = Math.max(0, -Math.sin(this.phase)) * 0.9;
        bodyBob = Math.abs(Math.sin(this.phase)) * 0.06;
        lean = 0.16;
        break;
      case 'jump':
        swing = 0.3; kneeBend = 0.9; armSwing = -1.1;
        lean = -0.05;
        break;
      case 'fall':
        swing = -0.2; kneeBend = 0.45; armSwing = -0.9;
        break;
      case 'land':
        swing = 0.1; kneeBend = 0.7; armSwing = 0.2;
        bodyBob = -0.12;
        break;
    }

    const k = moving ? Math.min(1, dt * 12) : Math.min(1, dt * 10);
    const Lerp = (a: number, b: number, f: number) => a + (b - a) * f;

    this.legL.rotation.x = Lerp(this.legL.rotation.x, swing, k);
    this.legR.rotation.x = Lerp(this.legR.rotation.x, -swing, k);
    this.kneeL.rotation.x = Lerp(this.kneeL.rotation.x, -kneeBend, k);
    this.kneeR.rotation.x = Lerp(this.kneeR.rotation.x, -(this.state === 'walk' || this.state === 'run' ? Math.max(0, Math.sin(this.phase)) * (this.state === 'run' ? 0.9 : 0.55) : kneeBend), k);
    this.footL.rotation.x = Lerp(this.footL.rotation.x, this.state === 'jump' ? 0.4 : 0, k);
    this.footR.rotation.x = Lerp(this.footR.rotation.x, this.state === 'jump' ? 0.4 : 0, k);

    this.armL.rotation.x = Lerp(this.armL.rotation.x, armSwing, k);
    this.armR.rotation.x = Lerp(this.armR.rotation.x, -armSwing, k);
    this.armL.rotation.z = Lerp(this.armL.rotation.z, -0.12, k);
    this.armR.rotation.z = Lerp(this.armR.rotation.z, 0.12, k);
    this.elbowL.rotation.x = Lerp(this.elbowL.rotation.x, this.state === 'run' ? -0.7 : -0.2, k);
    this.elbowR.rotation.x = Lerp(this.elbowR.rotation.x, this.state === 'run' ? -0.7 : -0.2, k);

    this.torso.rotation.x = Lerp(this.torso.rotation.x, lean, k);
    this.pelvis.position.y = Lerp(this.pelvis.position.y, 0.95 + bodyBob + this.squash, k);
    this.head.rotation.z = Lerp(this.head.rotation.z, headTilt, k);
    this.head.rotation.y = Lerp(this.head.rotation.y, Math.sin(this.t * 0.5) * 0.06, k);

    if (this.squash !== 0) this.squash = Math.abs(this.squash) < 0.001 ? 0 : this.squash * Math.pow(0.01, dt);
  }

  public landingImpact(v: number) {
    this.squash = -Math.min(0.16, Math.abs(v) * 0.012);
    this.setState('land');
  }

  public dispose() {
    this.root.dispose(false, false);
    for (const m of this.meshes) m.dispose();
    this.skinMat.dispose(); this.outfitMat.dispose(); this.accentMat.dispose();
    this.shoesMat.dispose(); this.hairMat.dispose();
    this.eyeMat.dispose(); this.pupilMat.dispose();
  }
}
