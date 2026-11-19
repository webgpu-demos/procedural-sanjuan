// The sound of the morning: plenas and more on the radio (six songs, public/audio), and the road under it.
//   the radio  one song after the other, round again; in the apagón it dies with the power (with a deep thump
//              and the crackle of the lines), then comes back faint and dull, a battery radio somewhere down the
//              street, until the power is back
//   the road   a low rumble of traffic that swells with the cars near the camera and how fast they go
//   your car   its engine (two saws an octave apart under a low-pass, at the firing rate of a four going up through
//              five gears; louder and brighter with the throttle), the air past it, its tyres when they slide (the
//              handbrake), and the knock of what it runs into. All made here: no recordings.
// Starts on a gesture (browsers keep audio off until one).
const SONGS = ['audio/callejon-de-panderetas.m4a', 'audio/fiesta-de-la-memoria.m4a', 'audio/romanoctubre.m4a',
  'audio/island-call-and-response.m4a', 'audio/bounce-playful.m4a', 'audio/perdona-mi-vida.m4a'];
const LEVEL = 0.6; // the radio, against the rest
const GEARS = [13, 23, 34, 46, 60]; // the speed each gear runs out at (m/s)

export class CitySound {
  constructor() { this.ctx = null; this.on = false; this.powered = 1; this.since = 0; this.thump = -1e9; this.failed = 0; }

  start() {
    if (this.ctx) { this.ctx.resume(); this.song.play().catch(() => {}); this.on = true; return; }
    const ctx = this.ctx = new AudioContext(), sr = ctx.sampleRate;
    this.master = ctx.createGain(); this.master.gain.value = 0; this.master.connect(ctx.destination);
    this.master.gain.setTargetAtTime(0.9, ctx.currentTime, 1.2);
    // the radio: the song through a tone control (open, or the muffled radio of the apagón) and its own level
    this.track = 0; this.song = new Audio(SONGS[0]); this.song.preload = 'auto';
    // (one after the other; one that will not load, the next: a song lost to the network ended the radio)
    const next = () => { this.track = (this.track + 1) % SONGS.length; this.song.src = SONGS[this.track]; this.song.play().catch(() => {}); };
    this.song.addEventListener('ended', next);
    this.song.addEventListener('playing', () => { this.failed = 0; });
    this.song.addEventListener('error', () => { if (++this.failed < SONGS.length) next(); });
    this.tone = ctx.createBiquadFilter(); this.tone.type = 'lowpass'; this.tone.frequency.value = 20000; this.tone.Q.value = 0.7;
    this.radio = ctx.createGain(); this.radio.gain.value = LEVEL;
    ctx.createMediaElementSource(this.song).connect(this.tone).connect(this.radio).connect(this.master);
    this.song.play().catch(() => {}); // (inside the click that started the sound)
    // the road: brown noise, looped, under a low-pass
    const len = sr * 4, brown = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) { const d = brown.getChannelData(c); let b = 0; for (let i = 0; i < len; i++) { b = (b + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = b * 3.5; } }
    const road = ctx.createBufferSource(); road.buffer = brown; road.loop = true;
    const low = ctx.createBiquadFilter(); low.type = 'lowpass'; low.frequency.value = 220;
    this.road = ctx.createGain(); this.road.gain.value = 0;
    road.connect(low).connect(this.road).connect(this.master); road.start();
    // your car: the engine, the air, the tyres (silent till you drive: update)
    const white = this.white = ctx.createBuffer(1, sr * 2, sr);
    { const d = white.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    const noise = () => { const n = ctx.createBufferSource(); n.buffer = white; n.loop = true; n.start(); return n; };
    const filter = (type, f, Q = 0.7) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = Q; return b; };
    const gain = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    this.engTone = filter('lowpass', 300, 1.2); this.engine = gain(0);
    this.saws = [0.6, 0.4].map((level) => { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 30; o.connect(gain(level)).connect(this.engTone); o.start(); return o; });
    this.engTone.connect(this.engine).connect(this.master);
    this.wind = gain(0); noise().connect(filter('bandpass', 500, 0.4)).connect(this.wind).connect(this.master);
    this.squeal = gain(0); noise().connect(filter('bandpass', 1250, 9)).connect(this.squeal).connect(this.master);
    this.gear = 0; this.knocked = -1e9;
    this.on = true;
  }

  // What the car ran into, heard: a low thud and a burst of noise, by how hard (0..1)
  knock(hard) {
    const ctx = this.ctx, t = ctx.currentTime;
    this.knocked = t;
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(95, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.22);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.6 * hard, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.32);
    const n = ctx.createBufferSource(); n.buffer = this.white;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 500 + 1800 * hard;
    const ng = ctx.createGain(); ng.gain.setValueAtTime(0.45 * hard, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    n.connect(lp).connect(ng).connect(this.master); n.start(t, Math.random()); n.stop(t + 0.2);
  }

