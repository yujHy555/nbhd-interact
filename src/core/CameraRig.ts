import * as BABYLON from 'babylonjs';

/** Cinematic side-scrolling follow camera with smooth tracking and look-ahead.
 *
 *  Driven through the ArcRotateCamera's alpha/beta/radius/target — writing
 *  position directly is futile because the camera recomputes it from those
 *  values on every render. Gamepad left stick changes alpha/beta (orbit),
 *  right stick moves the character. */
export class CameraRig {
  private camera: BABYLON.ArcRotateCamera;
  private focus = new BABYLON.Vector3(0, 1.2, 0);
  private shake = 0;
  private shakeAmp = 0;
  public distance = 16;
  public orbitYaw = 0;   // gamepad left stick → camera yaw
  public orbitPitch = 0; // gamepad left stick → camera pitch

  public addOrbit(dx: number, dy: number) {
    this.camera.alpha += dx;
    this.camera.beta = BABYLON.Scalar.Clamp(this.camera.beta + dy, 0.25, 1.42);
    this.orbitYaw = this.camera.alpha + Math.PI / 2;
    this.orbitPitch = this.camera.beta - 1.15;
  }

  constructor(scene: BABYLON.Scene, canvas: HTMLCanvasElement) {
    // alpha -π/2 puts the camera at -Z looking toward +Z (screen right = +X).
    this.camera = new BABYLON.ArcRotateCamera('cam', -Math.PI / 2, 1.15, this.distance, new BABYLON.Vector3(0, 1, 0), scene);
    this.camera.lowerRadiusLimit = 6;
    this.camera.upperRadiusLimit = 26;
    this.camera.lowerBetaLimit = 0.25;
    this.camera.upperBetaLimit = 1.42;
    this.camera.wheelPrecision = 40;
    // No inertial damping — orbit must respond instantly to input.
    this.camera.inertia = 0;
    this.camera.angularSensibilityX = 500;
    this.camera.angularSensibilityY = 500;
    this.camera.attachControl(canvas, true);
    // Our own layer drives ALL orbit input (gamepad right stick + mouse drag).
    // Remove Babylon's competing inputs so nothing fights our alpha/beta writes.
    this.camera.inputs.removeByType('ArcRotateCameraKeyboardMoveInput');
    this.camera.inputs.removeByType('ArcRotateCameraGamepadInput');
    this.camera.inputs.removeByType('ArcRotateCameraMouseWheelInput');
    this.camera.inputs.removeByType('ArcRotateCameraPointersInput');

    // LEFT-MOUSE DRAG → orbit the camera. Handled explicitly instead of via
    // Babylon's pointer input so it can never fight setTarget/copyFrom writes.
    let dragging = false;
    let lastX = 0, lastY = 0;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; // left button only
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { void err; }
    });
    window.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      this.addOrbit(-dx * 0.013, -dy * 0.013);
    });
    const endDrag = (e?: PointerEvent) => {
      dragging = false;
      if (e) { try { canvas.releasePointerCapture(e.pointerId); } catch (err) { void err; } }
    };
    window.addEventListener('pointerup', (e) => { if (e.button === 0) endDrag(e); });
    window.addEventListener('pointercancel', endDrag);
    window.addEventListener('blur', () => endDrag());
    canvas.addEventListener('lostpointercapture', () => endDrag());
  }

  public getCamera() { return this.camera; }

  public punch(amt = 6) { this.shake = 0.25; this.shakeAmp = amt; }

  /** Snap instantly to a target (used when exploration starts). */
  public snap(target: BABYLON.Vector3) {
    this.focus.set(target.x, target.y + 0.9, target.z);
    this.camera.alpha = -Math.PI / 2;
    this.camera.beta = 1.15;
    this.camera.radius = this.distance;
    this.orbitYaw = 0;
    this.orbitPitch = 0;
    this.camera.setTarget(this.focus);
  }

  public update(dt: number, target: BABYLON.Vector3, lookAhead = 0) {
    // Snappy follow — the camera must not feel heavy when turning.
    const k = Math.min(1, dt * 11);
    this.focus.x += (target.x + lookAhead - this.focus.x) * k;
    this.focus.y += (target.y + 0.9 - this.focus.y) * k;
    this.focus.z += (target.z - this.focus.z) * k;

    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt);
      const f = this.shake * this.shakeAmp * 0.02;
      this.focus.x += (Math.random() - 0.5) * f;
      this.focus.y += (Math.random() - 0.5) * f;
    }
    this.camera.radius += (this.distance - this.camera.radius) * k;
    // Set the target directly (not setTarget) — setTarget recomputes alpha/beta
    // from position every frame, which fights orbit writes → sticky camera.
    this.camera.target.copyFrom(this.focus);
  }
}
