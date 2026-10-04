// Areas the pipeline can build. An area is a rectangle given by its bounding box; the world origin
// (0, 0, 0) sits on `origin`, which need not be its centre.
//   view      default camera for the client: [x, z, distance, azimuth°, elevation°] around the origin
//   heritage  [[lon, lat], ...] outline of a historic district: its buildings get the colonial palette
//   ads       how many invented billboards and screens (1 = as dense as a Tokyo shopping street, where this code began)
import path from 'node:path';

export const AREAS = {
  viejosanjuan: {
    name: 'Old San Juan',
    origin: [-66.11656, 18.46530], // Plaza de Armas [lon, lat]
    bbox: { west: -66.1290, south: 18.4560, east: -66.0930, north: 18.4750 },
    view: [-180, 40, 900, 200, 30],
    // the walled city, from El Morro to the Plaza Colón / San Cristóbal gate, La Perla included
    heritage: [[-66.1262, 18.4716], [-66.1180, 18.4718], [-66.1095, 18.4690], [-66.1080, 18.4660], [-66.1090, 18.4635],
      [-66.1135, 18.4610], [-66.1190, 18.4600], [-66.1225, 18.4625], [-66.1262, 18.4680]],
    ads: 0.06,
  },
  condado: {
    name: 'Condado',
    origin: [-66.07165, 18.45604], // Avenida Ashford, between La Concha and Calle Magdalena
    bbox: { west: -66.0890, south: 18.4440, east: -66.0560, north: 18.4655 },
    view: [0, 0, 900, 195, 30],
    ads: 0.25,
  },
  hatorey: {
    name: 'Hato Rey (Milla de Oro)',
    origin: [-66.06290, 18.42360], // Avenida Ponce de León in the Golden Mile
    bbox: { west: -66.0800, south: 18.4100, east: -66.0460, north: 18.4340 },
    view: [430, -200, 950, 345, 24], // the towers of the Milla de Oro, looking north to the Condado and the sea
    ads: 0.35,
  },
};
export const DEFAULT_AREA = 'viejosanjuan';

export const ROOT = path.resolve(import.meta.dirname, '../..');
export const RAW = path.join(ROOT, 'data/raw');

export function resolveArea(argv = process.argv) {
  const arg = argv.find((a) => a.startsWith('--area='));
  const id = arg ? arg.split('=')[1] : DEFAULT_AREA;
  const area = AREAS[id];
  if (!area) throw new Error(`unknown area "${id}" (known: ${Object.keys(AREAS).join(', ')})`);
  return { id, ...area, bbox: { ...area.bbox }, rawDir: path.join(RAW, id), outDir: path.join(ROOT, 'public/tiles', id) };
}
