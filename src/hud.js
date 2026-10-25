// The heads-up display of free roaming: quiet glass in the corners of the screen, so the city stays the picture.
//   top left      the name and the frame rate
//   top right     the time of day (presets), teleporting to places of San Juan, the map (M), sound (N), the
//                 clean view (H)
//   bottom left   where you are, as Puerto Rico's green street-name signs, over a minimap (north up: the roads,
//                 you, and the simulated cars round you)
//   bottom centre the ways round the city (Explorar, Caminar, Bici, Manejar, Volar: 1 to 5) and the keys of the one in use
//   bottom right  speed, and the camera (V cycles)
// The full map (M) pans and zooms; a click on it teleports there. After the HUD of mrdoob's Slop New York (MIT:
// github.com/mrdoob/slop-newyork).
const CSS = `
:root { --hud-glass: rgba(18,19,22,0.62); --hud-glass-strong: rgba(16,17,20,0.9); --hud-border: rgba(255,255,255,0.09); --hud-text: #f6f5f2;
  --hud-text-2: rgba(246,245,242,0.68); --hud-text-3: rgba(246,245,242,0.44); --hud-accent: #ff6b3d; --hud-accent-ink: #1e0c05; --hud-sign: #0b6a46;
  --hud-edge: 18px; --hud-r: 16px; --hud-shadow: 0 18px 40px -18px rgba(0,0,0,0.7), 0 2px 8px rgba(0,0,0,0.2);
  --hud-font: 'Inter', -apple-system, 'Helvetica Neue', Arial, sans-serif; --hud-sign-font: 'Overpass', 'Inter', 'Helvetica Neue', Arial, sans-serif; }
.hud { position: fixed; z-index: 920; font-family: var(--hud-font); color: var(--hud-text); font-size: 13px; -webkit-font-smoothing: antialiased; user-select: none;
  transition: opacity 0.4s ease, transform 0.4s ease; }
.hud button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
.hud-off .hud, .hud-hidden .hud { opacity: 0; pointer-events: none; }
.hud-off .hud.keep { opacity: 1; pointer-events: auto; }
.hud .panel { background: var(--hud-glass); backdrop-filter: blur(14px) saturate(1.2); -webkit-backdrop-filter: blur(14px) saturate(1.2);
  border: 1px solid var(--hud-border); border-radius: var(--hud-r); box-shadow: var(--hud-shadow); }
.hud kbd { display: inline-flex; align-items: center; justify-content: center; min-width: 19px; height: 19px; padding: 0 5px; border-radius: 5px; font: 650 10.5px var(--hud-font);
  color: var(--hud-text-2); background: rgba(255,255,255,0.08); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.07), inset 0 -1px 0 rgba(0,0,0,0.3); }
.hud .icon { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; flex: none; }
#hud-tl { top: var(--hud-edge); left: var(--hud-edge); }
#hud-tl .brand { display: flex; align-items: center; gap: 11px; padding: 9px 15px 9px 10px; }
#hud-tl .bullet { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; background: var(--hud-accent); color: var(--hud-accent-ink); font-weight: 800; font-size: 12.5px; letter-spacing: -0.02em; }
#hud-tl h1 { font-size: 15px; font-weight: 700; margin: 0; letter-spacing: -0.01em; }
#hud-tl .sub { font-size: 11px; color: var(--hud-text-3); margin-top: 1px; }
#hud-tl .sub b { font-weight: 600; color: #5ee08f; } #hud-tl .sub b.warn { color: #ffc857; } #hud-tl .sub b.bad { color: #ff7a6b; }
#hud-tr { top: var(--hud-edge); right: var(--hud-edge); }
#hud-tr .toolbar { display: flex; align-items: center; gap: 2px; padding: 5px; }
#hud-tr .seg { display: inline-flex; align-items: center; gap: 7px; height: 36px; padding: 0 11px; border-radius: 10px; color: var(--hud-text-2); font-weight: 550; white-space: nowrap; }
#hud-tr .seg:hover { background: rgba(255,255,255,0.08); color: var(--hud-text); }
#hud-tr .seg.on { background: var(--hud-text); color: #15161a; }
#hud-tr .seg .lbl { display: none; } #hud-tr .seg.on .lbl { display: inline; }
#hud-tr .div { width: 1px; height: 22px; background: rgba(255,255,255,0.1); margin: 0 4px; }
.hud-pop { position: fixed; z-index: 990; min-width: 250px; padding: 6px; font-family: var(--hud-font); color: var(--hud-text); background: var(--hud-glass-strong);
  border: 1px solid var(--hud-border); border-radius: 14px; box-shadow: var(--hud-shadow); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); }
.hud-pop[hidden] { display: none; }
.hud-pop .t { font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--hud-text-3); padding: 6px 10px 4px; }
.hud-pop button { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; width: 100%; padding: 8px 10px; border: 0; border-radius: 9px; background: none; color: inherit; font: inherit; cursor: pointer; text-align: left; }
.hud-pop button:hover { background: rgba(255,255,255,0.08); }
.hud-pop .n { font-size: 13.5px; font-weight: 600; } .hud-pop .s { font-size: 11.5px; color: var(--hud-text-3); }
#hud-bl { left: var(--hud-edge); bottom: 44px; display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
#hud-bl .place { font-size: 12px; font-weight: 600; color: var(--hud-text-2); text-shadow: 0 1px 8px rgba(0,0,0,0.6); letter-spacing: 0.02em; }
#hud-bl .signs { display: flex; gap: 6px; flex-wrap: wrap; max-width: 330px; }
#hud-bl .sign { font: 700 13px var(--hud-sign-font); color: #fff; background: var(--hud-sign); padding: 4px 9px 3px; border-radius: 4px; box-shadow: inset 0 0 0 1.5px rgba(255,255,255,0.85), 0 3px 10px rgba(0,0,0,0.35); white-space: nowrap; }
#hud-bl .radar { position: relative; width: 236px; height: 152px; overflow: hidden; cursor: pointer; }
#hud-bl .radar canvas { width: 100%; height: 100%; display: block; border-radius: var(--hud-r); }
#hud-bl .radar .north { position: absolute; top: 8px; left: 10px; font-size: 10px; font-weight: 700; color: var(--hud-text-2); }
#hud-bl .radar kbd { position: absolute; top: 7px; right: 8px; }
#hud-bc { left: 50%; bottom: var(--hud-edge); transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 9px; }
#hud-bc .hints { display: flex; gap: 14px; flex-wrap: wrap; justify-content: center; font-size: 11.5px; color: var(--hud-text-2); text-shadow: 0 1px 8px rgba(0,0,0,0.7);
  padding: 5px 12px; border-radius: 999px; background: rgba(12,13,16,0.38); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
#hud-bc .hints span { display: inline-flex; align-items: center; gap: 4px; }
#hud-bc .modes { position: relative; display: flex; gap: 2px; padding: 5px; }
#hud-bc .mode { position: relative; z-index: 1; display: inline-flex; align-items: center; gap: 8px; height: 40px; padding: 0 13px; border-radius: 11px; color: var(--hud-text-2); font-weight: 600; }
#hud-bc .mode:hover { color: var(--hud-text); }
#hud-bc .mode.on { color: var(--hud-accent-ink); }
#hud-bc .mode.on kbd { background: rgba(0,0,0,0.14); color: var(--hud-accent-ink); box-shadow: none; }
#hud-bc .ind { position: absolute; z-index: 0; top: 5px; bottom: 5px; left: 0; width: 0; border-radius: 11px; background: var(--hud-accent); transition: transform 0.35s cubic-bezier(.22,1,.36,1), width 0.35s cubic-bezier(.22,1,.36,1); }
#hud-br { right: var(--hud-edge); bottom: var(--hud-edge); }
#hud-br .cluster { width: 236px; padding: 12px 12px 8px; }
#hud-br .top { display: flex; justify-content: space-between; font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--hud-text-3); }
#hud-br .speed { display: flex; align-items: baseline; gap: 6px; margin-top: 2px; }
#hud-br .speed b { font-size: 40px; font-weight: 750; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; line-height: 1.05; }
#hud-br .speed span { font-size: 12px; color: var(--hud-text-3); font-weight: 600; }
#hud-br .meter { height: 4px; border-radius: 2px; background: rgba(255,255,255,0.09); overflow: hidden; margin: 6px 0 9px; }
#hud-br .meter i { display: block; height: 100%; background: var(--hud-accent); transform-origin: 0 50%; transform: scaleX(0); transition: transform 0.25s linear; }
#hud-br .cams { display: flex; align-items: center; gap: 2px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 7px; }
#hud-br .cams button { height: 30px; border-radius: 8px; color: var(--hud-text-2); display: inline-flex; align-items: center; justify-content: center; }
#hud-br .cams button:hover { background: rgba(255,255,255,0.08); color: var(--hud-text); }
#hud-br .cams .arr { width: 28px; } #hud-br .cams .cur { flex: 1; gap: 7px; font-weight: 600; font-size: 12.5px; }
#hud-map { position: fixed; inset: 0; z-index: 985; background: rgba(8,9,11,0.94); font-family: var(--hud-font); color: var(--hud-text); }
#hud-map[hidden] { display: none; }
#hud-map canvas { position: absolute; inset: 0; width: 100%; height: 100%; cursor: crosshair; }
#hud-map .head { position: absolute; top: 18px; left: 20px; right: 20px; display: flex; justify-content: space-between; align-items: center; pointer-events: none; }
#hud-map .head h2 { margin: 0; font-size: 17px; font-weight: 700; } #hud-map .head span { font-size: 12px; color: var(--hud-text-3); }
#hud-map .head button { pointer-events: auto; font: inherit; color: inherit; background: rgba(255,255,255,0.1); border: 0; border-radius: 10px; padding: 8px 12px; cursor: pointer; }
#hud-map .hover { position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%); font-size: 12.5px; color: var(--hud-text-2); background: rgba(0,0,0,0.5); padding: 7px 12px; border-radius: 10px; pointer-events: none; }
#hud-br .cluster, #hud-bl .radar { box-sizing: border-box; }
.touch #hud-bc .hints { display: none; }
#hud-bl { pointer-events: none; } #hud-bl .radar { pointer-events: auto; } /* (the signs are not buttons: a touch goes through them) */
.touch.roam #xp-dock { display: none; } /* (roaming by touch: the clock's dock gives the screen to the thumbs; back in Explorar) */
@media (max-width: 760px) { .touch.roam #hud-bl { top: 76px; bottom: auto; flex-direction: column-reverse; } }
@media (max-width: 760px) { #hud-tr .seg .lbl, #hud-bc .mode span.l, #hud-bc .hints, #hud-tr kbd, #hud-tr .div, #hud-tl, #hud-bc .mode kbd { display: none !important; }
  #hud-tr { left: var(--hud-edge); } #hud-tr .toolbar { justify-content: space-between; } #hud-tr .seg { padding: 0 8px; }
  #hud-bl .radar { width: 150px; height: 104px; } #hud-br .cluster { width: 150px; padding: 9px 10px 6px; } #hud-br .speed b { font-size: 30px; }
  #hud-br .cams .cur span, #hud-br .cams kbd { display: none; } #hud-bl .signs { max-width: 200px; }
  #hud-bl { bottom: 108px; } #hud-br { bottom: 108px; } #hud-bc { bottom: 46px; } #hud-bc .mode { padding: 0 16px; } }
/* on a touch screen: a thumbstick where the left thumb lands, and the buttons of the way in use */
#hud-pad { position: fixed; inset: auto 0 0 0; height: 60vh; z-index: 910; display: none; pointer-events: none; }
#hud-pad .zone, #hud-pad .btns button { pointer-events: auto; }
.touch.roam #hud-pad { display: block; } .hud-off #hud-pad, .hud-hidden #hud-pad { display: none !important; }
#hud-pad .zone { position: absolute; left: 0; top: 0; bottom: 0; width: 50%; touch-action: none; }
#hud-pad .stick { position: absolute; width: 112px; height: 112px; margin: -56px 0 0 -56px; border-radius: 50%; display: none; pointer-events: none;
  background: rgba(18,19,22,0.35); border: 1.5px solid rgba(255,255,255,0.25); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
#hud-pad .stick i { position: absolute; left: 50%; top: 50%; width: 46px; height: 46px; margin: -23px 0 0 -23px; border-radius: 50%; background: rgba(255,255,255,0.85); box-shadow: 0 4px 14px rgba(0,0,0,0.35); }
#hud-pad .btns { position: absolute; right: var(--hud-edge); bottom: 240px; display: flex; flex-direction: column; gap: 10px; align-items: flex-end; }
#hud-pad .btns button { width: 64px; height: 64px; border-radius: 50%; touch-action: none; font: 650 11px var(--hud-font); color: var(--hud-text); letter-spacing: 0.02em;
  background: var(--hud-glass); border: 1px solid var(--hud-border); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); box-shadow: var(--hud-shadow); }
#hud-pad .btns button.down { background: var(--hud-accent); color: var(--hud-accent-ink); }
`;

