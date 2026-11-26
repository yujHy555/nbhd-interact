import * as BABYLON from 'babylonjs';

export type AnimState = 'idle' | 'walk' | 'run' | 'jump' | 'doubleJump' | 'fall' | 'land' | 'strafe' | 'crouch' | 'flip' | 'slide' | 'crouchwalk';
export type MoveDir = 'forward' | 'back' | 'left' | 'right' | 'idle';

export interface CharacterColors {
  skin: [number, number, number];
  outfit: [number, number, number];
  accent: [number, number, number];
  shoes: [number, number, number];
  hair: [number, number, number];
}

export const DEFAULT_COLORS: CharacterColors = {
  skin: [0.82, 0.60, 0.42],
  outfit: [0.10, 0.36, 0.68],
  accent: [0.98, 0.78, 0.22],
  shoes: [0.10, 0.11, 0.14],
  hair: [0.16, 0.11, 0.08],
};

/** One animation clip from an imported Mixamo/glTF character. */
export interface MixamoBinding {
  root: BABYLON.TransformNode;
  animationGroups: BABYLON.AnimationGroup[];
  play(name: string, loop?: boolean): boolean;
  setCurrentSpeed(ratio: number): void;
  stopAll(): void;
}

/**
 * AAA character — fully hierarchical humanoid rig with correct limb axes,
 * directional locomotion (forward/back/strafe), smooth animation blending,
 * secondary motion, and a Mixamo/glTF binding path for production mocap.
 *
 * Procedural rig faces -Z. The imported Mixamo rig faces +Z at yaw 0 (the
 * controller's heading convention accounts for this). All limbs hang down.
 */
export class Character {
  public root: BABYLON.TransformNode;
  /** World-space slope tilt (about Z) — parent of heading, so feet stay on ramps. */
  public slopePivot: BABYLON.TransformNode;
  /** Yaw pivot — heading only; the slope tilt is applied above it. */
  public headingPivot: BABYLON.TransformNode;
  /** Waist-height pivot — rotate this for flips so they pivot at the centre of mass. */
  public flipPivot: BABYLON.TransformNode;
  public state: AnimState = 'idle';
  public colors: CharacterColors = { ...DEFAULT_COLORS };
  public onLand?: () => void;
  public mixamo: MixamoBinding | null = null;

  private scene: BABYLON.Scene;
  private t = 0;
  private phase = 0;
  private blend = 1;
  private prevState: AnimState = 'idle';
  private verticalVel = 0;
  private squash = 0;
  private dir: MoveDir = 'idle';
  private heading = 0;
  private secondary = 0;

  // Rig nodes
  private pelvis!: BABYLON.TransformNode;
  private spine!: BABYLON.TransformNode;
  private chest!: BABYLON.TransformNode;
  private neck!: BABYLON.TransformNode;
  private head!: BABYLON.TransformNode;
  private shoulderL!: BABYLON.TransformNode; private elbowL!: BABYLON.TransformNode; private wristL!: BABYLON.TransformNode;
  private shoulderR!: BABYLON.TransformNode; private elbowR!: BABYLON.TransformNode; private wristR!: BABYLON.TransformNode;
  private hipL!: BABYLON.TransformNode; private kneeL!: BABYLON.TransformNode; private ankleL!: BABYLON.TransformNode;
  private hipR!: BABYLON.TransformNode; private kneeR!: BABYLON.TransformNode; private ankleR!: BABYLON.TransformNode;

  private skinMat!: BABYLON.PBRMaterial;
  private outfitMat!: BABYLON.PBRMaterial;
  private accentMat!: BABYLON.PBRMaterial;
  private shoesMat!: BABYLON.PBRMaterial;
  private hairMat!: BABYLON.PBRMaterial;
  private eyeMat!: BABYLON.StandardMaterial;
  private pupilMat!: BABYLON.StandardMaterial;
  private meshes: BABYLON.Mesh[] = [];
  private footOffset = 0.13; // ankle bone → sole, calibrated at bind time