  stop() { if (this.ctx) { this.ctx.suspend(); this.song.pause(); this.on = false; } }

  // The grid failing, heard: a deep thump, the crackle of the lines letting go (the radio dies with the power where
  // the camera is, update).
  blackout() {
    if (!this.on || !this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime + 0.05;
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(28, t + 1.4);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.5, t + 0.03); g.gain.exponentialRampToValueAtTime(0.001, t + 1.8);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + 1.9);
    const len = ctx.sampleRate * 1.2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() < 0.02 ? Math.random() * 2 - 1 : 0) * Math.exp(-i / (len * 0.35));
    const n = ctx.createBufferSource(); n.buffer = buf; const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1800;
    const ng = ctx.createGain(); ng.gain.value = 0.3; n.connect(hp).connect(ng).connect(this.master); n.start(t);
    this.thump = ctx.currentTime;
  }
  // The radio as the power has it: back, as it was; gone, dead (with the thump just heard) and, after a while, faint
  // and dull, a radio on batteries somewhere down the street; gone already when the sound came on, or the clock was
  // taken past the failure, faint and dull at once.
  radioFor(on, now) {
    const r = this.radio.gain, f = this.tone.frequency;
    r.cancelScheduledValues(now); r.setValueAtTime(r.value, now); f.cancelScheduledValues(now); f.setValueAtTime(f.value, now);
    if (on) { r.setTargetAtTime(LEVEL, now, 0.6); f.setTargetAtTime(20000, now, 0.3); return; }
    f.setValueAtTime(650, now + 0.1);
    if (now - this.thump < 4) { r.linearRampToValueAtTime(0, now + 0.05); r.setValueAtTime(0, now + 5); r.linearRampToValueAtTime(LEVEL * 0.4, now + 11); }
    else r.linearRampToValueAtTime(LEVEL * 0.4, now + 1.5);
  }

  // night 0..1; cars: how many near the camera; moving: their mean speed (m/s); height: the camera's above the
  // ground (m); powered: the grid at the camera (0..1); car: the car you drive (drive.js's view: speed, throttle,
  // slip, hit) or null
  update(dt, { cars, moving, height, powered, car = null }) {
    if (!this.on || !this.ctx) return;
    const ctx = this.ctx, now = ctx.currentTime, up = Math.min(1, Math.max(0, (height - 30) / 900));
    const traffic = Math.min(1, Math.log1p(cars) / Math.log1p(400));
    this.road.gain.setTargetAtTime(0.12 * traffic * (1 - 0.75 * up) * (0.4 + 0.6 * Math.min(1, moving / 12)), now, 0.4);
    // your car. The engine turns with the speed in its gear (up a gear near the top of one, down one well below the
    // top of the last: not hunting between two), from 900 to 6,500 rpm; a four fires twice a turn.
    if (car) {
      const v = car.speed;
      if (this.gear < GEARS.length - 1 && v > GEARS[this.gear] * 0.92) this.gear++;
      else if (this.gear > 0 && v < GEARS[this.gear - 1] * 0.62) this.gear--;
      const rev = Math.min(1, v / GEARS[this.gear]), fire = (900 + 5600 * rev) / 30;
      this.saws[0].frequency.setTargetAtTime(fire / 2, now, 0.07); this.saws[1].frequency.setTargetAtTime(fire * 1.006, now, 0.07);
      this.engTone.frequency.setTargetAtTime(260 + 900 * rev + 700 * car.throttle, now, 0.08);
      this.engine.gain.setTargetAtTime(0.07 + 0.055 * rev + 0.095 * car.throttle, now, 0.08);
      this.wind.gain.setTargetAtTime(0.09 * Math.min(1, v / 50) ** 2, now, 0.3);
      this.squeal.gain.setTargetAtTime(0.11 * Math.min(1, Math.max(0, (car.slip - 3) / 6)), now, 0.05);
      if (car.hit > 0.12 && now - this.knocked > 0.25) this.knock(car.hit);
    } else for (const g of [this.engine, this.wind, this.squeal]) g.gain.setTargetAtTime(0, now, 0.15);
    // The power at the camera: gone, at once (the grid's first stumble); back (the clock taken back before the
    // failure, or the ordinary morning) once it has held half a second (not each flicker of the stumble). It was
    // the blackout's own work, undone in the same frame: the power still on where the flicker had it on.
    const p = powered > 0.5 ? 1 : 0;
    this.since = p === this.powered ? 0 : this.since + dt;
    if (p !== this.powered && (p === 0 || this.since > 0.5)) { this.powered = p; this.since = 0; this.radioFor(p === 1, now); }
  }
}
