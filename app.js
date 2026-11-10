'use strict';
const RATING = ['none', 'Very low', 'Low', 'Moderate', 'High', 'Very high'];
const COL = { 1: '#2a9d8f', 2: '#e9c46a', 3: '#f4a261', 4: '#e76f51', 5: '#9b2226' };
const CONF = { 1: 'low', 2: 'medium', 3: 'high' };
const ORDER = ['koshi_east', 'trishuli_valley', 'sun_koshi_roshi', 'kali_gandaki_hills', 'midwest_terai', 'koshi_arun_glacial'];
const Z_DISTRICT = 8.5, Z_90M = 11.5;                 // below 8.5: districts; 8.5–11.5: 1 km squares; above: 90 m squares
const HZ_LABEL = { flood: 'Flood', landslide: 'Landslide', glacial: 'Glacial lake outburst' };
const BANDS = { flood: ['under 1%', '1–5%', '5–20%', 'over 20%'], glacial: ['not exposed', 'Moderate', 'High', 'Very high'],
                landslide: ['under 20%', '20–40%', '40–60%', 'over 60%'] };
const BAND_COL = ['#f1efe8', '#fac775', '#e76f51', '#9b2226'];
let hazard = 'flood', manifest, lakes = {}, munis = {};
const blockCache = new Map();