  constructor(scene: BABYLON.Scene) {
    this.scene = scene;
    this.root = new BABYLON.TransformNode('characterRoot', scene);
    this.slopePivot = new BABYLON.TransformNode('characterSlopePivot', scene);
    this.slopePivot.parent = this.root;
    this.headingPivot = new BABYLON.TransformNode('characterHeadingPivot', scene);
    this.headingPivot.parent = this.slopePivot;
    this.flipPivot = new BABYLON.TransformNode('characterFlipPivot', scene);
    this.flipPivot.parent = this.headingPivot;
    this.flipPivot.position.y = 0.96; // waist / centre of mass
    // Run IK AFTER the Mixamo animation is evaluated so it can't be overwritten.
    scene.onAfterAnimationsObservable.add(() => {
      if (!this.mixamo) return;
      this.cancelRootMotion();
      this.applyFootIK(this.scene.getEngine().getDeltaTime() / 1000);
    });
    this.buildMaterials();
    this.buildRig();
    // The procedural rig is only a fallback. Hide it from the very first
    // frame so the old character is never visible during load/start — the
    // real Mixamo hero is shown as soon as its GLB finishes loading.
    for (const m of this.meshes) m.setEnabled(false);
  }

  // ---------------------------------------------------------------- materials
  private buildMaterials() {
    const pbr = (name: string, rough = 0.6, metal = 0.05) => {
      const m = new BABYLON.PBRMaterial(name, this.scene);
      m.metallic = metal; m.roughness = rough;
      m.environmentIntensity = 1.1;
      return m;
    };
    this.skinMat = pbr('charSkin', 0.72);
    this.outfitMat = pbr('charOutfit', 0.65);
    this.accentMat = pbr('charAccent', 0.35, 0.3);
    this.shoesMat = pbr('charShoes', 0.85);
    this.hairMat = pbr('charHair', 0.92);
    this.applyColors(this.colors);

    this.eyeMat = new BABYLON.StandardMaterial('charEyeWhite', this.scene);
    this.eyeMat.diffuseColor = BABYLON.Color3.White();
    this.eyeMat.emissiveColor = new BABYLON.Color3(0.3, 0.3, 0.3);
    this.eyeMat.disableLighting = true;
    this.pupilMat = new BABYLON.StandardMaterial('charPupil', this.scene);
    this.pupilMat.diffuseColor = new BABYLON.Color3(0.05, 0.07, 0.11);
    this.pupilMat.emissiveColor = new BABYLON.Color3(0.01, 0.01, 0.02);
    this.pupilMat.disableLighting = true;
  }

  public applyColors(c: CharacterColors) {
    this.colors = { ...c };
    const set = (m: BABYLON.PBRMaterial, v: [number, number, number]) => m.albedoColor = new BABYLON.Color3(v[0], v[1], v[2]);
    set(this.skinMat, c.skin); set(this.outfitMat, c.outfit);
    set(this.accentMat, c.accent); set(this.shoesMat, c.shoes);
    set(this.hairMat, c.hair);
  }

  // ---------------------------------------------------------------- rig helpers
  private node(name: string, parent: BABYLON.TransformNode, x = 0, y = 0, z = 0) {
    const n = new BABYLON.TransformNode(name, this.scene);
    n.parent = parent; n.position.set(x, y, z);
    return n;
  }

  private mesh(name: string, parent: BABYLON.TransformNode, shape: 'box' | 'sphere' | 'cyl' | 'cap',
    opts: any, mat: BABYLON.Material, pos: [number, number, number] = [0, 0, 0],
    rot: [number, number, number] = [0, 0, 0], scl: [number, number, number] = [1, 1, 1]) {
    let m: BABYLON.Mesh;
    if (shape === 'sphere') m = BABYLON.MeshBuilder.CreateSphere(name, opts, this.scene);
    else if (shape === 'cap') m = BABYLON.MeshBuilder.CreateSphere(name, opts, this.scene);
    else if (shape === 'cyl') m = BABYLON.MeshBuilder.CreateCylinder(name, opts, this.scene);
    else m = BABYLON.MeshBuilder.CreateBox(name, opts, this.scene);
    m.parent = parent; m.position.set(pos[0], pos[1], pos[2]);
    m.rotation.set(rot[0], rot[1], rot[2]); m.scaling.set(scl[0], scl[1], scl[2]);
    m.material = mat; m.isPickable = false;
    this.meshes.push(m);
    return m;
  }

