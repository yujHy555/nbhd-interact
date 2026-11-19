import { CharacterColors } from '../character/Character';

type Handler = () => void;

/** DOM UI layer: overlays, customization, zone chips, FPS. */
export class UI {
  private onCustomize: (c: CharacterColors) => void;
  private onRotate: (on: boolean) => void;
  private onExplore: Handler;
  private colors: CharacterColors;
  private rotateOn = false;

  constructor(colors: CharacterColors, handlers: {
    customize: (c: CharacterColors) => void;
    rotate: (on: boolean) => void;
    explore: Handler;
  }) {
    this.colors = { ...colors };
    this.onCustomize = handlers.customize;
    this.onRotate = handlers.rotate;
    this.onExplore = handlers.explore;
    this.buildCustomization();
    this.wire();
  }

  private el(id: string) { return document.getElementById(id); }
  private show(id: string) { this.el(id)?.classList.add('visible'); }
  private hide(id: string) { this.el(id)?.classList.remove('visible'); }

  public setLoading(pct: number) {
    const f = this.el('loader-fill');
    if (f) f.style.width = `${pct}%`;
  }
  public hideLoading() { const l = this.el('loading'); if (l) l.style.display = 'none'; }

  private wire() {
    this.el('btn-customize')?.addEventListener('click', () => this.show('customize'));
    this.el('btn-cust-done')?.addEventListener('click', () => this.hide('customize'));
    this.el('btn-explore')?.addEventListener('click', () => {
      this.hide('welcome');
      this.onExplore();
    });
    const rot = this.el('btn-rotate');
    rot?.addEventListener('click', () => {
      this.rotateOn = !this.rotateOn;
      if (rot) rot.textContent = `⟳ Turntable: ${this.rotateOn ? 'ON' : 'OFF'}`;
      rot?.classList.toggle('on', this.rotateOn);
      this.onRotate(this.rotateOn);
    });
    this.el('btn-wwd-close')?.addEventListener('click', () => this.hide('whatwedo'));
    this.el('btn-contact-close')?.addEventListener('click', () => this.hide('contact'));
  }

  private buildCustomization() {
    const host = this.el('cust-controls');
    if (!host) return;
    const palettes: Record<string, string[]> = {
      Skin: ['#dbab7a', '#c88e5e', '#8d5a3b', '#f0c9a0', '#5c3a28'],
      Outfit: ['#1f6bc7', '#c0392b', '#1e8449', '#6c3483', '#2c3e50'],
      Accent: ['#ffc857', '#5ce1e6', '#ff7fb8', '#a3e635', '#f1f5f9'],
      Shoes: ['#1a1a1a', '#ffffff', '#c0392b', '#1f6bc7', '#ffc857'],
      Hair: ['#2e1d12', '#8b5a2b', '#111111', '#b5651d', '#e0c068'],
    };
    const keys: (keyof CharacterColors)[] = ['skin', 'outfit', 'accent', 'shoes', 'hair'];
    host.innerHTML = '';
    keys.forEach((key) => {
      const wrap = document.createElement('div');
      wrap.style.marginBottom = '14px';
      const label = document.createElement('div');
      label.className = 'cust-label';
      label.textContent = key;
      const row = document.createElement('div');
      row.className = 'swatch-row';
      palettes[key.charAt(0).toUpperCase() + key.slice(1)].forEach((hex) => {
        const sw = document.createElement('div');
        sw.className = 'swatch';
        sw.style.background = hex;
        const rgb = this.hexToRgb(hex);
        if (this.colors[key].every((v, i) => Math.abs(v * 255 - rgb[i]) < 6)) sw.classList.add('active');
        sw.addEventListener('click', () => {
          row.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
          sw.classList.add('active');
          this.colors[key] = [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
          this.onCustomize(this.colors);
        });
        row.appendChild(sw);
      });
      wrap.append(label, row);
      host.appendChild(wrap);
    });
  }

  private hexToRgb(hex: string): [number, number, number] {
    const n = parseInt(hex.replace('#', ''), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  public setZone(name: string) {
    const chip = this.el('zone-chip');
    if (chip) chip.textContent = `${name} ZONE`;
    this.hide('whatwedo'); this.hide('contact');
    if (name === 'WHAT WE DO') this.show('whatwedo');
    if (name === 'CONTACT') this.show('contact');
  }

  public setPickups(n: number, total: number) {
    const e = this.el('pickup-count');
    if (e) e.textContent = `COLLECTIBLES ${n} / ${total}`;
  }

  public setFps(n: number) {
    const e = this.el('fps');
    if (e) e.textContent = `${n} FPS`;
  }
}
