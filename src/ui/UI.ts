type Handler = () => void;

/** DOM UI layer: main menu, HUD, zone chips, FPS. */
export class UI {
  private onPlay: Handler;
  private onMenu: Handler;
  private onCollapse: Handler;
  private sfx: (kind: 'play' | 'menu' | 'collapse' | 'nav' | 'toggle') => void;

  constructor(colors: { [k: string]: any }, handlers: { play: Handler; menu: Handler; collapse?: Handler; sfx?: (kind: any) => void }) {
    void colors;
    this.onPlay = handlers.play;
    this.onMenu = handlers.menu;
    this.onCollapse = handlers.collapse ?? (() => {});
    this.sfx = handlers.sfx ?? (() => {});
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
    this.el('btn-play')?.addEventListener('click', () => {
      this.sfx('play'); this.hide('mainmenu'); this.onPlay();
    });
    this.el('btn-controls')?.addEventListener('click', () => { this.sfx('nav'); this.show('controls'); });
    this.el('btn-controls-close')?.addEventListener('click', () => { this.sfx('nav'); this.hide('controls'); });
    this.el('btn-credits')?.addEventListener('click', () => { this.sfx('nav'); this.show('credits'); });
    this.el('btn-credits-close')?.addEventListener('click', () => { this.sfx('nav'); this.hide('credits'); });
    this.el('btn-menu')?.addEventListener('click', () => {
      this.sfx('menu');
      this.hide('whatwedo'); this.hide('contact'); this.hide('controls'); this.hide('credits');
      this.show('mainmenu');
      this.onMenu();
    });
    this.el('btn-collapse')?.addEventListener('click', () => {
      this.sfx('collapse');
      const fx = this.el('collapse-fx');
      if (fx) { fx.classList.remove('active'); void fx.offsetWidth; fx.classList.add('active'); }
      this.onCollapse();
    });
    this.el('btn-wwd-close')?.addEventListener('click', () => { this.sfx('nav'); this.hide('whatwedo'); });
    this.el('btn-contact-close')?.addEventListener('click', () => { this.sfx('nav'); this.hide('contact'); });
  }

  public showMainMenu() {
    this.hide('whatwedo'); this.hide('contact'); this.hide('controls'); this.hide('credits');
    this.show('mainmenu');
  }
  public hideMainMenu() { this.hide('mainmenu'); }

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
