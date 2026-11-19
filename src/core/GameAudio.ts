/**
 * AAA procedural audio engine — all sounds synthesized via Web Audio, no assets.
 * Features tempo-synced footsteps, animation whooshes, landings, pickups, jumps,
 * flips and cinematic UI stingers. Lazily creates the AudioContext on first gesture.
 */
export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private muted = false;
  private footTimer = 0;
  private lastSurface = '';

  private ensure() {
    if (this.ctx) return this.ctx;
    try {
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.42;
      this.master.connect(this.ctx.destination);
    } catch { this.ctx = null; }
    return this.ctx;
  }
  public unlock() { const c = this.ensure(); if (c && c.state === 'suspended') c.resume(); }
  public setMuted(m: boolean) { this.muted = m; if (this.master) this.master.gain.value = m ? 0 : 0.42; }
  public get isMuted() { return this.muted; }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, slideTo?: number) {
    const ctx = this.ensure();
    if (!ctx || !this.master || this.muted) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, ctx.currentTime);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), ctx.currentTime + dur);
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g); g.connect(this.master);
    o.start(); o.stop(ctx.currentTime + dur + 0.02);
  }
  private noise(dur: number, vol: number, filterFreq: number, type: BiquadFilterType = 'lowpass') {
    const ctx = this.ensure();
    if (!ctx || !this.master || this.muted) return;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = filterFreq;
    const g = ctx.createGain(); g.gain.value = vol;
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start();
  }

  // ---- Movement ----
  public jump() { this.tone(300, 0.16, 'square', 0.16, 620); this.noise(0.08, 0.06, 2400); }
  public doubleJump() {
    this.tone(440, 0.14, 'square', 0.14, 880);
    this.tone(660, 0.18, 'triangle', 0.1, 1320);
    this.noise(0.1, 0.05, 3200);
  }
  public flip() { this.noise(0.3, 0.11, 1800, 'bandpass'); this.tone(300, 0.22, 'sine', 0.12, 1100); }
  public land(impact = 5) {
    this.tone(120, 0.18, 'sine', 0.2, 58);
    this.noise(0.14, Math.min(0.2, 0.06 + impact * 0.012), 820);
  }
  public crouch() { this.noise(0.12, 0.05, 1200); this.tone(160, 0.1, 'sine', 0.08, 100); }

  /** Footsteps are driven by the animation cycle — call from the foot-plant event. */
  public footstep(surface = 'concrete', intensity = 1) {
    if (surface !== this.lastSurface) { this.lastSurface = surface; }
    const base = surface === 'metal' ? 1500 : surface === 'grass' ? 700 : 980;
    this.noise(0.06, 0.07 * intensity, base, 'bandpass');
    this.tone(70 + Math.random() * 20, 0.05, 'sine', 0.06 * intensity, 45);
    if (surface === 'metal') this.tone(1800, 0.04, 'triangle', 0.03, 1200);
  }

  /** Drive footsteps from the REAL Mixamo cycle phase (0..1). Two clean
   *  footfalls per cycle — one at 0.05, one at 0.55 — with slight variation. */
  public updateFootsteps(dt: number, speed: number, phase: number, grounded: boolean, state: string) {
    if (!grounded || speed < 0.4 || (state !== 'walk' && state !== 'run')) { this.footTimer = 0; this.lastStep = -1; return; }
    // phase is normalised 0..1 of the active clip; two foot plants per cycle.
    const stepIndex = Math.floor(phase * 2);
    if (stepIndex !== this.lastStep) {
      this.lastStep = stepIndex;
      const surface = 'concrete';
      const intensity = state === 'run' ? 1.2 : 0.9;
      this.footstep(surface, intensity * (0.94 + Math.random() * 0.12)); // natural variation
    }
    void dt;
  }
  private lastStep = -1;

  // ---- World / UI ----
  public pickup() {
    this.tone(880, 0.09, 'square', 0.1, 1320);
    this.tone(1320, 0.12, 'sine', 0.08, 1980);
  }
  public zone() { [523, 659, 784].forEach((f, i) => setTimeout(() => this.tone(f, 0.18, 'triangle', 0.09), i * 70)); }
  public uiClick() { this.tone(700, 0.05, 'square', 0.06, 900); }
  /** Cinematic AAA button sounds — distinct tones per button role. */
  public button(kind: 'play' | 'menu' | 'collapse' | 'nav' | 'toggle' = 'nav') {
    switch (kind) {
      case 'play':
        [523, 784, 1046].forEach((f, i) => setTimeout(() => this.tone(f, 0.14, 'triangle', 0.09, f * 1.5), i * 60));
        this.noise(0.12, 0.04, 3200);
        break;
      case 'collapse':
        this.tone(220, 0.5, 'sawtooth', 0.13, 55);
        this.noise(0.5, 0.1, 600, 'lowpass');
        [880, 660, 440].forEach((f, i) => setTimeout(() => this.tone(f, 0.1, 'square', 0.05), i * 90));
        break;
      case 'menu':
        this.tone(400, 0.1, 'triangle', 0.08, 300);
        this.tone(300, 0.12, 'sine', 0.06, 200);
        break;
      case 'toggle':
        this.tone(620, 0.05, 'square', 0.05, 880);
        this.tone(880, 0.04, 'triangle', 0.03);
        break;
      default:
        this.tone(760, 0.045, 'triangle', 0.05, 1100);
        this.noise(0.03, 0.02, 2800);
    }
  }
  public whoosh() { this.noise(0.18, 0.06, 1400, 'bandpass'); }

  public dispose() { this.ctx?.close(); this.ctx = null; }
}