const map = new maplibregl.Map({
  container: 'map', style: 'https://tiles.openfreemap.org/styles/positron',
  center: [85.3, 27.9], zoom: 7, minZoom: 6, maxZoom: 14, attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

const pill = (r) => `<span class="pill r${r}">${RATING[r]}</span>`;
const conf = (c) => c ? `<span class="conf">${CONF[c] || c} confidence</span>` : '';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const lakeName = (i) => {
  const L = lakes[i]; if (!L) return 'a ranked dangerous lake';
  const where = L.country === 'China' ? 'Tibet' : `${L.district} district`;
  return L.name ? `${L.name}, a Rank ${L.rank} dangerous lake in ${where}` : `a Rank ${L.rank} dangerous lake in ${where}`;
};
const kmText = (k) => (k < 1 ? 'less than 1 km' : `${Math.round(k)} km`);

// ---------- map icons, drawn once on a canvas ----------
function makeIcon(draw, size = 48) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const x = c.getContext('2d'); draw(x, size);
  return x.getImageData(0, 0, size, size);
}
function addIcons() {
  // hydropower: a map pin with a lightning bolt; pin colour = glacial outburst exposure (flood is near-universal for plants)
  const HYDRO_BG = { none: '#1d3557', Low: '#c9a227', Moderate: '#e07a2f', High: '#c0392b', 'Very high': '#7a0f14' };
  for (const [lvl, bg] of Object.entries(HYDRO_BG)) {
    map.addImage(`icon-hydro-${lvl}`, makeIcon((x, s) => {
      const cx = s / 2, r = s * 0.3, cy = s * 0.36;
      x.fillStyle = bg; x.strokeStyle = '#ffffff'; x.lineWidth = 3.5;
      x.beginPath(); x.arc(cx, cy, r, Math.PI * 0.82, Math.PI * 2.18); x.lineTo(cx, s - 3); x.closePath(); x.fill(); x.stroke();
      x.fillStyle = lvl === 'none' ? '#ffd166' : '#ffffff'; x.beginPath();
      x.moveTo(cx + r * 0.25, cy - r * 0.75); x.lineTo(cx - r * 0.5, cy + r * 0.12); x.lineTo(cx - r * 0.02, cy + r * 0.12);
      x.lineTo(cx - r * 0.25, cy + r * 0.8); x.lineTo(cx + r * 0.55, cy - r * 0.2); x.lineTo(cx + r * 0.05, cy - r * 0.2); x.closePath(); x.fill();
    }, 56), { pixelRatio: 2 });
  }
}

async function loadJSON(u) { const r = await fetch(u); if (!r.ok) throw new Error(u); return r.json(); }

async function init() {
  addIcons();
  manifest = await loadJSON('data/manifest.json');
  (await loadJSON('data/vec/lakes.json')).forEach((L) => { lakes[L.lake_index] = L; });
  munis = await loadJSON('data/vec/municipalities.json');
  for (const [rg, e] of Object.entries(manifest.regions)) {
    for (const hz of ['flood', 'landslide', 'glacial']) {
      for (const lv of ['1km', '90m']) {
        const im = e.images[`${hz}_${lv}`], id = `${rg}_${hz}_${lv}`;
        map.addSource(id, { type: 'image', url: im.url, coordinates: im.coordinates });
        map.addLayer({ id, type: 'raster', source: id,
          minzoom: lv === '1km' ? Z_DISTRICT : Z_90M, maxzoom: lv === '1km' ? Z_90M : 24,
          layout: { visibility: hz === hazard ? 'visible' : 'none' },
          paint: { 'raster-resampling': 'nearest', 'raster-opacity': 0.9, 'raster-fade-duration': 0 } });
      }
    }
  }
  map.addSource('districts', { type: 'geojson', data: 'data/vec/districts.geojson' });
  map.addLayer({ id: 'districts-fill', type: 'fill', source: 'districts', maxzoom: Z_DISTRICT, paint: { 'fill-color': districtColor(), 'fill-opacity': 0.75 } });
  map.addLayer({ id: 'districts-line', type: 'line', source: 'districts', paint: { 'line-color': '#555', 'line-width': 0.6 } });
  map.addSource('coverage', { type: 'geojson', data: 'data/vec/coverage.geojson' });
  map.addLayer({ id: 'coverage-line', type: 'line', source: 'coverage', paint: { 'line-color': '#0f6e56', 'line-width': 1.8, 'line-dasharray': [3, 2] } });
  map.addSource('roads', { type: 'geojson', data: 'data/vec/roads.geojson' });
  map.addLayer({ id: 'roads', type: 'line', source: 'roads', layout: { visibility: 'none', 'line-cap': 'round' }, minzoom: 8,
    paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.5, 13, 5], 'line-color': ratingColor('flood') } });
  map.addSource('bridges', { type: 'geojson', data: 'data/vec/bridges.geojson' });
  // bridges: a small dot when zoomed out; drawn as the bridge deck itself from zoom 13
  map.addLayer({ id: 'bridges', type: 'circle', source: 'bridges', minzoom: 10, maxzoom: 13, layout: { visibility: 'none' },
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 13, 4], 'circle-color': ['case', bridgeRated('flood'), bridgeColor('flood'), '#ffffff'],
             'circle-stroke-color': '#1f2328', 'circle-stroke-width': 1.2 } });
  map.addSource('bridges-lines', { type: 'geojson', data: 'data/vec/bridges_lines.geojson' });
  const DECK = (extra) => ['interpolate', ['exponential', 2], ['zoom'], 13, 6 + extra, 16, 18 + extra];
  map.addLayer({ id: 'bridges-deck-edge', type: 'line', source: 'bridges-lines', minzoom: 13, layout: { visibility: 'none', 'line-cap': 'butt' },
    paint: { 'line-color': '#1f2328', 'line-width': DECK(3) } });
  map.addLayer({ id: 'bridges-deck', type: 'line', source: 'bridges-lines', minzoom: 13, layout: { visibility: 'none', 'line-cap': 'butt' },
    paint: { 'line-color': '#ffffff', 'line-width': DECK(0) } });
  map.addLayer({ id: 'bridges-stripe', type: 'line', source: 'bridges-lines', minzoom: 13, filter: bridgeRated('flood'), layout: { visibility: 'none', 'line-cap': 'butt' },
    paint: { 'line-color': bridgeColor('flood'), 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 13, 2.5, 16, 7] } });
  map.addSource('hydro', { type: 'geojson', data: 'data/vec/hydropower.geojson' });
  map.addLayer({ id: 'hydro', type: 'symbol', source: 'hydro', minzoom: 8,
    layout: { 'icon-image': ['match', ['get', 'glacial'], 'Very high', 'icon-hydro-Very high', 'High', 'icon-hydro-High', 'Moderate', 'icon-hydro-Moderate', 'Low', 'icon-hydro-Low', 'icon-hydro-none'],
      'icon-allow-overlap': true, 'icon-anchor': 'bottom', 'symbol-sort-key': ['match', ['get', 'glacial'], 'Very high', 0, 'High', 1, 'Moderate', 2, 'Low', 3, 4],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 8, ['interpolate', ['linear'], ['get', 'capacity_mw'], 1, 0.6, 500, 1.0],
                                                         13, ['interpolate', ['linear'], ['get', 'capacity_mw'], 1, 1.0, 500, 1.6]] } });
  ['hydro', 'bridges', 'bridges-deck', 'roads', 'districts-fill'].forEach((l) => {
    map.on('mouseenter', l, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', l, () => { map.getCanvas().style.cursor = ''; });
  });
  map.on('click', onClick);
  setHazard('flood');
}

