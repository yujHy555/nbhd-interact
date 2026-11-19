import * as BABYLON from 'babylonjs';
import HK from '@babylonjs/havok';
import { HavokPlugin } from 'babylonjs';

/** Thin wrapper around Babylon V2 Havok physics (AAA deterministic physics). */
export class HavokWorld {
  public plugin!: HavokPlugin;
  public hp: any = null;
  public initialized = false;
  private scene: BABYLON.Scene;

  constructor(scene: BABYLON.Scene) { this.scene = scene; }

  public async init(gravityY = -24) {
    this.hp = await HK({ locateFile: (path: string) => `/wasm/${path}` });
    this.plugin = new BABYLON.HavokPlugin(true, this.hp);
    this.scene.enablePhysics(new BABYLON.Vector3(0, gravityY, 0), this.plugin);
    this.initialized = true;
  }

  public dynamicBody(mesh: BABYLON.Mesh | BABYLON.TransformNode, shape: BABYLON.PhysicsShape,
    opts: { mass?: number; linearDamping?: number; angularDamping?: number; disablePreStep?: boolean } = {}): BABYLON.PhysicsBody {
    const body = new BABYLON.PhysicsBody(mesh, BABYLON.PhysicsMotionType.DYNAMIC, false, this.scene);
    body.shape = shape;
    if (opts.linearDamping !== undefined) body.setLinearDamping(opts.linearDamping);
    if (opts.angularDamping !== undefined) body.setAngularDamping(opts.angularDamping);
    if (opts.disablePreStep === true) body.disablePreStep = true;
    if (opts.mass !== undefined) {
      const mp = body.computeMassProperties();
      mp.mass = opts.mass;
      body.setMassProperties(mp);
    }
    return body;
  }

  public staticBody(mesh: BABYLON.Mesh, shape: BABYLON.PhysicsShape): BABYLON.PhysicsBody {
    const body = new BABYLON.PhysicsBody(mesh, BABYLON.PhysicsMotionType.STATIC, false, this.scene);
    body.shape = shape;
    return body;
  }

  public boxShape(w: number, h: number, d: number) {
    return new BABYLON.PhysicsShapeBox(BABYLON.Vector3.Zero(), BABYLON.Quaternion.Identity(),
      new BABYLON.Vector3(w / 2, h / 2, d / 2), this.scene);
  }
  public sphereShape(r: number) { return new BABYLON.PhysicsShapeSphere(BABYLON.Vector3.Zero(), r, this.scene); }
  public capsuleShape(r: number, height: number) {
    return new BABYLON.PhysicsShapeCapsule(new BABYLON.Vector3(0, height / 2, 0),
      new BABYLON.Vector3(0, -height / 2, 0), r, this.scene);
  }
  public getVelocity(body: BABYLON.PhysicsBody): BABYLON.Vector3 {
    const v = BABYLON.Vector3.Zero(); body.getLinearVelocityToRef(v); return v;
  }
  public setVelocity(body: BABYLON.PhysicsBody, v: BABYLON.Vector3) { body.setLinearVelocity(v); }
  public addImpulse(body: BABYLON.PhysicsBody, impulse: BABYLON.Vector3, at?: BABYLON.Vector3) {
    body.applyImpulse(impulse, at ?? body.transformNode.position);
  }
  public teleport(body: BABYLON.PhysicsBody, pos: BABYLON.Vector3) {
    // Direct position — preStep reads it next frame. Disabling preStep target
    // transforms here caused violent solver fights, so we never use them.
    body.transformNode.position.copyFrom(pos);
    body.setLinearVelocity(BABYLON.Vector3.Zero());
    body.setAngularVelocity(BABYLON.Vector3.Zero());
  }
}