  private buildRig() {
    // ---- Core ----
    this.pelvis = this.node('pelvis', this.headingPivot, 0, 0.96, 0);
    this.mesh('pelvisMesh', this.pelvis, 'sphere', { diameter: 0.36, segments: 16 }, this.outfitMat, [0, 0, 0], [0, 0, 0], [1.15, 0.72, 0.85]);
    // Belt must sit OUTSIDE the pelvis ellipsoid (x radius ~0.21, z ~0.15)
    this.mesh('belt', this.pelvis, 'cyl', { diameter: 0.45, height: 0.055, tessellation: 20 }, this.accentMat, [0, 0.01, 0], [0, 0, 0], [1, 1, 0.78]);

    this.spine = this.node('spine', this.pelvis, 0, 0.14, 0);
    this.mesh('spineMesh', this.spine, 'sphere', { diameter: 0.34, segments: 16 }, this.outfitMat, [0, 0.16, 0], [0, 0, 0], [1.05, 1.25, 0.78]);

    this.chest = this.node('chest', this.spine, 0, 0.30, 0);
    this.mesh('chestMesh', this.chest, 'sphere', { diameter: 0.42, segments: 16 }, this.outfitMat, [0, 0.06, 0], [0, 0, 0], [1.25, 0.95, 0.82]);
    this.mesh('chestEmblem', this.chest, 'cyl', { diameter: 0.13, height: 0.03, tessellation: 6 }, this.accentMat, [0, 0.08, -0.19], [Math.PI / 2, 0, 0]);

    // ---- Neck + head ----
    this.neck = this.node('neck', this.chest, 0, 0.27, 0);
    this.mesh('neckMesh', this.neck, 'cyl', { diameter: 0.12, height: 0.12, tessellation: 12 }, this.skinMat, [0, 0.03, 0]);
    this.head = this.node('head', this.neck, 0, 0.14, 0);
    this.mesh('headMesh', this.head, 'sphere', { diameter: 0.30, segments: 20 }, this.skinMat, [0, 0.10, 0], [0, 0, 0], [0.96, 1.08, 0.92]);
    // Hair cap sits on top, no overlap with eyes
    this.mesh('hairCap', this.head, 'cap', { diameter: 0.315, segments: 20, slice: 0.52 }, this.hairMat, [0, 0.135, 0.012], [0, 0, 0], [0.99, 1.0, 0.98]);
    // Eyes on the -Z face, pupils slightly proud
    for (const sx of [-1, 1]) {
      const eye = BABYLON.MeshBuilder.CreateSphere('eye' + sx, { diameter: 0.082, segments: 12 }, this.scene);
      eye.parent = this.head; eye.position.set(sx * 0.068, 0.11, -0.135);
      eye.material = this.eyeMat; this.meshes.push(eye);
      const pupil = BABYLON.MeshBuilder.CreateSphere('pupil' + sx, { diameter: 0.04, segments: 10 }, this.scene);
      pupil.parent = eye; pupil.position.set(0, 0, -0.032);
      pupil.material = this.pupilMat; this.meshes.push(pupil);
    }
    this.mesh('nose', this.head, 'sphere', { diameter: 0.055, segments: 10 }, this.skinMat, [0, 0.055, -0.155]);
    this.mesh('mouth', this.head, 'box', { width: 0.075, height: 0.014, depth: 0.012 }, this.pupilMat, [0, -0.005, -0.15]);

    // ---- Arms (hang down, bend forward at elbow) ----
    const buildArm = (side: -1 | 1) => {
      const shoulder = this.node('shoulder' + side, this.chest, side * 0.28, 0.18, 0);
      this.mesh('deltoid' + side, shoulder, 'sphere', { diameter: 0.16, segments: 12 }, this.outfitMat, [0, -0.02, 0]);
      // Upper arm: 0.28 long, hangs DOWN (-Y) from shoulder
      this.mesh('upperArm' + side, shoulder, 'cyl', { diameter: 0.11, height: 0.28, tessellation: 12 }, this.skinMat, [0, -0.15, 0]);
      const elbow = this.node('elbow' + side, shoulder, 0, -0.30, 0);
      this.mesh('elbowJoint' + side, elbow, 'sphere', { diameter: 0.105, segments: 10 }, this.skinMat);
      // Forearm 0.26 long
      this.mesh('forearm' + side, elbow, 'cyl', { diameter: 0.095, height: 0.26, tessellation: 12 }, this.skinMat, [0, -0.14, 0]);
      // Wrist cuff + hand
      this.mesh('cuff' + side, elbow, 'cyl', { diameter: 0.11, height: 0.06, tessellation: 12 }, this.accentMat, [0, -0.27, 0]);
      const wrist = this.node('wrist' + side, elbow, 0, -0.30, 0);
      this.mesh('hand' + side, wrist, 'sphere', { diameter: 0.12, segments: 10 }, this.skinMat, [0, -0.055, 0], [0, 0, 0], [0.9, 1.1, 0.75]);
      return { shoulder, elbow, wrist };
    };
    const aL = buildArm(-1), aR = buildArm(1);
    this.shoulderL = aL.shoulder; this.elbowL = aL.elbow; this.wristL = aL.wrist;
    this.shoulderR = aR.shoulder; this.elbowR = aR.elbow; this.wristR = aR.wrist;

    // ---- Legs ----
    const buildLeg = (side: -1 | 1) => {
      const hip = this.node('hip' + side, this.pelvis, side * 0.135, -0.08, 0);
      this.mesh('thigh' + side, hip, 'cyl', { diameter: 0.15, height: 0.44, tessellation: 14 }, this.outfitMat, [0, -0.22, 0]);
      const knee = this.node('knee' + side, hip, 0, -0.44, 0);
      this.mesh('kneeJoint' + side, knee, 'sphere', { diameter: 0.14, segments: 10 }, this.outfitMat);
      this.mesh('shin' + side, knee, 'cyl', { diameter: 0.12, height: 0.42, tessellation: 14 }, this.outfitMat, [0, -0.21, 0]);
      // Sock + shoe at the ankle, shoe points forward (-Z)
      const ankle = this.node('ankle' + side, knee, 0, -0.42, 0);
      this.mesh('sock' + side, ankle, 'cyl', { diameter: 0.125, height: 0.08, tessellation: 12 }, this.accentMat, [0, -0.02, 0]);
      this.mesh('shoe' + side, ankle, 'box', { width: 0.17, height: 0.11, depth: 0.32 }, this.shoesMat, [0, -0.08, -0.075]);
      this.mesh('sole' + side, ankle, 'box', { width: 0.175, height: 0.035, depth: 0.33 }, this.accentMat, [0, -0.135, -0.075]);
      return { hip, knee, ankle };
    };
    const lL = buildLeg(-1), lR = buildLeg(1);
    this.hipL = lL.hip; this.kneeL = lL.knee; this.ankleL = lL.ankle;
    this.hipR = lR.hip; this.kneeR = lR.knee; this.ankleR = lR.ankle;
  }