function ratingColor(hz) {        // roads and bridges store ratings as numbers 0-5
  return ['match', ['to-number', ['get', hz], 0], 5, COL[5], 4, COL[4], 3, COL[3], 2, COL[2], COL[1]];
}
function bridgeRated(hz) {           // which bridges get a coloured dot: rated Low or higher (flood: only over big rivers)
  const r = ['to-number', ['get', hz], 0];
  return hz === 'flood' ? ['all', ['==', ['get', 'river_size'], 'big river'], ['>=', r, 2]] : ['>=', r, 2];
}
function bridgeColor(hz) {
  return ['match', ['to-number', ['get', hz], 0], 5, COL[5], 4, COL[4], 3, COL[3], COL[2]];
}
function districtColor() {
  const key = hazard === 'glacial' ? 'glacial_band' : `${hazard}_band`;
  const b = BANDS[hazard], expr = ['match', ['get', key]];
  b.forEach((lab, i) => expr.push(lab, BAND_COL[i]));
  if (hazard === 'glacial') expr.push('Low', BAND_COL[0]);
  expr.push('#f1efe8');
  return expr;
}

function setHazard(hz) {
  hazard = hz;
  document.querySelectorAll('.hazards button').forEach((b) => b.classList.toggle('on', b.dataset.hz === hz));
  for (const rg of Object.keys(manifest.regions)) for (const h of ['flood', 'landslide', 'glacial']) for (const lv of ['1km', '90m'])
    map.setLayoutProperty(`${rg}_${h}_${lv}`, 'visibility', h === hz ? 'visible' : 'none');
  map.setPaintProperty('districts-fill', 'fill-color', districtColor());
  map.setPaintProperty('districts-fill', 'fill-opacity', hz === 'glacial' ? 0.4 : 0.75);   // glacial: worst spot anywhere, so lighter
  map.setPaintProperty('roads', 'line-color', ratingColor(hz));
  map.setPaintProperty('bridges', 'circle-color', ['case', bridgeRated(hz), bridgeColor(hz), '#ffffff']);
  map.setPaintProperty('bridges-stripe', 'line-color', bridgeColor(hz)); map.setFilter('bridges-stripe', bridgeRated(hz));
  drawLegend();
}

function drawLegend() {
  const z = map.getZoom();
  let html = `<div class="title">${HZ_LABEL[hazard]}</div>`;
  if (z < Z_DISTRICT) {
    html += `<div class="note">${hazard === 'glacial' ? 'District colour: the worst outburst exposure anywhere in it. Most of the district is outside the path; zoom in to see where it runs.' : 'District colour: share of the district rated High or Very high'}</div>`;
    BANDS[hazard].forEach((lab, i) => { html += `<div class="row"><span class="sw" style="background:${BAND_COL[i]}"></span>${lab}</div>`; });
    html += '<div class="note">Zoom in for 1 km squares, then 90 m squares.</div>';
  } else {
    [5, 4, 3, 2].forEach((r) => { html += `<div class="row"><span class="sw" style="background:${COL[r]}"></span>${RATING[r]}</div>`; });
    html += `<div class="note">${z < Z_90M ? (hazard === 'landslide' ? '1 km squares: the level 75% of the square is at or below.' : '1 km squares: the highest rating present (on at least 2 of 144 squares).') : '90 m squares.'} Blank = Very low or not exposed.</div>`;
  }
  const on = (l) => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none';
  let assets = '';
  if (on('hydro')) assets += '<div class="row"><span class="ic pin" style="--c:#c0392b"></span><span class="ic pin" style="--c:#e07a2f"></span><span class="ic pin" style="--c:#1d3557"></span>Hydropower plant, pin colour = glacial outburst exposure: High · Moderate · none (size = MW)</div>'
    + '<div class="note">Almost every plant is in the flood zone, because intakes are built in the river; the plant card explains. Glacial exposure is what sets plants apart.</div>';
  if (on('bridges')) assets += '<div class="row"><span class="ic deck"></span>Bridge, drawn as its deck when zoomed in (a dot further out). A coloured stripe or dot = rated Low or higher for this hazard; plain white = Very low or not assessed.</div>';
  if (on('roads')) assets += '<div class="row"><span class="ic road"></span>National road (colour = rating)</div>';
  if (assets) html += `<div class="title" style="margin-top:8px">On the map</div>${assets}`;
  document.getElementById('legend').innerHTML = html;
}

