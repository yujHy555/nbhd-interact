type Handler = () => void;

/** DOM UI layer: overlays, zone chips, FPS. */
export class UI {
  private onExplore: Handler;

  constructor(colors: { [k: string]: any }, handlers: { explore: Handler }) {
    void colors;
    this.onExplore = handlers.explore;
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
    this.el('btn-explore')?.addEventListener('click', () => {
      this.hide('welcome');
      this.onExplore();
    });
    this.el('btn-wwd-close')?.addEventListener('click', () => this.hide('whatwedo'));
    this.el('btn-contact-close')?.addEventListener('click', () => this.hide('contact'));
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