  // ---------------------------------------------------------------- Mixamo
  /** Bind an imported Mixamo-style glTF character and its animation groups. */
  public bindMixamo(binding: MixamoBinding) {
    this.mixamo = binding;
    // Mount the mocap character on the waist pivot (offset so feet sit at y=0)
    binding.root.parent = this.flipPivot;
    binding.root.position.y = -0.96;
    // Auto-scale the imported mocap character to ~1.8 m real-world height.
    // (FBX→glTF conversion can leave the model at cm-scale.)
    const meshes = binding.root.getChildMeshes(false);
    if (meshes.length) {
      let minY = Infinity, maxY = -Infinity;
      for (const m of meshes) {
        const bb = m.getBoundingInfo().boundingBox;
        minY = Math.min(minY, bb.minimumWorld.y);
        maxY = Math.max(maxY, bb.maximumWorld.y);
      }
      const h = maxY - minY;
      if (h > 0.001 && (h < 1.2 || h > 2.6)) {
        const s = 1.8 / h;
        binding.root.scaling.setAll(s);
      }
      // Seat feet at the ROOT origin (local y=0) — NOT absolute world y.
      // Using world y here made the model sink once the root moved to ground.
      binding.root.computeWorldMatrix(true);
      for (const m of meshes) m.computeWorldMatrix(true);
      let low = Infinity;
      for (const m of meshes) low = Math.min(low, m.getBoundingInfo().boundingBox.minimumWorld.y);
      const rootY = this.root.getAbsolutePosition().y;
      binding.root.position.y -= (low - rootY); // feet now at root.y (local 0)
      binding.root.computeWorldMatrix(true);
      for (const m of meshes) m.computeWorldMatrix(true);
      // The GLB's stale bind-pose bounds are ~72 m wide (cm-scale leftovers),
      // which makes the hero cast a giant shadow and never get culled. Clamp
      // to a character-sized box. IMPORTANT: bounds are LOCAL, while the GLB
      // root is scaled ~108x to bring the cm model to 1.8 m. Dividing by each
      // mesh's accumulated world scale keeps the WORLD box ~1.1 x 2 m — a
      // fixed ±1.1 local box became ±119 m and cast a huge long shadow.
      for (const m of meshes) {
        m.computeWorldMatrix(true);
        // Use the world-matrix BASIS LENGTHS, not Matrix.decompose(): the
        // Mixamo armature scale is 1e-4 combined with a 108x root scale, which
        // makes decompose() return garbage (a zero axis) on this near-singular
        // matrix. Basis lengths are reliable and give ~0.0108 for this hero.
        const w = m.getWorldMatrix().m;
        const sx = Math.hypot(w[0], w[1], w[2]);
        const sy = Math.hypot(w[4], w[5], w[6]);
        const sz = Math.hypot(w[8], w[9], w[10]);
        const hx = 1.1 / Math.max(1e-6, sx);
        const hy = 2.0 / Math.max(1e-6, sy);
        const hz = 1.1 / Math.max(1e-6, sz);
        m.setBoundingInfo(new BABYLON.BoundingInfo(
          new BABYLON.Vector3(-hx, 0, -hz),
          new BABYLON.Vector3(hx, hy, hz),
        ));
      }
      // Calibrate ankle → sole distance for the slope foot-contact check.
      const skinned = meshes.find((m) => (m as BABYLON.Mesh).skeleton) as BABYLON.Mesh | undefined;
      if (skinned && skinned.skeleton) {
        let ankle = Infinity;
        for (const n of ['mixamorig:LeftFoot', 'mixamorig:RightFoot']) {
          const b = skinned.skeleton.bones.find((x) => x.name === n);
          if (b) ankle = Math.min(ankle, BABYLON.Vector3.TransformCoordinates(b.getAbsolutePosition(), skinned.getWorldMatrix()).y);
        }
        if (isFinite(ankle)) this.footOffset = Math.max(0.02, ankle - this.root.getAbsolutePosition().y);
        // Rest-pose hips offset — the target the root-motion cancel pins to.
        const hips = skinned.skeleton.bones.find((b) => /Hips/i.test(b.name));
        if (hips) {
          skinned.computeWorldMatrix(true);
          skinned.skeleton.computeAbsoluteMatrices();
          const wp = BABYLON.Vector3.TransformCoordinates(hips.getAbsolutePosition(), skinned.getWorldMatrix());
          const rp = this.root.getAbsolutePosition();
          this.rootMotionRef = { x: wp.x - rp.x, z: wp.z - rp.z };
        }
      }
    }
    // Hide procedural mesh while the mocap character is bound
    for (const m of this.meshes) m.setEnabled(false);
  }
  public unbindMixamo() {
    this.mixamo?.stopAll();
    this.mixamo = null;
    for (const m of this.meshes) m.setEnabled(true);
  }
  public playMocap(name: string) {
    // Slide is a one-shot: press once → the full animation plays at normal
    // speed, then the controller blends back to run/walk from where it ended.
    return this.mixamo?.play(name, name !== 'slide') ?? false;
  }

