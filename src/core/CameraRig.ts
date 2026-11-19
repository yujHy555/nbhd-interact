import * as BABYLON from 'babylonjs';

/** Cinematic side-scrolling follow camera with smooth tracking and look-ahead. */
export class CameraRig {
  private camera: BABYLON.ArcRotateCamera;
  private scene: BABYLON.Scene;
  private focus = new BABYLON.Vector3(0, 1.2, 0);
  private current = new BABYLON.Vector3(-8, 4.5, -14);
  private shake = 0;
  private shakeAmp = 0;
  public distance = 13;
  public height = 4.6;
  public sideOffset = -3.5;

  constructor(scene: BABYLON.Scene, canvas: HTMLCanvasElement) {
    this.scene = scene;
    // Use a FreeCamera-style TargetCamera we drive manually via position+target
    this.camera = new BABYLON.ArcRotateCamera('cam', -Math.PI / 2, 1.15, 16, new BABYLON.Vector3(0, 1, 0), scene);
    this.camera.lowerRadiusLimit = 6;
    this.camera.upperRadiusLimit = 40;
    this.camera.wheelPrecision = 40;
    this.camera.attachControl(canvas, true);
    this.camera.inputs.removeByType('ArcRotateCameraKeyboardMoveInput');
  }

  public getCamera() { return this.camera; }

  public punch(amt = 6) { this.shake = 0.25; this.shakeAmp = amt; }

  /** Snap instantly to a target (used on zone level load). */
  public snap(target: BABYLON.Vector3) {
    this.focus.copyFrom(target);
    this.current.set(target.x + this.sideOffset, target.y + this.height, -this.distance);
    this.camera.setTarget(this.focus);
    this.camera.position.copyFrom(this.current);
  }

  public update(dt: number, target: BABYLON.Vector3, lookAhead = 0) {
    // Desired: side-scrolling 2.5D view (camera in front at -Z, offset left)
    const desired = new BABYLON.Vector3(
      target.x + this.sideOffset + lookAhead * 1.5,
      target.y + this.height,
      -this.distance,
    );
    const k = Math.min(1, dt * 4.5);
    this.current.x += (desired.x - this.current.x) * k;
    this.current.y += (desired.y - this.current.y) * k;
    this.current.z += (desired.z - this.current.z) * k;
    this.focus.x += (target.x + lookAhead - this.focus.x) * k;
    this.focus.y += (target.y + 0.9 - this.focus.y) * k;
    this.focus.z += (target.z - this.focus.z) * k;

    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt);
      const f = this.shake * this.shakeAmp * 0.02;
      this.current.x += (Math.random() - 0.5) * f;
      this.current.y += (Math.random() - 0.5) * f;
    }
    this.camera.position.copyFrom(this.current);
    this.camera.setTarget(this.focus);
  }
}
