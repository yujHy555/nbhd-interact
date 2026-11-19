import * as BABYLON from 'babylonjs';

/** Developer-only tools panel. This file is imported ONLY when
 *  import.meta.env.DEV is true, so Vite/tree-shaking removes it entirely
 *  from production builds — it will never appear in the deployed game. */
export class DevPanel {
  private el: HTMLDivElement;
  private stats: HTMLDivElement;
  private app: any;
  private observer: BABYLON.Observer<BABYLON.Scene>;

  constructor(app: any) {
    this.app = app;
    this.el = document.createElement('div');
    this.el.id = 'devpanel';
    this.el.innerHTML = `
      <div class="dev-head">⚙ DEV TOOLS <span class="dev-badge">DEV ONLY</span></div>
      <div class="dev-axis">
        <div class="ax-row"><i class="ax-x"></i><span>+X → LEVEL END</span></div>
        <div class="ax-row"><i class="ax-y"></i><span>+Y ↑ UP</span></div>
        <div class="ax-row"><i class="ax-z"></i><span>+Z → HORIZON</span></div>
      </div>
      <div class="dev-stats">
        <div><span>mode</span><b data-k="mode">—</b></div>
        <div><span>pos</span><b data-k="pos">—</b></div>
        <div><span>state</span><b data-k="state">—</b></div>
        <div><span>grounded</span><b data-k="grounded">—</b></div>
        <div><span>speed</span><b data-k="speed">—</b></div>
        <div><span>cam</span><b data-k="cam">—</b></div>
        <div><span>pixel</span><b data-k="pixel">—</b></div>
        <div><span>meshes</span><b data-k="meshes">—</b></div>
        <div><span>fps</span><b data-k="fps">—</b></div>
      </div>
      <div class="dev-section">TELEPORT</div>
      <div class="dev-grid">
        <button data-tp="0">Start</button><button data-tp="40">Ramp</button>
        <button data-tp="70">Road</button><button data-tp="100">Belt</button>
        <button data-tp="160">Contact</button><button data-tp="240">Extended</button>
        <button data-tp="192">Pixel Door</button>
      </div>
      <div class="dev-section">TOGGLES</div>
      <div class="dev-grid">
        <button data-act="wire">Wireframe</button>
        <button data-act="shadows">Shadows</button>
        <button data-act="pixel">Pixel FX</button>
        <button data-act="drone">Trigger Drone</button>
        <button data-act="fps">FPS</button>
        <button data-act="colliders">Colliders</button>
        <button data-act="axes">3D Axes</button>
      </div>
      <div class="dev-section">SPEED</div>
      <input id="devSpeed" type="range" min="1" max="30" value="6.5" />
      <div class="dev-hint">dev only — stripped from build</div>`;
    document.body.appendChild(this.el);
    this.stats = this.el.querySelector('.dev-stats') as HTMLDivElement;

    this.el.querySelectorAll('[data-tp]').forEach((b) => {
      b.addEventListener('click', () => {
        let x = parseFloat((b as HTMLElement).dataset.tp!);
        // Portal buttons place the player BEFORE the threshold so walking
        // forward actually crosses it (and triggers the transition).
        if (b.textContent === 'Pixel Door') x = 188;   // portal plane at 192
        this.app.ppos.set(x, this.app.world.surfaceHeightAt(x, 0) + 0.2, 0);
        this.app.pvel.set(0, 0, 0);
        this.app.camera.snap(new BABYLON.Vector3(x, 1, 0));
      });
    });
    this.el.querySelectorAll('[data-act]').forEach((b) => {
      b.addEventListener('click', () => this.action((b as HTMLElement).dataset.act!));
    });
    (this.el.querySelector('#devSpeed') as HTMLInputElement).addEventListener('input', (e) => {
      const v = parseFloat((e.target as HTMLInputElement).value);
      if (this.app.world.travelators[0]) this.app.world.travelators[0].speed = v;
    });

    this.observer = app.scene.onAfterRenderObservable.add(() => this.updateStats());
    this.buildAxisGizmo(app);
    this.injectCSS();
  }