  // ---------------------------------------------------------------- public API
  public getMeshes() { return this.meshes; }
  /** Normalised cycle phase (0..1) of the ACTIVE locomotion clip — used to
   *  trigger footsteps exactly on the animated foot plants. */
  public getCyclePhase() {
    if (this.mixamo) {
      const g = this.mixamo.animationGroups.find((x) => x.isPlaying);
      if (g && g.to > g.from && g.animatables.length) {
        const frame = g.animatables[0].masterFrame;
        return (((frame - g.from) % (g.to - g.from)) + (g.to - g.from)) % (g.to - g.from) / (g.to - g.from);
      }
      return 0;
    }
    return this.phase;
  }
  public setPosition(x: number, y: number, z: number) { this.root.position.set(x, y, z); }
  public get position() { return this.root.position; }

  public setState(s: AnimState, verticalVel = 0, dir: MoveDir = 'idle') {
    this.dir = dir;
    this.verticalVel = verticalVel;
    if (s !== this.state) {
      this.prevState = this.state;
      this.state = s;
      this.blend = 0;
      if (s === 'land') this.onLand?.();
    }
    if (this.mixamo) {
      const clip = s === 'run' ? 'run' : s === 'walk' ? 'walk' : s === 'strafe' ? 'walk'
        : s === 'jump' || s === 'doubleJump' || s === 'flip' ? 'jump'
        : s === 'crouch' ? 'crouch' : s === 'crouchwalk' ? 'crouchwalk'
        : s === 'slide' ? 'slide' : s === 'land' ? 'land' : s === 'fall' ? 'fall' : 'idle';
      this.playMocap(clip);
    }
  }

  private L(a: number, b: number, f: number) { return a + (b - a) * f; }

