// The links to and from Garita (src/shared/twin.js): what a street-view link carries in, what a building carries out.
import assert from 'node:assert/strict';
import { parseLatLon, parseSeaLevel, garitaLink, GARITA } from '../../src/shared/twin.js';

// ?ll: latitude first; a view only when all three numbers are there
assert.deepEqual(parseLatLon('18.4655,-66.1057'), { lat: 18.4655, lon: -66.1057, view: null });
assert.deepEqual(parseLatLon('18.4655,-66.1057,250,180,30'), { lat: 18.4655, lon: -66.1057, view: [250, 180, 30] });
assert.deepEqual(parseLatLon('18.4655,-66.1057,250'), { lat: 18.4655, lon: -66.1057, view: null });
assert.equal(parseLatLon(''), null);
assert.equal(parseLatLon(null), null);
assert.equal(parseLatLon('abc,def'), null);
assert.equal(parseLatLon('-66.1,18.4,1'.replace('-66.1', '-166.1')), null, 'a longitude in the latitude slot is caught when out of range');
assert.equal(parseLatLon('91,0'), null);

// ?sea: only a level above the present sea raises it
assert.equal(parseSeaLevel(null), null);
assert.equal(parseSeaLevel(''), null);
assert.equal(parseSeaLevel('0'), null);
assert.equal(parseSeaLevel('-1'), null);
assert.equal(parseSeaLevel('x'), null);
assert.equal(parseSeaLevel('1.5'), 1.5);
assert.equal(parseSeaLevel('0.3', 0.5), null, 'not above the area\'s own sea');
assert.equal(parseSeaLevel('500'), null, 'not a sea level');

// Garita: the building by its point, the camera over it, the sea when raised, in Spanish by default
const u = new URL(garitaLink(-66.1057123, 18.4655456, { sea: 1.234 }));
assert.equal(u.origin + u.pathname, GARITA);
assert.equal(u.searchParams.get('pick'), '-66.105712,18.465546');
assert.equal(u.searchParams.get('cam'), '-66.105712,18.465546,650,0,55');
assert.equal(u.searchParams.get('sea'), '1.23');
assert.equal(u.searchParams.get('lang'), 'es');
const plain = new URL(garitaLink(-66.1, 18.4, { lang: null }));
assert.equal(plain.searchParams.has('sea'), false);
assert.equal(plain.searchParams.has('lang'), false);
assert.ok(!garitaLink(-66.1, 18.4).includes('%2C'), 'commas left readable');

console.log('twin links: ok');
