import * as BABYLON from 'babylonjs';
import { MixamoBinding } from './Character';

/**
 * Production Mixamo/glTF pipeline.
 *
 * Loads a skinned character with its embedded AnimationGroups (Mixamo exports
 * .glb/.gltf with clips named "Idle", "Walk", "Run", "Jump", etc.) and exposes
 * a clean API for the game: play(name) with smooth crossfades, speed control
 * and foot-locked idle/walk/run blending.
 *
 * Falls back gracefully when no model is present — the procedural rig drives
 * the character until a real mocap model is bound.
 */
export class MixamoController implements MixamoBinding {
  public root: BABYLON.TransformNode;
  public animationGroups: BABYLON.AnimationGroup[] = [];
  private scene: BABYLON.Scene;
  private clipMap = new Map<string, BABYLON.AnimationGroup>();
  private current: BABYLON.AnimationGroup | null = null;
  private fadeObs: BABYLON.Observer<BABYLON.Scene> | null = null;
  private loaded = false;

  constructor(scene: BABYLON.Scene) {
    this.scene = scene;
    this.root = new BABYLON.TransformNode('mixamoRoot', scene);
  }

  /** Load the full Mixamo set: one GLB per clip, all bound to the FIRST
   *  imported skinned mesh so only one character is ever visible. */
  public async loadClips(url: string, files: string[]): Promise<boolean> {
    let any = false;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const clipName = file.replace(/\.glb?$/i, '').toLowerCase();
      try {
        const result = await BABYLON.SceneLoader.ImportMeshAsync('', url, file, this.scene);
        if (i === 0) {
          // First file defines the visible skinned character
          const rootNode = result.transformNodes.find(n => !n.parent) ?? result.meshes.find(m => !m.parent);
          if (rootNode) rootNode.parent = this.root;
          else for (const m of result.meshes) if (!m.parent) m.parent = this.root;
          // Hide any extra skinned meshes from subsequent imports by tracking them
        }
        for (const g of result.animationGroups) {
          g.name = clipName;
          this.clipMap.set(clipName, g);
          this.animationGroups.push(g);
        }
        // Later files are animation-only: hide their meshes
        if (i > 0) {
          const rootNode = result.transformNodes.find(n => !n.parent) ?? result.meshes.find(m => !m.parent);
          if (rootNode) rootNode.setEnabled(false);
          else for (const m of result.meshes) if (!m.parent) m.setEnabled(false);
        }
        any = true;
        console.log(`[Mixamo] loaded ${file} → ${clipName}`);
      } catch (e) {
        console.warn(`[Mixamo] failed ${file}:`, e);
      }
    }
    this.stopAll();
    this.loaded = any;
    return any;
  }

  /** Load a Mixamo glTF/glb (FBX→glTF converted) with all its animation clips. */
  public async load(url: string, fileName?: string): Promise<boolean> {
    try {
      const result = await BABYLON.SceneLoader.ImportMeshAsync('', url, fileName ?? '', this.scene);
      // Root container
      const rootNode = result.transformNodes.find(n => !n.parent) ?? result.meshes.find(m => !m.parent);
      if (rootNode) rootNode.parent = this.root;
      else for (const m of result.meshes) if (!m.parent) m.parent = this.root;

      this.animationGroups = result.animationGroups;
      this.clipMap.clear();
      for (const g of result.animationGroups) {
        // Normalise names: "mixamo.com" → use targetAnimation if present
        let name = g.name.replace(/\|.*$/, '').trim();
        if (name.toLowerCase().includes('mixamo') || name === '') {
          name = g.targetedAnimations[0]?.animation?.name ?? name;
        }
        this.clipMap.set(name.toLowerCase(), g);
      }
      // Stop all by default — we play clips explicitly
      this.stopAll();
      this.loaded = true;
      return true;
    } catch (e) {
      console.warn('[Mixamo] load failed (procedural rig remains):', e);
      return false;
    }
  }

  /** Load an additional animation-only GLB (no visible mesh) and register its
   *  clip under `alias`. Used for extra mocap like slide / crouched-walk that
   *  ships separately from the main character GLB. */
  public async addClip(url: string, file: string, alias: string): Promise<boolean> {
    try {
      const result = await BABYLON.SceneLoader.ImportMeshAsync('', url, file, this.scene);
      for (const g of result.animationGroups) {
        g.name = alias;
        this.clipMap.set(alias.toLowerCase(), g);
        this.animationGroups.push(g);
        g.stop(); g.weight = 0;
      }
      // These GLBs are animation-only (no meshes), but hide any if present.
      for (const m of result.meshes) m.setEnabled(false);
      for (const n of result.transformNodes) n.setEnabled(false);
      console.log(`[Mixamo] added clip ${alias} from ${file}`);
      return result.animationGroups.length > 0;
    } catch (e) {
      console.warn(`[Mixamo] failed to add clip ${alias}:`, e);
      return false;
    }
  }

  /** Map a game state to a clip name with common Mixamo aliases. */
  private resolve(name: string): BABYLON.AnimationGroup | null {
    const aliases: Record<string, string[]> = {
      idle: ['idle', 'idle 1', 'standing idle', 'breathing idle'],
      walk: ['walk', 'walking', 'walk forward'],
      run: ['run', 'running', 'sprint', 'run forward'],
      jump: ['jump', 'jump up', 'jumping', 'jump in place'],
      fall: ['fall', 'falling', 'fall down'],
      land: ['land', 'landing', 'landing idle'],
      crouch: ['crouch', 'crouching', 'crouch idle', 'sneak', 'crouchwalk'],
      crouchwalk: ['crouchwalk', 'crouched walk', 'crouched walking'],
      slide: ['slide', 'sliding', 'running slide'],
      flip: ['flip', 'front flip', 'aerial flip', 'jump flip'],
      doublejump: ['double jump', 'jump 2', 'flip jump'],
      back: ['walk backwards', 'backward walk', 'walk back'],
      strafe: ['strafe', 'sidestep', 'walk sideways'],
    };
    const key = name.toLowerCase();
    const direct = this.clipMap.get(key) ?? this.clipMap.get(key.replace(/\s/g, ''));
    if (direct) return direct;
    for (const [canonical, list] of Object.entries(aliases)) {
      if (key !== canonical) continue;
      for (const a of list) {
        const g = this.clipMap.get(a) ?? this.clipMap.get(a.replace(/\s/g, ''));
        if (g) return g;
      }
    }
    return null;
  }

  /** Play a clip with a real, interruptible crossfade.
   *  The previous bug set group.weight = 1 immediately after starting the
   *  blend, so the crossfade observer fought it and the pose froze. */
  public play(name: string, loop = true): boolean {
    if (!this.loaded) return false;
    const group = this.resolve(name);
    if (!group) return false;
    if (this.current === group) return true;

    // Cancel an in-flight fade so rapid transitions never stack observers.
    if (this.fadeObs) {
      this.scene.onBeforeAnimationsObservable.remove(this.fadeObs);
      this.fadeObs = null;
    }
    const old = this.current;
    // Silence anything that is neither the outgoing nor incoming clip —
    // otherwise several groups drive the same bones at once and the mesh
    // freezes or jitters between poses.
    for (const g of this.animationGroups) {
      if (g !== old && g !== group) { g.stop(); g.weight = 0; }
    }
    group.speedRatio = 1;

    if (!old) {
      group.start(loop);
      group.weight = 1;
      this.current = group;
      return true;
    }

    const from = old.weight ?? 1;
    old.weight = from;
    group.start(loop);
    group.weight = 0;
    let t = 0;
    const FADE = 0.16; // seconds — snappy, AAA feel
    // Update weights BEFORE animation evaluation. Updating them afterwards
    // (onBeforeRender) makes the clip pose one frame stale relative to the
    // foot-IK / root-motion pass, which shows up as a stutter at hand-offs.
    this.fadeObs = this.scene.onBeforeAnimationsObservable.add(() => {
      t += this.scene.getEngine().getDeltaTime() / 1000 / FADE;
      const k = Math.min(1, t);
      const e = k * k * (3 - 2 * k); // smoothstep
      old.weight = from * (1 - e);
      group.weight = e;
      if (k >= 1) {
        old.stop();
        old.weight = 0;
        this.scene.onBeforeAnimationsObservable.remove(this.fadeObs!);
        this.fadeObs = null;
      }
    });
    this.current = group;
    return true;
  }

  /** Scale the ACTIVE clip's playback rate. Matching this to ground speed
   *  removes foot sliding — the legs move as fast as the character travels. */
  public setCurrentSpeed(ratio: number) {
    if (!this.current) return;
    const r = Math.max(-2, Math.min(2, ratio));
    if (Math.abs(this.current.speedRatio - r) > 0.01) this.current.speedRatio = r;
  }

  public setSpeed(speed: number) {
    if (this.current) this.current.speedRatio = speed;
  }

  public stopAll() {
    if (this.fadeObs) { this.scene.onBeforeAnimationsObservable.remove(this.fadeObs); this.fadeObs = null; }
    for (const g of this.animationGroups) { g.stop(); g.weight = 0; g.speedRatio = 1; }
    this.current = null;
  }

  public isLoaded() { return this.loaded; }
  public availableClips() { return [...this.clipMap.keys()]; }
  public dispose() { this.stopAll(); this.root.dispose(false, false); }
}
