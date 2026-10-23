// The sound of the morning, made here (WebAudio; no recordings): a plena, and the road under it.
//   the plena  Puerto Rico's street music: three panderos (hand frame drums) — the seguidor keeps the bass
//              pattern, the punteador answers it off the beat, the requinto improvises and rolls into each
//              phrase — a güiro scraping long-short-short, and a cuatro and a bass, plucked strings
//              (Karplus-Strong), strumming D and A7 with now and then a run of melody. Quiet before dawn, fuller
//              as the city fills; in the apagón the cuatro and the bass die with the power and the panderos,
//              which need none, play on, harder
//   the road   a low rumble of traffic that swells with the cars near the camera and how fast they go
// Starts on a gesture (browsers keep audio off until one).
const BPM = 112, STEP = 60 / BPM / 4;    // sixteenth notes; plena is in 2/4: 8 steps a bar
const BARS = ['D', 'D', 'A7', 'A7', 'A7', 'A7', 'D', 'D'];
const CHORD = { D: [146.83, 220.0, 293.66, 369.99, 440.0], A7: [164.81, 220.0, 277.18, 329.63, 392.0] };
const BASS = { D: [73.42, 110.0], A7: [55.0, 82.41] };              // root, fifth
const SCALE = { D: [293.66, 329.63, 369.99, 440.0, 493.88, 587.33], A7: [277.18, 329.63, 392.0, 440.0, 493.88, 554.37] };
// the panderos' parts, a step a character: o open tone, s slap, m muted (one bar of 8 sixteenths)
const SEGUIDOR = 'm...o.o.', PUNTEADOR = '..so.s.s';

export class CitySound {
  constructor() { this.ctx = null; this.on = false; this.energy = 0.3; this.powered = 1; this.wasPowered = 1; }

