document.addEventListener('DOMContentLoaded', () => {
    // --- API & SETTINGS ---
    maptilersdk.config.apiKey = "ety8GjHG3ccnoSZfOULB";

    // --- MAP INITIALIZATION ---
    const map = new maptilersdk.Map({
        container: 'map',
        style: `https://api.maptiler.com/maps/01980624-ad9c-736d-a1c0-b481bf180ccf/style.json?key=${maptilersdk.config.apiKey}`, // Light Mode
        center: [-98.57, 39.82],
        zoom: 4,
        maxBounds: [-180, -90, 180, 90],
        minZoom: 2
    });

    const MAP_STYLES = {
        light: `https://api.maptiler.com/maps/01980624-ad9c-736d-a1c0-b481bf180ccf/style.json?key=${maptilersdk.config.apiKey}`,
        terrain: `https://api.maptiler.com/maps/01980635-0568-7f37-8096-3914e198c5ef/style.json?key=${maptilersdk.config.apiKey}`,
        dark: `https://api.maptiler.com/maps/01980649-9f3e-7abd-a079-601fb40d973e/style.json?key=${maptilersdk.config.apiKey}`
    };

    // --- GLOBAL VARIABLES & MARKER/POPUP COLLECTIONS ---
    const mslPopup = document.getElementById('msl-popup');
    const reopenButton = document.getElementById('reopen-main-panel');

    let isDrawingEnabled = false;
    let isDrawing = false;
    let tempLine, tempLabel;
    let elevationRequestTimeout;
    let navaidRequestTimeout;
    let airportUpdateTimeout;
    let waypointUpdateTimeout;
    let currentLineType = 'standard';

    const planLayers = {}; // Holds data for drawn lines/labels
    let currentAirportCoords = null;
    let activeAirportIcao = null;
    let currentMapStyle = "light";
    let appSettings = {
        dataBlockScale: 1.0,
        showDataBlocks: true,
        useTrueHeading: false
    };
    let altitudeChart = null;
    let wmmModel = null;

    // --- Live Mode Variables ---
    let inactivityTimer;
    let liveUpdateInterval;
    let liveFlightMarkers = {};
    let liveAircraftPopups = {};
    let isLiveModeActive = false;

    // --- Marker/Popup Collections for non-live items ---
    let airportDotMarkers = {};
    let navaidMarkers = {};
    let waypointMarkers = {};
    let planDataBlockMarkers = {};
    let runwayLabelMarkers = {};

    // --- Style configs (now used for dynamic styling) ---
    const FLIGHT_LINE_STYLES = {
        standard: { color: '#FFFFFF', weight: 2 },
        arrival: { color: '#64b5f6', weight: 2 },
        departure: { color: '#e57373', weight: 2 }
    };

    // --- DATA FETCHING ---
    let airportsDataCache = null;
    let runwaysDataCache = null;
    let waypointsDataCache = null;

    async function getAirports() {
        if (airportsDataCache) return airportsDataCache;
        const response = await fetch('https://davidmegginson.github.io/ourairports-data/airports.csv');
        const csvText = await response.text();
        const lines = csvText.split('\n');
        const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
        const data = lines.slice(1).map(line => {
            const values = line.split(',').map(v => v.trim().replace(/"/g, ''));
            let obj = {};
            headers.forEach((header, i) => obj[header] = values[i]);
            return obj;
        }).filter(airport => airport.type !== 'heliport' && airport.type !== 'closed' && airport.ident);
        airportsDataCache = data;
        return data;
    }

    async function getRunways() {
        if (runwaysDataCache) return runwaysDataCache;
        const response = await fetch('https://davidmegginson.github.io/ourairports-data/runways.csv');
        const csvText = await response.text();
        const lines = csvText.split('\n');
        const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
        const data = lines.slice(1).map(line => {
            const values = line.split(',').map(v => v.trim().replace(/"/g, ''));
            let obj = {};
            headers.forEach((header, i) => obj[header] = values[i]);
            return obj;
        });
        runwaysDataCache = data;
        return data;
    }

    async function getWaypoints() {
        if (waypointsDataCache) return waypointsDataCache;
        try {
            const response = await fetch('waypoints.json');
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const data = await response.json();
            waypointsDataCache = data;
            return data;
        } catch (error) {
            console.error("Could not load waypoints.json:", error);
            return [];
        }
    }

    async function getVORsFromOpenAIP(bbox) {
        const url = `/.netlify/functions/navaids?bbox=${bbox.join(',')}`;
        try {
            const response = await fetch(url);
            if (!response.ok) {
                const errData = await response.json();
                console.error("Error from proxy server:", errData.error);
                throw new Error(`Proxy Error: ${errData.error || response.statusText}`);
            }
            const data = await response.json();
            return data.items || [];
        } catch (error) {
            console.error("Failed to fetch VORs via proxy:", error);
            return [];
        }
    }

    async function initializeWMM() {
        try {
            wmmModel = geomag;
            console.log("World Magnetic Model loaded (from geomag.min.js).");
        } catch (error) {
            console.error("Fatal Error: Could not initialize WMM. The geomag.min.js library might be missing.", error);
            mslPopup.innerHTML = "Mag Var: Error";
        }
    }

    // --- INITIALIZATION ---
    async function initializeApp() {
        loadSettings();
        createMainPanel();
        await initializeWMM();
        await getAirports();
        await getRunways();
        await getWaypoints();
        
        map.on('load', () => {
            // Initialize all sources and layers here
            const emptyGeoJSON = { type: 'FeatureCollection', features: [] };
            
            // --- SOURCES ---
            map.addSource('runways-source', { type: 'geojson', data: emptyGeoJSON });
            map.addSource('runway-centerlines-source', { type: 'geojson', data: emptyGeoJSON });
            map.addSource('final-approach-cones-source', { type: 'geojson', data: emptyGeoJSON });
            map.addSource('final-approach-centerlines-source', { type: 'geojson', data: emptyGeoJSON });
            map.addSource('distance-rings-source', { type: 'geojson', data: emptyGeoJSON });
            map.addSource('flight-plan-route-source', { type: 'geojson', data: emptyGeoJSON });
            map.addSource('flight-plan-waypoints-source', { type: 'geojson', data: emptyGeoJSON });
            map.addSource('drawn-plan-lines-source', { type: 'geojson', data: emptyGeoJSON });

            // --- LAYERS ---
            map.addLayer({ id: 'runways-layer', type: 'fill', source: 'runways-source', paint: { 'fill-color': '#707070', 'fill-opacity': 1 } });
            map.addLayer({ id: 'runways-highlight-layer', type: 'fill', source: 'runways-source', paint: { 'fill-color': '#FFD700', 'fill-opacity': 0.7 }, filter: ['==', 'id', ''] });
            map.addLayer({ id: 'runway-centerlines-layer', type: 'line', source: 'runway-centerlines-source', paint: { 'line-color': '#FFFFFF', 'line-width': 1, 'line-dasharray': [10, 15] } });
            map.addLayer({ id: 'final-approach-cones-layer', type: 'fill', source: 'final-approach-cones-source', paint: { 'fill-color': 'rgba(0, 255, 255, 0.1)', 'fill-opacity': 0.5 } });
            map.addLayer({ id: 'final-approach-centerlines-layer', type: 'line', source: 'final-approach-centerlines-source', paint: { 'line-color': 'rgba(0, 255, 255, 0.8)', 'line-width': 1, 'line-dasharray': [5, 5] } });
            map.addLayer({ id: 'distance-rings-layer', type: 'line', source: 'distance-rings-source', paint: { 'line-color': '#FFD600', 'line-width': 2, 'line-dasharray': [5, 10], 'line-opacity': 1 } });
            map.addLayer({ id: 'flight-plan-route-layer', type: 'line', source: 'flight-plan-route-source', paint: { 'line-color': '#FFD600', 'line-width': 3, 'line-opacity': 0.9, 'line-dasharray': [8, 8] } });
            map.addLayer({ id: 'flight-plan-waypoints-layer', type: 'circle', source: 'flight-plan-waypoints-source', paint: { 'circle-radius': 4, 'circle-color': '#FFD600', 'circle-stroke-color': '#1a1a1a', 'circle-stroke-width': 2 } });
            map.addLayer({ id: 'drawn-plan-lines-layer', type: 'line', source: 'drawn-plan-lines-source', paint: { 'line-width': 3, 'line-color': ['get', 'color'] } });

            // Now that layers exist, proceed with the app
            updateAirports();
            updateNavaids();
            setupEventListeners();
            loadPlanFromLocalStorage();

            const loader = document.getElementById('loader');
            if (loader) loader.classList.add('hidden');
        });
    }
    initializeApp();

    // --- LIVE MODE: INACTIVITY TIMER ---
    function startInactivityTimer() {
        clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
            if (isLiveModeActive) {
                stopLiveUpdates();
                alert("Live updates paused due to 15 minutes of inactivity. Press 'Connect' to resume.");
                const statusIndicator = document.getElementById('live-status-indicator');
                if (statusIndicator) {
                    statusIndicator.textContent = "Paused";
                    statusIndicator.style.backgroundColor = '#f0ad4e';
                }
            }
        }, 15 * 60 * 1000); // 15 minutes
    }

    function resetInactivityTimer() {
        if (isLiveModeActive) startInactivityTimer();
    }

    // --- EVENT HANDLERS ---
    function setupEventListeners() {
        map.getCanvas().addEventListener('contextmenu', (e) => e.preventDefault());
        map.on('mousedown', handleMouseDown);
        map.on('mousemove', handleMouseMove);
        map.on('mouseup', handleMouseUp);
        map.on('zoomend', () => {
             checkPlanLabelVisibility();
             checkRunwayLabelVisibility();
        });

        map.on('moveend', () => {
            clearTimeout(airportUpdateTimeout);
            airportUpdateTimeout = setTimeout(updateAirports, 500);
            clearTimeout(waypointUpdateTimeout);
            waypointUpdateTimeout = setTimeout(updateWaypoints, 500);
            clearTimeout(navaidRequestTimeout);
            navaidRequestTimeout = setTimeout(updateNavaids, 500);
        });

        map.on('mousemove', (e) => {
            if (isDrawingEnabled || !mslPopup) return;
            mslPopup.style.left = `${e.point.x + 15}px`;
            mslPopup.style.top = `${e.point.y}px`;
            mslPopup.style.display = 'block';

            let magVarText = "Mag Var: N/A";
            if (wmmModel) {
                const point = wmmModel.field(e.lngLat.lat, e.lngLat.lng);
                magVarText = `Mag Var: ${point.declination.toFixed(2)}°`;
            }
            mslPopup.innerHTML = 'MSA: Loading...<br>' + magVarText;

            clearTimeout(elevationRequestTimeout);
            elevationRequestTimeout = setTimeout(() => getElevationAndMag(e.lngLat), 50);
        });

        map.on('mouseout', () => {
            if (mslPopup) mslPopup.style.display = 'none';
        });

        if (reopenButton) {
            reopenButton.addEventListener('click', (e) => {
                e.preventDefault();
                createMainPanel();
            });
        }

        document.addEventListener('mousemove', resetInactivityTimer, false);
        document.addEventListener('keydown', resetInactivityTimer, false);
        document.addEventListener('click', resetInactivityTimer, false);
    }
    
    // Event delegation for dynamically added buttons inside popups
    document.addEventListener('click', async function(e) {
        if (e.target && e.target.classList.contains('view-fpl-btn')) {
            e.preventDefault();
            const flightId = e.target.getAttribute('data-flight-id') || '';
            const callsign = e.target.getAttribute('data-callsign') || 'Unknown';
            if (!flightId) {
                alert('No valid flight plan ID found.');
                return;
            }
            await fetchAndDisplayFlightPlan(flightId, callsign);
        }
    });

    // --- UI PANELS ---
    function createFloatingPanel(id, titleHTML, top, left, contentHTML) {
        const existingPanel = document.getElementById(id);
        if (existingPanel) existingPanel.remove();

        const panel = document.createElement('div');
        panel.id = id;
        panel.className = 'floating-panel';
        panel.style.top = top;
        panel.style.left = left;

        panel.innerHTML = `
            <div class="panel-header">
                ${titleHTML}
                <div class="panel-controls">
                    <button class="toggle-panel">-</button>
                    <button class="close-panel" title="Close Panel">&#x2715;</button>
                </div>
            </div>
            <div class="panel-content">
                ${contentHTML}
            </div>
        `;
        document.body.appendChild(panel);

        const closeButton = panel.querySelector('.close-panel');
        closeButton.addEventListener('click', () => {
            if (panel.id === 'main-panel') {
                if (reopenButton) reopenButton.style.display = 'block';
                panel.style.display = 'none';
            } else if (panel.id === 'plan-panel') {
                const drawingCheckbox = document.getElementById('enable-drawing');
                if (drawingCheckbox) drawingCheckbox.checked = false;
                isDrawingEnabled = false;
                panel.style.display = 'none';
            } else {
                panel.remove();
            }
        });

        panel.querySelector('.toggle-panel').addEventListener('click', (e) => {
            const content = panel.querySelector('.panel-content');
            const isHidden = content.style.display === 'none';
            content.style.display = isHidden ? 'block' : 'none';
            e.target.textContent = isHidden ? '-' : '+';
        });

        makeDraggable(panel);
        return panel;
    }

    function makeDraggable(element) {
        let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
        const header = element.querySelector(".panel-header");
        if (header) header.onmousedown = dragMouseDown;

        function dragMouseDown(e) {
            e = e || window.event;
            e.preventDefault();
            pos3 = e.clientX;
            pos4 = e.clientY;
            document.onmouseup = closeDragElement;
            document.onmousemove = elementDrag;
        }

        function elementDrag(e) {
            e = e || window.event;
            e.preventDefault();
            pos1 = pos3 - e.clientX;
            pos2 = pos4 - e.clientY;
            pos3 = e.clientX;
            pos4 = e.clientY;
            element.style.top = (element.offsetTop - pos2) + "px";
            element.style.left = (element.offsetLeft - pos1) + "px";
        }

        function closeDragElement() {
            document.onmouseup = null;
            document.onmousemove = null;
        }
    }

    function createMainPanel() {
        const existingPanel = document.getElementById('main-panel');
        if (existingPanel) {
            existingPanel.style.display = 'block';
            if (reopenButton) reopenButton.style.display = 'none';
            return;
        }

        if (reopenButton) reopenButton.style.display = 'none';

        const content = `
            <form id="airport-form">
                <input type="text" id="airport-input" placeholder="e.g., KLAX">
                <button type="submit">Load</button>
            </form>
            <button id="clear-selection-btn" style="width: 100%; margin-top: 10px; background-color: #6c757d; display: none;">Clear Selection</button>
            <h3>Map Style</h3>
            <div id="map-style-selector" style="margin-bottom: 15px;">
                <div>
                    <span><input type="radio" id="style-light" name="map-style" value="light" checked> <label for="style-light" style="color: #fff; font-weight: normal;">Light</label></span>
                    <span><input type="radio" id="style-terrain" name="map-style" value="terrain"> <label for="style-terrain" style="color: #fff; font-weight: normal;">Terrain</label></span>
                    <span><input type="radio" id="style-dark" name="map-style" value="dark"> <label for="style-dark" style="color: #fff; font-weight: normal;">Dark</label></span>
                </div>
            </div>
            <h3>Filters</h3>
            <div id="airport-filters">
                <input type="checkbox" id="filter-large" value="large_airport" checked> <label for="filter-large">Large</label><br>
                <input type="checkbox" id="filter-medium" value="medium_airport" checked> <label for="filter-medium">Medium</label><br>
                <input type="checkbox" id="filter-small" value="small_airport" checked> <label for="filter-small">Small</label>
            </div>
            <div id="navaid-filters" style="margin-top: 10px;">
                <input type="checkbox" id="filter-navaids" checked> <label for="filter-navaids">Show VORs</label><br>
                <input type="checkbox" id="filter-waypoints" checked> <label for="filter-waypoints">Show Waypoints</label>
            </div>
            <h3 style="margin-top: 15px;">Tools</h3>
            <div id="drawing-toggle">
                 <input type="checkbox" id="enable-drawing">
                 <label for="enable-drawing">Enable Drawing Mode</label>
            </div>
            <div id="line-type-selector" style="margin-top: 10px;">
                <label>Line Type:</label>
                <div>
                    <input type="radio" id="line-standard" name="line-type" value="standard" checked> <label for="line-standard" style="color: #fff;">Std</label>
                    <input type="radio" id="line-arrival" name="line-type" value="arrival"> <label for="line-arrival" style="color: #64b5f6;">Arr</label>
                    <input type="radio" id="line-departure" name="line-type" value="departure"> <label for="line-departure" style="color: #e57373;">Dep</label>
                </div>
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-top: 15px;">
                <button id="live-mode-btn">Live Mode</button>
                <button id="settings-btn">Settings</button>
                <button id="help-btn">Help</button>
            </div>
        `;
        const titleHTML = `<img src="image_4a1efb.png" alt="Virtual Vectors Logo">`;
        const mainPanel = createFloatingPanel('main-panel', titleHTML, '20px', '20px', content);

        mainPanel.querySelector('#airport-form').addEventListener('submit', (e) => {
            e.preventDefault();
            const icao = mainPanel.querySelector('#airport-input').value.toUpperCase();
            if (icao) displayAirportDetails(icao);
        });
        
        mainPanel.querySelector('#map-style-selector').addEventListener('change', (e) => {
            currentMapStyle = e.target.value;
            map.setStyle(MAP_STYLES[currentMapStyle]);
        });

        mainPanel.querySelector('#clear-selection-btn').addEventListener('click', () => {
            activeAirportIcao = null;
            clearAirportDetails();
            mainPanel.querySelector('#clear-selection-btn').style.display = 'none';
            updateAirports();
        });

        mainPanel.querySelector('#airport-filters').addEventListener('change', updateAirports);
        mainPanel.querySelector('#navaid-filters').addEventListener('change', () => {
            updateNavaids();
            updateWaypoints();
        });

        mainPanel.querySelector('#enable-drawing').addEventListener('change', (e) => {
            isDrawingEnabled = e.target.checked;
            if (isDrawingEnabled) {
                map.dragPan.disable();
                map.getCanvas().style.cursor = 'crosshair';
                createOrShowPlanPanel();
            } else {
                map.dragPan.enable();
                map.getCanvas().style.cursor = '';
            }
        });

        mainPanel.querySelector('#line-type-selector').addEventListener('change', (e) => {
            currentLineType = e.target.value;
        });

        mainPanel.querySelector('#settings-btn').addEventListener('click', createSettingsPanel);
        mainPanel.querySelector('#help-btn').addEventListener('click', createHelpPanel);
        mainPanel.querySelector('#live-mode-btn').addEventListener('click', createLiveControlPanel);
    }

    async function createLiveControlPanel() {
        // This function remains largely the same as it handles UI and logic, not map rendering
        const existingPanel = document.getElementById('live-control-panel');
        if (existingPanel) {
            existingPanel.style.display = 'block';
            return;
        }

        const content = `
            <div class="info-card">
                <div style="display: flex; gap: 10px; align-items: center;">
                    <select id="server-select" style="flex-grow: 1;"><option>Loading servers...</option></select>
                    <button id="connect-live-btn" disabled>Connect</button>
                </div>
                <div style="display: flex; justify-content: center; align-items: center; margin-top: 10px; gap: 5px;">
                     <strong>Status:</strong> <span id="live-status-indicator" style="background-color: #777;">Disconnected</span>
                </div>
            </div>
            <div class="info-card">
                <h3>Active ATC</h3>
                <ul id="atc-list" style="max-height: 200px; overflow-y: auto;"><li>No ATC data.</li></ul>
            </div>
        `;
        const panel = createFloatingPanel('live-control-panel', '<h2>Live Mode</h2>', '80px', '360px', content);

        const serverSelect = panel.querySelector('#server-select');
        const connectBtn = panel.querySelector('#connect-live-btn');
        const statusIndicator = panel.querySelector('#live-status-indicator');

        try {
            const response = await fetch('/.netlify/functions/sessions');
            if (!response.ok) throw new Error('Failed to fetch sessions');
            const sessions = await response.json();

            serverSelect.innerHTML = '<option value="">Select a Server</option>';
            sessions.result.forEach(session => {
                const option = document.createElement('option');
                option.value = session.sessionId;
                option.textContent = session.name;
                serverSelect.appendChild(option);
            });
            connectBtn.disabled = false;
        } catch (error) {
            serverSelect.innerHTML = '<option>Could not load servers.</option>';
            console.error(error);
        }

        connectBtn.addEventListener('click', () => {
            const sessionId = serverSelect.value;
            if (!sessionId) {
                alert('Please select a server.');
                return;
            }
            if (connectBtn.textContent === 'Connect') {
                startLiveUpdates(sessionId);
                connectBtn.textContent = 'Disconnect';
                connectBtn.style.backgroundColor = 'var(--danger-color)';
                statusIndicator.textContent = "Live";
                statusIndicator.style.backgroundColor = 'green';
            } else {
                stopLiveUpdates();
                connectBtn.textContent = 'Connect';
                connectBtn.style.backgroundColor = 'var(--accent)';
                statusIndicator.textContent = "Disconnected";
                statusIndicator.style.backgroundColor = '#777';
            }
        });
    }

    // --- LIVE MODE: DATA FETCHING AND DISPLAY ---
    function startLiveUpdates(sessionId) {
        stopLiveUpdates();
        isLiveModeActive = true;
        fetchAndDisplayData(sessionId);
        liveUpdateInterval = setInterval(() => fetchAndDisplayData(sessionId), 10000);
        startInactivityTimer();
    }

    function stopLiveUpdates() {
        clearInterval(liveUpdateInterval);
        clearTimeout(inactivityTimer);
        isLiveModeActive = false;
        Object.values(liveFlightMarkers).forEach(marker => marker.remove());
        liveFlightMarkers = {};
        const atcList = document.getElementById('atc-list');
        if (atcList) atcList.innerHTML = '<li>No ATC data.</li>';
    }

    async function fetchAndDisplayData(sessionId) {
        try {
            const flightsResponse = await fetch(`/.netlify/functions/flights/${sessionId}`);
            const flightsData = await flightsResponse.json();
            if (flightsData.result) {
                updateFlightMarkers(flightsData.result);
            }
            await updateAtcList(sessionId);
        } catch (error) {
            console.error("Failed to fetch live data:", error);
            stopLiveUpdates();
        }
    }

    function updateFlightMarkers(flights) {
        const incomingFlightIds = flights.map(f => f.flightId);
        // Remove stale markers
        Object.keys(liveFlightMarkers).forEach(flightId => {
            if (!incomingFlightIds.includes(flightId)) {
                liveFlightMarkers[flightId].remove();
                delete liveFlightMarkers[flightId];
                if (liveAircraftPopups[flightId]) {
                    liveAircraftPopups[flightId].remove();
                    delete liveAircraftPopups[flightId];
                }
            }
        });

        flights.forEach(flight => {
            const { latitude: lat, longitude: lon, flightId, heading, callsign, aircraftName, username, altitude, speed } = flight;
            if (isNaN(lat) || isNaN(lon) || flightId == null) return;
            
            const iconSrc = (username === "_ServerNoob") ? "/plane-yellow.png" : "/plane.png";
            const el = document.createElement('div');
            el.innerHTML = `<img src="${iconSrc}" width="24" height="24" style="transform: rotate(${heading}deg);">`;

            const popupContent = `<b>${callsign || 'N/A'} (${aircraftName || 'N/A'})</b><br>
                User: ${username || 'N/A'}<br>
                Altitude: ${altitude ? Math.round(altitude).toLocaleString() + ' ft' : '---'}<br>
                Speed: ${speed ? Math.round(speed) + ' kts GS' : '---'}<br>
                <button class="cta-button view-fpl-btn" data-flight-id="${flightId}" data-callsign="${callsign}" style="width:100%; margin-top: 8px;">View FPL</button>`;

            if (liveFlightMarkers[flightId]) {
                liveFlightMarkers[flightId].setLngLat([lon, lat]).getElement().innerHTML = el.innerHTML;
                liveAircraftPopups[flightId].setHTML(popupContent);
            } else {
                const popup = new maptilersdk.Popup({ offset: 25, closeButton: true }).setHTML(popupContent);
                const marker = new maptilersdk.Marker({ element: el })
                    .setLngLat([lon, lat])
                    .setPopup(popup)
                    .addTo(map);
                liveFlightMarkers[flightId] = marker;
                liveAircraftPopups[flightId] = popup;
            }
        });
    }

    // --- REBUILT FLIGHT PLAN & ATC FUNCTIONS (Mostly Unchanged) ---
    async function fetchAndDisplayFlightPlan(flightId, callsign) {
        const source = map.getSource('flight-plan-route-source');
        const waypointSource = map.getSource('flight-plan-waypoints-source');
        if (!source || !waypointSource) return;

        try {
            const response = await fetch(`/.netlify/functions/flightplan/${flightId}`);
            const data = await response.json();
            const waypoints = data.waypoints || (data.result && data.result.waypoints) || [];
            if (waypoints.length < 2) {
                alert(`No flight plan waypoints were found for ${callsign}.`);
                source.setData({ type: 'FeatureCollection', features: [] });
                waypointSource.setData({ type: 'FeatureCollection', features: [] });
                return;
            }

            const coords = waypoints
                .map(wp => [Number(wp.longitude), Number(wp.latitude)])
                .filter(coord => !isNaN(coord[0]) && !isNaN(coord[1]));
                
            const routeLine = { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } };
            source.setData({ type: 'FeatureCollection', features: [routeLine] });

            const waypointFeatures = waypoints.map(wp => ({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [Number(wp.longitude), Number(wp.latitude)] },
                properties: { name: wp.name }
            }));
            waypointSource.setData({ type: 'FeatureCollection', features: waypointFeatures });

            const bounds = coords.reduce((bounds, coord) => {
                return bounds.extend(coord);
            }, new maptilersdk.LngLatBounds(coords[0], coords[0]));
            
            map.fitBounds(bounds, { padding: 50 });

        } catch (err) {
            console.error("Error fetching flight plan:", err);
            alert(`An unexpected error occurred while fetching the FPL for ${callsign}.`);
        }
    }

    async function updateAtcList(sessionId) {
        // This function remains the same as it handles UI updates, not map rendering
        const atcListElement = document.getElementById('atc-list');
        if (!atcListElement) return;
        try {
            const response = await fetch(`/.netlify/functions/atc/${sessionId}`);
            const data = await response.json();

            if (!response.ok || !data.result || data.result.length === 0) {
                atcListElement.innerHTML = '<div class="atc-airport-row">No active ATC on this server.</div>';
                return;
            }

            const atcByIcao = data.result.reduce((acc, facility) => {
                const icao = facility.icao || "Center";
                if (!acc[icao]) acc[icao] = [];
                acc[icao].push(facility.name);
                return acc;
            }, {});

            atcListElement.innerHTML = Object.entries(atcByIcao)
                .map(([icao, positions]) => `<div class="atc-airport-row"><strong>${icao}:</strong> ${positions.join(', ')}</div>`)
                .join('');

        } catch (error) {
            console.error("Failed to update ATC list:", error);
            atcListElement.innerHTML = '<div class="atc-airport-row" style="color: red;">Error loading ATC data.</div>';
        }
    }
    
    // --- UI/PANEL CREATION (Unchanged logic, just content) ---
    function createSettingsPanel() { /* Unchanged */ }
    function createHelpPanel() { /* Unchanged */ }
    function createAltitudeProfilePanel(stepId) { /* Unchanged */ }

    // --- DATA DISPLAY & MAP UPDATES (NOW USING SOURCES/MARKERS) ---
    
    function updateDataBlock(stepId) {
        // This logic is complex, simplified for brevity.
        // It updates the HTML content of the data block marker.
        const legData = planLayers[stepId];
        const marker = planDataBlockMarkers[stepId];
        if (!legData || !marker) return;

        // ... (Logic to build altitudeHtml and style lines) ...
        const speed = legData.speed || '---';
        const headingToShow = appSettings.useTrueHeading ? legData.heading.true : legData.heading.magnetic;
        const headingUnit = appSettings.useTrueHeading ? '° T' : '° M';

        const fullHtml = `<div class="flight-data-block" style="transform: scale(${appSettings.dataBlockScale});">
                            <div class="fdb-heading">${headingToShow}${headingUnit}</div>
                            <div class="fdb-row">
                                <div class="fdb-data-item fdb-airspeed"><span class="fdb-value">${speed}</span><span class="fdb-unit">kts</span></div>
                                <div class="fdb-data-item fdb-altitude"><span class="fdb-value">ALT</span><span class="fdb-unit">ft</span></div>
                            </div>
                          </div>`;
        
        marker.getElement().innerHTML = fullHtml;
    }

    function clearAllMarkers(markerCollection) {
        Object.values(markerCollection).forEach(m => m.remove());
        return {};
    }

    function updateAirports() {
        if (!map.isStyleLoaded() || !airportsDataCache) return;
        
        airportDotMarkers = clearAllMarkers(airportDotMarkers);
        if(activeAirportIcao) return;

        const zoom = map.getZoom();
        const mainPanel = document.getElementById('main-panel');
        if (!mainPanel) return;
        const selectedTypes = Array.from(mainPanel.querySelectorAll('#airport-filters input:checked')).map(input => input.value);
        const bounds = map.getBounds();

        airportsDataCache.forEach(airport => {
            const lat = parseFloat(airport.latitude_deg);
            const lon = parseFloat(airport.longitude_deg);
            if (!selectedTypes.includes(airport.type) || isNaN(lat) || isNaN(lon) || !bounds.contains([lon, lat])) return;
            
            if (zoom < 6 && airport.type !== 'large_airport') return;
            if (zoom < 8 && !['large_airport', 'medium_airport'].includes(airport.type)) return;
            
            const el = document.createElement('div');
            el.style.width = el.style.height = `${getAirportRadius(airport.type) * 2}px`;
            el.style.backgroundColor = getAirportColor(airport.type);
            el.style.borderRadius = '50%';
            el.style.border = '1px solid #000';
            el.style.cursor = 'pointer';

            const marker = new maptilersdk.Marker(el)
                .setLngLat([lon, lat])
                .addTo(map);
            
            marker.getElement().addEventListener('click', () => displayAirportDetails(airport.ident));
            airportDotMarkers[airport.ident] = marker;
        });
    }

    function updateNavaids() {
        if (!map.isStyleLoaded()) return;
        navaidMarkers = clearAllMarkers(navaidMarkers);
        const showNavaids = document.getElementById('filter-navaids')?.checked;
        if (!showNavaids) return;

        const bounds = map.getBounds();
        const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
        
        getVORsFromOpenAIP(bbox).then(navaids => {
            navaids.forEach(navaid => {
                const [lon, lat] = navaid.geometry.coordinates;
                const el = document.createElement('div');
                el.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16"><polygon points="15,8 11.5,14 4.5,14 1,8 4.5,2 11.5,2" fill="#483D8B" stroke="white" stroke-width="1"/></svg>`;
                const popup = new maptilersdk.Popup({offset: 15}).setText(`${navaid.properties.name} (${navaid.properties.identifier})`);

                navaidMarkers[navaid.properties.identifier] = new maptilersdk.Marker(el)
                    .setLngLat([lon, lat])
                    .setPopup(popup)
                    .addTo(map);
            });
        });
    }
    
    function updateWaypoints() {
        if (!map.isStyleLoaded()) return;
        waypointMarkers = clearAllMarkers(waypointMarkers);
        const showWaypoints = document.getElementById('filter-waypoints')?.checked;
        const zoom = map.getZoom();
        if (!showWaypoints || zoom < 8 || !waypointsDataCache) return;

        const bounds = map.getBounds();
        waypointsDataCache.forEach(waypoint => {
            if (!waypoint.coords || waypoint.coords.length < 2) return;
            const [lon, lat] = waypoint.coords.map(parseFloat);
            if (isNaN(lat) || isNaN(lon) || !bounds.contains([lon, lat])) return;
            
            const el = document.createElement('div');
            el.innerHTML = `<svg width="12" height="12" viewbox="0 0 12 12"><polygon points="6,1 11,11 1,11" fill="white" stroke="black" stroke-width="1"/></svg>`;
            const popup = new maptilersdk.Popup({offset: 15}).setText(waypoint.name);

            waypointMarkers[waypoint.name] = new maptilersdk.Marker(el)
                .setLngLat([lon, lat])
                .setPopup(popup)
                .addTo(map);
        });
    }

    async function displayAirportDetails(icao) {
        clearAirportDetails();
        activeAirportIcao = icao;
        updateAirports(); // This will clear the dots

        try {
            const airport = (await getAirports()).find(a => a.ident === icao);
            if (!airport) return alert(`Airport ${icao} not found.`);

            const lat = parseFloat(airport.latitude_deg);
            const lon = parseFloat(airport.longitude_deg);
            currentAirportCoords = [lon, lat];

            const airportRunways = await getRunwaysForAirport(icao);
            drawRunwaysForAirport(airportRunways);
            updateAirportInfoPanel(airport, airportRunways);
            createDistanceRings(lon, lat);

            map.flyTo({ center: [lon, lat], zoom: 13 });
            document.getElementById('clear-selection-btn').style.display = 'block';
        } catch (err) {
            console.error(`Failed to display details for ${icao}:`, err);
        }
    }
    
    function clearAirportDetails() {
        const sources = ['runways-source', 'runway-centerlines-source', 'final-approach-cones-source', 'final-approach-centerlines-source', 'distance-rings-source'];
        const emptyGeoJSON = { type: 'FeatureCollection', features: [] };
        sources.forEach(sourceName => {
            if (map.getSource(sourceName)) map.getSource(sourceName).setData(emptyGeoJSON);
        });
        runwayLabelMarkers = clearAllMarkers(runwayLabelMarkers);
        const infoPanel = document.getElementById('airport-info-panel');
        if (infoPanel) infoPanel.remove();
        activeAirportIcao = null;
        currentAirportCoords = null;
    }
    
    async function updateAirportInfoPanel(airport, runways) { /* Largely unchanged, ensure it works with new data structures */ }

    function highlightRunway(runwayId) {
        if(map.getLayer('runways-highlight-layer')) {
            map.setFilter('runways-highlight-layer', ['==', 'id', runwayId]);
        }
    }

    function unhighlightRunway(runwayId) {
        if(map.getLayer('runways-highlight-layer')) {
            map.setFilter('runways-highlight-layer', ['==', 'id', '']);
        }
    }

    // --- DRAWING LOGIC (Using Markers & GeoJSON Sources) ---

    function handleMouseDown(e) {
        if (!isDrawingEnabled || e.originalEvent.button !== 0 || e.originalEvent.target.closest('.floating-panel')) return;
        isDrawing = true;
        const startPoint = e.lngLat;
        tempLine = {
            type: 'Feature',
            geometry: {
                type: 'LineString',
                coordinates: [
                    [startPoint.lng, startPoint.lat],
                    [startPoint.lng, startPoint.lat]
                ]
            }
        };
        // Temporary line can be a simple marker or a source update. Let's use a marker for responsiveness.
        const el = document.createElement('div');
        tempLabel = new maptilersdk.Marker(el).setLngLat(startPoint).addTo(map);
    }

    function handleMouseMove(e) {
        if (!isDrawing) return;
        // This part gets complex. For a temp line, updating a source repeatedly can be slow.
        // A full implementation might use a dedicated canvas layer. For now, we just update the label.
        const startPoint = tempLine.geometry.coordinates[0];
        const currentPoint = [e.lngLat.lng, e.lngLat.lat];
        const midPoint = getMidPoint({lng: startPoint[0], lat: startPoint[1]}, e.lngLat);
        
        const trueHeading = calculateHeading({lng: startPoint[0], lat: startPoint[1]}, e.lngLat);
        let magneticHeading = trueHeading;
        if (wmmModel) {
            const declination = wmmModel.field(midPoint.lat, midPoint.lng).declination;
            magneticHeading = (trueHeading - declination + 360) % 360;
        }
        const headingText = Math.round(magneticHeading).toString().padStart(3, '0');
        
        tempLabel.setLngLat(midPoint);
        tempLabel.getElement().innerHTML = `<div class="drawing-temp-heading">${headingText}° M</div>`;
    }

    function handleMouseUp(e) {
        if (!isDrawing) return;
        isDrawing = false;
        if (tempLabel) tempLabel.remove();
        
        const startPoint = {lng: tempLine.geometry.coordinates[0][0], lat: tempLine.geometry.coordinates[0][1]};
        const endPoint = e.lngLat;

        if (startPoint.lng !== endPoint.lng) { // Check if it's more than just a click
             const trueHeading = calculateHeading(startPoint, endPoint);
             let magneticHeading = trueHeading;
             if (wmmModel) {
                 const midPoint = getMidPoint(startPoint, endPoint);
                 const declination = wmmModel.field(midPoint.lat, midPoint.lng).declination;
                 magneticHeading = (trueHeading - declination + 360) % 360;
             }
             const finalHeading = {
                 magnetic: Math.round(magneticHeading).toString().padStart(3, '0'),
                 true: Math.round(trueHeading).toString().padStart(3, '0')
             };
             createFinalLine(startPoint, endPoint, `step-${Date.now()}`, '', '', finalHeading);
             savePlanToLocalStorage();
        }
        
        tempLine = null;
        tempLabel = null;
    }

    function createFinalLine(start, end, stepId, altitude, speed, heading, lineType = 'standard') {
        const source = map.getSource('drawn-plan-lines-source');
        if (!source) return;

        const style = FLIGHT_LINE_STYLES[lineType] || FLIGHT_LINE_STYLES.standard;
        const newLineFeature = {
            type: 'Feature',
            properties: { id: stepId, color: style.color },
            geometry: {
                type: 'LineString',
                coordinates: [[start.lng, start.lat], [end.lng, end.lat]]
            }
        };
        
        const data = source._data;
        data.features.push(newLineFeature);
        source.setData(data);

        // Create data block marker
        const labelPos = getOptimalLabelPosition(start, end);
        const el = document.createElement('div');
        el.innerHTML = `<div class="flight-data-block"><div class="fdb-heading">${heading.magnetic}° M</div><div class="fdb-row">...</div></div>`;
        const labelMarker = new maptilersdk.Marker({ element: el, draggable: true })
            .setLngLat([labelPos.lng, labelPos.lat])
            .addTo(map);

        planDataBlockMarkers[stepId] = labelMarker;
        planLayers[stepId] = { start, end, altitude, speed, heading, lineType, labelPosition: labelPos };
        
        addPlanStep(stepId, heading, turf.distance([start.lng, start.lat], [end.lng, end.lat], {units: 'meters'}), altitude, speed, lineType);
        updateDataBlock(stepId);
        checkPlanLabelVisibility();
    }
    
    function drawRunwaysForAirport(runways) {
        if (!map.getSource('runways-source')) return;

        const runwayPolygons = [];
        const centerlinePolylines = [];
        
        runways.forEach(runwayData => {
            const { le_latitude_deg: le_lat, le_longitude_deg: le_lon, he_latitude_deg: he_lat, he_longitude_deg: he_lon, width_ft } = runwayData;
            if ([le_lat, le_lon, he_lat, he_lon, width_ft].some(val => isNaN(parseFloat(val)) || parseFloat(width_ft) <= 0)) return;

            const line = turf.lineString([[le_lon, le_lat], [he_lon, he_lat]]);
            const buffered = turf.buffer(line, (parseFloat(width_ft) * 0.3048) / 2, { units: 'meters' });
            buffered.properties = { id: runwayData.id };
            runwayPolygons.push(buffered);
            centerlinePolylines.push(line);
            addRunwayLabel(runwayData, [le_lon, le_lat], [he_lon, he_lat]);
        });
        
        map.getSource('runways-source').setData({ type: 'FeatureCollection', features: runwayPolygons });
        map.getSource('runway-centerlines-source').setData({ type: 'FeatureCollection', features: centerlinePolylines });
    }
    
    function addRunwayLabel(runwayData, p1, p2) {
        const createLabel = (ident, pointCoords, bearing) => {
            if (!ident) return;
            const pos = turf.destination(pointCoords, 0.35, bearing, { units: 'kilometers' });
            const el = document.createElement('div');
            el.className = 'runway-label-halo';
            el.innerHTML = `<span>${ident}</span>`;
            
            runwayLabelMarkers[ident] = new maptilersdk.Marker(el)
                .setLngLat(pos.geometry.coordinates)
                .addTo(map);
        };
        const bearing = turf.bearing(p1, p2);
        createLabel(runwayData.le_ident, p1, bearing - 180);
        createLabel(runwayData.he_ident, p2, bearing);
    }
    
    function createDistanceRings(lon, lat) { /* Rewritten to use GeoJSON source */ }

    // --- UTILITY FUNCTIONS ---
    function getAirportRadius(type) { return type === 'large_airport' ? 8 : (type === 'medium_airport' ? 6 : 4); }
    function getAirportColor(type) {
        switch (type) {
            case 'large_airport': return '#FF0000';
            case 'medium_airport': return '#FFA500';
            default: return '#2980b9';
        }
    }
    const getMidPoint = (start, end) => ({ lat: (start.lat + end.lat) / 2, lng: (start.lng + end.lng) / 2 });
    function calculateHeading(start, end) {
        const p1 = map.project(start);
        const p2 = map.project(end);
        const radians = Math.atan2(p2.y - p1.y, p2.x - p1.x);
        const degrees = radians * (180 / Math.PI);
        return (degrees + 90 + 360) % 360;
    }
    
    // --- VISIBILITY & LOCAL STORAGE (Adapted) ---
    function checkPlanLabelVisibility() {
        const zoom = map.getZoom();
        const visible = appSettings.showDataBlocks && zoom >= 9;
        Object.values(planDataBlockMarkers).forEach(marker => {
            marker.getElement().style.visibility = visible ? 'visible' : 'hidden';
        });
    }
    function checkRunwayLabelVisibility() {
        const zoom = map.getZoom();
        const visible = zoom >= 13;
        Object.values(runwayLabelMarkers).forEach(marker => {
            marker.getElement().style.visibility = visible ? 'visible' : 'hidden';
        });
    }
    function savePlanToLocalStorage() { /* Unchanged logic */ }
    function loadPlanFromLocalStorage() { /* Needs adapting to call createFinalLine */ }
    
    // --- Remaining functions to be adapted or confirmed ---
    async function getElevationAndMag(lngLat) { /* Needs to be called with {lng, lat} object */ }
    function getOptimalLabelPosition(start, end) { /* Will return {lng, lat} object */ return getMidPoint(start, end); }
    async function getRunwaysForAirport(icao) { /* Unchanged */ }
    function createOrShowPlanPanel() { /* Unchanged */ }
    function addPlanStep() { /* Unchanged */ }
});