  /** Top-right 3D axis gizmo — its own tiny scene/camera, synced to the main
   *  camera orientation. Red=+X (level end), Green=+Y (up), Blue=+Z (horizon). */
  private gizmoEngine?: BABYLON.Engine;
  private gizmoScene?: BABYLON.Scene;
  private gizmoCam?: BABYLON.ArcRotateCamera;
  private gizmoObs?: BABYLON.Observer<BABYLON.Scene>;

  private buildAxisGizmo(app: any) {
    const canvas = document.createElement('canvas');
    canvas.id = 'devAxisCanvas';
    canvas.width = 132; canvas.height = 132;
    document.body.appendChild(canvas);
    const eng = new BABYLON.Engine(canvas, true);
    this.gizmoEngine = eng;
    const sc = new BABYLON.Scene(eng);
    sc.clearColor = new BABYLON.Color4(0, 0, 0, 0);
    this.gizmoScene = sc;
    const cam = new BABYLON.ArcRotateCamera('gizmoCam', -Math.PI / 2, 1.1, 4.6, BABYLON.Vector3.Zero(), sc);
    this.gizmoCam = cam;

    const axis = (dir: BABYLON.Vector3, hex: string) => {
      const shaft = BABYLON.MeshBuilder.CreateCylinder('ax', { diameter: 0.075, height: 1.1, tessellation: 8 }, sc);
      const tip = BABYLON.MeshBuilder.CreateCylinder('axTip', { diameterTop: 0, diameterBottom: 0.2, height: 0.28, tessellation: 10 }, sc);
      const mat = new BABYLON.StandardMaterial('axMat', sc);
      const col = BABYLON.Color3.FromHexString(hex);
      mat.diffuseColor = col; mat.emissiveColor = col; mat.specularColor = col; mat.disableLighting = true;
      shaft.material = mat; tip.material = mat;
      const root = new BABYLON.TransformNode('axRoot', sc);
      shaft.parent = root; tip.parent = root;
      shaft.position.y = 0.55; tip.position.y = 1.24;
      // orient root so its local +Y points along the world axis
      const up = BABYLON.Vector3.Up();
      // Rotate local +Y onto the requested world axis.
      root.rotationQuaternion = BABYLON.Quaternion.RotationAxis(
        BABYLON.Vector3.Cross(up, dir).normalize(), Math.acos(Math.min(1, BABYLON.Vector3.Dot(up, dir))));
      return root;
    };
    axis(BABYLON.Axis.X, '#ff5a5a');
    axis(BABYLON.Axis.Y, '#6cff8a');
    axis(BABYLON.Axis.Z, '#5aa8ff');
    // Small origin sphere
    const origin = BABYLON.MeshBuilder.CreateSphere('axOrigin', { diameter: 0.16, segments: 10 }, sc);
    const om = new BABYLON.StandardMaterial('axOriginMat', sc);
    om.emissiveColor = new BABYLON.Color3(0.9, 0.9, 0.9); om.disableLighting = true;
    origin.material = om;
    new BABYLON.HemisphericLight('axLight', new BABYLON.Vector3(0, 1, 0), sc);

    // Sync gizmo camera to the MAIN camera's view orientation each frame.
    this.gizmoObs = app.scene.onAfterRenderObservable.add(() => {
      const main = app.camera.getCamera();
      cam.alpha = main.alpha;
      cam.beta = main.beta;
      cam.radius = 4.6;
      cam.setTarget(BABYLON.Vector3.Zero());
      sc.render();
    });
  }

  private action(a: string) {
    const s = this.app.scene;
    switch (a) {
      case 'wire':
        s.meshes.forEach((m: BABYLON.AbstractMesh) => { const mat = (m as BABYLON.Mesh).material; if (mat) mat.wireframe = !mat.wireframe; });
        break;
      case 'shadows':
        this.app.env.shadowGen.getShadowMap().renderList.length = 0;
        break;
      case 'pixel':
        this.app.pixelPortal.amount = this.app.pixelPortal.amount > 0.5 ? 0 : 1;
        this.app.pixelPortal.targetAmount = this.app.pixelPortal.amount;
        break;
      case 'drone':
        this.app.exploreTime = 29.99;
        break;
      case 'fps':
        this.app.debug = !this.app.debug;
        break;
      case 'colliders':
        this.app.toggleDebug();
        break;
    }
  }

  private lastStats = 0;
  private vals: Record<string, HTMLElement> = {};

