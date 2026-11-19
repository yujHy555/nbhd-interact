import * as BABYLON from 'babylonjs';

export interface InputState {
  left: boolean;
  right: boolean;
  forward: boolean;
  back: boolean;
  jump: boolean;
  jumpPressed: boolean;
  axisX: number;
  axisZ: number;
  cameraX: number;  // right stick → camera orbit
  cameraZ: number;
  run: boolean;     // Shift key OR gamepad shoulder → sprint / run animation
  anyInput: boolean;
}

/** Keyboard (WASD/arrows) + gamepad input, with edge detection. */
export class Input {
  public state: InputState = {
    left: false, right: false, forward: false, back: false,
    jump: false, jumpPressed: false, axisX: 0, axisZ: 0, cameraX: 0, cameraZ: 0, run: false, anyInput: false,
  };
  private keys = new Set<string>();
  private justPressed = new Set<string>();
  private padPrev: Record<string, boolean> = {};

  constructor() {
    window.addEventListener('keydown', (e) => {
      const k = this.map(e.code);
      if (!k) return;
      if (!this.keys.has(k)) this.justPressed.add(k);
      this.keys.add(k);
      if (k === 'jump' || k === 'forward' || k === 'back') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      const k = this.map(e.code);
      if (k) this.keys.delete(k);
    });
    window.addEventListener('blur', () => this.keys.clear());
  }

  private map(code: string): string | null {
    switch (code) {
      case 'ArrowLeft': case 'KeyA': return 'left';
      case 'ArrowRight': case 'KeyD': return 'right';
      case 'ArrowUp': case 'KeyW': return 'forward';
      case 'ArrowDown': case 'KeyS': return 'back';
      case 'Space': return 'jump';
      default: return null;
    }
  }

  public update(dt: number) {
    const snap = new Set(this.justPressed);
    this.justPressed.clear();

    let ax = 0, az = 0;
    if (this.keys.has('left')) ax -= 1;
    if (this.keys.has('right')) ax += 1;
    if (this.keys.has('forward')) az += 1;
    if (this.keys.has('back')) az -= 1;
    let jumpHeld = this.keys.has('jump');
    let jumpPressed = snap.has('jump');
    this.state.run = false;

    // Gamepad — left stick movement, A button jump
    if (navigator.getGamepads) {
      const gps = navigator.getGamepads();
      const gp = gps && gps.length ? Array.from(gps).find(g => g && g.connected) as Gamepad | null : null;
      if (gp) {
        const dz = 0.18;
        const dzl = (v: number) => Math.abs(v) > dz ? Math.sign(v) * ((Math.abs(v) - dz) / (1 - dz)) : 0;
        // Left stick = character movement (industry standard)
        const lx = gp.axes[0] ?? 0, ly = gp.axes[1] ?? 0;
        if (Math.abs(lx) > dz) ax = dzl(lx);
        if (Math.abs(ly) > dz) az = -dzl(ly);
        // Right stick = camera orbit
        const rx = gp.axes[2] ?? 0, ry = gp.axes[3] ?? 0;
        this.state.cameraX = dzl(rx);
        this.state.cameraZ = dzl(ry);
        const btn = (i: number) => !!(gp.buttons[i] && gp.buttons[i]!.pressed);
        const jp = btn(0);
        if (jp) { jumpHeld = true; if (!this.padPrev['jump']) jumpPressed = true; }
        this.padPrev['jump'] = jp;
        // Shoulder / stick-click = sprint (the gamepad "Shift equivalent")
        this.state.run = btn(6) || btn(7) || btn(10) || btn(11);
      }
    }

    this.state.axisX = ax;
    this.state.axisZ = az;
    this.state.left = ax < -0.15;
    this.state.right = ax > 0.15;
    this.state.forward = az > 0.15;
    this.state.back = az < -0.15;
    this.state.jump = jumpHeld;
    this.state.jumpPressed = jumpPressed;
    this.state.anyInput = ax !== 0 || az !== 0 || jumpHeld;
  }
}