const ICON = {
  explore: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  bike: '<circle cx="5.5" cy="15.5" r="3.6"/><circle cx="18.5" cy="15.5" r="3.6"/><path d="M5.5 15.5 9.6 8.6h6.2M18.5 15.5l-3.6-8.8M9.6 8.6l3.3 6.9h-7.4M12.9 15.5l2-6.9M14 6.7h2.6"/>',
  walk: '<circle cx="13" cy="4.4" r="2"/><path d="M12.3 8.2 10.8 13.8M10.8 13.8 9.2 17.2 7.2 20.5M10.8 13.8l2.4 3 1.6 3.8M12.3 8.6 9.6 10.2l-.8 2.6M12.3 8.6l2.1 2.4 2.4.8"/>',
  car: '<path d="m5.2 10.5 1.4-4.1A2.2 2.2 0 0 1 8.7 4.8h6.6a2.2 2.2 0 0 1 2.1 1.6l1.4 4.1"/><rect x="3" y="10.5" width="18" height="6.5" rx="2"/><path d="M6 17v2.6M18 17v2.6M6.6 13.8h1.6M15.8 13.8h1.6"/>',
  fly: '<path d="M3.5 4h15M11 4v3.2"/><path d="M6 12.2a5 5 0 0 1 5-5h1.6a4.4 4.4 0 0 1 4.4 4.4V15H8.8A2.8 2.8 0 0 1 6 12.2z"/><path d="M17 11h4.2M21.2 8.8v4.4M7 19h10.5M9.5 15v4M15 15v4"/>',
  sunrise: '<path d="M3 17.5h18M7 17.5a5 5 0 0 1 10 0M12 5v3M5.6 9.6l2 1.6M18.4 9.6l-2 1.6M7.5 21h9"/>',
  rush: '<rect x="3" y="7" width="7" height="5" rx="1.2"/><rect x="14" y="7" width="7" height="5" rx="1.2"/><path d="M3 16h18M6 12v2M17 12v2"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.8v2.1M12 19.1v2.1M2.8 12h2.1M19.1 12h2.1M5.5 5.5 7 7M17 17l1.5 1.5M5.5 18.5 7 17M17 7l1.5-1.5"/>',
  dusk: '<path d="M3 15.5h18M7.5 19h9M8 15.5a4 4 0 0 1 8 0M17.5 4v3.2M15.9 5.6h3.2"/>',
  moon: '<path d="M19.5 14.6A7.8 7.8 0 0 1 9.4 4.5a7.8 7.8 0 1 0 10.1 10.1z"/>',
  pin: '<path d="M12 21.2s-6.6-5.7-6.6-11.2a6.6 6.6 0 0 1 13.2 0c0 5.5-6.6 11.2-6.6 11.2z"/><circle cx="12" cy="10" r="2.4"/>',
  map: '<path d="M9 4.5 3.5 6.6v13l5.5-2.1 6 2.1 5.5-2.1v-13L15 6.6 9 4.5zM9 4.5v13M15 6.6v13"/>',
  sound: '<path d="m11 4-5 4H3v8h3l5 4V4ZM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/>',
  mute: '<path d="m11 4-5 4H3v8h3l5 4V4ZM16 9l6 6M22 9l-6 6"/>',
  eye: '<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  cam: '<rect x="2.8" y="6.5" width="12.4" height="11" rx="2.4"/><path d="m15.2 10.4 6-3.4v10l-6-3.4"/>',
  left: '<path d="M14.5 6.5 9 12l5.5 5.5"/>', right: '<path d="m9.5 6.5 5.5 5.5-5.5 5.5"/>',
};
const icon = (k) => `<svg class="icon" viewBox="0 0 24 24">${ICON[k]}</svg>`;

