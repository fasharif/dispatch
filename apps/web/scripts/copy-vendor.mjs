// Copies browser files that must be served from this origin into public/vendor:
// - the MapLibre web worker and the module it shares with the main bundle (MapLibre loads them
//   by URL, which a bundler cannot rewrite);
// - the right-to-left text plugin that shapes Arabic labels on the map.
// Nothing is fetched from a CDN at runtime.
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const vendor = fileURLToPath(new URL('../public/vendor/', import.meta.url));

async function copy(source, target) {
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}

const maplibreDist = dirname(fileURLToPath(import.meta.resolve('maplibre-gl')));
for (const file of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) {
  await copy(join(maplibreDist, file), join(vendor, 'maplibre', file));
}

const rtlEntry = fileURLToPath(import.meta.resolve('@mapbox/mapbox-gl-rtl-text'));
await copy(
  join(dirname(rtlEntry), '..', 'dist', 'mapbox-gl-rtl-text.js'),
  join(vendor, 'mapbox-gl-rtl-text.js'),
);
