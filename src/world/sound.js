// The sound of the morning, made here (WebAudio; no recordings):
//   coquíes   Eleutherodactylus coqui: a short "co" near 1.1 kHz and a rising "quí" near 2 kHz, from a chorus of
//             frogs scattered round the listener; loud before dawn, gone by full day, quiet high above the city
//   the road  a rumble of traffic that swells with the cars near the camera and how fast they go
//   the grid  the faint 60 Hz hum of the powered city, which stops dead when the power does
//   birds     after first light: quick high whistles and trills (a pitirre, a reinita), near the ground
//   horns     in a jam, now and then; often, in the apagón
// Starts on a gesture (browsers keep audio off until one).
export class CitySound {
  constructor() { this.ctx = null; this.on = false; this.frogs = []; this.next = 0; this.nextHorn = 0; }

  start() {
    if (this.ctx) { this.ctx.resume(); this.on = true; return; }
    const ctx = this.ctx = new AudioContext();
    this.master = ctx.createGain(); this.master.gain.value = 0; this.master.connect(ctx.destination);
    this.master.gain.setTargetAtTime(0.9, ctx.currentTime, 1.5);
    // noise for the road
    const len = ctx.sampleRate * 4, buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); let b = 0; for (let i = 0; i < len; i++) { b = (b + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = b * 3.5; } }
    const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true;
    const low = ctx.createBiquadFilter(); low.type = 'lowpass'; low.frequency.value = 260;
    const tyre = ctx.createBiquadFilter(); tyre.type = 'bandpass'; tyre.frequency.value = 900; tyre.Q.value = 0.6;
    this.road = ctx.createGain(); this.road.gain.value = 0;
    this.hiss = ctx.createGain(); this.hiss.gain.value = 0;
    noise.connect(low).connect(this.road).connect(this.master);
    noise.connect(tyre).connect(this.hiss).connect(this.master);
    noise.start();
    // the mains hum: 60 Hz and its harmonics, barely there
    this.hum = ctx.createGain(); this.hum.gain.value = 0; this.hum.connect(this.master);
    for (const [f, a] of [[60, 1], [120, 0.6], [180, 0.25]]) {
      const o = ctx.createOscillator(); o.frequency.value = f; const g = ctx.createGain(); g.gain.value = a * 0.012;
      o.connect(g).connect(this.hum); o.start();
    }
    // the frog chorus: a few dozen frogs, each its own pitch, pace and place
    this.frogBus = ctx.createGain(); this.frogBus.gain.value = 0; this.frogBus.connect(this.master);
    for (let i = 0; i < 26; i++) this.frogs.push({ pitch: 0.93 + Math.random() * 0.14, pan: Math.random() * 2 - 1, gain: 0.25 + Math.random() * 0.75, every: 1.4 + Math.random() * 2.8, at: Math.random() * 3 });
    this.on = true;
  }

  stop() { if (this.ctx) { this.ctx.suspend(); this.on = false; } }

  chirp(f) {
    const ctx = this.ctx, t = ctx.currentTime + 0.02, pan = ctx.createStereoPanner(); pan.pan.value = f.pan;
    const g = ctx.createGain(); g.gain.value = 0; g.connect(pan).connect(this.frogBus);
    const o = ctx.createOscillator(); o.type = 'sine'; o.connect(g);
    // "co": a short note; "quí": higher, rising, a little longer
    o.frequency.setValueAtTime(1120 * f.pitch, t);
    o.frequency.setValueAtTime(1960 * f.pitch, t + 0.12);
    o.frequency.linearRampToValueAtTime(2180 * f.pitch, t + 0.3);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.11 * f.gain, t + 0.012); g.gain.setValueAtTime(0.11 * f.gain, t + 0.08);
    g.gain.linearRampToValueAtTime(0.0, t + 0.1); g.gain.linearRampToValueAtTime(0.14 * f.gain, t + 0.13); g.gain.setValueAtTime(0.14 * f.gain, t + 0.26);
    g.gain.linearRampToValueAtTime(0, t + 0.31);
    o.start(t); o.stop(t + 0.34);
  }

  // a bird: a few quick notes, high and sliding, somewhere to one side
  bird(gain) {
    const ctx = this.ctx, pan = ctx.createStereoPanner(); pan.pan.value = Math.random() * 2 - 1;
    const g = ctx.createGain(); g.gain.value = 0; g.connect(pan).connect(this.master);
    const o = ctx.createOscillator(); o.type = 'sine'; o.connect(g);
    const base = 2600 + Math.random() * 2200, notes = 2 + Math.floor(Math.random() * 5);
    let t = ctx.currentTime + 0.02;
    for (let i = 0; i < notes; i++) {
      const len = 0.05 + Math.random() * 0.09, f0 = base * (0.85 + Math.random() * 0.3), f1 = f0 * (Math.random() < 0.5 ? 1.25 : 0.8);
      o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + len);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.035 * gain, t + 0.01); g.gain.linearRampToValueAtTime(0, t + len);
      t += len + 0.02 + Math.random() * 0.06;
    }
    o.start(ctx.currentTime); o.stop(t + 0.05);
  }

  horn(near) {
    const ctx = this.ctx, t = ctx.currentTime + 0.01, len = 0.18 + Math.random() * 0.5;
    const pan = ctx.createStereoPanner(); pan.pan.value = Math.random() * 1.6 - 0.8;
    const g = ctx.createGain(); g.gain.value = 0;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800;
    g.connect(lp).connect(pan).connect(this.master);
    const base = 360 + Math.random() * 180;
    for (const k of [1, 1.26]) { const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = base * k; o.connect(g); o.start(t); o.stop(t + len + 0.05); }
    const v = 0.035 * near;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + 0.015); g.gain.setValueAtTime(v, t + len); g.gain.linearRampToValueAtTime(0, t + len + 0.04);
  }

  // The grid failing: a deep thump and the crackle of the lines letting go.
  blackout() {
    if (!this.on || !this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime + 0.05;
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(28, t + 1.4);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.55, t + 0.03); g.gain.exponentialRampToValueAtTime(0.001, t + 1.8);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + 1.9);
    const len = ctx.sampleRate * 1.2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() < 0.02 ? Math.random() * 2 - 1 : 0) * Math.exp(-i / (len * 0.35));
    const n = ctx.createBufferSource(); n.buffer = buf; const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1800;
    const ng = ctx.createGain(); ng.gain.value = 0.35; n.connect(hp).connect(ng).connect(this.master); n.start(t);
  }

  // night 0..1; cars: how many near the camera; moving: their mean speed (m/s); height: the camera's above the
  // ground (m); powered: the grid at the camera (0..1); jammed: how many of the near cars stand still.
  update(dt, { night, cars, moving, height, powered, jammed }) {
    if (!this.on || !this.ctx) return;
    const ctx = this.ctx, now = ctx.currentTime, up = Math.min(1, Math.max(0, (height - 30) / 900));
    const traffic = Math.min(1, Math.log1p(cars) / Math.log1p(400)) * (1 - 0.75 * up);
    this.road.gain.setTargetAtTime(0.22 * traffic * (0.4 + 0.6 * Math.min(1, moving / 12)), now, 0.4);
    this.hiss.gain.setTargetAtTime(0.05 * traffic * Math.min(1, moving / 10), now, 0.4);
    this.hum.gain.setTargetAtTime(powered > 0.5 ? 0.6 * (1 - up) : 0, now, powered > 0.5 ? 1 : 0.05);
    // the frogs sing in the dark and fall quiet as the day comes; fainter from high up
    const chorus = Math.min(1, Math.max(0, (night - 0.15) / 0.5)) * (1 - 0.6 * up);
    this.frogBus.gain.setTargetAtTime(chorus * 0.9, now, 1.2);
    if (chorus > 0.02) for (const f of this.frogs) { f.at -= dt; if (f.at <= 0) { f.at = f.every * (0.8 + Math.random() * 0.4); if (Math.random() < 0.85) this.chirp(f); } }
    // birds: from the first light, near the ground, fewer as the traffic swells
    const morning = Math.min(1, Math.max(0, (0.75 - night) / 0.4)) * (1 - up) * (1 - 0.6 * traffic);
    if (morning > 0.05 && Math.random() < morning * dt * 0.9) this.bird(morning);
    // horns: a jam near the camera, at street level
    this.nextHorn -= dt;
    const urge = jammed * (powered > 0.5 ? 0.012 : 0.05) * (1 - up);
    if (this.nextHorn <= 0 && Math.random() < urge * dt * 30) { this.horn(1 - up); this.nextHorn = 0.4 + Math.random() * 2; }
  }
}