  public update(dt: number, speed: number, heading: number) {
    this.t += dt;
    this.blend = Math.min(1, this.blend + dt * 9);
    this.heading = heading;
    // Smoothly turn toward the requested heading (Mixamo faces +Z at yaw 0)
    let dh = heading - this.headingPivot.rotation.y;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    this.headingPivot.rotation.y += dh * Math.min(1, dt * 12);

    if (this.mixamo) {
      // Foot-lock: playback rate tracks real ground speed so the feet do not
      // slide across the floor. A backwards move reverses the same cycle.
      // Mixamo clips are authored at their own pace. Match playback so the
      // planted foot's ground speed ≈ the character's travel speed (no slide).
      let nominal = 1;
      if (this.state === 'run') nominal = 4.2;
      else if (this.state === 'walk' || this.state === 'strafe') nominal = 2.0;
      // Slide plays at 1x — the clip's run-up→slide→recover must keep its
      // authored timing, otherwise it reads as a leg kick.
      const ratio = nominal > 1 ? Math.min(2.2, Math.max(0.4, speed / nominal)) : 1;
      this.mixamo.setCurrentSpeed(this.dir === 'back' ? -ratio : ratio);
      this.updateSecondaryOnly(dt);
      return;
    }

    const moving = this.state === 'walk' || this.state === 'run' || this.state === 'strafe';
    const rate = this.state === 'run' ? 11 : this.state === 'walk' ? 7 : this.state === 'strafe' ? 7.5 : 0;
    if (moving) this.phase += dt * rate; else this.phase = 0;
    const k = Math.min(1, dt * 14);

    // Directional multiplier: backward walk reverses the cycle, strafe adds lean
    const back = this.dir === 'back' ? -1 : 1;
    const strafe = this.dir === 'left' || this.dir === 'right' ? 1 : 0;
    const stride = this.state === 'run' ? 0.95 : this.state === 'walk' ? 0.62 : 0.42;

    let hipL = 0, hipR = 0, kneeL = 0, kneeR = 0;
    let armL = 0, armR = 0, elbowL = 0, elbowR = 0;
    let bob = 0, lean = 0, sideLean = 0, headTilt = 0;

    switch (this.state) {
      case 'idle': {
        const br = Math.sin(this.t * 1.7);
        bob = br * 0.012;
        // Facing -Z: +X rotation swings an arm FORWARD. Arms slightly forward.
        armL = 0.08 + br * 0.04; armR = 0.08 - br * 0.04;
        headTilt = Math.sin(this.t * 0.62) * 0.06;
        elbowL = elbowR = 0.12; // elbows bend forward
        break;
      }
      case 'walk': case 'run': case 'strafe': {
        const s = Math.sin(this.phase) * stride * back;
        hipL = s; hipR = -s;
        kneeL = Math.max(0, -Math.sin(this.phase) * back) * (this.state === 'run' ? 1.0 : 0.6);
        kneeR = Math.max(0, Math.sin(this.phase) * back) * (this.state === 'run' ? 1.0 : 0.6);
        // Opposite arm to leg swings forward (+X = forward)
        armL = -s * (this.state === 'run' ? 0.85 : 0.7);
        armR = s * (this.state === 'run' ? 0.85 : 0.7);
        elbowL = elbowR = (this.state === 'run' ? 0.7 : 0.4); // bend FORWARD
        bob = Math.abs(Math.sin(this.phase)) * (this.state === 'run' ? 0.07 : 0.035);
        lean = this.state === 'run' ? 0.18 : 0.06;
        sideLean = strafe * (this.dir === 'right' ? -0.1 : 0.1);
        break;
      }
      case 'jump':
        hipL = 0.35; hipR = -0.2; kneeL = 1.0; kneeR = 0.5;
        armL = 1.2; armR = 1.2; elbowL = elbowR = 0.3; // arms UP and forward
        lean = -0.06;
        break;
      case 'doubleJump': case 'flip': {
        // Tucked flip pose — arms in, knees to chest
        const tuck = this.state === 'flip' ? 1 : 0.7;
        hipL = 0.9 * tuck; hipR = 0.9 * tuck;
        kneeL = 1.4 * tuck; kneeR = 1.4 * tuck;
        armL = 0.6; armR = 0.6; elbowL = elbowR = 1.0;
        bob = 0.03; lean = -0.1;
        break;
      }
      case 'crouch':
        hipL = 0.9; hipR = 0.9; kneeL = 1.5; kneeR = 1.5;
        armL = 0.7; armR = 0.7; elbowL = elbowR = 0.6;
        bob = -0.3; lean = 0.22;
        break;
      case 'fall':
        hipL = -0.15; hipR = 0.25; kneeL = 0.5; kneeR = 0.35;
        armL = 0.55; armR = 0.55; // arms out/forward for balance
        elbowL = elbowR = 0.4;
        lean = 0.05;
        break;
      case 'land':
        hipL = 0.18; hipR = -0.18; kneeL = 0.85; kneeR = 0.85;
        armL = 0.5; armR = 0.5; // arms forward to absorb
        elbowL = elbowR = 0.5;
        bob = -0.1;
        break;
    }

    // Apply with smoothing
    this.hipL.rotation.x = this.L(this.hipL.rotation.x, hipL, k);
    this.hipR.rotation.x = this.L(this.hipR.rotation.x, hipR, k);
    this.kneeL.rotation.x = this.L(this.kneeL.rotation.x, -kneeL, k); // knee bends backward
    this.kneeR.rotation.x = this.L(this.kneeR.rotation.x, -kneeR, k);
    this.ankleL.rotation.x = this.L(this.ankleL.rotation.x, this.state === 'jump' ? 0.4 : kneeL * 0.3, k);
    this.ankleR.rotation.x = this.L(this.ankleR.rotation.x, this.state === 'jump' ? 0.4 : kneeR * 0.3, k);

    this.shoulderL.rotation.x = this.L(this.shoulderL.rotation.x, armL, k);
    this.shoulderR.rotation.x = this.L(this.shoulderR.rotation.x, armR, k);
    // Small outward splay keeps arms clear of the torso (left arm -Z, right +Z)
    this.shoulderL.rotation.z = this.L(this.shoulderL.rotation.z, -0.14, k);
    this.shoulderR.rotation.z = this.L(this.shoulderR.rotation.z, 0.14, k);
    this.elbowL.rotation.x = this.L(this.elbowL.rotation.x, elbowL, k);
    this.elbowR.rotation.x = this.L(this.elbowR.rotation.x, elbowR, k);
    this.wristL.rotation.x = this.L(this.wristL.rotation.x, 0.1, k);
    this.wristR.rotation.x = this.L(this.wristR.rotation.x, 0.1, k);

    this.spine.rotation.x = this.L(this.spine.rotation.x, lean, k);
    this.spine.rotation.z = this.L(this.spine.rotation.z, sideLean, k);
    this.chest.rotation.x = this.L(this.chest.rotation.x, lean * 0.5, k);
    this.pelvis.position.y = this.L(this.pelvis.position.y, 0.96 + bob + this.squash, k);
    this.head.rotation.z = this.L(this.head.rotation.z, headTilt, k);
    this.head.rotation.y = this.L(this.head.rotation.y, Math.sin(this.t * 0.5) * 0.05, k);

    // Secondary motion: torso counter-rotation to hips adds life
    this.secondary = this.L(this.secondary, moving ? Math.sin(this.phase) * 0.06 * back : 0, k);
    this.chest.rotation.y = this.secondary;

    if (this.squash !== 0) this.squash = Math.abs(this.squash) < 0.001 ? 0 : this.squash * Math.pow(0.01, dt);
  }