// ---------- click → square or asset ----------
function regionAt(lng, lat) {
  for (const rg of ORDER) {
    const g = manifest.regions[rg]?.grid; if (!g) continue;
    const [w, s, e, n] = g.bounds;
    if (lng >= w && lng <= e && lat >= s && lat <= n) {
      const r = Math.floor((g.north - lat) / g.dy), c = Math.floor((lng - g.west) / g.dx);
      if (r >= 0 && c >= 0 && r < g.rows && c < g.cols) return { rg, g, r, c };
    }
  }
  return null;
}
async function readBlock(rg, br, bc) {
  const key = `${rg}_${br}_${bc}`;
  if (blockCache.has(key)) return blockCache.get(key);
  const p = (async () => {
    const res = await fetch(`data/click/${key}.bin.gz`); if (!res.ok) return null;
    let buf = new Uint8Array(await res.arrayBuffer());
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = new Uint8Array(await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    return buf;
  })();
  blockCache.set(key, p); return p;
}
async function squareAt(lng, lat) {
  const tries = [];
  for (const rg of ORDER) {
    const g = manifest.regions[rg]?.grid; if (!g) continue;
    const [w, s, e, n] = g.bounds;
    if (!(lng >= w && lng <= e && lat >= s && lat <= n)) continue;
    const r = Math.floor((g.north - lat) / g.dy), c = Math.floor((lng - g.west) / g.dx);
    if (r < 0 || c < 0 || r >= g.rows || c >= g.cols) continue;
    const B = g.block, blk = await readBlock(rg, Math.floor(r / B), Math.floor(c / B));
    if (!blk) continue;
    const o = ((r % B) * B + (c % B)) * 16, v = blk.subarray(o, o + 16);
    if (v[0] > 0) return { rg, v };
  }
  return null;
}

async function onClick(e) {
  const box = [[e.point.x - 4, e.point.y - 4], [e.point.x + 4, e.point.y + 4]];
  const hits = map.queryRenderedFeatures(box, { layers: ['hydro', 'bridges', 'bridges-deck', 'roads'].filter((l) => map.getLayoutProperty(l, 'visibility') !== 'none') });
  if (hits.length) {
    const f = hits[0], p = f.properties;
    if (f.layer.id === 'hydro') {
      const sq = await squareAt(f.geometry.coordinates[0], f.geometry.coordinates[1]);
      const mu = sq ? munis[String(sq.v[14] + 256 * sq.v[15])] : null;
      return show(plantCard(p, mu ? `${mu[0]}, ${mu[1]} district` : ''));
    }
    if (f.layer.id === 'bridges' || f.layer.id === 'bridges-deck') return show(bridgeCard(p));
    if (f.layer.id === 'roads') return show(roadCard(p));
  }
  if (map.getZoom() < Z_DISTRICT) {
    const d = map.queryRenderedFeatures(e.point, { layers: ['districts-fill'] });
    if (d.length) return show(districtCard(d[0].properties));
  }
  const sq = await squareAt(e.lngLat.lng, e.lngLat.lat);
  if (!sq) return show(`<p class="hint">This spot is outside the six mapped regions. Canopi v1 covers Trishuli, Sun Koshi & Roshi, Koshi east, Koshi/Arun, Kali Gandaki and Mid-West Terai.</p>`);
  show(squareCard(sq.v, e.lngLat));
}
function show(html) { document.getElementById('card').innerHTML = html; if (window.innerWidth < 760) document.getElementById('card').scrollIntoView({ behavior: 'smooth' }); }

function floodText(v) {
  const [r, c, m, d10, d100, d500, hand] = [v[0], v[1], v[2], v[3] / 10, v[4] / 10, v[5] / 10, v[6]];
  if (m === 2) return `<p>Rated from the ground's height above the big river (${hand} m), because the global flood model fails our checks here (often in narrow gorges). We can't give flood odds here.</p>`;
  if (m === 3) return `<p>This river isn't in the global flood model, so the rating comes from the ground's height above it (${hand} m). We can't give flood odds here.</p>`;
  if (d500 === 0 && d100 === 0 && d10 === 0) return `<p>No modelled flood reaches this spot.${c === 1 ? ' A small stream nearby isn\'t modelled, so treat this with caution.' : ''}</p>`;
  const depth = (d) => (d > 10 ? 'water deeper than 10 m (river channel or deep gorge; depth not reliable)' : `about ${d.toFixed(1)} m of water`);
  if (d10 > 0) return `<p>Floods reach this spot often: almost certain (about 96%) at least once in the next 30 years.${d100 > 0 ? ` A bigger flood, with about a 1 in 4 chance in the next 30 years, would bring ${depth(d100)}.` : ''}</p>`;
  if (d100 > 0) return `<p>About a 1 in 4 chance in the next 30 years of a flood reaching here, with ${depth(d100)}.</p>`;
  return `<p>Only an extreme flood reaches here: about a 6% chance in the next 30 years.</p>`;
}
function squareCard(v, ll) {
  const mu = munis[String(v[14] + 256 * v[15])];
  const place = mu ? `${esc(mu[0])}, ${esc(mu[1])} district` : 'Nepal';
  let h = `<h2>${place}</h2><p class="sub">90 m square at ${ll.lat.toFixed(4)}°N, ${ll.lng.toFixed(4)}°E</p>`;
  h += `<div class="hz"><h3>Flood ${pill(v[0])} ${conf(v[1])}</h3>${floodText(v)}</div>`;
  h += `<div class="hz"><h3>Landslide ${pill(v[7])} <span class="conf">medium confidence</span></h3><p>Average slope ${v[8]}°. Based on slope only; rainfall, geology and past slides are not yet included.</p></div>`;
  if (v[9] > 0) {
    const reach = v[10] === 1 ? 'Water would very likely reach here in an outburst.' : 'A large outburst could reach here.';
    h += `<div class="hz"><h3>Glacial lake outburst ${pill(v[9])} <span class="conf">medium confidence</span></h3><p>${kmText(v[11])} downstream of ${esc(lakeName(v[12]))}. ${reach}</p><p class="note">Screening level: where a surge could reach, not how deep or when. Only lakes ICIMOD ranked as dangerous (2015) are traced.</p></div>`;
  } else {
    h += `<div class="hz"><h3>Glacial lake outburst ${pill(0)}</h3><p>No ICIMOD-ranked dangerous lake has an outburst path through here.</p></div>`;
  }
  h += `<div class="hz"><h3>History <span class="conf">low confidence for exact location</span></h3><p>${v[13] > 0 ? `${v[13]} floods or landslides recorded within about 1 km since 2011.` : 'No floods or landslides recorded within about 1 km since 2011.'} Records are located only to the ward, so “nearby” is approximate.</p></div>`;
  return h;
}
function districtCard(p) {
  const n = (x) => Number(x).toFixed(1);
  let h = `<h2>${esc(p.district)} district</h2><p class="sub">${esc(p.province || p.adm1_name || '')} · summary of ${Number(p.squares).toLocaleString()} squares of 90 m. Zoom in for detail.</p>`;
  h += `<div class="hz"><h3>Flood <span class="pill" style="background:${BAND_COL[BANDS.flood.indexOf(p.flood_band)] || '#ccc'};color:#222">${esc(p.flood_band)}</span></h3><p>${n(p.flood_high_pct)}% of the district rated High or Very high. In the hills much of this comes from rivers the global flood model doesn't cover, at low confidence.</p></div>`;
  h += `<div class="hz"><h3>Landslide <span class="pill" style="background:${BAND_COL[BANDS.landslide.indexOf(p.landslide_band)] || '#ccc'};color:#222">${esc(p.landslide_band)}</span></h3><p>${n(p.landslide_high_pct)}% rated High or Very high (slope only, so hill districts differ only modestly).</p></div>`;
  if (p.glacial_lake !== undefined) {
    const lvl = Number(p.glacial_highest_lvl || 0);
    h += `<div class="hz"><h3>Glacial lake outburst ${pill(lvl)}</h3><p>${lvl ? `Highest rating in the district, ${Number(p.glacial_km_from_lake) < 1 ? 'with the lake inside the district' : `${Math.round(Number(p.glacial_km_from_lake))} km below the lake`}: ${esc(p.glacial_lake)}. ${Number(p.glacial_zone_km2).toFixed(1)} km² of the district lies in an outburst path.` : 'No ICIMOD-ranked dangerous lake has an outburst path through this district.'}</p></div>`;
  } else {
    h += `<div class="hz"><h3>Glacial lake outburst</h3><p>${n(p.glacial_high_pct)}% rated High or Very high.</p></div>`;
  }
  return h;
}
function ratingNum(s) { const i = RATING.indexOf(s); return i < 0 ? 0 : i; }
function plantCard(p, place) {
  let h = `<h2>${esc(p.project)}</h2><p class="sub">${place ? `${esc(place)} · ` : ''}Hydropower · ${Number(p.capacity_mw).toLocaleString()} MW on the ${esc(p.river)} · ${p.operating === true || p.operating === 'true' ? 'operating' : 'licensed'} · ${esc(p.location)}</p>`;
  if (p.known_event) h += `<div class="hz event"><h3>What happened here</h3><p>${esc(p.known_event)}</p></div>`;
  const small = p.small_river === true || p.small_river === 'true';
  if (p.flood === 'not assessed') {
    h += `<div class="hz"><h3>Flood <span class="pill r0">not assessed</span></h3><p>${small ? 'The plant sits on a small river (under 100 km² draining) that our flood layer does not cover.' : 'Its listed location is not on a river we can place it on.'}</p></div>`;
  } else {
    h += `<div class="hz"><h3>Flood ${pill(ratingNum(p.flood))} ${p.flood_confidence ? `<span class="conf">${esc(p.flood_confidence)} confidence</span>` : ''}</h3><p>On a river that floods often: the ${esc(p.flood_at === 'snapped to river' ? 'nearest river reach' : p.flood_at)} sits in the 100-year flood zone. Whether the plant can withstand it depends on its design flood, which we don't have.</p></div>`;
  }
  h += p.glacial && p.glacial !== 'none'
    ? `<div class="hz"><h3>Glacial lake outburst ${pill(ratingNum(p.glacial))} <span class="conf">medium confidence</span></h3><p>${kmText(Number(p.glacial_km_below_lake))} below ${esc(p.glacial_lake || 'a ranked lake')}.</p><p class="note">Only ICIMOD-ranked lakes are traced; outbursts from unlisted lakes (such as July 2025 on the Bhotekoshi) can be missed or under-rated.</p></div>`
    : `<div class="hz"><h3>Glacial lake outburst ${pill(0)}</h3><p>No ICIMOD-ranked dangerous lake upstream.</p></div>`;
  h += `<div class="hz"><h3>Landslide ${pill(ratingNum(p.landslide))} <span class="conf">medium confidence</span></h3><p>Slopes around the site${p.location === 'placed by hand' ? '' : ' (approximate location)'}. Based on slope only; rainfall, geology and past slides are not yet included.</p></div>`;
  const ev = Number(p.events_1km || 0);
  h += `<div class="hz"><h3>History <span class="conf">low confidence for exact location</span></h3><p>${ev > 0 ? `${ev} floods or landslides recorded within about 1 km since 2011.` : 'No floods or landslides recorded within about 1 km since 2011.'} Records are located only to the ward, and large events are often missing.</p></div>`;
  if (p.location !== 'placed by hand') h += `<p class="note">Location approximate: DoED lists the centre of the licence area; we moved it to the largest river within reach (checked against 10 hand-placed plants: flood agreed 10/10, glacial 9/10).</p>`;
  return h;
}
function bridgeCard(p) {
  let h = `<h2>${esc(p.name || (p.carries === 'foot' ? 'Footbridge' : 'Road bridge'))}</h2><p class="sub">${p.carries === 'foot' ? 'Footbridge' : `Bridge on a ${esc(p.road_class)} road`} · ${Math.round(p.length_m)} m long · ${esc(p.river_size)}</p>`;
  h += p.river_size === 'big river'
    ? `<div class="hz"><h3>Flood ${pill(Number(p.flood))} <span class="conf">${esc(p.flood_confidence)} confidence</span></h3><p>Crosses a river that floods; the rating is the highest within 50 m of the bridge.</p></div>`
    : `<div class="hz"><h3>Flood <span class="pill r0">not assessed</span></h3><p>${p.river_size === 'small river (<100 km²)' ? 'Crosses a small river our flood layer does not cover. Small-stream bridges are often the ones flash floods wash out.' : 'No mapped river at this bridge (a canal, drain or gully, or the river is drawn slightly off).'}</p></div>`;
  h += Number(p.glacial) > 0 ? `<div class="hz"><h3>Glacial lake outburst ${pill(Number(p.glacial))}</h3><p>${kmText(Number(p.glacial_km_below_lake))} downstream of ${esc(lakeName(Number(p.glacial_lake_index)))}.</p></div>`
                             : `<div class="hz"><h3>Glacial lake outburst ${pill(0)}</h3><p>No ranked lake upstream.</p></div>`;
  h += `<div class="hz"><h3>Landslide ${pill(Number(p.landslide))}</h3><p>Highest slope rating within 50 m.</p></div>`;
  return h;
}
function roadCard(p) {
  const pct = (x) => `${Math.round(Number(x) * 100)}%`;
  let h = `<h2>${esc(p.road_name || p.road_refno)}</h2><p class="sub">${esc(p.road_refno)} · ${esc(p.link_name)} · ~${Math.round(p.length_m)} m stretch${p.aadt && p.aadt !== 'null' ? ` · ~${Number(p.aadt).toLocaleString()} vehicles a day` : ''}</p>`;
  h += `<div class="hz"><h3>Flood ${pill(Number(p.flood))} <span class="conf">${esc(p.flood_confidence)} confidence</span></h3><p>${pct(p.flood_share_high)} of this stretch rated High or above.</p></div>`;
  h += `<div class="hz"><h3>Landslide ${pill(Number(p.landslide))}</h3><p>${pct(p.landslide_share_high)} of this stretch rated High or above (slope only).</p></div>`;
  h += `<div class="hz"><h3>Glacial lake outburst ${pill(Number(p.glacial))}</h3><p>${Number(p.glacial) > 0 ? `${pct(p.glacial_share_any)} of this stretch is in an outburst zone.` : 'Not in an outburst zone.'}</p></div>`;
  return h;
}

document.querySelectorAll('.hazards button').forEach((b) => b.addEventListener('click', () => setHazard(b.dataset.hz)));
document.querySelectorAll('#layers input').forEach((cb) => cb.addEventListener('change', () => {
  const v = cb.checked ? 'visible' : 'none';
  map.setLayoutProperty(cb.dataset.layer, 'visibility', v); if (cb.dataset.layer === 'bridges') ['bridges-deck-edge', 'bridges-deck', 'bridges-stripe'].forEach((l) => map.setLayoutProperty(l, 'visibility', v));
  drawLegend();
}));
map.on('zoomend', drawLegend);
map.on('load', () => init().catch((err) => { document.getElementById('card').innerHTML = `<p class="hint">Could not load the map data (${esc(err.message)}). If you opened this file directly, run a local server: python3 -m http.server 8000</p>`; }));