export const MODES = [
  { id: 'explore', label: 'Explorar', key: '1', icon: 'explore', hints: [['Arrastra', 'Mover'], ['Clic der.', 'Girar'], ['Rueda', 'Acercar'], ['W A S D', 'Desplazar']] },
  { id: 'walk', label: 'Caminar', key: '2', icon: 'walk', hints: [['W S', 'Caminar'], ['A D', 'Girar'], ['Shift', 'Correr'], ['Espacio', 'Saltar'], ['E', 'Al carro']] },
  { id: 'bike', label: 'Bici', key: '3', icon: 'bike', hints: [['W', 'Pedalear'], ['S', 'Frenar'], ['A D', 'Dobla'], ['Shift', 'Rápido'], ['E', 'Al carro']] },
  { id: 'car', label: 'Manejar', key: '4', icon: 'car', hints: [['W S', 'Acelerar / Frenar'], ['A D', 'Dobla'], ['Espacio', 'Freno de mano'], ['Shift', 'Turbo'], ['E', 'Bajarse']] },
  { id: 'fly', label: 'Volar', key: '5', icon: 'fly', hints: [['W S', 'Avanzar'], ['A D', 'Girar'], ['Espacio', 'Subir'], ['C', 'Bajar'], ['Shift', 'Turbo']] },
];
const TIMES = [
  { id: 'sunrise', label: 'Amanecer', hour: 6.33, icon: 'sunrise' },
  { id: 'rush', label: 'Hora pico', hour: 7.5, icon: 'rush' },
  { id: 'noon', label: 'Mediodía', hour: 12.5, icon: 'sun' },
  { id: 'dusk', label: 'Atardecer', hour: 18.45, icon: 'dusk' },
  { id: 'night', label: 'Noche', hour: 22.5, icon: 'moon' },
];
// Places to go: [name, where, lon, lat] (or world [x, z] where it is a point of the simulated morning)
const PLACES = [
  ['Castillo San Felipe del Morro', 'Viejo San Juan', -66.1188, 18.4703],
  ['Plaza de Armas', 'Calle San Francisco · Viejo San Juan', -66.1168, 18.4655],
  ['El Capitolio', 'Avenida Ponce de León · Puerta de Tierra', -66.1056, 18.4632],
  ['Condado', 'Avenida Ashford', -66.0727, 18.4585],
  ['La Placita de Santurce', 'Santurce', -66.0701, 18.4497],
  ['Milla de Oro', 'Ponce de León y Roosevelt · Hato Rey', { x: 6255, z: 4591 }],
  ['Plaza Las Américas', 'Avenida Roosevelt · Hato Rey', -66.0752, 18.4207],
  ['Universidad de Puerto Rico', 'Avenida Ponce de León · Río Piedras', -66.0505, 18.4038],
  ['Avenida Piñero', 'el tapón del apagón · Río Piedras', { x: 5195, z: 6416 }],
  ['Ocean Park', 'Calle McLeary · Santurce', -66.0490, 18.4570],
];