  private updateStats() {
    const now = performance.now();
    if (now - this.lastStats < 400) return; // throttle to 2.5Hz
    this.lastStats = now;
    const a = this.app;
    const cam = a.camera.getCamera();
    if (!Object.keys(this.vals).length) {
      this.el.querySelectorAll('[data-k]').forEach((n) => { this.vals[(n as HTMLElement).dataset.k!] = n as HTMLElement; });
    }
    // textContent only — no DOM rebuild, no reflow, no button shifting.
    this.vals['mode'].textContent = a.mode;
    this.vals['pos'].textContent = `${a.ppos.x.toFixed(1)},${a.ppos.y.toFixed(1)},${a.ppos.z.toFixed(1)}`;
    this.vals['state'].textContent = a.character.state;
    this.vals['grounded'].textContent = String(a.grounded);
    this.vals['speed'].textContent = Math.hypot(a.pvel.x, a.pvel.z).toFixed(2);
    this.vals['cam'].textContent = `${cam.position.x.toFixed(0)},${cam.position.y.toFixed(0)},${cam.position.z.toFixed(0)}`;
    this.vals['pixel'].textContent = a.pixelPortal?.amount.toFixed(2) ?? '0';
    this.vals['meshes'].textContent = String(a.scene.meshes.length);
    this.vals['fps'].textContent = String(a.scene.getEngine().getFps());
  }

  private injectCSS() {
    if (document.getElementById('devpanel-css')) return;
    const st = document.createElement('style');
    st.id = 'devpanel-css';
    st.textContent = `
      #devpanel { position:absolute; top:14px; right:14px; width:236px; height:430px; z-index:40; pointer-events:auto;
        box-sizing:border-box; overflow:hidden;
        background:rgba(6,14,20,0.94); border:1px solid rgba(255,120,60,0.5); border-radius:10px;
        padding:12px; color:#d8e8ee; font:11px/1.4 ui-monospace,monospace; box-shadow:0 12px 40px rgba(0,0,0,0.6); }
      .dev-head { font-weight:800; letter-spacing:0.1em; color:#ff9a5a; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center; }
      .dev-badge { font-size:8px; background:#ff7a3a; color:#1a0a00; padding:2px 5px; border-radius:3px; font-weight:800; }
      .dev-axis { display:grid; gap:3px; margin-bottom:8px; padding:6px; border:1px solid rgba(255,255,255,0.1); border-radius:5px; background:rgba(0,0,0,0.25); }
      .ax-row { display:flex; align-items:center; gap:6px; font-size:9px; letter-spacing:0.06em; }
      .ax-row i { width:12px; height:3px; border-radius:2px; display:inline-block; }
      .ax-x { background:#ff5a5a; } .ax-y { background:#6cff8a; } .ax-z { background:#5aa8ff; }
      .dev-stats { display:grid; grid-template-columns:1fr 1fr; gap:2px 8px; margin-bottom:10px; }
      .dev-stats div { display:flex; justify-content:space-between; border-bottom:1px solid rgba(255,255,255,0.07); }
      .dev-stats span { opacity:0.55; }
      .dev-stats b { color:#5ce1e6; font-weight:600; }
      .dev-section { margin:9px 0 5px; font-size:9px; letter-spacing:0.16em; color:#ff9a5a; opacity:0.8; }
      .dev-grid { display:grid; grid-template-columns:1fr 1fr; gap:4px; }
      .dev-grid button { pointer-events:auto; cursor:pointer; background:rgba(255,255,255,0.06); color:#d8e8ee;
        border:1px solid rgba(255,255,255,0.15); border-radius:5px; padding:5px; font:10px ui-monospace,monospace; }
      .dev-grid button:hover { background:rgba(255,154,90,0.25); border-color:#ff9a5a; }
      #devSpeed { width:100%; }
      .dev-hint { margin-top:8px; font-size:9px; opacity:0.35; text-align:center; }
      #devAxisCanvas { position:absolute; top:14px; right:262px; width:132px; height:132px; z-index:41;
        pointer-events:none; border:1px solid rgba(255,154,90,0.35); border-radius:8px; background:rgba(6,14,20,0.5); }`;
    document.head.appendChild(st);
  }

  public dispose() {
    this.app.scene.onAfterRenderObservable.remove(this.observer);
    this.el.remove();
  }
}