  start() {
    if (this.ctx) { this.ctx.resume(); this.on = true; return; }
    const ctx = this.ctx = new AudioContext(), sr = ctx.sampleRate;
    this.master = ctx.createGain(); this.master.gain.value = 0; this.master.connect(ctx.destination);
    this.master.gain.setTargetAtTime(0.9, ctx.currentTime, 1.2);
    // a room: a second and a half of decaying noise, a little of everything goes through it
    const ir = ctx.createBuffer(2, Math.floor(sr * 1.6), sr);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3.2); }
    this.room = ctx.createConvolver(); this.room.buffer = ir;
    const wet = ctx.createGain(); wet.gain.value = 0.22; this.room.connect(wet).connect(this.master);
    // the band: drums and strings on their own buses (the strings are the ones the apagón silences)
    this.band = ctx.createGain(); this.band.gain.value = 0.62;
    const glue = ctx.createDynamicsCompressor(); glue.threshold.value = -14; glue.ratio.value = 3; glue.attack.value = 0.005; glue.release.value = 0.12;
    this.band.connect(glue).connect(this.master); glue.connect(this.room);
    this.drums = ctx.createGain(); this.drums.connect(this.band);
    this.strings = ctx.createGain(); this.strings.connect(this.band);
    // noise: white for the hands and the güiro; brown, looped, for the road
    const white = ctx.createBuffer(1, sr, sr), w = white.getChannelData(0);
    for (let i = 0; i < w.length; i++) w[i] = Math.random() * 2 - 1;
    this.white = white;
    const len = sr * 4, brown = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) { const d = brown.getChannelData(c); let b = 0; for (let i = 0; i < len; i++) { b = (b + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = b * 3.5; } }
    const road = ctx.createBufferSource(); road.buffer = brown; road.loop = true;
    const low = ctx.createBiquadFilter(); low.type = 'lowpass'; low.frequency.value = 220;
    this.road = ctx.createGain(); this.road.gain.value = 0;
    road.connect(low).connect(this.road).connect(this.master); road.start();
    // the güiro's scrapes, made once: a train of ridges, long and short, a few of each
    this.scrapes = { long: [0, 1, 2].map(() => this.scrape(0.2)), short: [0, 1, 2].map(() => this.scrape(0.065)) };
    // the strings, plucked once per pitch and kept
    this.plucks = new Map();
    for (const f of new Set([...Object.values(CHORD).flat(), ...Object.values(SCALE).flat()])) this.plucks.set(f, this.pluck(f, 1.3, 0.996, 0.55));
    for (const f of new Set(Object.values(BASS).flat())) this.plucks.set(f, this.pluck(f, 1.1, 0.994, 0.2));
    // the clock: notes are put on the audio timeline a little ahead of time (a slow frame does not make a late note)
    this.step = 0; this.nextAt = ctx.currentTime + 0.2; this.run = null;
    this.timer = setInterval(() => this.schedule(), 40);
    this.on = true;
  }

  stop() { if (this.ctx) { this.ctx.suspend(); this.on = false; } }

  // A string plucked at f Hz (Karplus-Strong: a burst of noise round a delay line as long as one period, each
  // pass a little softer and duller), as two strings of a course a hair apart. tone: 0 dull .. 1 bright.
  pluck(f, seconds, decay, tone) {
    const sr = this.ctx.sampleRate, n = Math.floor(sr * seconds), buf = this.ctx.createBuffer(1, n, sr), out = buf.getChannelData(0);
    for (const detune of [1, 1.0025]) {
      const N = Math.max(2, Math.round(sr / (f * detune))), line = new Float32Array(N);
      let prev = 0;
      for (let i = 0; i < N; i++) { const r = Math.random() * 2 - 1; prev = prev + tone * (r - prev); line[i] = prev; } // (a duller pluck: a smoother burst)
      let k = 0;
      for (let i = 0; i < n; i++) {
        const a = line[k], b = line[(k + 1) % N];
        out[i] += a * 0.5;
        line[k] = (a + b) * 0.5 * decay;
        k = (k + 1) % N;
      }
    }
    for (let i = 0; i < Math.min(n, 64); i++) out[i] *= i / 64; // (no click at the start)
    return buf;
  }

  // a güiro stroke: the stick over the ridges, one tick each, loudest in the middle of the stroke
  scrape(seconds) {
    const sr = this.ctx.sampleRate, n = Math.floor(sr * seconds), buf = this.ctx.createBuffer(1, n, sr), d = buf.getChannelData(0);
    const rate = 55 + Math.random() * 25;
    let next = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr, env = Math.sin(Math.PI * Math.min(1, t / seconds)) ** 0.6;
      if (t >= next) next = t + (1 + (Math.random() - 0.5) * 0.3) / rate;
      const since = (t - (next - 1 / rate)) * rate;            // 0..1 through a ridge
      d[i] = (Math.random() * 2 - 1) * env * Math.exp(-since * 5);
    }
    return buf;
  }

  play(buf, t, gain, { pan = 0, to = this.strings, rate = 1, hp = 0, bp = 0 } = {}) {
    const ctx = this.ctx, s = ctx.createBufferSource(); s.buffer = buf; s.playbackRate.value = rate;
    let node = s;
    if (hp) { const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp; node = node.connect(f); }
    if (bp) { const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = bp; f.Q.value = 1.2; node = node.connect(f); }
    const g = ctx.createGain(); g.gain.value = gain; const p = ctx.createStereoPanner(); p.pan.value = pan;
    node.connect(g).connect(p).connect(to);
    s.start(t);
    return s;
  }

  // A pandero: the skin (a tone that drops as it settles, and its second mode) and the hand (a slap of noise).
  // size: 0 the big seguidor .. 1 the small requinto; stroke: o open, s slap, m muted
  drum(t, size, stroke, vel, pan) {
    const ctx = this.ctx, f0 = 92 * Math.pow(2.6, size) * (0.98 + Math.random() * 0.04);
    const open = stroke === 'o', slap = stroke === 's', decay = open ? 0.32 - 0.12 * size : 0.07;
    const p = ctx.createStereoPanner(); p.pan.value = pan; p.connect(this.drums);
    for (const [k, a] of [[1, 1], [1.59, 0.35]]) {
      const o = ctx.createOscillator(); o.frequency.setValueAtTime(f0 * k * 1.5, t); o.frequency.exponentialRampToValueAtTime(f0 * k, t + 0.03);
      const g = ctx.createGain(); const peak = vel * a * (slap ? 0.35 : open ? 0.9 : 0.5);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0008, t + decay * (k > 1 ? 0.5 : 1));
      o.connect(g).connect(p); o.start(t); o.stop(t + decay + 0.05);
    }
    const n = ctx.createBufferSource(); n.buffer = this.white; const off = Math.random() * 0.8;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = slap ? 2400 + 1400 * size : 900 + 600 * size; bp.Q.value = 0.9;
    const g = ctx.createGain(), hit = vel * (slap ? 0.55 : 0.18), len = slap ? 0.07 : 0.03;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(hit, t + 0.0015); g.gain.exponentialRampToValueAtTime(0.0008, t + len);
    n.connect(bp).connect(g).connect(p); n.start(t, off, len + 0.02);
  }

  // Puts the notes of the coming quarter second on the timeline.
  schedule() {
    if (!this.on || !this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx, horizon = ctx.currentTime + 0.25;
    if (this.nextAt < ctx.currentTime - 0.1) this.nextAt = ctx.currentTime + 0.05; // (back from a pause: pick up the beat)
    while (this.nextAt < horizon) { this.note(this.step, this.nextAt); this.step++; this.nextAt += STEP; }
  }

  note(step, t0) {
    const e = this.energy, powered = this.powered, s = step % 8, bar = Math.floor(step / 8) % BARS.length, chord = BARS[bar];
    const swing = s % 2 ? STEP * 0.06 : 0, j = () => (Math.random() - 0.5) * 0.008, t = t0 + swing;
    const phraseEnd = bar === BARS.length - 1 && s >= 4;
    // seguidor: always (the heartbeat of it)
    const sg = SEGUIDOR[s];
    if (sg !== '.') this.drum(t + j(), 0, sg, sg === 'o' ? 0.95 : 0.55, -0.25);
    // güiro: long on the beat, short, short
    if (e > 0.15) {
      const q = s % 4;
      if (q === 0) this.play(this.scrapes.long[step % 3], t + j(), 0.16 * Math.min(1, e + 0.3), { to: this.drums, hp: 2500, pan: 0.45 });
      else if (q >= 2) this.play(this.scrapes.short[step % 3], t + j(), 0.12 * Math.min(1, e + 0.3), { to: this.drums, hp: 2500, pan: 0.45 });
    }
    // punteador: once the morning is under way
    const pt = PUNTEADOR[s];
    if (e > 0.35 && pt !== '.') this.drum(t + j(), 0.45, pt, 0.7, 0.3);
    // requinto: improvises, more as the city fills (and in the dark), and rolls into each new phrase
    const wild = Math.min(1, e + (powered ? 0 : 0.35));
    if (wild > 0.45) {
      const chance = phraseEnd ? 0.9 : (s % 2 ? 0.18 : 0.3) * wild;
      if (Math.random() < chance) this.drum(t + j(), 1, Math.random() < 0.6 ? 's' : 'o', 0.45 + 0.4 * Math.random(), 0.1);
      if (phraseEnd && Math.random() < 0.6) this.drum(t + STEP / 2 + j(), 1, 's', 0.4, 0.1); // (a roll: the thirty-seconds between)
    }
    if (!powered) return; // (the apagón: what needs the power is gone)
    // cuatro: a strum down on the one, up on the and, a syncopated push before the two
    if (e > 0.25) {
      const strum = { 0: 'down', 2: 'up', 3: 'down', 5: 'up', 6: 'down' }[s];
      if (strum) {
        const notes = CHORD[chord], order = strum === 'down' ? notes : [...notes].reverse().slice(0, 3), v = (s === 0 ? 0.2 : 0.12) * Math.min(1, e + 0.2);
        order.forEach((f, i) => this.play(this.plucks.get(f), t + i * 0.012 + j(), v, { pan: -0.35 + i * 0.06 }));
      }
    }
    // bass: root on the one, fifth before the two, root again
    if (e > 0.45) {
      const [root, fifth] = BASS[chord], f = { 0: root, 3: fifth, 4: root, 6: fifth }[s];
      if (f) this.play(this.plucks.get(f), t + j(), s === 0 ? 0.55 : 0.4, { pan: 0 });
    }
    // a run of melody on the cuatro now and then: the second half of a phrase, eighth notes, step-wise
    if (e > 0.55 && bar >= 4 && s % 2 === 0) {
      if (bar === 4 && s === 0) this.run = Math.random() < 0.55 ? { at: Math.floor(Math.random() * SCALE[chord].length) } : null;
      if (this.run && Math.random() < 0.8) {
        const sc = SCALE[chord]; this.run.at = Math.max(0, Math.min(sc.length - 1, this.run.at + (Math.random() < 0.5 ? -1 : 1) * (Math.random() < 0.8 ? 1 : 2)));
        if (bar === BARS.length - 1 && s === 6) this.run.at = 0; // (home at the end of the phrase)
        this.play(this.plucks.get(sc[this.run.at]), t + j(), 0.2, { pan: 0.35 });
      }
    }
  }

  // The grid failing: a deep thump, the crackle of the lines letting go, and the strings stop dead.
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
    this.strings.gain.cancelScheduledValues(t); this.strings.gain.setValueAtTime(this.strings.gain.value, t); this.strings.gain.linearRampToValueAtTime(0, t + 0.04);
  }

  // night 0..1; cars: how many near the camera; moving: their mean speed (m/s); height: the camera's above the
  // ground (m); powered: the grid at the camera (0..1); jammed: how many of the near cars stand still.
  update(dt, { night, cars, moving, height, powered }) {
    if (!this.on || !this.ctx) return;
    const ctx = this.ctx, now = ctx.currentTime, up = Math.min(1, Math.max(0, (height - 30) / 900));
    const traffic = Math.min(1, Math.log1p(cars) / Math.log1p(400));
    this.road.gain.setTargetAtTime(0.12 * traffic * (1 - 0.75 * up) * (0.4 + 0.6 * Math.min(1, moving / 12)), now, 0.4);
    // the band fills out as the city wakes: a few hands before dawn, all of them by the rush
    const target = Math.min(1, 0.3 + 0.45 * (1 - night) + 0.35 * traffic);
    this.energy += (target - this.energy) * Math.min(1, dt / 6);
    this.powered = powered > 0.5 ? 1 : 0;
    if (this.powered && !this.wasPowered) this.strings.gain.setTargetAtTime(1, now, 0.6); // (the power back: the strings again)
    this.wasPowered = this.powered;
  }
}