  private updateSecondaryOnly(dt: number) {
    this.t += dt;
    this.secondary = Math.sin(this.t * 1.5) * 0.01;
  }

  /** Slope alignment target (radians), consumed in the post-animation IK pass. */
  public setSlopeAngle(angle: number) { this.targetSlope = angle; }
  private targetSlope = 0;
  private smoothSlope = 0;
  /** Surface height sampler supplied by the game (foot XZ → ground Y). */
  public groundSampler: ((x: number, z: number) => number) | null = null;

  /** AAA foot IK — deterministic and jitter-free.
   *  Runs AFTER the Mixamo clip. On a slope we (a) pitch each foot bone to the
   *  ground angle and (b) apply ONE smoothed, geometry-derived lift computed
   *  from the actual sole penetration. The lift uses a smoothed error signal
   *  (not a per-frame snap), so it cannot fight the root and cause bob. The
   *  controller owns the root; IK only supplements it on real slopes. */
  private footLift = 0;

  /** Rest-pose hips offset from the collider (world space). Mixamo clips
   *  translate the hips as root motion; the running-slide drifts ~1 m forward
   *  then returns. We cancel that drift at runtime so the visible body stays
   *  exactly on the collider and resumes idle/walk/run from the slide's end
   *  position — the GLB and all its clips stay untouched. */
  private rootMotionRef: { x: number; z: number } | null = null;