// Road names by 60 m cell, for "Avenida Ponce de León & Calle Bolivia"; the road segments by 250 m cell for the maps
function indexRoads(roads) {
  const names = new Map(), segs = new Map(), all = [];
  const cls = (h) => (/^(motorway|trunk)/.test(h) ? 0 : /^(primary|secondary)/.test(h) ? 1 : /^(tertiary|unclassified|residential|living)/.test(h) ? 2 : 3);
  for (const e of roads.edges) {
    const name = e.name ?? e.ref, p = e.pts, c = cls(e.highway);
    for (let i = 0; i < p.length; i += 3) {
      if (name) { const k = Math.floor(p[i] / 60) + ',' + Math.floor(p[i + 2] / 60); if (!names.has(k)) names.set(k, []); names.get(k).push([p[i], p[i + 2], name]); }
      if (i >= 3) {
        const s = [p[i - 3], p[i - 1], p[i], p[i + 2], c];
        all.push(s);
        const k = Math.floor(p[i] / 250) + ',' + Math.floor(p[i + 2] / 250);
        if (!segs.has(k)) segs.set(k, []); segs.get(k).push(s);
      }
    }
  }
  return { names, segs, all };
}

export class Hud {
  // app: { setMode(id), mode, cycleCamera(step), cameraName, view() -> {x, z, heading, kmh, altitude?} | null, focus()
  //        -> {x, z}, teleport(x, z), setHour(h), hour(), soundOn(), toggleSound(), roads, proj, sim(), fps() }
  constructor(app) {
    this.app = app;
    const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
    const el = (html) => { const d = document.createElement('div'); d.innerHTML = html.trim(); return document.body.appendChild(d.firstChild); };
    this.tl = el(`<div id="hud-tl" class="hud"><div class="panel brand"><span class="bullet">SJ</span><div><h1>San Juan</h1>
      <div class="sub">simulación SUMO · <b class="fps">60</b> fps</div></div></div></div>`);
    this.tr = el(`<div id="hud-tr" class="hud"><div class="panel toolbar">
      ${TIMES.map((t) => `<button class="seg time" data-time="${t.id}" title="${t.label}">${icon(t.icon)}<span class="lbl">${t.label}</span></button>`).join('')}
      <span class="div"></span>
      <button class="seg tp" title="Ir a un lugar">${icon('pin')}<span class="lbl" style="display:inline">Ir a</span></button>
      <button class="seg mapb" title="Mapa de San Juan [M]">${icon('map')}<span class="lbl" style="display:inline">Mapa</span><kbd>M</kbd></button>
      <span class="div"></span>
      <button class="seg snd" title="Sonido [N]">${icon('sound')}</button>
      <button class="seg clean" title="Vista limpia: esconder [H]">${icon('eye')}</button></div></div>`);
    this.pop = el(`<div class="hud-pop" hidden><div class="t">Ir a</div>${PLACES.map(([n, s], i) => `<button data-place="${i}"><span class="n">${n}</span><span class="s">${s}</span></button>`).join('')}</div>`);
    this.bl = el(`<div id="hud-bl" class="hud"><div class="place"></div><div class="signs"></div><div class="panel radar" title="Mapa de San Juan [M]"><canvas></canvas><span class="north">N</span><kbd>M</kbd></div></div>`);
    this.bc = el(`<div id="hud-bc" class="hud"><div class="hints"></div><nav class="panel modes"><span class="ind"></span>
      ${MODES.map((m) => `<button class="mode" data-mode="${m.id}" title="${m.label} [${m.key}]">${icon(m.icon)}<span class="l">${m.label}</span><kbd>${m.key}</kbd></button>`).join('')}</nav></div>`);
    this.br = el(`<div id="hud-br" class="hud"><div class="panel cluster"><div class="top"><span class="lbl">—</span><span class="alt"></span></div>
      <div class="speed"><b>0</b><span>km/h</span></div><div class="meter"><i></i></div>
      <div class="cams"><button class="arr prev" title="Cámara anterior">${icon('left')}</button><button class="cur" title="Cámara [V]">${icon('cam')}<span>Persecución</span><kbd>V</kbd></button><button class="arr next" title="Cámara siguiente [V]">${icon('right')}</button></div></div></div>`);
    this.map = el(`<div id="hud-map" hidden><canvas></canvas><div class="head"><div><h2>San Juan</h2><span>Clic para ir · arrastra para mover · rueda para acercar</span></div><button class="close">Cerrar · M</button></div><div class="hover"></div></div>`);
    this.radar = this.bl.querySelector('canvas'); this.mapCanvas = this.map.querySelector('canvas');
    this.places = PLACES.map(([name, where, a, b]) => { const p = typeof a === 'object' ? a : (([x, z]) => ({ x, z }))(app.proj.project(a, b)); return { name, where, ...p }; });
    this.index = indexRoads(app.roads);
    this.view = { x: 0, z: 0, scale: 0.06 }; // the full map: world point at the centre, pixels per metre
    // ---- wiring
    this.bc.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => app.setMode(b.dataset.mode)));
    this.tr.querySelectorAll('.time').forEach((b) => b.addEventListener('click', () => app.setHour(TIMES.find((t) => t.id === b.dataset.time).hour)));
    this.tr.querySelector('.tp').addEventListener('click', (e) => { e.stopPropagation(); this.togglePlaces(); });
    this.pop.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { const p = this.places[+b.dataset.place]; app.teleport(p.x, p.z); this.pop.hidden = true; }));
    addEventListener('click', (e) => { if (!this.pop.hidden && !this.pop.contains(e.target)) this.pop.hidden = true; });
    this.tr.querySelector('.mapb').addEventListener('click', () => this.toggleMap());
    this.bl.querySelector('.radar').addEventListener('click', () => this.toggleMap(true));
    this.tr.querySelector('.snd').addEventListener('click', () => { app.toggleSound(); this.syncSound(); });
    this.tr.querySelector('.clean').addEventListener('click', () => this.toggleClean());
    this.br.querySelector('.prev').addEventListener('click', () => app.cycleCamera(-1));
    this.br.querySelector('.next').addEventListener('click', () => app.cycleCamera(1));
    this.br.querySelector('.cur').addEventListener('click', () => app.cycleCamera(1));
    this.map.querySelector('.close').addEventListener('click', () => this.toggleMap(false));
    // (a click leaves no button focused: Space would press it again)
    document.addEventListener('click', (e) => { const b = e.target.closest?.('.hud button, .hud-pop button'); if (b && e.detail > 0) b.blur(); });
    addEventListener('keydown', (e) => {
      if (document.activeElement?.tagName === 'INPUT' || e.metaKey || e.ctrlKey || e.altKey || this.locked) return;
      const m = MODES.find((x) => x.key === e.key);
      if (m && !this.mapOpen) { app.setMode(m.id); return; }
      if (e.code === 'KeyM') this.toggleMap();
      else if (e.code === 'KeyH') this.toggleClean();
      else if (e.code === 'KeyN' && !e.repeat) { app.toggleSound(); this.syncSound(); }
      else if (e.code === 'KeyV' && !this.mapOpen) app.cycleCamera(e.shiftKey ? -1 : 1);
      else if (e.code === 'Escape' && this.mapOpen) this.toggleMap(false);
    });
    this.mapEvents();
    if (matchMedia('(pointer: coarse)').matches && app.keys) this.touchControls(app.keys);
    addEventListener('resize', () => { this.placeIndicator(); if (this.mapOpen) this.drawMap(); });
    if (document.fonts) document.fonts.ready.then(() => this.placeIndicator());
    this.t = 0; this.mode = null; this.lastLoc = '';
  }

  // the HUD shown (free roaming) or not (the opening, a scene of the apagón, the title)
  set visible(v) { document.body.classList.toggle('hud-off', !v); }
  toggleClean() { document.body.classList.toggle('hud-hidden'); }
  syncSound() { this.tr.querySelector('.snd').innerHTML = icon(this.app.soundOn() ? 'sound' : 'mute'); }
  togglePlaces() {
    this.pop.hidden = !this.pop.hidden;
    if (this.pop.hidden) return;
    const r = this.tr.querySelector('.tp').getBoundingClientRect();
    Object.assign(this.pop.style, { top: `${r.bottom + 10}px`, right: `${innerWidth - r.right}px`, maxHeight: `${innerHeight - r.bottom - 30}px`, overflowY: 'auto' });
  }
  placeIndicator() {
    const on = this.bc.querySelector('.mode.on'), ind = this.bc.querySelector('.ind');
    if (!on) return;
    ind.style.transform = `translateX(${on.offsetLeft}px)`; ind.style.width = `${on.offsetWidth}px`;
  }
  setMode(id) {
    this.mode = id;
    document.body.classList.toggle('roam', id !== 'explore');
    if (this.pad) this.padButtons(id);
    this.bc.querySelectorAll('.mode').forEach((b) => b.classList.toggle('on', b.dataset.mode === id));
    this.placeIndicator();
    this.bc.querySelector('.hints').innerHTML = (MODES.find((m) => m.id === id)?.hints ?? []).map(([k, a]) => `<span>${k.split(' ').map((x) => `<kbd>${x}</kbd>`).join('')} ${a}</span>`).join('');
  }

  // ---------------------------------------------------------------- a touch screen
  // The thumbstick stands in for W A S D (it appears where the thumb lands on the left half of the screen); the
  // buttons, for the keys of the way in use (held while pressed; E is a tap). The right half still drags the view.
  touchControls(keys) {
    document.body.classList.add('touch');
    this.keys = keys;
    const d = document.createElement('div'); d.id = 'hud-pad'; d.className = 'hud';
    d.innerHTML = '<div class="zone"></div><div class="stick"><i></i></div><div class="btns"></div>';
    this.pad = document.body.appendChild(d);
    const zone = d.querySelector('.zone'), stick = d.querySelector('.stick'), knob = stick.querySelector('i'), R = 48;
    let id = null, ox = 0, oy = 0;
    const set = (code, on) => (on ? keys.add(code) : keys.delete(code));
    const steer = (dx, dy) => {
      const l = Math.hypot(dx, dy), k = l > R ? R / l : 1; dx *= k; dy *= k;
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      set('KeyW', dy < -R * 0.3); set('KeyS', dy > R * 0.3); set('KeyA', dx < -R * 0.35); set('KeyD', dx > R * 0.35);
    };
    zone.addEventListener('pointerdown', (e) => {
      if (id != null) return;
      id = e.pointerId; zone.setPointerCapture(id); ox = e.clientX; oy = e.clientY;
      const r = d.getBoundingClientRect();
      Object.assign(stick.style, { display: 'block', left: `${ox - r.left}px`, top: `${oy - r.top}px` }); steer(0, 0);
    });
    zone.addEventListener('pointermove', (e) => { if (e.pointerId === id) steer(e.clientX - ox, e.clientY - oy); });
    const end = (e) => { if (e.pointerId !== id) return; id = null; stick.style.display = 'none'; ['KeyW', 'KeyS', 'KeyA', 'KeyD'].forEach((c) => keys.delete(c)); };
    zone.addEventListener('pointerup', end); zone.addEventListener('pointercancel', end);
    this.padButtons(this.app.mode);
  }
  padButtons(mode) {
    const B = { car: [['Freno', 'Space'], ['Turbo', 'ShiftLeft'], ['Bajarse', 'KeyE', true]], walk: [['Saltar', 'Space'], ['Correr', 'ShiftLeft'], ['Carro', 'KeyE', true]], bike: [['Freno', 'Space'], ['Rápido', 'ShiftLeft'], ['Carro', 'KeyE', true]],
      fly: [['Subir', 'Space'], ['Bajar', 'KeyC'], ['Turbo', 'ShiftLeft']] }[mode] ?? [];
    const box = this.pad.querySelector('.btns');
    box.innerHTML = B.map(([l, c, tap]) => `<button data-code="${c}" data-tap="${tap ? 1 : ''}">${l}</button>`).join('');
    box.querySelectorAll('button').forEach((b) => {
      const code = b.dataset.code, tap = !!b.dataset.tap;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault(); b.setPointerCapture(e.pointerId); b.classList.add('down');
        if (tap) dispatchEvent(new KeyboardEvent('keydown', { code, key: code.slice(3).toLowerCase() })); else this.keys.add(code);
      });
      const up = () => { b.classList.remove('down'); if (!tap) this.keys.delete(code); };
      b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
    });
  }

  // ---------------------------------------------------------------- where you are
  streetsAt(x, z) {
    const near = [];
    const cx = Math.floor(x / 60), cz = Math.floor(z / 60);
    for (let i = cx - 1; i <= cx + 1; i++) for (let j = cz - 1; j <= cz + 1; j++)
      for (const [px, pz, n] of this.index.names.get(i + ',' + j) ?? []) near.push([Math.hypot(px - x, pz - z), n]);
    near.sort((a, b) => a[0] - b[0]);
    const first = near.find((v) => v[0] < 30)?.[1], cross = near.find((v) => v[0] < 70 && v[1] !== first)?.[1];
    return [first, cross].filter(Boolean);
  }
  placeName(x, z) {
    let best = null, bd = 900;
    for (const p of this.places) { const d = Math.hypot(p.x - x, p.z - z); if (d < bd) { bd = d; best = p; } }
    return best ? `cerca de ${best.name}` : '';
  }

  // ---------------------------------------------------------------- each frame
  update(dt) {
    const app = this.app;
    this.t += dt;
    if (this.mode !== app.mode) this.setMode(app.mode);
    const v = app.view(), focus = v ?? app.focus();
    this.drawRadar(focus, v?.heading ?? app.lookHeading()); // (every frame: it glides)
    if (this.t < 0.2) return;
    this.t = 0;
    if (app.soundOn() !== this.soundShown) { this.soundShown = app.soundOn(); this.syncSound(); }
    const fps = app.fps(), f = this.tl.querySelector('.fps');
    f.textContent = String(Math.round(fps)); f.className = 'fps ' + (fps >= 50 ? '' : fps >= 30 ? 'warn' : 'bad');
    // the time-of-day preset nearest the clock, lit
    const h = app.hour(), nearest = TIMES.reduce((a, t) => (Math.abs(t.hour - h) < Math.abs(a.hour - h) ? t : a), TIMES[0]);
    this.tr.querySelectorAll('.time').forEach((b) => b.classList.toggle('on', b.dataset.time === nearest.id && Math.abs(nearest.hour - h) < 0.6));
    // the speed and the camera
    this.br.querySelector('.lbl').textContent = app.vehicleLabel();
    this.br.querySelector('.speed b').textContent = String(Math.round(v?.kmh ?? 0));
    this.br.querySelector('.meter i').style.transform = `scaleX(${Math.min(1, (v?.kmh ?? 0) / (app.mode === 'fly' ? 220 : app.mode === 'walk' ? 30 : app.mode === 'bike' ? 45 : 170))})`;
    this.br.querySelector('.alt').textContent = v?.altitude != null ? `alt ${Math.round(v.altitude)} m` : '';
    this.br.querySelector('.cur span').textContent = app.cameraName();
    // where
    const streets = this.streetsAt(focus.x, focus.z), loc = streets.join('|') + this.placeName(focus.x, focus.z);
    if (loc !== this.lastLoc) {
      this.lastLoc = loc;
      this.bl.querySelector('.signs').innerHTML = streets.map((s) => `<span class="sign">${s.replace(/^Avenida /, 'Ave. ').replace(/^Calle /, 'C. ')}</span>`).join('');
      this.bl.querySelector('.place').textContent = this.placeName(focus.x, focus.z);
    }
    if (this.mapOpen) this.drawMap();
  }

  // ---------------------------------------------------------------- the minimap
  drawRadar(at, heading) {
    const c = this.radar, dpr = Math.min(2, devicePixelRatio || 1), W = c.clientWidth, H = c.clientHeight;
    if (c.width !== W * dpr) { c.width = W * dpr; c.height = H * dpr; }
    const g = c.getContext('2d'), s = 0.42 * dpr; // pixels per metre (about 280 m across)
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = 'rgba(14,16,19,0.55)'; g.fillRect(0, 0, c.width, c.height);
    g.translate(c.width / 2, c.height / 2);
    const R = Math.hypot(W, H) / 2 / 0.42 + 20, cx = Math.floor(at.x / 250), cz = Math.floor(at.z / 250), n = Math.ceil(R / 250);
    const style = [[4.2, 'rgba(255,190,110,0.85)'], [3.2, 'rgba(255,255,255,0.62)'], [2, 'rgba(255,255,255,0.32)'], [1.2, 'rgba(255,255,255,0.16)']];
    for (let k = 3; k >= 0; k--) {
      g.strokeStyle = style[k][1]; g.lineWidth = style[k][0] * dpr * 0.6; g.lineCap = 'round'; g.beginPath();
      for (let i = cx - n; i <= cx + n; i++) for (let j = cz - n; j <= cz + n; j++) for (const sg of this.index.segs.get(i + ',' + j) ?? []) {
        if (sg[4] !== k) continue;
        g.moveTo((sg[0] - at.x) * s, (sg[1] - at.z) * s); g.lineTo((sg[2] - at.x) * s, (sg[3] - at.z) * s);
      }
      g.stroke();
    }
    // the simulated cars round about
    const sim = this.app.sim();
    if (sim?.nearby) {
      g.fillStyle = 'rgba(255,107,61,0.9)';
      for (const [x, z] of sim.nearby) g.fillRect((x - at.x) * s - 1.5 * dpr, (z - at.z) * s - 1.5 * dpr, 3 * dpr, 3 * dpr);
    }
    // you: an arrow along the heading (north up)
    g.rotate(-heading + Math.PI);
    g.fillStyle = '#ff6b3d'; g.strokeStyle = '#fff'; g.lineWidth = 1.5 * dpr;
    g.beginPath(); g.moveTo(0, -9 * dpr); g.lineTo(6 * dpr, 7 * dpr); g.lineTo(0, 3.5 * dpr); g.lineTo(-6 * dpr, 7 * dpr); g.closePath(); g.fill(); g.stroke();
  }

  // ---------------------------------------------------------------- the full map
  toggleMap(open = !this.mapOpen) {
    this.mapOpen = open; this.map.hidden = !open; this.app.mapOpen?.(open);
    if (open) { const f = this.app.view() ?? this.app.focus(); this.view.x = f.x; this.view.z = f.z; this.view.scale = 0.12; this.drawMap(); }
  }
  toWorld(px, py) { const c = this.mapCanvas, v = this.view; return [(px - c.clientWidth / 2) / v.scale + v.x, (py - c.clientHeight / 2) / v.scale + v.z]; }
  mapEvents() {
    const c = this.mapCanvas; let drag = null, moved = false;
    c.addEventListener('pointerdown', (e) => { drag = [e.clientX, e.clientY, this.view.x, this.view.z]; moved = false; c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointermove', (e) => {
      if (drag) { const dx = e.clientX - drag[0], dy = e.clientY - drag[1]; if (Math.hypot(dx, dy) > 4) moved = true; this.view.x = drag[2] - dx / this.view.scale; this.view.z = drag[3] - dy / this.view.scale; this.drawMap(); return; }
      const [x, z] = this.toWorld(e.offsetX, e.offsetY), st = this.streetsAt(x, z);
      this.map.querySelector('.hover').textContent = st.length ? st.join(' y ') : this.placeName(x, z) || '—';
    });
    c.addEventListener('pointerup', (e) => { if (drag && !moved) { const [x, z] = this.toWorld(e.offsetX, e.offsetY); this.app.teleport(x, z); this.toggleMap(false); } drag = null; });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [wx, wz] = this.toWorld(e.offsetX, e.offsetY), k = Math.exp(-e.deltaY * 0.0015);
      this.view.scale = Math.min(2, Math.max(0.02, this.view.scale * k));
      const [nx, nz] = this.toWorld(e.offsetX, e.offsetY); this.view.x += wx - nx; this.view.z += wz - nz; this.drawMap();
    }, { passive: false });
  }
  drawMap() {
    const c = this.mapCanvas, dpr = Math.min(2, devicePixelRatio || 1), W = c.clientWidth, H = c.clientHeight, v = this.view;
    if (c.width !== W * dpr || c.height !== H * dpr) { c.width = W * dpr; c.height = H * dpr; }
    const g = c.getContext('2d'), s = v.scale * dpr;
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, c.width, c.height);
    g.translate(c.width / 2, c.height / 2);
    const style = [[2.6, 'rgba(255,190,110,0.85)'], [1.8, 'rgba(255,255,255,0.6)'], [1, 'rgba(255,255,255,0.28)'], [0.8, 'rgba(255,255,255,0.12)']];
    const x0 = v.x - W / 2 / v.scale - 50, x1 = v.x + W / 2 / v.scale + 50, z0 = v.z - H / 2 / v.scale - 50, z1 = v.z + H / 2 / v.scale + 50;
    for (let k = 3; k >= 0; k--) {
      if (k === 3 && v.scale < 0.08) continue; // (far out, the service lanes are noise)
      g.strokeStyle = style[k][1]; g.lineWidth = style[k][0] * dpr * Math.min(1.6, Math.max(0.6, v.scale * 6)); g.lineCap = 'round'; g.beginPath();
      for (const sg of this.index.all) {
        if (sg[4] !== k || (sg[0] < x0 && sg[2] < x0) || (sg[0] > x1 && sg[2] > x1) || (sg[1] < z0 && sg[3] < z0) || (sg[1] > z1 && sg[3] > z1)) continue;
        g.moveTo((sg[0] - v.x) * s, (sg[1] - v.z) * s); g.lineTo((sg[2] - v.x) * s, (sg[3] - v.z) * s);
      }
      g.stroke();
    }
    // the places, and you
    g.font = `600 ${12 * dpr}px Inter, sans-serif`; g.textAlign = 'left'; g.textBaseline = 'middle';
    for (const p of this.places) {
      const px = (p.x - v.x) * s, py = (p.z - v.z) * s;
      g.fillStyle = '#ff6b3d'; g.beginPath(); g.arc(px, py, 4.5 * dpr, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(246,245,242,0.9)'; g.fillText(p.name, px + 8 * dpr, py);
    }
    const me = this.app.view() ?? this.app.focus();
    g.fillStyle = '#fff'; g.beginPath(); g.arc((me.x - v.x) * s, (me.z - v.z) * s, 6 * dpr, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ff6b3d'; g.beginPath(); g.arc((me.x - v.x) * s, (me.z - v.z) * s, 3.5 * dpr, 0, Math.PI * 2); g.fill();
  }
}
