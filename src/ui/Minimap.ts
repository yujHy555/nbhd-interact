import { World } from '../world/World';

/** Cinematic top-down route map. Tracks the player, the three zones,
 *  platforms, ramps and collectibles in real time. Drawn at 2× resolution
 *  for a crisp, glassy HUD look. */
export class Minimap {
  private ctx: CanvasRenderingContext2D;
  private W: number;
  private H: number;
  private sx: number; // px per metre along the route
  private sz: number; // px per metre across the route

  constructor(private canvas: HTMLCanvasElement, private world: World) {
    this.ctx = canvas.getContext('2d')!;
    this.W = canvas.width;
    this.H = canvas.height;
    this.sx = this.W / 48; // ±24 m of route
    this.sz = this.H / 20; // ±10 m across
  }

  private px(x: number, playerX: number) { return this.W / 2 + (x - playerX) * this.sx; }
  private py(z: number) { return this.H / 2 - z * this.sz; }

  public update(playerX: number, playerZ: number, heading: number) {
    const c = this.ctx, W = this.W, H = this.H;
    c.clearRect(0, 0, W, H);

    // Backdrop with a subtle vertical gradient
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, 'rgba(12,30,40,0.94)');
    g.addColorStop(1, 'rgba(7,16,22,0.94)');
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);

    // Metric grid — 5 m along X, 2 m across Z
    c.lineWidth = 1;
    c.strokeStyle = 'rgba(120,160,180,0.12)';
    c.beginPath();
    for (let x = Math.floor(playerX / 5) * 5 - 25; x <= playerX + 25; x += 5) {
      const px = this.px(x, playerX);
      c.moveTo(px, 0); c.lineTo(px, H);
    }
    for (let z = -10; z <= 10; z += 2) {
      const py = this.py(z);
      c.moveTo(0, py); c.lineTo(W, py);
    }
    c.stroke();

    // Zone bands
    const zones = this.world.zones;
    const colors = ['rgba(92,225,230,0.10)', 'rgba(255,200,87,0.10)', 'rgba(255,127,184,0.10)'];
    zones.forEach((z, i) => {
      const x0 = this.px(z.x - 4, playerX);
      const x1 = this.px(i + 1 < zones.length ? zones[i + 1].x - 4 : 320, playerX);
      if (x1 < 0 || x0 > W) return;
      c.fillStyle = colors[i % colors.length];
      c.fillRect(x0, 0, Math.max(2, x1 - x0), H);
      c.fillStyle = 'rgba(255,255,255,0.42)';
      c.font = '600 15px Segoe UI, sans-serif';
      c.fillText(z.name, Math.max(8, x0 + 8), 22);
    });

    // Ramps — a warm line showing the incline between two heights
    for (const s of this.world.slopes) {
      const x0 = this.px(s.x - s.w / 2, playerX), x1 = this.px(s.x + s.w / 2, playerX);
      if (x1 < 0 || x0 > W) continue;
      c.strokeStyle = 'rgba(255,200,87,0.85)';
      c.lineWidth = 5;
      c.beginPath(); c.moveTo(x0, this.py(0)); c.lineTo(x1, this.py(0)); c.stroke();
      c.fillStyle = 'rgba(255,200,87,0.9)';
      c.font = '600 13px Segoe UI, sans-serif';
      c.fillText('30°', (x0 + x1) / 2 - 12, this.py(0) - 10);
    }

    // Platforms
    for (const b of this.world.colliders) {
      if (b.w < 0.75 || b.h < 0.3) continue;
      const x = this.px(b.x - b.w / 2, playerX);
      const w = b.w * this.sx;
      if (x + w < 0 || x > W) continue;
      const y = this.py(b.z + b.d / 2);
      const h = b.d * this.sz;
      c.fillStyle = b.x < 70 ? 'rgba(92,225,230,0.45)' : b.x < 150 ? 'rgba(255,200,87,0.45)' : 'rgba(255,127,184,0.45)';
      c.fillRect(x, y, w, h);
      c.strokeStyle = 'rgba(255,255,255,0.35)';
      c.lineWidth = 1;
      c.strokeRect(x, y, w, h);
    }

    // Collectibles
    for (const p of this.world.pickups) {
      if (p.collected) continue;
      const x = this.px(p.pos.x, playerX);
      if (x < 0 || x > W) continue;
      c.fillStyle = '#ffd75e';
      c.beginPath(); c.arc(x, this.py(p.pos.z), 4.5, 0, Math.PI * 2); c.fill();
    }

    // Player view cone
    const dirX = Math.sin(heading), dirZ = Math.cos(heading);
    const ang = Math.atan2(-dirZ * this.sz, dirX * this.sx);
    const cx = this.px(playerX, playerX), cy = this.py(playerZ);
    c.fillStyle = 'rgba(92,225,230,0.16)';
    c.beginPath(); c.moveTo(cx, cy);
    c.arc(cx, cy, 70, ang - 0.42, ang + 0.42);
    c.closePath(); c.fill();

    // Player marker (triangle pointing along travel heading)
    c.save();
    c.translate(cx, cy);
    c.rotate(ang + Math.PI / 2);
    c.fillStyle = '#5ce1e6';
    c.shadowColor = '#5ce1e6';
    c.shadowBlur = 14;
    c.beginPath();
    c.moveTo(0, -11); c.lineTo(8, 9); c.lineTo(0, 5); c.lineTo(-8, 9);
    c.closePath(); c.fill();
    c.restore();
    c.shadowBlur = 0;
    c.fillStyle = 'rgba(255,255,255,0.8)';
    c.font = '600 13px Segoe UI, sans-serif';
    c.fillText('YOU', cx + 12, cy - 10);

    // Compass ticks
    c.fillStyle = 'rgba(255,255,255,0.5)';
    c.font = '600 13px ui-monospace, monospace';
    c.fillText('W', 10, H - 12);
    c.fillText('ROUTE →', W - 88, H - 12);
  }
}