  private cancelRootMotion() {
    if (!this.mixamo || !this.rootMotionRef) return;
    const gr = this.mixamo.root;
    const mesh = gr.getChildMeshes(false)
      .find((m) => (m as BABYLON.Mesh).skeleton) as BABYLON.Mesh | undefined;
    if (!mesh || !mesh.skeleton) return;
    const hips = mesh.skeleton.bones.find((b) => /Hips/i.test(b.name));
    if (!hips) return;

    // Drop last frame's compensation so we measure the animation's raw drift,
    // then offset the glTF root by the exact inverse — no feedback lag, and it
    // tracks crossfades precisely.
    const savedX = gr.position.x, savedZ = gr.position.z;
    gr.position.x = 0; gr.position.z = 0;
    gr.computeWorldMatrix(true);
    mesh.computeWorldMatrix(true);
    mesh.skeleton.computeAbsoluteMatrices();
    const wp = BABYLON.Vector3.TransformCoordinates(hips.getAbsolutePosition(), mesh.getWorldMatrix());
    const rp = this.root.getAbsolutePosition();
    const ex = (wp.x - rp.x) - this.rootMotionRef.x;
    const ez = (wp.z - rp.z) - this.rootMotionRef.z;
    gr.position.x = savedX; gr.position.z = savedZ;

    // Project the world drift onto the character's local axes (heading pivot
    // carries only yaw). glTF-root position is in that frame and unscaled.
    const yaw = this.headingPivot.rotation.y;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    gr.position.z = -(ex * fx + ez * fz);
    gr.position.x = -(ex * rx + ez * rz);
  }

  public applyFootIK(dt: number) {
    if (!this.mixamo || !this.groundSampler) return;
    this.smoothSlope += (this.targetSlope - this.smoothSlope) * Math.min(1, dt * 8);
    const slope = this.smoothSlope;
    const onSlope = Math.abs(slope) > 0.02;

    // Tilt the whole rig to the slope normal (feet conform perfectly), then
    // counter-tilt the upper body so the torso stays upright. Applied via a
    // stable TransformNode — reliable, unlike animating bone quaternions.
    this.slopePivot.rotation.z = slope;
    // Counter-rotate the spine/chest so the torso reads upright on the slope.
    for (const mesh of this.mixamo.root.getChildMeshes(false)) {
      const sk = (mesh as BABYLON.Mesh).skeleton;
      if (!sk) continue;
      for (const n of ['mixamorig:Spine', 'mixamorig:Spine1', 'mixamorig:Spine2']) {
        const b = sk.bones.find((x) => x.name === n);
        if (b) b.setRotationMatrix(BABYLON.Matrix.RotationZ(-slope));
      }
    }

    let minSoleErr = Infinity;
    for (const mesh of this.mixamo.root.getChildMeshes(false)) {
      const sk = (mesh as BABYLON.Mesh).skeleton;
      if (!sk) continue;
      mesh.computeWorldMatrix(true);
      sk.computeAbsoluteMatrices();
      for (const name of ['mixamorig:LeftFoot', 'mixamorig:RightFoot']) {
        const bone = sk.bones.find((b) => b.name === name);
        if (!bone) continue;
        sk.computeAbsoluteMatrices();
        const wp = BABYLON.Vector3.TransformCoordinates(bone.getAbsolutePosition(), mesh.getWorldMatrix());
        const ground = this.groundSampler(wp.x, wp.z);
        minSoleErr = Math.min(minSoleErr, (wp.y - this.footOffset) - ground);
      }
    }

    // Hard anti-penetration constraint: if any sole is below the sampled
    // surface, lift the root by the exact deficit immediately — this is the
    // only way to guarantee zero sinking while the surface rises under a
    // climbing foot. Damping caused the foot to lag and clip, so it's gone.
    // Gated to slopes only → flat running stays perfectly smooth.
    if (onSlope && isFinite(minSoleErr)) {
      const penetration = -minSoleErr; // >0 means sole is below the surface
      if (penetration > 0) {
        this.footLift = Math.min(0.3, penetration) + 0.012;
        this.root.position.y += this.footLift;
      } else {
        this.footLift += (0 - this.footLift) * Math.min(1, dt * 6);
        if (this.footLift > 0) this.root.position.y += this.footLift;
      }
    } else {
      this.footLift = 0;
    }
  }

  /** Set the flip rotation about the waist (radians). */
  public setFlip(angle: number) { this.flipPivot.rotation.x = angle; }
  public getFlip() { return this.flipPivot.rotation.x; }

  public landingImpact(v: number) {
    this.squash = -Math.min(0.14, Math.abs(v) * 0.012);
    this.setState('land');
  }

  public dispose() {
    this.root.dispose(false, false);
    for (const m of this.meshes) m.dispose();
    for (const m of [this.skinMat, this.outfitMat, this.accentMat, this.shoesMat, this.hairMat]) m.dispose();
    this.eyeMat.dispose(); this.pupilMat.dispose();
  }
}
