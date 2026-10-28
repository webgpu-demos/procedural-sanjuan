// A channel's banks (tools/pipeline/channels.mjs lays the channels out, src/world/channels.js draws them): for a
// river, canal, stream and ditch, how far a bank runs out for each metre it climbs (earth slopes; concrete stands
// nearly upright), and at most how far. h: the ground at the bank's top over the water.
export const RUN = [1.1, 0.25, 0.9, 0.5], MAXRUN = [7, 1.5, 4.5, 1.5];
export const bankRun = (k, h) => Math.min(MAXRUN[k] ?? 4, Math.max(0.3, Math.max(0, h) * (RUN[k] ?? 0.9)));
// end flags (e): 1 the start runs on into open water or another channel, 2 the end does (no wall across); 4 the start
// is where the waterway begins, 8 the end is where it ends (a sloping bank across, not a wall)
export const END = { OPEN_START: 1, OPEN_END: 2, SOURCE_START: 4, SOURCE_END: 8 };
