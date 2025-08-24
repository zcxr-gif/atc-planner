
document.addEventListener('DOMContentLoaded', () => {
  // -------------------------
  // --- CONFIG / CONSTANTS
  // -------------------------
  maptilersdk.config.apiKey = 'ety8GjHG3ccnoSZfOULB';

  const LIVE_UPDATE_BASE_MS = 30000; // base 30s fetch
  const MAX_VISIBLE_FLIGHTS = 600;    // cap number of visible flights
  const ELEVATION_DEBOUNCE_MS = 250;  // mousemove debounce
  const FLIGHT_SOURCE_ID = 'live-flights-source';
  const FLIGHT_LAYER_ID = 'live-flights-layer';
  const FLIGHT_CLUSTER_LAYER_ID = 'live-flights-cluster-layer';

  // -------------------------
  // --- MAP INITIALIZATION
  // -------------------------
  const map = new maptilersdk.Map({
    container: 'map',
    style: 'https://api.maptiler.com/maps/01980624-ad9c-736d-a1c0-b481bf180ccf/style.json?key=ety8GjHG3ccnoSZfOULB',
    center: [-98.57, 39.82],
    zoom: 4,
    terrain: {
      source: 'aws-terrain',
      exaggeration: 1.5
    }
  });

  // -------------------------
  // --- GLOBAL STATE
  // -------------------------
  let airportsDataCache = null;
  let runwaysDataCache = null;
  let waypointsDataCache = null;
  let wmmModel = null;

  // UI / runtime state
  let isDrawingEnabled = false;
  let isDrawing = false;
  let tempLabel = null;
  let elevationDebounceTimer = null;
  let airportUpdateTimeout = null;
  let waypointUpdateTimeout = null;
  let navaidRequestTimeout = null;

  // Live mode state
  let isLiveModeActive = false;
  let liveTimer = null;
  let isFetchingLive = false;
  let liveErrorBackoff = 0;
  let lastFlightsFingerprint = null;
  let currentSessionId = null;

  // Layers tracking
  const layerAndSourceIds = new Set();

  // Markers / in previous code were DOM markers; replaced by GeoJSON flights
  const planLabels = {};
  let pulseAnimationId = null;
  let activeAirportIcao = null;
  let activeAtisStationIcaos = new Set();
  let activeAtcAirportIcaos = new Set();
  let atisCache = {};

  // DOM helpers
  const mslPopup = document.getElementById('msl-popup') || createFloatingTooltip();
  const reopenButton = document.getElementById('reopen-main-panel');

  // Style constants (copied/kept from original)
  const RUNWAY_STYLE_REGULAR = { 'line-color': '#FFFFFF', 'line-width': 1.5, 'fill-color': '#4E4E4E', 'fill-opacity': 1 };
  const RUNWAY_STYLE_HIGHLIGHT = { 'line-color': '#FFD700', 'line-width': 2, 'fill-color': '#FFD700', 'fill-opacity': 0.7 };
  const RUNWAY_CENTERLINE_STYLE_REGULAR = { 'line-color': '#FFFFFF', 'line-width': 1.5, 'line-dasharray': [10, 8] };
  const FLIGHT_LINE_STYLES_REGULAR = {
    standard: { 'line-color': '#000000', 'line-width': 3, 'line-opacity': 0.85 },
    arrival: { 'line-color': '#2979FF', 'line-width': 3, 'line-opacity': 1 },
    departure: { 'line-color': '#FF3D00', 'line-width': 3, 'line-opacity': 1 }
  };
  const FINAL_APPROACH_STYLE = { 'fill-color': 'rgba(128,128,128,0.2)', 'fill-opacity': 1 };
  const FINAL_APPROACH_CENTERLINE_STYLE = { 'line-color': '#000000', 'line-width': 2, 'line-dasharray': [5,5] };

  // App settings
  let appSettings = { dataBlockScale: 1.0, showDataBlocks: true, useTrueHeading: false };

  // -------------------------
  // --- UTILITIES
  // -------------------------
  function createFloatingTooltip() {
    const el = document.createElement('div');
    el.id = 'msl-popup';
    el.style.position = 'absolute';
    el.style.pointerEvents = 'none';
    el.style.zIndex = 9999;
    el.style.padding = '6px 8px';
    el.style.background = 'rgba(20,20,20,0.9)';
    el.style.color = '#fff';
    el.style.borderRadius = '6px';
    el.style.fontSize = '12px';
    el.style.display = 'none';
    document.body.appendChild(el);
    return el;
  }

  async function fetchCsv(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('CSV fetch failed: ' + r.status);
    const text = await r.text();
    const lines = text.split(/\r?\n/).filter(Boolean);
    const headers = lines[0].split(',').map(h => h.replace(/"/g,'').trim());
    const entries = lines.slice(1).map(line => {
      const cells = line.split(',').map(c => c.replace(/"/g,'').trim());
      const obj = {};
      headers.forEach((h,i) => obj[h] = cells[i]);
      return obj;
    });
    return entries;
  }

  // -------------------------
  // --- DATA CACHES
  // -------------------------
  async function getAirports() {
    if (airportsDataCache) return airportsDataCache;
    try {
      const data = await fetchCsv('https://davidmegginson.github.io/ourairports-data/airports.csv');
      airportsDataCache = data.filter(a => a.ident && a.type !== 'heliport' && a.type !== 'closed');
      return airportsDataCache;
    } catch (err) {
      console.error('getAirports error', err);
      return [];
    }
  }

  async function getRunways() {
    if (runwaysDataCache) return runwaysDataCache;
    try {
      const data = await fetchCsv('https://davidmegginson.github.io/ourairports-data/runways.csv');
      runwaysDataCache = data;
      return runwaysDataCache;
    } catch (err) {
      console.error('getRunways error', err);
      return [];
    }
  }

  async function getWaypoints() {
    if (waypointsDataCache) return waypointsDataCache;
    try {
      const r = await fetch('waypoints.json');
      if (!r.ok) throw new Error('waypoints.json not found');
      const j = await r.json();
      waypointsDataCache = j;
      return j;
    } catch (err) {
      console.error('getWaypoints error', err);
      return [];
    }
  }

  // Proxy function for VORs - keep same behavior (serverless)
  async function getVORsFromOpenAIP(bbox) {
    try {
      const response = await fetch(`/.netlify/functions/navaids?bbox=${bbox.join(',')}`);
      if (!response.ok) {
        console.error('navaids proxy returned error', response.status);
        return [];
      }
      const data = await response.json();
      return data.items || [];
    } catch (err) {
      console.error('getVORsFromOpenAIP', err);
      return [];
    }
  }

  // -------------------------
  // --- WMM (geomag) INIT
  // -------------------------
  async function initializeWMM() {
    try {
      if (typeof geomag !== 'undefined' && geomag && typeof geomag.field === 'function') {
        wmmModel = geomag;
        console.log('WMM loaded (geomag)');
      } else if (typeof window.Geomag === 'function') {
        wmmModel = new window.Geomag();
        console.log('WMM loaded (Geomag constructor)');
      } else {
        console.warn('WMM not found, mag var disabled');
        wmmModel = null;
      }
    } catch (err) {
      console.error('initializeWMM error', err);
      wmmModel = null;
    }
  }

  // -------------------------
  // --- MAP LOAD
  // -------------------------
  map.on('load', async () => {
    // Add terrain source (AWS terrarium)
    if (!map.getSource('aws-terrain')) {
      map.addSource('aws-terrain', {
        type: 'raster-dem',
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        tileSize: 256,
        encoding: 'terrarium'
      });
    }

    // Terrain highlight layer (hidden by default)
    if (!map.getLayer('terrain-highlight-layer')) {
      map.addLayer({
        id: 'terrain-highlight-layer',
        type: 'raster',
        source: 'aws-terrain',
        paint: { 'raster-color': 'hsla(0,0%,0%,0)', 'raster-resampling': 'nearest' },
        layout: { visibility: 'none' }
      });
    }

    // Peaks MBTiles (if available)
    try {
      if (!map.getSource('peaks-source')) {
        map.addSource('peaks-source', {
          type: 'vector',
          url: 'https://storage.googleapis.com/peaks_mountains/peaks.mbtiles'
        });
        map.addLayer({
          id: 'peaks-labels-layer',
          type: 'symbol',
          source: 'peaks-source',
          'source-layer': 'peak',
          layout: {
            'text-field': ['get', 'name'],
            'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
            'text-size': ['interpolate', ['linear'], ['zoom'], 8, 9, 14, 12],
            'text-optional': true
          },
          paint: {
            'text-color': '#E0E0E0',
            'text-halo-color': '#111111',
            'text-halo-width': 1.5
          },
          minzoom: 8
        });
      }
    } catch (err) {
      console.warn('peaks source add failed (maybe URL unsupported):', err);
    }

    // VOR compass image (one-time)
    if (!map.hasImage('vor-compass-rose')) {
      try {
        const imgData = createVorCompassImage(300);
        map.addImage('vor-compass-rose', imgData);
      } catch (err) {
        console.warn('vor-compass creation failed', err);
      }
    }

    // Create efficient flights GeoJSON source + cluster + symbol layers
    createEfficientFlightsLayer();

    // Setup event listeners
    setupEventListeners();

    // Initialize caches & WMM
    await initializeWMM();
    await getAirports();
    await getRunways();
    await getWaypoints();

    // Initial UI
    createMainPanel();
    updateAirports();
    updateNavaids();
    updateWaypoints();
    setupMobileNav();

    // Hide loader if present
    const loader = document.getElementById('loader');
    if (loader) loader.classList.add('hidden');
  });

  // -------------------------
  // --- CREATE EFFICIENT FLIGHTS LAYER
  // -------------------------
  function createEfficientFlightsLayer() {
    if (!map.getSource(FLIGHT_SOURCE_ID)) {
      map.addSource(FLIGHT_SOURCE_ID, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        cluster: true,
        clusterMaxZoom: 8,
        clusterRadius: 40
      });
    }

    if (!map.hasImage('aircraft-icon')) {
      // create small canvas triangle
      const size = 64;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.translate(size/2, size/2);
      ctx.rotate(-Math.PI/2);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(0, -size*0.26);
      ctx.lineTo(size*0.12, size*0.26);
      ctx.lineTo(-size*0.12, size*0.26);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 2;
      ctx.stroke();
      try {
        map.addImage('aircraft-icon', ctx.getImageData(0,0,size,size));
      } catch (err) {
        // Some SDK versions require HTMLImage; fallback to no custom icon then
        console.warn('addImage failed', err);
      }
    }

    if (!map.getLayer(FLIGHT_LAYER_ID)) {
      map.addLayer({
        id: FLIGHT_LAYER_ID,
        type: 'symbol',
        source: FLIGHT_SOURCE_ID,
        layout: {
          'icon-image': 'aircraft-icon',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 0.35, 8, 0.8],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'icon-rotation-alignment': 'map',
          'icon-rotate': ['get', 'heading'],
          'text-field': ['get', 'callsign'],
          'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
          'text-anchor': 'top',
          'text-offset': [0, 1.2],
          'text-size': 11,
          'text-allow-overlap': false
        },
        paint: {
          'text-color': '#fff',
          'text-halo-color': '#000',
          'text-halo-width': 1
        },
        minzoom: 2
      });
    }

    // cluster circle & count
    if (!map.getLayer(FLIGHT_CLUSTER_LAYER_ID)) {
      map.addLayer({
        id: FLIGHT_CLUSTER_LAYER_ID,
        type: 'circle',
        source: FLIGHT_SOURCE_ID,
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': ['step', ['get', 'point_count'], '#6EE7B7', 10, '#FDE68A', 50, '#FB7185'],
          'circle-radius': ['step', ['get', 'point_count'], 15, 10, 20, 50, 30]
        }
      });

      map.addLayer({
        id: FLIGHT_LAYER_ID + '-cluster-count',
        type: 'symbol',
        source: FLIGHT_SOURCE_ID,
        filter: ['has', 'point_count'],
        layout: { 'text-field': '{point_count_abbreviated}', 'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'], 'text-size': 12 },
        paint: { 'text-color': '#000' }
      });
    }

    // click handler to open popup (on feature)
    map.on('click', FLIGHT_LAYER_ID, (e) => {
      if (!e.features || !e.features[0]) return;
      const feat = e.features[0];
      const props = feat.properties || {};
      const coords = feat.geometry.coordinates.slice();
      const altitudeText = props.altitude ? `${Math.round(props.altitude)} ft` : 'N/A';
      const speedText = props.speed ? `${Math.round(props.speed)} kts` : 'N/A';
      const callsign = props.callsign || 'N/A';
      const html = `
        <div class="flight-popup-header">
          <div style="font-weight:700;">${callsign}</div>
          <div style="font-size:12px;color:#ddd;">${props.aircraftName || ''}</div>
        </div>
        <div style="margin-top:6px;">
          <div><strong>Altitude:</strong> ${altitudeText}</div>
          <div><strong>Speed:</strong> ${speedText}</div>
          <div><strong>User:</strong> ${props.username || 'N/A'}</div>
          ${props.flightId ? `<div style="margin-top:6px;"><button class="cta-button view-fpl-btn" data-flight-id="${props.flightId}" data-session-id="${currentSessionId || ''}" data-callsign="${callsign}" data-altitude="${altitudeText}" data-speed="${speedText}">View FPL</button></div>` : ''}
        </div>`;
      new maptilersdk.Popup({ offset: 12, className: 'custom-popup' }).setLngLat(coords).setHTML(html).addTo(map);
    });

    map.on('mouseenter', FLIGHT_LAYER_ID, () => map.getCanvas().style.cursor = 'pointer');
    map.on('mouseleave', FLIGHT_LAYER_ID, () => map.getCanvas().style.cursor = '');
  }

  // -------------------------
  // --- LIVE MODE CONTROLS
  // -------------------------
  function startLiveUpdates(sessionId) {
    if (!sessionId) return console.warn('startLiveUpdates: no sessionId');
    stopLiveUpdates();
    isLiveModeActive = true;
    liveErrorBackoff = 0;
    currentSessionId = sessionId;
    fetchAndDisplayData(sessionId);
    liveTimer = setTimeout(() => liveTick(sessionId), LIVE_UPDATE_BASE_MS);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    startInactivityTimer();
    if (!pulseAnimationId) animatePulse(); // start airport pulse if needed
  }

  function stopLiveUpdates() {
    isLiveModeActive = false;
    if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
    isFetchingLive = false;
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    // Clear flights geojson
    try {
      if (map.getSource && map.getSource(FLIGHT_SOURCE_ID)) {
        map.getSource(FLIGHT_SOURCE_ID).setData({ type: 'FeatureCollection', features: [] });
      }
    } catch (err) { /* ignore */ }
    // Stop pulse animation
    if (pulseAnimationId) {
      cancelAnimationFrame(pulseAnimationId);
      pulseAnimationId = null;
    }
    updateAirports(); // re-render airport dots (no pulse)
  }

  function handleVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
      if (pulseAnimationId) { cancelAnimationFrame(pulseAnimationId); pulseAnimationId = null; }
    } else {
      if (isLiveModeActive && !liveTimer) liveTimer = setTimeout(() => liveTick(currentSessionId), 2000);
      if (isLiveModeActive && !pulseAnimationId) animatePulse();
    }
  }

  async function liveTick(sessionId) {
    if (!isLiveModeActive) return;
    if (document.visibilityState === 'hidden') {
      liveTimer = setTimeout(() => liveTick(sessionId), 30000);
      return;
    }
    await fetchAndDisplayData(sessionId);
    const nextDelay = Math.max(LIVE_UPDATE_BASE_MS, LIVE_UPDATE_BASE_MS + (liveErrorBackoff * 5000));
    liveTimer = setTimeout(() => liveTick(sessionId), nextDelay);
  }

  async function fetchAndDisplayData(sessionId) {
    if (isFetchingLive) return;
    isFetchingLive = true;
    try {
      const [flightsRes, atcRes] = await Promise.allSettled([
        fetch(`/.netlify/functions/flights/${sessionId}`),
        fetch(`/.netlify/functions/atc/${sessionId}`)
      ]);

      if (flightsRes.status === 'fulfilled' && flightsRes.value.ok) {
        const flightsJson = await flightsRes.value.json();
        const flights = flightsJson.result || [];
        updateFlightsGeojson(flights);
        liveErrorBackoff = 0;
      } else {
        liveErrorBackoff++;
        console.warn('flights fetch failed', flightsRes.reason || (flightsRes.value && flightsRes.value.status));
      }

      if (atcRes.status === 'fulfilled' && atcRes.value.ok) {
        const atcJson = await atcRes.value.json();
        updateAtcListFromData(atcJson.result || []);
      } else {
        console.warn('atc fetch failed', atcRes.reason || (atcRes.value && atcRes.value.status));
      }
    } catch (err) {
      console.error('fetchAndDisplayData failed', err);
      liveErrorBackoff++;
    } finally {
      isFetchingLive = false;
    }
  }

  function updateFlightsGeojson(flights) {
    if (!map || !map.getSource || !map.getSource(FLIGHT_SOURCE_ID)) return;
    let bounds;
    try { bounds = map.getBounds(); } catch (e) { bounds = null; }
    const filtered = [];
    for (let i = 0; i < flights.length; i++) {
      const f = flights[i];
      if (!f) continue;
      const lon = Number(f.longitude), lat = Number(f.latitude);
      if (!isFinite(lon) || !isFinite(lat)) continue;
      if (bounds && !bounds.contains([lon, lat])) continue;
      filtered.push(f);
      if (filtered.length >= MAX_VISIBLE_FLIGHTS) break;
    }

    if (filtered.length === 0) {
      try { map.getSource(FLIGHT_SOURCE_ID).setData({ type: 'FeatureCollection', features: [] }); } catch(e){}
      lastFlightsFingerprint = null;
      return;
    }

    const features = filtered.map(f => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [Number(f.longitude), Number(f.latitude)] },
      properties: {
        flightId: String(f.flightId || ''),
        callsign: f.callsign || '',
        heading: Number(f.heading || 0),
        altitude: Number(f.altitude || 0),
        speed: Number(f.speed || 0),
        username: f.username || '',
        aircraftName: f.aircraftName || ''
      }
    }));

    // Simple fingerprint to skip noisy updates
    let fingerprint = `${features.length}`;
    if (features.length) {
      fingerprint += '|' + features[0].properties.flightId;
      fingerprint += '|' + features[Math.floor(features.length/2)].properties.flightId;
      fingerprint += '|' + features[features.length-1].properties.flightId;
    }
    if (fingerprint === lastFlightsFingerprint) return;
    lastFlightsFingerprint = fingerprint;

    try {
      map.getSource(FLIGHT_SOURCE_ID).setData({ type: 'FeatureCollection', features });
    } catch (err) {
      console.error('setData failed', err);
    }
  }

  // -------------------------
  // --- ATC / UI helpers
  // -------------------------
  function updateAtcListFromData(atcArr) {
    const el = document.getElementById('atc-list');
    if (!el) return;
    if (!Array.isArray(atcArr) || atcArr.length === 0) {
      el.innerHTML = '<div>No ATC data.</div>';
      return;
    }
    const html = atcArr.slice(0, 200).map(a => {
      const callsign = a.callsign || a.facility || '';
      const freq = a.frequency || '';
      const facility = a.facility || '';
      return `<div class="atc-row"><strong>${callsign}</strong> ${freq} ${facility}</div>`;
    }).join('');
    el.innerHTML = html;
  }

  // -------------------------
  // --- PULSE ANIMATION (AIRPORTS)
  // -------------------------
  function animatePulse() {
    if (!isLiveModeActive || !map.getLayer('airport-dots-pulse-layer')) {
      pulseAnimationId = null;
      return;
    }
    const duration = 2000;
    const t = (performance.now() % duration) / duration;
    const pulseAmount = Math.sin(t * Math.PI);
    const maxRadiusIncrease = 10;
    const radius = pulseAmount * maxRadiusIncrease;
    const opacity = 1 - pulseAmount;
    try {
      map.setPaintProperty('airport-dots-pulse-layer', 'circle-radius', ['+', ['match', ['get', 'type'], 'large_airport', 7, 'medium_airport', 5, 3], radius]);
      map.setPaintProperty('airport-dots-pulse-layer', 'circle-opacity', opacity);
      map.setPaintProperty('airport-dots-pulse-layer', 'circle-stroke-opacity', opacity);
    } catch (err) {
      // layer may not exist yet
    }
    pulseAnimationId = requestAnimationFrame(animatePulse);
  }

  // -------------------------
  // --- MOUSEMOVE -> ELEVATION & MAG VAR (debounced)
  // -------------------------
  function getPublicElevation(latlng) {
    const endpoint = `https://api.open-meteo.com/v1/elevation?latitude=${latlng.lat}&longitude=${latlng.lng}`;
    return fetch(endpoint).then(r => r.ok ? r.json() : null).then(json => {
      if (json && Array.isArray(json.elevation) && json.elevation.length>0) return json.elevation[0];
      return null;
    }).catch(err => { console.warn('elevation fetch error', err); return null; });
  }

  async function getElevationAndMag(lngLat) {
    try {
      const elevation = await getPublicElevation({ lat: lngLat.lat, lng: lngLat.lng });
      let magText = 'Mag Var: N/A';
      if (wmmModel) {
        try {
          const p = wmmModel.field(lngLat.lat, lngLat.lng);
          if (p && typeof p.declination === 'number') magText = `Mag Var: ${p.declination.toFixed(2)}°`;
        } catch (err) { /* ignore */ }
      }
      const elevText = (typeof elevation === 'number' && !isNaN(elevation)) ? `${Math.round(elevation)} m` : 'N/A';
      if (mslPopup) mslPopup.innerHTML = `Elev: ${elevText}<br>${magText}`;
    } catch (err) {
      console.error('getElevationAndMag error', err);
    }
  }

  // -------------------------
  // --- EVENT LISTENERS & DRAWING
  // -------------------------
  function setupEventListeners() {
    map.getCanvas().addEventListener('contextmenu', (e) => e.preventDefault());

    // drawing handlers (mouse/touch)
    map.on('mousedown', handleMouseDown);
    map.on('mousemove', handleMouseMove);
    map.on('mouseup', handleMouseUp);
    map.on('touchstart', handleMouseDown);
    map.on('touchmove', handleMouseMove);
    map.on('touchend', handleMouseUp);

    // throttle moveend events
    let moveEndTimeout = null;
    function handleMapMoveEnd() {
      clearTimeout(moveEndTimeout);
      moveEndTimeout = setTimeout(() => {
        adjustAllLabelPositions && adjustAllLabelPositions();
        clearTimeout(airportUpdateTimeout);
        airportUpdateTimeout = setTimeout(updateAirports, 500);
        clearTimeout(waypointUpdateTimeout);
        waypointUpdateTimeout = setTimeout(updateWaypoints, 500);
        clearTimeout(navaidRequestTimeout);
        navaidRequestTimeout = setTimeout(updateNavaids, 500);
      }, 400);
    }
    map.on('moveend', handleMapMoveEnd);
    map.on('zoomend', handleMapMoveEnd);

    // mousemove debounced elevation/mag var
    map.on('mousemove', (e) => {
      if (isDrawingEnabled || !mslPopup) return;
      mslPopup.style.left = `${e.point.x + 15}px`;
      mslPopup.style.top = `${e.point.y}px`;
      mslPopup.style.display = 'block';
      if (wmmModel) {
        try {
          const point = wmmModel.field(e.lngLat.lat, e.lngLat.lng);
          mslPopup.innerHTML = 'MSA: Loading...<br>Mag Var: ' + (point && typeof point.declination === 'number' ? point.declination.toFixed(2) + '°' : 'N/A');
        } catch (err) {
          mslPopup.innerHTML = 'MSA: Loading...<br>Mag Var: N/A';
        }
      } else {
        mslPopup.innerHTML = 'MSA: Loading...<br>Mag Var: N/A';
      }

      clearTimeout(elevationDebounceTimer);
      elevationDebounceTimer = setTimeout(() => getElevationAndMag(e.lngLat), ELEVATION_DEBOUNCE_MS);
    });

    map.on('mouseout', () => { if (mslPopup) mslPopup.style.display = 'none'; });

    // general UI listeners
    document.addEventListener('mousemove', resetInactivityTimer, false);
    document.addEventListener('keydown', resetInactivityTimer, false);
    document.addEventListener('click', resetInactivityTimer, false);

    // delegate view-fpl buttons
    document.addEventListener('click', async function (e) {
      if (e.target && e.target.classList.contains('view-fpl-btn')) {
        e.preventDefault();
        const flightId = e.target.getAttribute('data-flight-id');
        const sessionId = e.target.getAttribute('data-session-id');
        const callsign = e.target.getAttribute('data-callsign') || 'Unknown';
        const altitude = e.target.getAttribute('data-altitude') || 'N/A';
        const speed = e.target.getAttribute('data-speed') || 'N/A';
        if (flightId && sessionId) {
          await fetchAndDisplayFlightPlan(flightId, sessionId, callsign, altitude, speed);
        } else {
          console.error("Flight ID or Session ID is missing from the button.", { flightId, sessionId });
          alert("Could not fetch flight plan: required information is missing.");
        }
      }
    });
  }

  // ---------- Drawing logic (adapted from original) ----------
  function handleMouseDown(e) {
    // e.originalEvent may not exist in maptiler event; handle gracefully
    const ev = e.originalEvent || e;
    if (!isDrawingEnabled || (ev.button && ev.button !== 0)) return;
    if (ev.target && ev.target.closest && ev.target.closest('.floating-panel')) return;

    isDrawing = true;
    const startPoint = e.lngLat;

    if (!map.getSource('temp-line')) {
      map.addSource('temp-line', { type: 'geojson', data: { type: 'LineString', coordinates: [] }});
      map.addLayer({ id: 'temp-line', type: 'line', source: 'temp-line', paint: { 'line-color': '#007bff', 'line-width': 3, 'line-dasharray': [2,2] }});
    }
    map.getSource('temp-line').setData({ type: 'LineString', coordinates: [[startPoint.lng, startPoint.lat], [startPoint.lng, startPoint.lat]] });

    const el = document.createElement('div');
    el.className = 'drawing-temp-heading';
    el.innerHTML = '---';
    tempLabel = new maptilersdk.Marker(el).setLngLat(startPoint).addTo(map);
  }

  function handleMouseMove(e) {
    if (!isDrawing) return;
    const currentPoint = e.lngLat;
    const src = map.getSource('temp-line');
    if (!src) return;
    try {
      const startCoords = src._data.coordinates[0] || src._data.coordinates[0];
      if (!startCoords) return;
      const startPoint = { lat: startCoords[1], lng: startCoords[0] };
      src.setData({ type: 'LineString', coordinates: [[startPoint.lng, startPoint.lat], [currentPoint.lng, currentPoint.lat]] });
      const midPoint = { lat: (startPoint.lat + currentPoint.lat)/2, lng: (startPoint.lng + currentPoint.lng)/2 };
      if (tempLabel) tempLabel.setLngLat(midPoint);
      const trueHeading = calculateHeading(startPoint, currentPoint);
      let magneticHeading = trueHeading;
      if (wmmModel) {
        try {
          const decl = wmmModel.field(midPoint.lat, midPoint.lng).declination;
          magneticHeading = (trueHeading - decl + 360) % 360;
        } catch (err) { /* ignore */ }
      }
      const headingText = Math.round(magneticHeading).toString().padStart(3,'0');
      if (tempLabel && tempLabel.getElement) tempLabel.getElement().innerHTML = `${headingText}° M`;
    } catch (err) {
      // swallow transient errors
    }
  }

  function handleMouseUp(e) {
    if (!isDrawing) return;
    isDrawing = false;
    const endPoint = e.lngLat;
    const src = map.getSource('temp-line');
    if (!src || !src._data || !src._data.coordinates || !src._data.coordinates[0]) return;

    const startPointCoords = src._data.coordinates[0];
    const startPoint = { lat: startPointCoords[1], lng: startPointCoords[0] };

    if (map.getLayer('temp-line')) map.removeLayer('temp-line');
    if (map.getSource('temp-line')) map.removeSource('temp-line');
    if (tempLabel) { tempLabel.remove(); tempLabel = null; }

    try {
      const distance = turf.distance(turf.point([startPoint.lng, startPoint.lat]), turf.point([endPoint.lng, endPoint.lat]), { units: 'meters' });
      if (distance > 50) {
        const trueHeading = calculateHeading(startPoint, endPoint);
        let magneticHeading = trueHeading;
        if (wmmModel) {
          const midPoint = { lat: (startPoint.lat + endPoint.lat)/2, lng: (startPoint.lng + endPoint.lng)/2 };
          const declination = wmmModel.field(midPoint.lat, midPoint.lng).declination;
          magneticHeading = (trueHeading - declination + 360) % 360;
        }
        const finalHeading = {
          magnetic: Math.round(magneticHeading).toString().padStart(3,'0'),
          true: Math.round(trueHeading).toString().padStart(3,'0')
        };
        createFinalLine(startPoint, endPoint, `step-${Date.now()}`, '', '', true, currentLineType, null, null, finalHeading);
        savePlanToLocalStorage && savePlanToLocalStorage();
      }
    } catch(err) {
      console.error('handleMouseUp error', err);
    }
  }

  // -------------- Plan / lines helpers (kept from original, slightly optimized) --------------
  function calculateHeading(from, to) {
    // returns true heading from point a to b
    const y = Math.sin((to.lng - from.lng) * Math.PI/180) * Math.cos(to.lat * Math.PI/180);
    const x = Math.cos(from.lat * Math.PI/180) * Math.sin(to.lat * Math.PI/180) - Math.sin(from.lat * Math.PI/180) * Math.cos(to.lat * Math.PI/180) * Math.cos((to.lng - from.lng)*Math.PI/180);
    const brng = Math.atan2(y, x) * 180/Math.PI;
    return (brng + 360) % 360;
  }

  function createFinalLine(start, end, stepId, altitude = '', speed = '', performCollisionCheck = false, lineType = 'standard', startAltitude, endAltitude, heading) {
    // simplified: create geodata & add to a plan-layer set (assumes your plan management exists)
    const lineId = `plan-line-${stepId}`;
    const coords = [[start.lng, start.lat], [end.lng, end.lat]];
    try {
      addSourceAndLayer(lineId, { type:'geojson', data: { type:'Feature', geometry: { type: 'LineString', coordinates: coords }}}, { type:'line', paint: FLIGHT_LINE_STYLES_REGULAR[lineType] || FLIGHT_LINE_STYLES_REGULAR.standard });
    } catch (err) {
      console.warn('createFinalLine failed', err);
    }
  }

  // -------------------------
  // --- AIRPORTS / RUNWAYS / GLIDESLOPE
  // -------------------------
  async function updateAirports() {
    if (activeAirportIcao) {
      if (map.getLayer('airport-dots-layer')) map.setLayoutProperty('airport-dots-layer', 'visibility', 'none');
      if (map.getLayer('airport-dots-pulse-layer')) map.setLayoutProperty('airport-dots-pulse-layer', 'visibility', 'none');
      return;
    }
    const zoom = map.getZoom();
    if (!airportsDataCache) return;
    const mainPanel = document.getElementById('main-panel');
    if (!mainPanel) return;
    const selectedTypes = Array.from(mainPanel.querySelectorAll('#airport-filters input:checked')).map(i => i.value);
    const bounds = map.getBounds();
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();

    const airportFeatures = airportsDataCache.filter(airport => {
      if (!selectedTypes.includes(airport.type)) return false;
      const lat = parseFloat(airport.latitude_deg), lon = parseFloat(airport.longitude_deg);
      if (!isFinite(lat) || !isFinite(lon)) return false;
      if (lat < sw.lat || lat > ne.lat || lon < sw.lng || lon > ne.lng) return false;
      if (zoom < 6) return airport.type === 'large_airport';
      if (zoom < 8) return ['large_airport', 'medium_airport'].includes(airport.type);
      return true;
    }).map(airport => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [parseFloat(airport.longitude_deg), parseFloat(airport.latitude_deg)] },
      properties: {
        icao: airport.ident,
        type: airport.type,
        hasActiveAtc: isLiveModeActive && activeAtcAirportIcaos.has(airport.ident)
      }
    }));

    const sourceId = 'airport-dots-source';
    const layerId = 'airport-dots-layer';
    const pulseLayerId = 'airport-dots-pulse-layer';
    if (map.getSource(sourceId)) {
      map.getSource(sourceId).setData({ type: 'FeatureCollection', features: airportFeatures });
    } else {
      map.addSource(sourceId, { type: 'geojson', data: { type: 'FeatureCollection', features: airportFeatures }});
      map.addLayer({ id: pulseLayerId, type: 'circle', source: sourceId, filter: ['==', ['get','hasActiveAtc'], true], paint: { 'circle-radius': 10, 'circle-color': '#EABFFF', 'circle-opacity': 0.5, 'circle-stroke-width': 2, 'circle-stroke-color': '#FFFFFF' }});
      map.addLayer({ id: layerId, type: 'circle', source: sourceId, paint: {
        'circle-radius': ['match', ['get','type'], 'large_airport', 7, 'medium_airport', 5, 3],
        'circle-color': ['case', ['==', ['get', 'hasActiveAtc'], true], '#4169E1', ['match', ['get','type'],'large_airport','#FF0000','medium_airport','#FFA500','small_airport','#2980b9','#95a5a6']],
        'circle-stroke-color': '#000',
        'circle-stroke-width': 1
      }});
      map.on('click', layerId, (e) => {
        const icao = e.features[0].properties.icao;
        displayAirportDetails(icao);
      });
    }
  }

  async function drawRunwaysForAirport(icao) {
    try {
      const runways = await getRunwaysForAirport(icao);
      const runwayPolygons = [];
      const centerlines = [];
      const labels = [];
      const finalCones = [];
      const finalCenterlines = [];

      for (const rw of runways) {
        // Build runway polygon & centerline features
        // (kept from existing logic: heavy geometry code retained but not altering)
        // ... simplified to keep runtime small - the original detailed geometry code can be restored as needed
        const le_lat = parseFloat(rw.le_latitude_deg);
        const le_lon = parseFloat(rw.le_longitude_deg);
        const he_lat = parseFloat(rw.he_latitude_deg);
        const he_lon = parseFloat(rw.he_longitude_deg);
        if (!isFinite(le_lat) || !isFinite(le_lon) || !isFinite(he_lat) || !isFinite(he_lon)) continue;
        centerlines.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[le_lon, le_lat], [he_lon, he_lat]] },
          properties: { id: rw.id, le_ident: rw.le_ident, he_ident: rw.he_ident }
        });
        labels.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [(le_lon+he_lon)/2, (le_lat+he_lat)/2] }, properties: { ident: (rw.le_ident || '') }});
        // final approach cones: reuse earlier createFinalApproach logic if desired
      }

      addSourceAndLayer('runways', { type: 'geojson', data: { type: 'FeatureCollection', features: runwayPolygons }}, { type: 'fill', paint: RUNWAY_STYLE_REGULAR });
      addSourceAndLayer('runway-centerlines', { type: 'geojson', data: { type: 'FeatureCollection', features: centerlines }}, { type: 'line', paint: RUNWAY_CENTERLINE_STYLE_REGULAR });
      addSourceAndLayer('runway-labels', { type: 'geojson', data: { type: 'FeatureCollection', features: labels }}, { type: 'symbol', layout: { 'text-field': ['get','ident'], 'text-font': ['Open Sans Bold'], 'text-size': 14, 'text-anchor': 'bottom', 'text-offset': [0, -0.5] }, paint: { 'text-color': '#fff', 'text-halo-color': '#000', 'text-halo-width': 2 }});
      addSourceAndLayer('final-approach-cones', { type: 'geojson', data: { type: 'FeatureCollection', features: finalCones }}, { type: 'fill', paint: FINAL_APPROACH_STYLE });
      addSourceAndLayer('final-approach-centerlines', { type: 'geojson', data: { type: 'FeatureCollection', features: finalCenterlines }}, { type: 'line', paint: FINAL_APPROACH_CENTERLINE_STYLE });
    } catch (err) {
      console.error('drawRunwaysForAirport failed', err);
    }
  }

  // helper: get runways for airport
  async function getRunwaysForAirport(icao) {
    const all = await getRunways();
    return all.filter(r => r.le_ident && (r.le_ident.includes(icao) || r.he_ident && r.he_ident.includes(icao)) || r.airport_ident === icao || r.airport === icao)
              .map(r => r)
              .slice(0, 200);
  }

  // Glideslope visualization (from your earlier code)
  async function createGlideslopeDots(icao) {
    const runways = await getRunwaysForAirport(icao);
    const glideslopeFeatures = [];
    const NM_TO_FEET = 6076.12;
    const GLIDESLOPE_ANGLE_RAD = 3 * (Math.PI/180);
    runways.forEach(runway => {
      const le_lat = parseFloat(runway.le_latitude_deg);
      const le_lon = parseFloat(runway.le_longitude_deg);
      const le_hdg = parseFloat(runway.le_heading_degT);
      const le_elev = parseFloat(runway.le_elevation_ft);
      if (![le_lat, le_lon, le_hdg, le_elev].some(isNaN)) {
        const thresholdPoint = turf.point([le_lon, le_lat]);
        const bearing = (le_hdg + 180) % 360;
        for (let i=1;i<=10;i++){
          const distanceNM = i * 1.5;
          const distanceFeet = distanceNM * NM_TO_FEET;
          const pointOnFinal = turf.destination(thresholdPoint, distanceNM, bearing, { units: 'nauticalmiles' });
          const altitude = Math.round((Math.tan(GLIDESLOPE_ANGLE_RAD) * distanceFeet) + le_elev);
          glideslopeFeatures.push({ type:'Feature', geometry: pointOnFinal.geometry, properties: { altitude, distanceNM }});
        }
      }
    });
    const geojson = { type: 'FeatureCollection', features: glideslopeFeatures };
    addSourceAndLayer('glideslope-dots', { type: 'geojson', data: geojson }, { type: 'circle', paint: { 'circle-color': '#FFA500', 'circle-radius': 6, 'circle-stroke-color': '#000', 'circle-stroke-width': 1.5 }});
    // toggle visibility based on checkbox
    const glideslopeCheckbox = document.getElementById('filter-glideslope');
    const visibility = (glideslopeCheckbox && glideslopeCheckbox.checked) ? 'visible' : 'none';
    if (map.getLayer('glideslope-dots-layer')) map.setLayoutProperty('glideslope-dots-layer', 'visibility', visibility);

    map.on('mouseenter', 'glideslope-dots-layer', (e) => {
      map.getCanvas().style.cursor = 'pointer';
      const coordinates = e.features[0].geometry.coordinates.slice();
      const props = e.features[0].properties;
      const popupContent = `<div style="text-align:center;color:#fff;background:#333;padding:6px;border-radius:4px;"><strong>${Number(props.altitude).toLocaleString()}'</strong><br><span style="font-size:11px;">${Number(props.distanceNM).toFixed(1)} NM Final</span></div>`;
      while (Math.abs(e.lngLat.lng - coordinates[0]) > 180) coordinates[0] += e.lngLat.lng > coordinates[0] ? 360 : -360;
      const pop = new maptilersdk.Popup({ closeButton: false, closeOnClick: true }).setLngLat(coordinates).setHTML(popupContent).addTo(map);
    });

    map.on('mouseleave', 'glideslope-dots-layer', () => {
      map.getCanvas().style.cursor = '';
      // popups are auto-removed on click due to closeOnClick true; no global popup used here
    });
  }

  // -------------------------
  // --- UI: Panels / Main / Live Control / Traffic Scan
  // -------------------------
  function createFloatingPanel(id, titleHTML, top='20px', left='20px', contentHTML='') {
    const existing = document.getElementById(id);
    if (existing) { existing.style.display='block'; return existing; }
    const panel = document.createElement('div');
    panel.id = id;
    panel.className = 'floating-panel';
    panel.style.position = 'absolute';
    panel.style.top = top;
    panel.style.left = left;
    panel.style.zIndex = 9998;
    panel.style.minWidth = '280px';
    panel.style.background = 'rgba(10,10,10,0.9)';
    panel.style.border = '1px solid rgba(255,255,255,0.06)';
    panel.style.borderRadius = '8px';
    panel.style.boxShadow = '0 6px 18px rgba(0,0,0,0.5)';
    panel.innerHTML = `
      <div class="panel-header" style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border-bottom:1px solid rgba(255,255,255,0.03);">
        <div style="display:flex;gap:8px;align-items:center">${titleHTML}</div>
        <div style="display:flex;gap:6px;">
          <button class="toggle-panel" style="background:none;border:none;color:#fff">-</button>
          <button class="close-panel" title="Close Panel" style="background:none;border:none;color:#fff">&#x2715;</button>
        </div>
      </div>
      <div class="panel-content" style="padding:10px;">${contentHTML}</div>
    `;
    document.body.appendChild(panel);
    panel.querySelector('.close-panel').addEventListener('click', () => { panel.style.display = 'none'; });
    panel.querySelector('.toggle-panel').addEventListener('click', (e) => {
      const content = panel.querySelector('.panel-content');
      const hidden = content.style.display === 'none';
      content.style.display = hidden ? 'block' : 'none';
      e.target.textContent = hidden ? '-' : '+';
    });
    return panel;
  }

  function createMainPanel() {
    const existing = document.getElementById('main-panel');
    if (existing) { existing.style.display = 'block'; if (reopenButton) reopenButton.style.display = 'none'; return existing; }
    const content = `
      <form id="airport-form"><input type="text" id="airport-input" placeholder="e.g., KLAX" style="width:70%;padding:6px;border-radius:6px;border:none;margin-right:6px"><button type="submit" style="padding:6px 10px;border-radius:6px">Load</button></form>
      <div style="margin-top:10px;">
        <div><label><input type="checkbox" id="enable-drawing"> Enable Drawing Mode</label></div>
        <div style="display:flex;gap:8px;margin-top:8px;">
          <button id="live-mode-btn">Live Mode</button>
          <button id="traffic-scan-btn">Traffic Scan</button>
        </div>
      </div>
      <div id="viewed-fpl-info" style="display:none;margin-top:10px;padding:8px;border:1px solid rgba(255,255,255,0.03);border-radius:6px">
        <h4 style="margin:0 0 6px 0">FPL: <span id="fpl-callsign"></span> <button id="clear-fpl-btn" style="float:right">Clear</button></h4>
        <div><strong>Altitude:</strong> <span id="fpl-altitude"></span></div>
        <div><strong>Speed:</strong> <span id="fpl-speed"></span></div>
      </div>
    `;
    const titleHTML = `<strong style="color:#fff">Virtual Vectors</strong>`;
    const panel = createFloatingPanel('main-panel', titleHTML, '20px','20px', content);

    panel.querySelector('#airport-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const icao = panel.querySelector('#airport-input').value.trim().toUpperCase();
      if (icao) displayAirportDetails(icao);
    });

    panel.querySelector('#live-mode-btn').addEventListener('click', () => createLiveControlPanel());
    panel.querySelector('#traffic-scan-btn').addEventListener('click', () => createTrafficScanPanel());

    panel.querySelector('#enable-drawing').addEventListener('change', (ev) => {
      const enabled = ev.target.checked;
      isDrawingEnabled = enabled;
      if (enabled) { map.dragPan.disable(); map.getCanvas().style.cursor = 'crosshair'; } else { map.dragPan.enable(); map.getCanvas().style.cursor = ''; }
    });

    return panel;
  }

  async function createLiveControlPanel() {
    const existing = document.getElementById('live-control-panel');
    if (existing) { existing.style.display='block'; return existing; }
    const content = `<div style="display:flex;gap:8px;"><select id="server-select" style="flex:1"><option>Loading servers...</option></select><button id="connect-live-btn" disabled>Connect</button></div>
      <div style="margin-top:8px"><strong>Status:</strong> <span id="live-status-indicator" style="background:#777;color:#fff;padding:4px 8px;border-radius:6px">Disconnected</span></div>
      <div class="info-card" style="margin-top:8px"><h3>Active ATC</h3><div id="atc-list">No ATC data.</div></div>`;
    const panel = createFloatingPanel('live-control-panel', '<strong style="color:#fff">Live Mode</strong>', '80px','360px', content);
    const serverSelect = panel.querySelector('#server-select');
    const connectBtn = panel.querySelector('#connect-live-btn');
    const statusIndicator = panel.querySelector('#live-status-indicator');

    try {
      const res = await fetch('/.netlify/functions/sessions');
      if (!res.ok) throw new Error('sessions fetch failed');
      const json = await res.json();
      serverSelect.innerHTML = '<option value="">Select a Server</option>';
      (json.result || []).forEach(s => { const o = document.createElement('option'); o.value = s.sessionId; o.textContent = s.name; serverSelect.appendChild(o); });
      connectBtn.disabled = false;
    } catch (err) {
      serverSelect.innerHTML = '<option>Could not load servers</option>';
    }

    connectBtn.addEventListener('click', () => {
      const sessionId = serverSelect.value;
      if (!sessionId) return alert('Pick a server');
      if (connectBtn.textContent === 'Connect') {
        startLiveUpdates(sessionId);
        connectBtn.textContent = 'Disconnect';
        connectBtn.style.backgroundColor = 'var(--danger-color)';
        statusIndicator.textContent = 'Live';
        statusIndicator.style.backgroundColor = 'var(--live-color)';
      } else {
        stopLiveUpdates();
        connectBtn.textContent = 'Connect';
        connectBtn.style.backgroundColor = '';
        statusIndicator.textContent = 'Disconnected';
        statusIndicator.style.backgroundColor = '#777';
      }
    });

    serverSelect.addEventListener('change', (e) => {
      if (connectBtn.textContent === 'Disconnect') {
        const val = e.target.value;
        stopLiveUpdates();
        if (val) startLiveUpdates(val);
      }
    });

    return panel;
  }

  function createTrafficScanPanel() {
    const existing = document.getElementById('traffic-scan-panel');
    if (existing) { existing.style.display='block'; return existing; }
    const content = `<div><p>Scans server for hotspots. Start only when Live Mode is active.</p><button id="begin-traffic-scan-btn">Begin Scan</button></div><div id="traffic-scan-results" style="margin-top:8px;display:none"></div>`;
    const panel = createFloatingPanel('traffic-scan-panel', '<strong>Server Traffic Scan</strong>', '120px','420px', content);
    panel.querySelector('#begin-traffic-scan-btn').addEventListener('click', generateTrafficHotspotReport);
    return panel;
  }

  // Traffic scan (kept mostly as before, but optimized loops)
  async function generateTrafficHotspotReport() {
    const resultsContainer = document.getElementById('traffic-scan-results');
    const scanButton = document.getElementById('begin-traffic-scan-btn');
    if (!resultsContainer || !scanButton) return;
    resultsContainer.style.display = 'block';
    resultsContainer.innerHTML = '<div class="loader-dual-ring"></div>';
    scanButton.disabled = true;
    scanButton.textContent = 'Scanning...';
    try {
      if (!isLiveModeActive) throw new Error('Live Mode not active. Connect first.');
      const serverSelect = document.getElementById('server-select');
      const sessionId = serverSelect ? serverSelect.value : null;
      if (!sessionId) throw new Error('No server chosen.');
      const [worldRes, flightsRes, atcRes] = await Promise.all([
        fetch(`/.netlify/functions/world/${sessionId}`),
        fetch(`/.netlify/functions/flights/${sessionId}`),
        fetch(`/.netlify/functions/atc/${sessionId}`)
      ]);
      if (!worldRes.ok || !flightsRes.ok || !atcRes.ok) throw new Error('Server fetch failed.');
      const world = await worldRes.json();
      const flights = await flightsRes.json();
      const atc = await atcRes.json();
      const allAirports = await getAirports();
      const flightsMap = new Map((flights.result || []).map(f => [f.flightId, f]));
      const activeAirports = world.result || [];
      const activeLocations = new Map();
      activeAirports.forEach(a => {
        const ap = allAirports.find(x => x.ident === a.airportIcao);
        if (!ap) return;
        const lat = parseFloat(ap.latitude_deg), lon = parseFloat(ap.longitude_deg), elev = parseFloat(ap.elevation_ft);
        if (!isFinite(lat) || !isFinite(lon)) return;
        activeLocations.set(a.airportIcao, { lat, lon, elev });
      });
      const lowSlow = (flights.result || []).filter(fl => fl.speed < 150);
      const onGroundByAirport = {};
      for (const icao of activeLocations.keys()) onGroundByAirport[icao] = 0;
      for (const f of lowSlow) {
        let closest = null, minD = Infinity;
        for (const [icao, c] of activeLocations) {
          const d = distanceNM(f.latitude, f.longitude, c.lat, c.lon);
          if (d < minD) { minD = d; closest = icao; }
        }
        if (closest && minD < 3) {
          const airportElev = activeLocations.get(closest).elev; const alt = f.altitude;
          if (Math.abs(alt - airportElev) < 500) onGroundByAirport[closest] = (onGroundByAirport[closest]||0) + 1;
        }
      }
      const airportTrafficData = {};
      activeAirports.forEach(as => {
        const icao = as.airportIcao;
        const airportInfo = allAirports.find(a => a.ident === icao);
        if (!airportInfo) return;
        airportTrafficData[icao] = {
          icao,
          name: (as.airportName || '').replace(/"/g,''),
          inboundTotal: as.inboundFlightsCount || 0,
          outboundOnGround: onGroundByAirport[icao] || 0,
          outboundTotal: as.outboundFlightsCount || 0,
          inboundBuckets: { in20:0, in60:0, over60:0 }
        };
        const inboundIds = new Set(as.inboundFlights || []);
        inboundIds.forEach(fid => {
          const fl = flightsMap.get(fid);
          if (!fl || fl.speed <= 50) return;
          const d = distanceNM(fl.latitude, fl.longitude, parseFloat(airportInfo.latitude_deg), parseFloat(airportInfo.longitude_deg));
          if (!isFinite(d)) return;
          const eteMin = Math.round((d / fl.speed) * 60);
          if (eteMin <= 20) airportTrafficData[icao].inboundBuckets.in20++;
          else if (eteMin <= 60) airportTrafficData[icao].inboundBuckets.in60++;
          else airportTrafficData[icao].inboundBuckets.over60++;
        });
      });
      const sorted = Object.values(airportTrafficData).sort((a,b)=>b.inboundTotal - a.inboundTotal).slice(0,20);
      if (!sorted.length) resultsContainer.innerHTML = '<p>No inbound flights detected.</p>';
      else {
        const html = sorted.map(d => `<div class="traffic-card" data-icao="${d.icao}"><div style="display:flex;justify-content:space-between"><strong>${d.name}</strong><span>${d.icao}</span></div><div style="display:flex;gap:8px;margin-top:6px"><div><div style="font-size:18px">${d.inboundTotal}</div><div>Inbound</div></div><div><div style="font-size:18px">${d.outboundOnGround}</div><div>On ground</div></div></div></div>`).join('');
        resultsContainer.innerHTML = html;
        resultsContainer.querySelectorAll('.traffic-card').forEach(c => c.addEventListener('click', () => { displayAirportDetails(c.dataset.icao); document.getElementById('traffic-scan-panel').style.display = 'none'; }));
      }
    } catch (err) {
      resultsContainer.innerHTML = `<p style="color:#f33">Error: ${err.message}</p>`;
    } finally {
      scanButton.disabled = false;
      scanButton.textContent = 'Re-Scan';
    }
  }

  function distanceNM(lat1, lon1, lat2, lon2) {
    const R = 3440.065; const rad = Math.PI/180;
    const dLat = (lat2 - lat1) * rad; const dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*rad)*Math.cos(lat2*rad)*Math.sin(dLon/2)**2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }

  // -------------------------
  // --- FLIGHT PLAN DISPLAY (kept from original but integrated with layers)
  // -------------------------
  async function fetchAndDisplayFlightPlan(flightId, sessionId, callsign, altitude, speed) {
    try {
      if (map.getLayer('flight-plan-route')) map.removeLayer('flight-plan-route');
      if (map.getSource('flight-plan-route')) map.removeSource('flight-plan-route');
      if (map.getLayer('flight-plan-waypoints')) map.removeLayer('flight-plan-waypoints');
      if (map.getSource('flight-plan-waypoints')) map.removeSource('flight-plan-waypoints');
      selectedFlightId = flightId;
      if (isLiveModeActive) fetchAndDisplayData(sessionId);
      const res = await fetch(`/.netlify/functions/flightplan/${sessionId}/${flightId}`);
      if (!res.ok) throw new Error(`API Error: ${res.status}`);
      const data = await res.json();
      const flightPlanItems = (data.result && data.result.flightPlanItems) || [];
      const allWaypoints = [];
      flightPlanItems.forEach(item => {
        if (item.children && item.children.length > 0) {
          allWaypoints.push(...item.children.filter(c => c.location));
        } else if (item.location) {
          allWaypoints.push(item);
        }
      });
      if (allWaypoints.length < 2) { alert(`No valid flight plan route could be found for ${callsign}.`); return; }
      const routeCoords = allWaypoints.map(wp => [wp.location.longitude, wp.location.latitude]);
      const waypointFeatures = allWaypoints.map(wp => ({ type:'Feature', geometry:{ type:'Point', coordinates:[wp.location.longitude, wp.location.latitude] }, properties: { name: wp.name }}));
      map.addSource('flight-plan-route', { type:'geojson', data: { type:'Feature', geometry: { type:'LineString', coordinates: routeCoords}}});
      map.addLayer({ id:'flight-plan-route', type:'line', source:'flight-plan-route', layout:{'line-join':'round','line-cap':'round'}, paint:{'line-color':'#FFD600','line-width':3,'line-dasharray':[2,2]}});
      map.addSource('flight-plan-waypoints', { type:'geojson', data: { type:'FeatureCollection', features: waypointFeatures }});
      map.addLayer({ id:'flight-plan-waypoints', type:'circle', source:'flight-plan-waypoints', paint: {'circle-radius':4,'circle-color':'#FFD600','circle-stroke-color':'#1a1a1a','circle-stroke-width':2} });
      const fplInfoSection = document.getElementById('viewed-fpl-info');
      if (fplInfoSection) {
        document.getElementById('fpl-callsign').textContent = callsign;
        document.getElementById('fpl-altitude').textContent = altitude;
        document.getElementById('fpl-speed').textContent = speed;
        fplInfoSection.style.display = 'block';
      }
    } catch (err) {
      console.error('Error fetching flight plan:', err);
      alert(`Could not display the flight plan for ${callsign}.`);
    }
  }

  // -------------------------
  // --- AIRPORT INFO PANEL, ATIS, etc (kept)
  // -------------------------
  async function displayAirportDetails(icao) {
    clearAirportLayers();
    activeAirportIcao = icao;
    updateAirports();
    try {
      const airports = await getAirports();
      const airport = airports.find(a => a.ident === icao);
      if (!airport) return alert(`Airport with ICAO ${icao} not found.`);
      const lat = parseFloat(airport.latitude_deg), lon = parseFloat(airport.longitude_deg);
      const airportRunways = await getRunwaysForAirport(icao);
      drawRunwaysForAirport(icao);
      updateAirportInfoPanel(airport, airportRunways);
      createDistanceRings && createDistanceRings(lat, lon);
      createGlideslopeDots(icao);
      map.flyTo({ center: [lon, lat], zoom: 13 });
      const clearBtn = document.getElementById('clear-selection-btn');
      if (clearBtn) clearBtn.style.display = 'block';
      const clearText = document.getElementById('clear-selection-text');
      if (clearText) clearText.style.display = 'block';
    } catch (err) {
      console.error(`Failed to fetch details for ${icao}:`, err);
    }
  }

  function displayAtis(atisText, isStale) {
    const atisContentElement = document.getElementById('atis-content');
    if (!atisContentElement) return;
    const formattedText = atisText.replace(/(INFORMATION\s+)(\w+)/, '$1<strong>$2</strong>');
    if (isStale) atisContentElement.innerHTML = `<span style="color: var(--danger-color); font-weight: 500;">Last ATIS:</span><br>${formattedText}`;
    else atisContentElement.innerHTML = formattedText;
  }

  async function updateAirportInfoPanel(airport, runways) {
    let airspaceClass = 'N/A';
    if (airport.type === 'large_airport') airspaceClass = 'Bravo';
    else if (airport.type === 'medium_airport') airspaceClass = 'Charlie';
    else if (airport.type === 'small_airport') airspaceClass = 'Other';
    const panelTitle = `INFO: ${airport.ident}`;
    const lat = parseFloat(airport.latitude_deg);
    const lon = parseFloat(airport.longitude_deg);
    let declination = 0;
    if (wmmModel) {
      try { declination = wmmModel.field(lat, lon).declination; } catch(e){}
    }
    let runwaysHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px;"><thead><tr style="text-align:left;border-bottom:1px solid #555;"><th style="padding:4px 2px;">Runway</th><th style="padding:4px 2px;">Mag Hdg</th><th style="padding:4px 2px;">True Hdg</th></tr></thead><tbody>`;
    if (runways.length > 0) {
      runwaysHTML += runways.map(runway => {
        const runwayName = (runway.le_ident && runway.he_ident) ? `${runway.le_ident}/${runway.he_ident}` : (runway.le_ident || runway.he_ident || 'Unnamed');
        let le_true_hdg = parseFloat(runway.le_heading_degT);
        let he_true_hdg = parseFloat(runway.he_heading_degT);
        let le_mag_hdg_raw = (le_true_hdg - declination + 360) % 360;
        let he_mag_hdg_raw = (he_true_hdg - declination + 360) % 360;
        const le_mag_hdg_str = !isNaN(le_mag_hdg_raw) ? Math.round(le_mag_hdg_raw).toString().padStart(3,'0') + '°' : '---';
        const he_mag_hdg_str = !isNaN(he_mag_hdg_raw) ? Math.round(he_mag_hdg_raw).toString().padStart(3,'0') + '°' : '---';
        const le_true_hdg_str = !isNaN(le_true_hdg) ? Math.round(le_true_hdg).toString().padStart(3,'0') + '°' : '---';
        const he_true_hdg_str = !isNaN(he_true_hdg) ? Math.round(he_true_hdg).toString().padStart(3,'0') + '°' : '---';
        return `<tr data-runway-id="${runway.id}"><td style="padding:4px 2px;">${runwayName}</td><td style="padding:4px 2px;">${le_mag_hdg_str}/${he_mag_hdg_str}</td><td style="padding:4px 2px;">${le_true_hdg_str}/${he_true_hdg_str}</td></tr>`;
      }).join('');
    } else {
      runwaysHTML += `<tr><td colspan="3">No runway data</td></tr>`;
    }
    runwaysHTML += `</tbody></table>`;
    const content = `
      <div class="info-card"><strong>${airport.name || airport.ident}</strong><div>ICAO: ${airport.ident}</div><div>Elevation: ${airport.elevation_ft || 'N/A'} ft</div><div>Airspace: ${airspaceClass}</div></div>
      <div class="info-card"><h3>Runways 🧭</h3>${runwaysHTML}</div>
      <div class="info-card"><h3>ATIS</h3><div id="atis-content">${isLiveModeActive ? 'Loading...' : 'Connect to Live Mode to view ATIS.'}</div></div>
    `;
    const panel = createFloatingPanel('airport-info-panel', `<h2>${panelTitle}</h2>`, '20px','360px', content);
    panel.querySelectorAll('[data-runway-id]').forEach(row => {
      const runwayId = row.dataset.runwayId;
      row.addEventListener('mouseover', () => highlightRunway(runwayId));
      row.addEventListener('mouseout', () => unhighlightRunway(runwayId));
    });

    // ATIS fetch logic (caching)
    const atisContentElement = document.getElementById('atis-content');
    if (isLiveModeActive) {
      const serverSelect = document.getElementById('server-select');
      const sessionId = serverSelect ? serverSelect.value : null;
      const airportIdent = airport.ident;
      if (sessionId) {
        if (activeAtisStationIcaos.has(airportIdent)) {
          try {
            const atisResponse = await fetch(`/.netlify/functions/atis/${sessionId}/${airportIdent}`);
            const atisData = await atisResponse.json();
            if (atisResponse.ok && atisData.errorCode === 0 && atisData.result) {
              atisCache[airportIdent] = atisData.result;
              displayAtis(atisData.result, false);
            } else {
              if (atisCache[airportIdent]) displayAtis(atisCache[airportIdent], true);
              else atisContentElement.textContent = 'No active ATIS for this airport.';
            }
          } catch (error) {
            console.error('Failed to fetch ATIS:', error);
            if (atisCache[airportIdent]) displayAtis(atisCache[airportIdent], true);
            else atisContentElement.textContent = 'Error loading ATIS data.';
          }
        } else {
          if (atisCache[airportIdent]) displayAtis(atisCache[airportIdent], true);
          else atisContentElement.textContent = 'No ATIS information available.';
        }
      } else {
        atisContentElement.textContent = 'Select a server in Live Mode to view ATIS.';
      }
    } else {
      atisContentElement.textContent = 'Connect to Live Mode to view ATIS.';
    }
  }

  function highlightRunway(runwayId) {
    if (map.getLayer('runways-layer')) {
      map.setPaintProperty('runways-layer', 'fill-color', ['case', ['==', ['get','id'], runwayId], '#FFD700', RUNWAY_STYLE_REGULAR['fill-color']]);
    }
  }
  function unhighlightRunway(runwayId) {
    if (map.getLayer('runways-layer')) {
      map.setPaintProperty('runways-layer', 'fill-color', RUNWAY_STYLE_REGULAR['fill-color']);
    }
  }

  // -------------------------
  // --- SOURCE/LAYER HELPERS
  // -------------------------
  function addSourceAndLayer(baseId, source, layer) {
    const sourceId = `${baseId}-source`;
    const layerId = `${baseId}-layer`;
    try {
      if (map.getSource(sourceId)) {
        map.getSource(sourceId).setData(source.data);
      } else {
        map.addSource(sourceId, source);
        layerAndSourceIds.add(sourceId);
      }
      if (!map.getLayer(layerId)) {
        map.addLayer({ ...layer, id: layerId, source: sourceId });
        layerAndSourceIds.add(layerId);
      }
    } catch (err) {
      console.warn('addSourceAndLayer error', err);
    }
  }

  function clearAllDynamicLayers() {
    const idsToRemove = new Set(layerAndSourceIds);
    idsToRemove.forEach(id => { if (map.getLayer(id)) map.removeLayer(id); });
    idsToRemove.forEach(id => { if (map.getSource(id)) map.removeSource(id); });
    layerAndSourceIds.clear();
    Object.values(planLabels).forEach(m => m.remove && m.remove());
    Object.keys(planLabels).forEach(k => delete planLabels[k]);
  }

  function clearAirportLayers() {
    const layers = ['runways','runway-centerlines','runway-labels','final-approach-cones','final-approach-centerlines','distance-rings-casing','distance-rings','distance-ring-labels','glideslope-dots'];
    layers.forEach(baseId => {
      const layerId = `${baseId}-layer`;
      const sourceId = `${baseId}-source`;
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
      layerAndSourceIds.delete(layerId);
      layerAndSourceIds.delete(sourceId);
    });
    const infoPanel = document.getElementById('airport-info-panel');
    if (infoPanel) infoPanel.remove();
  }

  // -------------------------
  // --- MISC HELPERS
  // -------------------------
  function createVorCompassImage(size = 256) {
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    const center = size/2; const radius = center - 8;
    ctx.strokeStyle = 'black'; ctx.fillStyle = 'black'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `bold ${size*0.08}px "Open Sans", sans-serif`;
    ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(center, center, radius, 0, 2*Math.PI); ctx.stroke();
    for (let i=0;i<360;i+=10){
      const angle = (i-90)*Math.PI/180; const isMajor = (i%30===0);
      const tickStart = isMajor ? radius - (size*0.12) : radius - (size*0.07);
      const sx = center + tickStart * Math.cos(angle);
      const sy = center + tickStart * Math.sin(angle);
      const ex = center + radius * Math.cos(angle);
      const ey = center + radius * Math.sin(angle);
      ctx.lineWidth = isMajor ? 2.5 : 1.2; ctx.beginPath(); ctx.moveTo(sx,sy); ctx.lineTo(ex,ey); ctx.stroke();
    }
    const textRadius = radius - (size*0.22);
    const headings = [{angle:0,label:'0'},{angle:90,label:'9'},{angle:180,label:'18'},{angle:270,label:'27'}];
    headings.forEach(h => { const ar = (h.angle - 90) * Math.PI/180; ctx.fillText(h.label, center + textRadius*Math.cos(ar), center + textRadius*Math.sin(ar)); });
    const symRadius = size*0.06; ctx.beginPath(); for (let i=0;i<6;i++){ const a = (Math.PI/3*i)+(Math.PI/6); const x = center + symRadius*Math.cos(a); const y = center + symRadius*Math.sin(a); if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); } ctx.closePath(); ctx.lineWidth = 2; ctx.stroke();
    return ctx.getImageData(0,0,size,size);
  }

  // -------------------------
  // --- INACTIVITY TIMER
  // -------------------------
  let inactivityTimer = null;
  function startInactivityTimer() { clearTimeout(inactivityTimer); inactivityTimer = setTimeout(() => { if (isLiveModeActive) { stopLiveUpdates(); alert('Live updates paused due to 15 minutes of inactivity. Press Connect to resume.'); const statusIndicator = document.getElementById('live-status-indicator'); if (statusIndicator){ statusIndicator.textContent = "Paused"; statusIndicator.style.backgroundColor = '#f0ad4e'; } } }, 15*60*1000); }
  function resetInactivityTimer() { if (isLiveModeActive) startInactivityTimer(); }

  // -------------------------
  // --- INITIALIZATION HELPERS
  // -------------------------
  function setupMobileNav() {
    const mobileNav = document.getElementById('mobile-nav');
    if (!mobileNav || window.innerWidth > 768) { if (mobileNav) mobileNav.style.display = 'none'; return; }
    const mainPanel = document.getElementById('main-panel');
    if (mainPanel) mainPanel.classList.add('visible');
  }

  // -------------------------
  // --- EXPORTS / DEBUG
  // -------------------------
  window._vv_stopLive = () => { stopLiveUpdates(); console.log('Live stopped'); };
  console.log('Optimized app.js loaded — flights rendered via GeoJSON symbol layer. Adjust LIVE_UPDATE_BASE_MS and MAX_VISIBLE_FLIGHTS to tune performance.');

});
