// app.js (Updated with ATIS functionality and migrated to MapTiler SDK)
document.addEventListener('DOMContentLoaded', () => {
    // --- API & SETTINGS ---
    maptilersdk.config.apiKey = 'ety8GjHG3ccnoSZfOULB';

    // --- MAP INITIALIZATION ---
    const map = new maptilersdk.Map({
        container: 'map',
        style: 'https://api.maptiler.com/maps/01980624-ad9c-736d-a1c0-b481bf180ccf/style.json?key=ety8GjHG3ccnoSZfOULB',
        center: [-98.57, 39.82],
        zoom: 4
    });

    // --- GLOBAL VARIABLES & LAYER MANAGEMENT ---
    const layerAndSourceIds = new Set();
    // liveFlightMarkers is no longer needed. We will use a GeoJSON source.
    const planLabels = {};

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

    const planLayers = {};
    let currentAirportCoords = null;
    let activeAirportIcao = null;
    let currentMapMode = "regular";
    let appSettings = { dataBlockScale: 1.0, showDataBlocks: true, useTrueHeading: false };
    let altitudeChart = null;
    let wmmModel = null;

    // --- Live Mode Variables ---
    let inactivityTimer;
    let liveUpdateInterval;
    let isLiveModeActive = false;
    let selectedFlightId = null;
    let atisCache = {};
    let activeAtisStationIcaos = new Set();
    let activeAtcAirportIcaos = new Set(); // For tracking all active airports
    let pulseAnimationId = null; // For the pulsating animation
    let currentFlightPopup = null; // Track the currently open flight popup

    // --- Style configs (remain mostly the same, but used differently) ---
    const RUNWAY_STYLE_REGULAR = { 'line-color': '#AAAAAA', 'line-width': 1, 'fill-color': '#707070', 'fill-opacity': 1 };
    const RUNWAY_STYLE_HIGHLIGHT = { 'line-color': '#FFD700', 'line-width': 2, 'fill-color': '#FFD700', 'fill-opacity': 0.7 };
    const RUNWAY_CENTERLINE_STYLE_REGULAR = { 'line-color': '#FFFFFF', 'line-width': 1, 'line-dasharray': [2, 3] };
    const FLIGHT_LINE_STYLES_REGULAR = {
        standard: { 'line-color': '#000000', 'line-width': 3, 'line-opacity': 0.85 },
        arrival: { 'line-color': '#2979FF', 'line-width': 3, 'line-opacity': 1 },
        departure: { 'line-color': '#FF3D00', 'line-width': 3, 'line-opacity': 1 }
    };
    const RUNWAY_STYLE_TERRAIN = { 'line-color': '#222', 'line-width': 2, 'fill-color': '#444', 'fill-opacity': 0.95, 'line-opacity': 1 };
    const RUNWAY_CENTERLINE_STYLE_TERRAIN = { 'line-color': '#F5F5F5', 'line-width': 2, 'line-dasharray': [2, 3], 'line-opacity': 1 };
    const FLIGHT_LINE_STYLES_TERRAIN = {
        standard: { 'line-color': '#000', 'line-width': 4, 'line-opacity': 1 },
        arrival:  { 'line-color': '#2979FF', 'line-width': 4, 'line-opacity': 1 },
        departure:{ 'line-color': '#FF3D00', 'line-width': 4, 'line-opacity': 1 }
    };
    const FINAL_APPROACH_STYLE = {
        'fill-color': 'rgba(128, 128, 128, 0.2)', // Gray with 20% opacity
        'fill-opacity': 1
    };
    const FINAL_APPROACH_CENTERLINE_STYLE = {
        'line-color': '#000000', // Solid Black
        'line-width': 2,
        'line-dasharray': [5, 5]
    };

    // --- DATA FETCHING (no changes here) ---
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

    // --- MAPTILER SDK HELPER ---
    /**
     * Safely adds a source and layer to the map, tracking their IDs for later removal.
     * @param {string} id - A unique base ID for the source and layer.
     * @param {object} source - The GeoJSON source object.
     * @param {object} layer - The layer style object.
     */
    function addSourceAndLayer(id, source, layer) {
        const sourceId = `${id}-source`;
        const layerId = `${id}-layer`;

        if (map.getSource(sourceId)) {
            map.getSource(sourceId).setData(source.data);
        } else {
            map.addSource(sourceId, source);
            layerAndSourceIds.add(sourceId);
        }

        if (map.getLayer(layerId)) {
             // If layer exists, we might need to update its paint properties, etc.
             // For simplicity here, we assume layers are added once.
        } else {
            map.addLayer({ ...layer, id: layerId, source: sourceId });
            layerAndSourceIds.add(layerId);
        }
    }

    /**
     * Clears all dynamically added layers and sources from the map.
     */
    function clearAllDynamicLayers() {
        // Create a copy of the Set to safely iterate over.
        const idsToRemove = new Set(layerAndSourceIds);

        // First, iterate and remove only the layers.
        // Layers must be removed before the sources they use.
        idsToRemove.forEach(id => {
            if (map.getLayer(id)) {
                map.removeLayer(id);
            }
        });

        // After all layers are gone, it's safe to remove the sources.
        idsToRemove.forEach(id => {
            if (map.getSource(id)) {
                map.removeSource(id);
            }
        });

        layerAndSourceIds.clear();

        // Clear markers separately as before.
        if (map.getSource('flights-source')) {
             map.getSource('flights-source').setData({ type: 'FeatureCollection', features: [] });
        }

        Object.values(planLabels).forEach(marker => marker.remove());
        Object.keys(planLabels).forEach(key => delete planLabels[key]);
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
            // --- REFACTORED FLIGHTS LAYER SETUP ---
            // Load all possible aircraft icons into the map style.
            const iconsToLoad = {
                'icon-default': '/plane.png',
                'icon-selected': '/whiteplane.png',
                'icon-a380': '/a380.png'
            };
            const promises = Object.entries(iconsToLoad).map(([name, url]) => {
                return new Promise((resolve, reject) => {
                    map.loadImage(url, (error, image) => {
                        if (error) reject(error);
                        map.addImage(name, image);
                        resolve();
                    });
                });
            });

            // After all icons are loaded, set up the map
            Promise.all(promises).then(() => {
                // Add the source for flight data
                map.addSource('flights-source', {
                    type: 'geojson',
                    data: { type: 'FeatureCollection', features: [] }
                });

                // Add the layer to display flights. This is added BEFORE updateAirports()
                // is called, so it will be rendered underneath the airport dots.
                map.addLayer({
                    id: 'flights-layer',
                    type: 'symbol',
                    source: 'flights-source',
                    layout: {
                        'icon-image': ['get', 'iconName'],
                        'icon-size': 0.75,
                        'icon-rotate': ['get', 'heading'],
                        'icon-rotation-alignment': 'map',
                        'icon-allow-overlap': true,
                        'icon-ignore-placement': true // Prevents icons from disappearing on collision
                    }
                });

                // Now that the flights layer is ready, continue with app setup
                setupEventListeners();
                updateAirports();
                updateNavaids();
                updateWaypoints();
                loadPlanFromLocalStorage();

                const loader = document.getElementById('loader');
                if (loader) {
                    loader.classList.add('hidden');
                }
            }).catch(error => {
                console.error("A critical error occurred while loading aircraft icons:", error);
                alert("Could not load essential image resources. The application may not function correctly.");
            });
        });
    }
    initializeApp();

    // --- LIVE MODE: INACTIVITY TIMER (no changes) ---
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
        if (isLiveModeActive) {
            startInactivityTimer();
        }
    }

    // --- EVENT HANDLERS (Updated for MapTiler) ---
    function setupEventListeners() {
        map.getCanvas().addEventListener('contextmenu', (e) => e.preventDefault());
        map.on('mousedown', handleMouseDown);
        map.on('mousemove', handleMouseMove);
        map.on('mouseup', handleMouseUp);
        map.on('zoomend', handleMapMoveEnd);
        map.on('moveend', handleMapMoveEnd);

        function handleMapMoveEnd() {
            adjustAllLabelPositions();
            clearTimeout(airportUpdateTimeout);
            airportUpdateTimeout = setTimeout(updateAirports, 500);
            clearTimeout(waypointUpdateTimeout);
            waypointUpdateTimeout = setTimeout(updateWaypoints, 500);
            clearTimeout(navaidRequestTimeout);
            navaidRequestTimeout = setTimeout(updateNavaids, 500);
        }


        map.on('mousemove', (e) => {
            if (isDrawingEnabled || !mslPopup) return;
            mslPopup.style.left = `${e.point.x + 15}px`;
            mslPopup.style.top = `${e.point.y}px`;
            mslPopup.style.display = 'block';

            let magVarText = "Mag Var: N/A";
            if (wmmModel) {
                const point = wmmModel.field(e.lngLat.lat, e.lngLat.lng);
                const declination = point.declination;
                magVarText = `Mag Var: ${declination.toFixed(2)}°`;
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
        
        // --- NEW: POPUP LOGIC FOR FLIGHTS LAYER ---
        map.on('click', 'flights-layer', (e) => {
            const properties = e.features[0].properties;
            const coordinates = e.features[0].geometry.coordinates.slice();
            
            // Close the previous popup if it exists
            if (currentFlightPopup) {
                currentFlightPopup.remove();
            }

            // Ensure the popup appears over the clicked point
            while (Math.abs(e.lngLat.lng - coordinates[0]) > 180) {
                coordinates[0] += e.lngLat.lng > coordinates[0] ? 360 : -360;
            }

            const popupContent = `
                <div class="flight-popup-container" style="line-height: 1.4; background-color: #2a2a35; color: #f0f0f0; border: 1px solid #4a4a55;">
                    <div style="display: flex; justify-content: space-between; align-items: baseline;">
                        <strong class="flight-popup-callsign">${properties.callsign}</strong>
                        <span class="flight-popup-aircraft" style="font-size: 0.8em; opacity: 0.7;">${properties.aircraftName || 'N/A'}</span>
                    </div>
                    <div style="font-size: 0.9em; margin-top: 4px; border-top: 1px solid #444; padding-top: 4px;">
                        <div><strong>Alt:</strong> ${properties.altitudeText}</div>
                        <div><strong>Spd:</strong> ${properties.speedText}</div>
                        <div><strong>User:</strong> ${properties.username || 'N/A'}</div>
                    </div>
                    ${
                        properties.flightId
                        ? `<div style="margin-top: 8px;">
                            <button class="cta-button view-fpl-btn"
                                    style="padding: 5px 10px; font-size: 12px; width: 100%;"
                                    data-flight-id="${properties.flightId}"
                                    data-session-id="${properties.sessionId}"
                                    data-callsign="${properties.callsign}"
                                    data-altitude="${properties.altitudeText}"
                                    data-speed="${properties.speedText}">View FPL</button>
                        </div>`
                        : ''
                    }
                </div>
            `;

            currentFlightPopup = new maptilersdk.Popup({ offset: 25, className: 'custom-popup' })
                .setLngLat(coordinates)
                .setHTML(popupContent)
                .addTo(map);
        });

        // Change cursor to pointer when hovering over a plane
        map.on('mouseenter', 'flights-layer', () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', 'flights-layer', () => { map.getCanvas().style.cursor = ''; });

        document.addEventListener('mousemove', resetInactivityTimer, false);
        document.addEventListener('keydown', resetInactivityTimer, false);
        document.addEventListener('click', resetInactivityTimer, false);

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

    // --- UI PANELS (no major changes here) ---
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

        // Prevent map interaction when clicking on panel
        panel.addEventListener('mousedown', (e) => e.stopPropagation());
        panel.addEventListener('wheel', (e) => e.stopPropagation());


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
                const reopenPlanButton = document.getElementById('reopen-plan-panel');
                if(reopenPlanButton) reopenPlanButton.style.display = 'block';
            } else if (panel.id === 'live-control-panel') {
                panel.style.display = 'none';
            }
            else {
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
        if (header) {
            header.onmousedown = dragMouseDown;
        }

        function dragMouseDown(e) {
            e = e || window.event;
            e.preventDefault();
            if (window.getComputedStyle(element).right !== 'auto') {
                element.style.left = element.offsetLeft + 'px';
                element.style.right = 'auto';
            }
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
            let newTop = element.offsetTop - pos2;
            let newLeft = element.offsetLeft - pos1;
            const minLeft = 0;
            const minTop = 0;
            const maxLeft = window.innerWidth - element.offsetWidth;
            const maxTop = window.innerHeight - element.offsetHeight;
            newLeft = Math.max(minLeft, Math.min(newLeft, maxLeft));
            newTop = Math.max(minTop, Math.min(newTop, maxTop));
            element.style.top = newTop + "px";
            element.style.left = newLeft + "px";
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
            <span id="clear-selection-text" style="font-size: 11px; color: #ccc; display: none; text-align: center;">Click to clear selection and see other airports</span>

            <div id="viewed-fpl-info" class="info-card" style="display: none; border-color: var(--accent); margin-top: 15px;">
                <h3 style="display: flex; justify-content: space-between; align-items: center; margin: 0; padding: 0; border: none;">
                    <span>FPL: <span id="fpl-callsign" style="color: white; font-weight: bold;"></span></span>
                    <button id="clear-fpl-btn" style="font-size: 12px; padding: 4px 8px; font-weight: 500; background-color: var(--danger-color); color: white; border-radius: 6px; box-shadow: none;">Clear</button>
                </h3>
                <ul style="font-size: 13px; margin-top: 8px;">
                    <li><strong>Altitude:</strong> <span id="fpl-altitude"></span></li>
                    <li><strong>Speed:</strong> <span id="fpl-speed"></span></li>
                </ul>
            </div>

            <h3>Filters</h3>

            <div class="filter-dropdown-container" id="airport-dropdown-container">
                <button class="filter-dropdown-btn">Airport Type <span style="float: right;">▼</span></button>
                <div class="filter-dropdown-content" style="display: none;">
                    <p class="dropdown-description">Filter airports by airspace classification.</p>
                    <div id="airport-filters">
                        <label><input type="checkbox" id="filter-large" value="large_airport" checked> Bravo</label>
                        <label><input type="checkbox" id="filter-medium" value="medium_airport" checked> Charlie</label>
                        <label><input type="checkbox" id="filter-small" value="small_airport" checked> Small/Other</label>
                    </div>
                </div>
            </div>

            <div class="filter-dropdown-container" id="navigation-dropdown-container">
                <button class="filter-dropdown-btn">Navigation Aids <span style="float: right;">▼</span></button>
                <div class="filter-dropdown-content" style="display: none;">
                    <p class="dropdown-description">Toggle visibility of navigational elements.</p>
                    <div id="navigation-filters">
                        <label><input type="checkbox" id="filter-navaids" checked> Show VORs</label>
                        <label><input type="checkbox" id="filter-waypoints" checked> Show Waypoints</label>
                        <label><input type="checkbox" id="enable-final-approach" checked> Show 10nm Final</label>
                    </div>
                </div>
            </div>

            <h3 style="margin-top: 15px;">Tools</h3>
            <div id="drawing-toggle">
                 <input type="checkbox" id="enable-drawing">
                 <label for="enable-drawing" style="color: #fff; font-weight: normal;">Enable Drawing Mode</label>
                 <span id="drawing-mode-text" style="font-size: 11px; color: #ccc; display: none; padding-left: 18px;">Uncheck to move the map</span>
            </div>

            <div id="line-type-selector" style="margin-top: 10px; display: none;">
                <label style="color: #fff; font-weight: normal; width: 100%; margin-bottom: 5px;">Line Type:</label>
                <div>
                    <span><input type="radio" id="line-standard" name="line-type" value="standard" checked> <label for="line-standard" style="color: #fff; font-weight: normal;">Standard</label></span>
                    <span><input type="radio" id="line-arrival" name="line-type" value="arrival"> <label for="line-arrival" style="color: #64b5f6; font-weight: normal;">Arrival</label></span>
                    <span><input type="radio" id="line-departure" name="line-type" value="departure"> <label for="line-departure" style="color: #e57373; font-weight: normal;">Departure</label></span>
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

        // --- Attach Event Listeners ---
        mainPanel.querySelector('#airport-form').addEventListener('submit', (e) => {
            e.preventDefault();
            const icao = mainPanel.querySelector('#airport-input').value.toUpperCase();
            if (icao) displayAirportDetails(icao);
        });
        mainPanel.querySelector('#clear-selection-btn').addEventListener('click', () => {
            activeAirportIcao = null;
            // Clear airport-specific layers
            clearAirportLayers();
            updateAirports(); // Re-render general airport dots

            const infoPanel = document.getElementById('airport-info-panel');
            if (infoPanel) infoPanel.remove();

            mainPanel.querySelector('#clear-selection-btn').style.display = 'none';
            const clearText = document.getElementById('clear-selection-text');
            if (clearText) clearText.style.display = 'none';
        });

        mainPanel.querySelector('#clear-fpl-btn').addEventListener('click', () => {
             if (map.getLayer('flight-plan-route')) map.removeLayer('flight-plan-route');
             if (map.getSource('flight-plan-route')) map.removeSource('flight-plan-route');
             if (map.getLayer('flight-plan-waypoints')) map.removeLayer('flight-plan-waypoints');
             if (map.getSource('flight-plan-waypoints')) map.removeSource('flight-plan-waypoints');

            document.getElementById('viewed-fpl-info').style.display = 'none';

            const oldSelectedId = selectedFlightId;
            selectedFlightId = null; // Clear the selection

            if (oldSelectedId) {
                const serverSelect = document.getElementById('server-select');
                const sessionId = serverSelect ? serverSelect.value : null;
                if (isLiveModeActive && sessionId) {
                    fetchAndDisplayData(sessionId);
                }
            }
        });

        mainPanel.querySelector('#airport-filters').addEventListener('change', updateAirports);

        mainPanel.querySelector('#navigation-filters').addEventListener('change', (e) => {
            if (e.target.id === 'filter-navaids' || e.target.id === 'filter-waypoints') {
                updateNavaids();
                updateWaypoints();
            }
            const finalApproachCheckbox = document.getElementById('enable-final-approach');
            const visibility = (finalApproachCheckbox && finalApproachCheckbox.checked) ? 'visible' : 'none';
            if(map.getLayer('final-approach-cones-layer')) map.setLayoutProperty('final-approach-cones-layer', 'visibility', visibility);
            if(map.getLayer('final-approach-centerlines-layer')) map.setLayoutProperty('final-approach-centerlines-layer', 'visibility', visibility);
        });

        mainPanel.querySelector('#enable-drawing').addEventListener('change', (e) => {
            isDrawingEnabled = e.target.checked;
            const drawingText = document.getElementById('drawing-mode-text');
            const lineSelector = document.getElementById('line-type-selector');

            if (isDrawingEnabled) {
                map.dragPan.disable();
                map.getCanvas().style.cursor = 'crosshair';
                if (drawingText) drawingText.style.display = 'block';
                if (lineSelector) lineSelector.style.display = 'block';
                createOrShowPlanPanel();
            } else {
                map.dragPan.enable();
                map.getCanvas().style.cursor = '';
                if (drawingText) drawingText.style.display = 'none';
                if (lineSelector) lineSelector.style.display = 'none';
            }
        });

        mainPanel.querySelector('#line-type-selector').addEventListener('change', (e) => {
            if (e.target.name === 'line-type') {
                currentLineType = e.target.value;
            }
        });

        const airportDropdownBtn = mainPanel.querySelector('#airport-dropdown-container .filter-dropdown-btn');
        const airportDropdownContent = mainPanel.querySelector('#airport-dropdown-container .filter-dropdown-content');

        const navDropdownBtn = mainPanel.querySelector('#navigation-dropdown-container .filter-dropdown-btn');
        const navDropdownContent = mainPanel.querySelector('#navigation-dropdown-container .filter-dropdown-content');

        airportDropdownBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = airportDropdownContent.style.display === 'block';
            if (navDropdownContent) navDropdownContent.style.display = 'none';
            airportDropdownContent.style.display = isVisible ? 'none' : 'block';
        });

        navDropdownBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = navDropdownContent.style.display === 'block';
            if (airportDropdownContent) airportDropdownContent.style.display = 'none';
            navDropdownContent.style.display = isVisible ? 'none' : 'block';
        });

        document.addEventListener('click', (e) => {
             if (airportDropdownContent && !airportDropdownBtn.contains(e.target) && !airportDropdownContent.contains(e.target)) {
                airportDropdownContent.style.display = 'none';
            }
            if (navDropdownContent && !navDropdownBtn.contains(e.target) && !navDropdownContent.contains(e.target)) {
                navDropdownContent.style.display = 'none';
            }
        });

        mainPanel.querySelector('#settings-btn').addEventListener('click', createSettingsPanel);
        mainPanel.querySelector('#help-btn').addEventListener('click', createHelpPanel);
        mainPanel.querySelector('#live-mode-btn').addEventListener('click', createLiveControlPanel);
    }
     async function createLiveControlPanel() {
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
                <div id="atc-list" style="max-height: 200px; overflow-y: auto;"><div>No ATC data.</div></div>
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
                statusIndicator.style.backgroundColor = 'var(--live-color)';
            } else {
                stopLiveUpdates();
                connectBtn.textContent = 'Connect';
                connectBtn.style.backgroundColor = 'var(--accent)';
                statusIndicator.textContent = "Disconnected";
                statusIndicator.style.backgroundColor = '#777';
            }
        });

		serverSelect.addEventListener('change', (e) => {
            const newSessionId = e.target.value;
            if (connectBtn.textContent === 'Disconnect') {
                if (newSessionId) {
                    stopLiveUpdates();
                    startLiveUpdates(newSessionId);
                } else {
                    stopLiveUpdates();
                    connectBtn.textContent = 'Connect';
                    connectBtn.style.backgroundColor = 'var(--accent)';
                    statusIndicator.textContent = "Disconnected";
                    statusIndicator.style.backgroundColor = '#777';
                }
            }
        });
    }

    // --- LIVE MODE: DATA FETCHING AND DISPLAY (Updated for MapTiler) ---
    function startLiveUpdates(sessionId) {
        stopLiveUpdates(); // Clear any previous state
        isLiveModeActive = true;
        
        // Start fetching data immediately and then set the interval
        fetchAndDisplayData(sessionId);
        liveUpdateInterval = setInterval(() => fetchAndDisplayData(sessionId), 10000);
        
        startInactivityTimer();

        // Start the pulse animation
        if (!pulseAnimationId) {
            animatePulse();
        }
    }

    function stopLiveUpdates() {
        clearInterval(liveUpdateInterval);
        clearTimeout(inactivityTimer);
        isLiveModeActive = false;

        // Stop the pulse animation
        if (pulseAnimationId) {
            cancelAnimationFrame(pulseAnimationId);
            pulseAnimationId = null;
        }
        
        // Clear the flight data source instead of removing individual markers
        if (map.getSource('flights-source')) {
            map.getSource('flights-source').setData({ type: 'FeatureCollection', features: [] });
        }
        
        selectedFlightId = null;
        atisCache = {};
        activeAtisStationIcaos.clear();
        activeAtcAirportIcaos.clear(); // Clear the active ATC list

        const atcList = document.getElementById('atc-list');
        if (atcList) atcList.innerHTML = '<div>No ATC data.</div>';

        updateAirports(); // Re-render airports to remove pulse effect
    }

    async function fetchAndDisplayData(sessionId) {
        try {
            const flightsResponse = await fetch(`/.netlify/functions/flights/${sessionId}`);
            const flightsData = await flightsResponse.json();
            if (flightsData.result) {
                updateFlightMarkers(flightsData.result, sessionId);
            }

            await updateAtcList(sessionId);

        } catch (error) {
            console.error("Failed to fetch live data:", error);
            const statusIndicator = document.getElementById('live-status-indicator');
            if(statusIndicator){
                statusIndicator.textContent = "Error";
                statusIndicator.style.backgroundColor = 'var(--danger-color)';
            }
            stopLiveUpdates();
        }
    }

    // --- COMPLETELY REWRITTEN FUNCTION ---
    function updateFlightMarkers(flights, sessionId) {
        if (!map.getSource('flights-source')) return; // Exit if the layer isn't ready

        const flightFeatures = flights.map(flight => {
            const lat = Number(flight.latitude);
            const lon = Number(flight.longitude);
            if (isNaN(lat) || isNaN(lon)) return null;
            
            const isSelected = flight.flightId === selectedFlightId;
            const iconName = getAircraftIconName(flight.aircraftName, isSelected);
            
            const altitude = (typeof flight.altitude === 'number') ? Math.round(flight.altitude) : null;
            const speed = (typeof flight.speed === 'number') ? Math.round(flight.speed) : null;

            // These properties will be passed to the GeoJSON feature and available on click
            const properties = {
                flightId: flight.flightId,
                sessionId: sessionId,
                heading: flight.heading,
                callsign: flight.callsign || 'N/A',
                aircraftName: flight.aircraftName || 'N/A',
                username: flight.username || 'N/A',
                iconName: iconName,
                altitudeText: altitude !== null ? `${altitude.toLocaleString()} ft` : '---',
                speedText: speed !== null ? `${speed} kts GS` : '---'
            };

            return {
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: [lon, lat]
                },
                properties: properties
            };
        }).filter(Boolean); // Filter out any null features

        // Update the source with the new data
        map.getSource('flights-source').setData({
            type: 'FeatureCollection',
            features: flightFeatures
        });
    }

    async function fetchAndDisplayFlightPlan(flightId, sessionId, callsign, altitude, speed) {
        // Clear previous FPL
        if (map.getLayer('flight-plan-route')) map.removeLayer('flight-plan-route');
        if (map.getSource('flight-plan-route')) map.removeSource('flight-plan-route');
        if (map.getLayer('flight-plan-waypoints')) map.removeLayer('flight-plan-waypoints');
        if (map.getSource('flight-plan-waypoints')) map.removeSource('flight-plan-waypoints');

        selectedFlightId = flightId;
        if (isLiveModeActive) {
            fetchAndDisplayData(sessionId);
        }

        try {
            const response = await fetch(`/.netlify/functions/flightplan/${sessionId}/${flightId}`);
            if (!response.ok) throw new Error(`API Error: ${response.status}`);
            const data = await response.json();

            const flightPlanItems = (data.result && data.result.flightPlanItems) || [];
            const allWaypoints = [];
            
            flightPlanItems.forEach(item => {
                if (item.children && item.children.length > 0) {
                    allWaypoints.push(...item.children.filter(c => c.location));
                }
                else if (item.location) {
                    allWaypoints.push(item);
                }
            });


            if (allWaypoints.length < 2) {
                alert(`No valid flight plan route could be found for ${callsign}.`);
                return;
            }

            const routeCoords = allWaypoints.map(wp => [wp.location.longitude, wp.location.latitude]);
            const waypointFeatures = allWaypoints.map(wp => ({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [wp.location.longitude, wp.location.latitude] },
                properties: { name: wp.name }
            }));

            map.addSource('flight-plan-route', {
                type: 'geojson',
                data: { type: 'LineString', coordinates: routeCoords }
            });
            map.addLayer({
                id: 'flight-plan-route',
                type: 'line',
                source: 'flight-plan-route',
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: { 'line-color': '#FFD600', 'line-width': 3, 'line-dasharray': [2, 2] }
            });

            map.addSource('flight-plan-waypoints', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: waypointFeatures }
            });
            map.addLayer({
                id: 'flight-plan-waypoints',
                type: 'circle',
                source: 'flight-plan-waypoints',
                paint: {
                    'circle-radius': 4,
                    'circle-color': '#FFD600',
                    'circle-stroke-color': '#1a1a1a',
                    'circle-stroke-width': 2
                }
            });

            const fplInfoSection = document.getElementById('viewed-fpl-info');
            if (fplInfoSection) {
                document.getElementById('fpl-callsign').textContent = callsign;
                document.getElementById('fpl-altitude').textContent = altitude;
                document.getElementById('fpl-speed').textContent = speed;
                fplInfoSection.style.display = 'block';
            }

        } catch (error) {
            console.error("Error fetching flight plan:", error);
            alert(`Could not display the flight plan for ${callsign}.`);
        }
    }

    function setsAreEqual(setA, setB) {
        if (setA.size !== setB.size) return false;
        for (const item of setA) {
            if (!setB.has(item)) return false;
        }
        return true;
    }

    async function updateAtcList(sessionId) {
        const atcListElement = document.getElementById('atc-list');
        if (!atcListElement) return;

        const frequencyTypeMap = { 0: 'Ground', 1: 'Tower', 2: 'Unicom', 3: 'Clearance', 4: 'Approach', 5: 'Departure', 6: 'Center', 7: 'ATIS' };

        try {
            const response = await fetch(`/.netlify/functions/atc/${sessionId}`);
            const data = await response.json();

            const newActiveAtisIcaos = new Set();
            const newActiveAtcIcaos = new Set();
            if (data.result) {
                data.result.forEach(facility => {
                    if (facility.type === 7 && facility.airportName) {
                        newActiveAtisIcaos.add(facility.airportName);
                    }
                    if (facility.airportName && facility.airportName !== "Center") {
                        newActiveAtcIcaos.add(facility.airportName);
                    }
                });
            }
            activeAtisStationIcaos = newActiveAtisIcaos;
            
            if (!setsAreEqual(activeAtcAirportIcaos, newActiveAtcIcaos)) {
                activeAtcAirportIcaos = newActiveAtcIcaos;
                updateAirports(); 
            }

            if (!response.ok || data.errorCode !== 0 || !data.result) {
                atcListElement.innerHTML = '<div class="atc-item">No active ATC on this server.</div>';
                if (data.errorCode !== 0) console.error("Received an API error for ATC data:", data);
                return;
            }

            const atcByAirport = data.result
                .filter(facility => frequencyTypeMap.hasOwnProperty(facility.type))
                .reduce((acc, facility) => {
                    const icao = facility.airportName || "Center";
                    if (!acc[icao]) {
                        acc[icao] = { name: facility.airportName || "Center Control", frequencies: [] };
                    }
                    acc[icao].frequencies.push(facility);
                    return acc;
                }, {});

            const airportIcaos = Object.keys(atcByAirport);
            if (airportIcaos.length === 0) {
                atcListElement.innerHTML = '<div class="atc-item">No active ATC on this server.</div>';
                return;
            }

            let htmlContent = airportIcaos.sort().map(icao => {
                const airportData = atcByAirport[icao];
                airportData.frequencies.sort((a, b) => a.type - b.type);
                const frequencyItems = airportData.frequencies.map(facility => {
                    const typeName = frequencyTypeMap[facility.type];
                    const controller = facility.username || "N/A";
                    return `<li class="atc-frequency">
                              <span class="atc-type">${typeName}</span>
                              <span class="atc-controller">${controller}</span>
                            </li>`;
                }).join('');
                return `<div class="atc-item">
                          <div class="atc-airport-header">
                            <strong>${icao}</strong>
                            <span>${(icao !== "Center" && airportData.name) ? ` - ${airportData.name}` : ''}</span>
                          </div>
                          <ul class="atc-frequency-list">${frequencyItems}</ul>
                        </div>`;
            }).join('');
            atcListElement.innerHTML = htmlContent;

        } catch (error) {
            console.error("Failed to fetch or render ATC data:", error);
            atcListElement.innerHTML = '<div class="atc-item" style="color: var(--danger-color);">Error loading ATC data.</div>';
        }
    }


    function createSettingsPanel() {
        const content = `
            <div class="info-card">
                <h3>Display</h3>
                <div style="padding-bottom: 10px;">
                     <label for="heading-type-toggle" style="display: flex; align-items: center; justify-content: space-between;">
                        Use True Heading
                        <input type="checkbox" id="heading-type-toggle" ${appSettings.useTrueHeading ? 'checked' : ''}>
                    </label>
                    <p style="font-size: 11px; color: #bbb; margin: 4px 0 0 0;">Toggles the primary heading on data blocks between Magnetic and True.</p>
                </div>
                <hr style="border-color: var(--border-color); margin: 10px 0;">
                <div style="padding-bottom: 10px;">
                    <label for="show-data-blocks-toggle" style="display: flex; align-items: center; justify-content: space-between;">
                        Show Data Blocks
                        <input type="checkbox" id="show-data-blocks-toggle" ${appSettings.showDataBlocks ? 'checked' : ''}>
                    </label>
                </div>
                <div>
                    <label for="data-block-scale-slider">Data Block Size: <span id="data-block-scale-value">${appSettings.dataBlockScale.toFixed(1)}x</span></label>
                    <input type="range" id="data-block-scale-slider" min="0.5" max="1.5" step="0.1" value="${appSettings.dataBlockScale}" style="width: 100%;">
                </div>
            </div>
             <div class="info-card">
                <h3>Data Source</h3>
                <p style="font-size: 12px; color: #ddd; margin: 0;">
                    Runway data from an open-source project may have inaccuracies. Use the INFO panel to manually correct magnetic variation if needed.
                </p>
            </div>
        `;
        createFloatingPanel('settings-panel', '<h2>Settings</h2>', '150px', '150px', content);

        const settingsPanel = document.getElementById('settings-panel');
        settingsPanel.querySelector('#heading-type-toggle').addEventListener('change', (e) => {
            appSettings.useTrueHeading = e.target.checked;
            updateAllFlightDataBlockStyles();
            saveSettings();
        });

        settingsPanel.querySelector('#show-data-blocks-toggle').addEventListener('change', (e) => {
            appSettings.showDataBlocks = e.target.checked;
            updateAllFlightDataBlockStyles();
            saveSettings();
        });

        const scaleSlider = settingsPanel.querySelector('#data-block-scale-slider');
        const scaleValueLabel = settingsPanel.querySelector('#data-block-scale-value');
        scaleSlider.addEventListener('input', (e) => {
            appSettings.dataBlockScale = parseFloat(e.target.value);
            scaleValueLabel.textContent = `${appSettings.dataBlockScale.toFixed(1)}x`;
            updateAllFlightDataBlockStyles();
        });
        scaleSlider.addEventListener('change', saveSettings);
    }

    function createHelpPanel() {
        const helpContent = `
            <div class="info-card">
                <h3>Getting Started</h3>
                <ul>
                    <li><strong>Load Airport:</strong> Type an airport ICAO code (e.g., KJFK) into the search box and click 'Load'.</li>
                    <li><strong>Filter Airports:</strong> Use the checkboxes under 'Filters' to show or hide large, medium, or small airports on the map as you zoom.</li>
                </ul>
            </div>
            <div class="info-card">
                <h3>Drawing Tool</h3>
                <p style="font-size: 14px; color: #ddd; margin: 0;">To plan a flight path:</p>
                <ol style="font-size: 14px; color: #ddd; padding-left: 20px;">
                    <li style="margin-bottom: 5px;">Check <strong>'Enable Drawing Mode'</strong> to start.</li>
                    <li style="margin-bottom: 5px;">The tool will stay active to draw multiple lines. <strong>Uncheck the box</strong> when you are finished drawing to move the map again.</li>
                    <li style="margin-bottom: 5px;">In the Flight Plan panel, <strong>click the heading value</strong> to edit it manually for precise intercepts.</li>
                </ol>
            </div>
            <div class="info-card">
                <h3>Settings Panel</h3>
                <p style="font-size: 14px; color: #ddd; margin: 0;">
                    Use the 'Settings' button to change the size of the flight data blocks or hide them completely.
                </p>
            </div>
        `;
        createFloatingPanel('help-panel', '<h2>Help</h2>', '150px', '150px', helpContent);
    }

    // --- MAP DRAWING AND UPDATING ---

    function clearAirportLayers() {
        const layers = [
            'runways', 'runway-centerlines', 'runway-labels',
            'final-approach-cones', 'final-approach-centerlines',
            'distance-rings-casing',
            'distance-rings',
            'distance-ring-labels'
        ];
        layers.forEach(baseId => {
            const layerId = `${baseId}-layer`;
            const sourceId = `${baseId}-source`;
            if (map.getLayer(layerId)) map.removeLayer(layerId);
            if (map.getSource(sourceId)) map.removeSource(sourceId);
        });
    }

	async function updateNavaids() {
		const navaidsCheckbox = document.getElementById('filter-navaids');
		if (!navaidsCheckbox || !navaidsCheckbox.checked) {
			if (map.getLayer('navaids-layer')) map.setLayoutProperty('navaids-layer', 'visibility', 'none');
			return;
		}

		const zoom = map.getZoom();
		if (zoom < 7) {
			if (map.getLayer('navaids-layer')) map.setLayoutProperty('navaids-layer', 'visibility', 'none');
			return;
		}

		const bounds = map.getBounds();
		const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];

		try {
			const navaids = await getVORsFromOpenAIP(bbox);
			const navaidFeatures = navaids.map(navaid => ({
				type: 'Feature',
				geometry: {
					type: 'Point',
					coordinates: [navaid.geometry.coordinates[0], navaid.geometry.coordinates[1]]
				},
				properties: {
					name: navaid.properties.name,
					type: navaid.type
				}
			}));

			const sourceId = 'navaids-source';
			const layerId = 'navaids-layer';

			if (map.getSource(sourceId)) {
				map.getSource(sourceId).setData({ type: 'FeatureCollection', features: navaidFeatures });
			} else {
				map.addSource(sourceId, {
					type: 'geojson',
					data: { type: 'FeatureCollection', features: navaidFeatures }
				});
				map.addLayer({
					id: layerId,
					type: 'symbol',
					source: sourceId,
					layout: {
						'text-field': ['get', 'name'],
						'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
						'text-size': 10,
						'text-anchor': 'top',
						'text-offset': [0, 0.8]
					},
					paint: {
						'text-color': '#cce5ff',
						'text-halo-color': '#000',
						'text-halo-width': 1
					}
				});
			}
			 if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', 'visible');

		} catch (error) {
			console.error("Failed to update navaids:", error);
		}
	}

	async function updateWaypoints() {
		const waypointsCheckbox = document.getElementById('filter-waypoints');
		if (!waypointsCheckbox || !waypointsCheckbox.checked) {
			if (map.getLayer('waypoints-layer')) map.setLayoutProperty('waypoints-layer', 'visibility', 'none');
			return;
		}

		const zoom = map.getZoom();
		if (zoom < 9) { 
			if (map.getLayer('waypoints-layer')) map.setLayoutProperty('waypoints-layer', 'visibility', 'none');
			return;
		}

		const bounds = map.getBounds();
		const waypoints = await getWaypoints();

		const waypointFeatures = waypoints.filter(wp => {
			const lat = wp.lat;
			const lon = wp.lon;
			return lat >= bounds.getSouth() && lat <= bounds.getNorth() && lon >= bounds.getWest() && lon <= bounds.getEast();
		}).map(wp => ({
			type: 'Feature',
			geometry: { type: 'Point', coordinates: [wp.lon, wp.lat] },
			properties: { name: wp.ident }
		}));

		const sourceId = 'waypoints-source';
		const layerId = 'waypoints-layer';

		if (map.getSource(sourceId)) {
			map.getSource(sourceId).setData({ type: 'FeatureCollection', features: waypointFeatures });
		} else {
			map.addSource(sourceId, {
				type: 'geojson',
				data: { type: 'FeatureCollection', features: waypointFeatures }
			});
			map.addLayer({
				id: layerId,
				type: 'symbol',
				source: sourceId,
				layout: {
					'text-field': ['get', 'name'],
					'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
					'text-size': 11,
					'text-anchor': 'bottom',
					'text-offset': [0, -0.8]
				},
				paint: {
					'text-color': '#ddd',
					'text-halo-color': '#000',
					'text-halo-width': 1.5
				}
			});
		}

		if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', 'visible');
	}

    function updateAirports() {
        if (activeAirportIcao) {
            if (map.getLayer('airport-dots-layer')) map.setLayoutProperty('airport-dots-layer', 'visibility', 'none');
            if (map.getLayer('airport-dots-pulse-layer')) map.setLayoutProperty('airport-dots-pulse-layer', 'visibility', 'none');
            return;
        }

        const zoom = map.getZoom();
        if (!airportsDataCache) return;

        const mainPanel = document.getElementById('main-panel');
        if (!mainPanel) return;
        const selectedTypes = Array.from(mainPanel.querySelectorAll('#airport-filters input:checked')).map(input => input.value);
        const bounds = map.getBounds();

        const airportFeatures = airportsDataCache.filter(airport => {
            if (!selectedTypes.includes(airport.type)) return false;
            const lat = parseFloat(airport.latitude_deg);
            const lon = parseFloat(airport.longitude_deg);
            if (isNaN(lat) || isNaN(lon)) return false;

            const sw = bounds.getSouthWest();
            const ne = bounds.getNorthEast();

            if (lat < sw.lat || lat > ne.lat || lon < sw.lng || lon > ne.lng) return false;

            if (zoom < 6) return airport.type === 'large_airport';
            if (zoom < 8) return ['large_airport', 'medium_airport'].includes(airport.type);
            return true;
        }).map(airport => ({
            type: 'Feature',
            geometry: {
                type: 'Point',
                coordinates: [parseFloat(airport.longitude_deg), parseFloat(airport.latitude_deg)]
            },
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
            map.addSource(sourceId, {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: airportFeatures }
            });

            map.addLayer({
                id: pulseLayerId,
                type: 'circle',
                source: sourceId,
                filter: ['==', ['get', 'hasActiveAtc'], true],
                paint: {
                    'circle-radius': 10,
                    'circle-color': '#EABFFF',
                    'circle-opacity': 0.5,
                    'circle-stroke-width': 2,
                    'circle-stroke-color': '#FFFFFF'
                }
            });

            map.addLayer({
                id: layerId,
                type: 'circle',
                source: sourceId,
                paint: {
                    'circle-radius': ['match', ['get', 'type'], 'large_airport', 7, 'medium_airport', 5, 3],
                    'circle-color': [
                        'case',
                        ['==', ['get', 'hasActiveAtc'], true],
                        '#4169E1', // Royal Blue for active ATC
                        ['match', ['get', 'type'],
                            'large_airport', '#FF0000',
                            'medium_airport', '#FFA500',
                            'small_airport', '#2980b9',
                            '#95a5a6'
                        ]
                    ],
                    'circle-stroke-color': '#000',
                    'circle-stroke-width': 1
                }
            });

            map.on('click', layerId, (e) => {
                const icao = e.features[0].properties.icao;
                displayAirportDetails(icao);
            });

            map.on('mouseenter', layerId, () => { map.getCanvas().style.cursor = 'pointer'; });
            map.on('mouseleave', layerId, () => { map.getCanvas().style.cursor = ''; });
        }

        if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', 'visible');
        if (map.getLayer(pulseLayerId)) map.setLayoutProperty(pulseLayerId, 'visibility', 'visible');
    }
    
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
    
        map.setPaintProperty('airport-dots-pulse-layer', 'circle-radius', [
            '+',
            ['match', ['get', 'type'], 'large_airport', 7, 'medium_airport', 5, 3],
            radius
        ]);
        map.setPaintProperty('airport-dots-pulse-layer', 'circle-opacity', opacity);
        map.setPaintProperty('airport-dots-pulse-layer', 'circle-stroke-opacity', opacity);
    
        pulseAnimationId = requestAnimationFrame(animatePulse);
    }

    async function displayAirportDetails(icao) {
        clearAirportLayers();
        activeAirportIcao = icao;
        updateAirports();

        try {
            const airports = await getAirports();
            const airport = airports.find(a => a.ident === icao);
            if (!airport) return alert(`Airport with ICAO ${icao} not found.`);

            const lat = parseFloat(airport.latitude_deg);
            const lon = parseFloat(airport.longitude_deg);
            currentAirportCoords = { lat, lng: lon };

            const airportRunways = await getRunwaysForAirport(icao);
            drawRunwaysForAirport(icao);
            updateAirportInfoPanel(airport, airportRunways);
            createDistanceRings(lat, lon);

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

        if (isStale) {
            atisContentElement.innerHTML = `<span style="color: var(--danger-color); font-weight: 500;">Last ATIS:</span><br>${formattedText}`;
        } else {
            atisContentElement.innerHTML = formattedText;
        }
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
            declination = wmmModel.field(lat, lon).declination;
        }
        let runwaysHTML = `
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                <thead>
                    <tr style="text-align: left; border-bottom: 1px solid #555;">
                        <th style="padding: 4px 2px;">Runway</th>
                        <th style="padding: 4px 2px;">Mag Hdg</th>
                        <th style="padding: 4px 2px;">True Hdg</th>
                    </tr>
                </thead>
                <tbody>
        `;
        if (runways.length > 0) {
            runwaysHTML += runways.map(runway => {
                const runwayName = (runway.le_ident && runway.he_ident) ? `${runway.le_ident}/${runway.he_ident}` : (runway.le_ident || runway.he_ident || 'Unnamed');
                let le_true_hdg = parseFloat(runway.le_heading_degT);
                let he_true_hdg = parseFloat(runway.he_heading_degT);
                let le_mag_hdg_raw = (le_true_hdg - declination + 360) % 360;
                let he_mag_hdg_raw = (he_true_hdg - declination + 360) % 360;
                const le_mag_hdg_str = !isNaN(le_mag_hdg_raw) ? Math.round(le_mag_hdg_raw).toString().padStart(3, '0') + '°' : '---';
                const he_mag_hdg_str = !isNaN(he_mag_hdg_raw) ? Math.round(he_mag_hdg_raw).toString().padStart(3, '0') + '°' : '---';
                const le_true_hdg_str = !isNaN(le_true_hdg) ? Math.round(le_true_hdg).toString().padStart(3, '0') + '°' : '---';
                const he_true_hdg_str = !isNaN(he_true_hdg) ? Math.round(he_true_hdg).toString().padStart(3, '0') + '°' : '---';
                return `
                    <tr data-runway-id="${runway.id}" style="border-bottom: 1px solid #333; cursor: pointer;">
                        <td style="padding: 5px 2px;"><strong>${runwayName}</strong></td>
                        <td style="padding: 5px 2px; font-weight: bold; color: var(--accent);">${le_mag_hdg_str} / ${he_mag_hdg_str}</td>
                        <td style="padding: 5px 2px;">${le_true_hdg_str} / ${he_true_hdg_str}</td>
                    </tr>
                `;
            }).join('');
        } else {
            runwaysHTML += '<tr><td colspan="3" style="padding: 4px; text-align: center;">No runway data available.</td></tr>';
        }
        runwaysHTML += '</tbody></table>';

        const content = `
            <div class="info-card">
                <h3>General</h3>
                <ul>
                    <li><strong>Class:</strong> ${airspaceClass}</li>
                    <li><strong>Elevation:</strong> ${parseInt(airport.elevation_ft).toLocaleString()}'</li>
                    <li><strong>Mag Var:</strong> ${declination.toFixed(2)}°</li>
                </ul>
            </div>
            <div class="info-card">
                <h3>ATIS</h3>
                <div id="atis-content" style="font-size: 13px; white-space: pre-wrap; word-wrap: break-word;">
                    ${isLiveModeActive ? 'Loading...' : 'Connect to Live Mode to view ATIS.'}
                </div>
            </div>
            <div class="info-card">
                <h3>Runways 🧭</h3>
                ${runwaysHTML}
            </div>`;

        const panel = createFloatingPanel('airport-info-panel', `<h2>${panelTitle}</h2>`, '20px', '360px', content);
        panel.querySelectorAll('[data-runway-id]').forEach(row => {
            const runwayId = row.dataset.runwayId;
            row.addEventListener('mouseover', () => highlightRunway(runwayId));
            row.addEventListener('mouseout', () => unhighlightRunway(runwayId));
        });

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
                            if (atisCache[airportIdent]) {
                                displayAtis(atisCache[airportIdent], true);
                            } else {
                                atisContentElement.textContent = 'No active ATIS for this airport.';
                            }
                        }
                    } catch (error) {
                        console.error('Failed to fetch ATIS:', error);
                        if (atisCache[airportIdent]) {
                            displayAtis(atisCache[airportIdent], true);
                        } else {
                            atisContentElement.textContent = 'Error loading ATIS data.';
                        }
                    }
                } else {
                    if (atisCache[airportIdent]) {
                        displayAtis(atisCache[airportIdent], true);
                    } else {
                        atisContentElement.textContent = 'No ATIS information available.';
                    }
                }
            } else {
                atisContentElement.textContent = 'Select a server in Live Mode to view ATIS.';
            }
        } else {
            atisContentElement.textContent = 'Connect to Live Mode to view ATIS.';
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

            runways.forEach(runwayData => {
                const le_lat = parseFloat(runwayData.le_latitude_deg);
                const le_lon = parseFloat(runwayData.le_longitude_deg);
                const he_lat = parseFloat(runwayData.he_latitude_deg);
                const he_lon = parseFloat(runwayData.he_longitude_deg);
                const width_ft = parseFloat(runwayData.width_ft);
                if ([le_lat, le_lon, he_lat, he_lon, width_ft].some(isNaN) || width_ft <= 0) return;

                const widthMeters = width_ft * 0.3048;
                const runwayLineString = turf.lineString([[le_lon, le_lat], [he_lon, he_lat]]);
                const buffer = turf.buffer(runwayLineString, (widthMeters / 2), { units: 'meters' });
                runwayPolygons.push({
                    type: 'Feature',
                    geometry: buffer.geometry,
                    properties: { id: runwayData.id }
                });
                centerlines.push({
                    type: 'Feature',
                    geometry: { type: 'LineString', coordinates: [[le_lon, le_lat], [he_lon, he_lat]] }
                });

                const le_point = turf.point([le_lon, le_lat]);
                const he_point = turf.point([he_lon, he_lat]);
                if (runwayData.le_ident) {
                    const bearing = turf.bearing(he_point, le_point);
                    labels.push(createRunwayLabelFeature(runwayData.le_ident, le_point, bearing));
                    finalCones.push(createFinalApproachConeFeature(le_point, bearing));
                    finalCenterlines.push(createFinalApproachCenterlineFeature(le_point, bearing));
                }
                if (runwayData.he_ident) {
                    const bearing = turf.bearing(le_point, he_point);
                    labels.push(createRunwayLabelFeature(runwayData.he_ident, he_point, bearing));
                    finalCones.push(createFinalApproachConeFeature(he_point, bearing));
                    finalCenterlines.push(createFinalApproachCenterlineFeature(he_point, bearing));
                }
            });

            addSourceAndLayer('runways', { type: 'geojson', data: { type: 'FeatureCollection', features: runwayPolygons }}, { type: 'fill', paint: RUNWAY_STYLE_REGULAR });
            addSourceAndLayer('runway-centerlines', { type: 'geojson', data: { type: 'FeatureCollection', features: centerlines }}, { type: 'line', paint: RUNWAY_CENTERLINE_STYLE_REGULAR });
            addSourceAndLayer('runway-labels', { type: 'geojson', data: { type: 'FeatureCollection', features: labels.filter(Boolean) }}, { type: 'symbol', layout: { 'text-field': ['get', 'ident'], 'text-font': ['Open Sans Bold'], 'text-size': 14, 'text-anchor': 'bottom', 'text-offset': [0, -0.5] }, paint: { 'text-color': '#fff', 'text-halo-color': '#000', 'text-halo-width': 2 } });
            addSourceAndLayer('final-approach-cones', { type: 'geojson', data: { type: 'FeatureCollection', features: finalCones }}, { type: 'fill', paint: FINAL_APPROACH_STYLE });
            addSourceAndLayer('final-approach-centerlines', { type: 'geojson', data: { type: 'FeatureCollection', features: finalCenterlines }}, { type: 'line', paint: FINAL_APPROACH_CENTERLINE_STYLE });

        } catch (err) {
            console.error(`Could not draw runways for ${icao}:`, err);
        }
    }


    function highlightRunway(runwayId) {
        if (map.getLayer('runways-layer')) {
            map.setPaintProperty('runways-layer', 'fill-color', [
                'case',
                ['==', ['get', 'id'], runwayId], '#FFD700', 
                RUNWAY_STYLE_REGULAR['fill-color']
            ]);
        }
    }

    function unhighlightRunway(runwayId) {
        if (map.getLayer('runways-layer')) {
             map.setPaintProperty('runways-layer', 'fill-color', RUNWAY_STYLE_REGULAR['fill-color']);
        }
    }

    // --- DRAWING LOGIC (Rewritten for MapTiler) ---

    function handleMouseDown(e) {
        if (!isDrawingEnabled || e.originalEvent.button !== 0) return;

        if (e.originalEvent.target.closest('.floating-panel')) return;

        isDrawing = true;
        const startPoint = e.lngLat;

        if (!map.getSource('temp-line')) {
            map.addSource('temp-line', {
                type: 'geojson',
                data: { type: 'LineString', coordinates: [] }
            });
            map.addLayer({
                id: 'temp-line',
                type: 'line',
                source: 'temp-line',
                paint: { 'line-color': '#007bff', 'line-width': 3, 'line-dasharray': [2, 2] }
            });
        }
        map.getSource('temp-line').setData({
            type: 'LineString',
            coordinates: [[startPoint.lng, startPoint.lat], [startPoint.lng, startPoint.lat]]
        });

        const el = document.createElement('div');
        el.className = 'drawing-temp-heading';
        el.innerHTML = '---';
        tempLabel = new maptilersdk.Marker(el)
            .setLngLat(startPoint)
            .addTo(map);
    }

    function handleMouseMove(e) {
        if (!isDrawing) return;

        const currentPoint = e.lngLat;
        const source = map.getSource('temp-line');
        const startPointLngLat = source._data.coordinates[0];
        const startPoint = { lat: startPointLngLat[1], lng: startPointLngLat[0] };

        source.setData({
            type: 'LineString',
            coordinates: [[startPoint.lng, startPoint.lat], [currentPoint.lng, currentPoint.lat]]
        });

        const midPoint = {
            lat: (startPoint.lat + currentPoint.lat) / 2,
            lng: (startPoint.lng + currentPoint.lng) / 2
        };
        tempLabel.setLngLat(midPoint);

        const trueHeading = calculateHeading(startPoint, currentPoint);
        let magneticHeading = trueHeading;
        if (wmmModel) {
            const declination = wmmModel.field(midPoint.lat, midPoint.lng).declination;
            magneticHeading = (trueHeading - declination + 360) % 360;
        }
        const headingText = Math.round(magneticHeading).toString().padStart(3, '0');
        tempLabel.getElement().innerHTML = `${headingText}° M`;
    }

    function handleMouseUp(e) {
        if (!isDrawing) return;
        isDrawing = false;

        const endPoint = e.lngLat;
        const source = map.getSource('temp-line');
        const startPointLngLat = source._data.coordinates[0];
        const startPoint = { lat: startPointLngLat[1], lng: startPointLngLat[0] };

        if (map.getLayer('temp-line')) map.removeLayer('temp-line');
        if (map.getSource('temp-line')) map.removeSource('temp-line');
        if (tempLabel) tempLabel.remove();

        const distance = turf.distance(
            turf.point([startPoint.lng, startPoint.lat]),
            turf.point([endPoint.lng, endPoint.lat]),
            { units: 'meters' }
        );

        if (distance > 50) {
            const trueHeading = calculateHeading(startPoint, endPoint);
            let magneticHeading = trueHeading;
             if (wmmModel) {
                const midPoint = { lat: (startPoint.lat + endPoint.lat) / 2, lng: (startPoint.lng + endPoint.lng) / 2 };
                const declination = wmmModel.field(midPoint.lat, midPoint.lng).declination;
                magneticHeading = (trueHeading - declination + 360) % 360;
            }
            const finalHeading = {
                magnetic: Math.round(magneticHeading).toString().padStart(3, '0'),
                true: Math.round(trueHeading).toString().padStart(3, '0')
            };

            createFinalLine(startPoint, endPoint, `step-${Date.now()}`, '', '', true, currentLineType, null, null, finalHeading);
            savePlanToLocalStorage();
        }
    }

    function createFinalLine(start, end, stepId, altitude = '', speed = '', performCollisionCheck = false, lineType = 'standard', startAltitude, endAltitude, heading) {
        const lineId = `plan-line-${stepId}`;
        const style = (currentMapMode === "terrain") ? FLIGHT_LINE_STYLES_TERRAIN[lineType] : FLIGHT_LINE_STYLES_REGULAR[lineType];

        addSourceAndLayer(lineId,
            { type: 'geojson', data: { type: 'LineString', coordinates: [[start.lng, start.lat], [end.lng, end.lat]] } },
            { type: 'line', paint: style }
        );

        if (!heading) {
             const trueHeading = calculateHeading(start, end);
             let magneticHeading = trueHeading;
             if (wmmModel) {
                 const midPoint = { lat: (start.lat + end.lat) / 2, lng: (start.lng + end.lng) / 2 };
                 const declination = wmmModel.field(midPoint.lat, midPoint.lng).declination;
                 magneticHeading = (trueHeading - declination + 360) % 360;
             }
             heading = {
                magnetic: Math.round(magneticHeading).toString().padStart(3, '0'),
                true: Math.round(trueHeading).toString().padStart(3, '0')
             };
        }

        const initialHtml = `<div class="flight-data-block"><div class="fdb-heading">${heading.magnetic}° M</div><div class="fdb-row"><div class="fdb-data-item fdb-airspeed"><span class="fdb-value">---</span><span class="fdb-unit">kts</span></div><div class="fdb-data-item fdb-altitude"><span class="fdb-value">---</span><span class="fdb-unit">ft</span></div></div></div>`;
        const el = document.createElement('div');
        el.innerHTML = initialHtml;

        let labelPos = getOptimalLabelPosition(start, end);

        const label = new maptilersdk.Marker({element: el, draggable: true})
            .setLngLat(labelPos)
            .addTo(map);

        label.on('dragend', () => {
            planLayers[stepId].labelPosition = label.getLngLat();
            planLayers[stepId].hasBeenDragged = true;
            savePlanToLocalStorage();
        });
        planLabels[stepId] = label;

        planLayers[stepId] = { start, end, labelPosition: labelPos, altitude, speed, lineType, hasBeenDragged: false, label, heading, startAltitude, endAltitude };

        addPlanStep(stepId, heading, turf.distance([start.lng, start.lat], [end.lng, end.lat], {units: 'meters'}), altitude, speed, lineType);
        updateAltitudeForLeg(stepId);
        updateAllFlightDataBlockStyles();
    }

    // --- HELPER FUNCTIONS ---

    /**
     * Determines the appropriate icon name for an aircraft based on its type.
     * @param {string} aircraftName - The name of the aircraft.
     * @param {boolean} isSelected - Whether the aircraft is currently selected.
     * @returns {string} The name of the icon registered with the map style.
     */
    function getAircraftIconName(aircraftName, isSelected) {
        if (isSelected) {
            return 'icon-selected';
        }
        const lowerCaseName = (aircraftName || "").toLowerCase();
        const aircraftMap = {
            'a380': 'icon-a380',
            '747': 'icon-a380', 
        };
        for (const key in aircraftMap) {
            if (lowerCaseName.includes(key)) {
                return aircraftMap[key];
            }
        }
        return 'icon-default';
    }

    function calculateHeading(start, end) {
        const bearing = turf.bearing(
            turf.point([start.lng, start.lat]),
            turf.point([end.lng, end.lat])
        );
        return (bearing + 360) % 360;
    }

    const getMidPoint = (start, end) => ({
        lat: (start.lat + end.lat) / 2,
        lng: (start.lng + end.lng) / 2
    });

    function createDistanceRings(lat, lon) {
        const ringSpecs = [
            { nm: 10, label: "10 NM" },
            { nm: 20, label: "20 NM" },
            { nm: 30, label: "30 NM" }
        ];

        const ringLineFeatures = [];
        const ringLabelFeatures = [];

        ringSpecs.forEach(spec => {
            const circle = turf.circle([lon, lat], spec.nm, { units: 'nauticalmiles', steps: 128 });
            ringLineFeatures.push(circle);

            const labelPoint = turf.destination(
                turf.point([lon, lat]),
                spec.nm,
                45,
                { units: 'nauticalmiles' }
            );
            labelPoint.properties = {
                labelText: spec.label
            };
            ringLabelFeatures.push(labelPoint);
        });

        const ringLinesGeoJSON = { type: 'FeatureCollection', features: ringLineFeatures };
        const ringLabelsGeoJSON = { type: 'FeatureCollection', features: ringLabelFeatures };

        addSourceAndLayer('distance-rings-casing',
            { type: 'geojson', data: ringLinesGeoJSON },
            { type: 'line', paint: { 'line-color': '#000000', 'line-width': 3, 'line-opacity': 0.6 } }
        );
        addSourceAndLayer('distance-rings',
            { type: 'geojson', data: ringLinesGeoJSON },
            { type: 'line', paint: { 'line-color': '#FFFFFF', 'line-width': 1.5, 'line-dasharray': [4, 6] } }
        );
        addSourceAndLayer('distance-ring-labels',
            { type: 'geojson', data: ringLabelsGeoJSON },
            {
                type: 'symbol',
                layout: {
                    'text-field': ['get', 'labelText'],
                    'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
                    'text-size': 14,
                    'text-allow-overlap': true
                },
                paint: { 'text-color': '#FFFFFF', 'text-halo-color': '#000000', 'text-halo-width': 2 }
            }
        );
    }

     function getAirportColor(type) {
        switch (type) {
            case 'large_airport': return '#FF0000';
            case 'medium_airport': return '#FFA500';
            case 'small_airport': return '#2980b9';
            default: return '#95a5a6';
        }
    }
    function getAirportRadius(type) {
        switch (type) {
            case 'large_airport': return 7;
            case 'medium_airport': return 5;
            default: return 3;
        }
    }

    function createRunwayLabelFeature(ident, point, bearing) {
        if (!ident) return null;
        const axialOffset = 0.35; // km
        let pos = turf.destination(point, axialOffset, bearing, { units: 'kilometers' });
        return {
            type: 'Feature',
            geometry: pos.geometry,
            properties: { ident: ident }
        };
    }

    function createFinalApproachConeFeature(runwayEnd, bearing) {
        const finalDistNM = 10;
        const finalWidthNM = 1.0;
        const baseCenter = turf.destination(runwayEnd, finalDistNM, bearing, { units: 'nauticalmiles' });
        const p1 = turf.destination(baseCenter, finalWidthNM, bearing - 90, { units: 'nauticalmiles' });
        const p2 = turf.destination(baseCenter, finalWidthNM, bearing + 90, { units: 'nauticalmiles' });
        const coneCoords = [[ p1.geometry.coordinates, p2.geometry.coordinates, runwayEnd.geometry.coordinates, p1.geometry.coordinates ]];
        return turf.polygon(coneCoords);
    }
     function createFinalApproachCenterlineFeature(runwayEnd, bearing) {
        const finalDistNM = 10;
        const baseCenter = turf.destination(runwayEnd, finalDistNM, bearing, { units: 'nauticalmiles' });
         return {
            type: 'Feature',
            geometry: {
                type: 'LineString',
                coordinates: [runwayEnd.geometry.coordinates, baseCenter.geometry.coordinates]
            }
        };
    }

    async function getRunwaysForAirport(icao) {
        const allRunways = await getRunways();
        return allRunways.filter(r => r.airport_ident === icao);
    }

    function updateAllFlightDataBlockStyles() {
        Object.keys(planLayers).forEach(stepId => updateDataBlock(stepId));
    }

     function updateDataBlock(stepId) {
        const legData = planLayers[stepId];
        if (!legData || !legData.label) return;

        const markerElement = legData.label.getElement();

        if (!appSettings.showDataBlocks) {
            markerElement.style.display = 'none';
            return;
        }

        markerElement.style.display = 'block';

        const startAlt = legData.startAltitude;
        const endAlt = legData.endAltitude;
        let altitudeHtml;

        if (startAlt !== undefined && endAlt !== undefined && startAlt !== endAlt) {
            altitudeHtml = `<div class="fdb-data-item fdb-altitude"><span class="fdb-value" style="font-size: 12px; color: #FFD700;">${(startAlt / 1000).toFixed(1).replace('.0','')}k &rarr; ${(endAlt / 1000).toFixed(1).replace('.0','')}k</span><span class="fdb-unit">ft</span></div>`;
            const color = endAlt < startAlt ? '#FF8C00' : '#39FF14';
             if (map.getLayer(`plan-line-${stepId}-layer`)) {
                map.setPaintProperty(`plan-line-${stepId}-layer`, 'line-color', color);
            }

        } else {
            const displayAlt = legData.altitude || startAlt;
            let altValueText = '---';
            if (displayAlt || displayAlt === 0) {
                altValueText = (displayAlt % 1000 === 0) ? `${displayAlt / 1000}k` : `${(displayAlt / 1000).toFixed(1)}k`;
            }
            altitudeHtml = `<div class="fdb-data-item fdb-altitude"><span class="fdb-value">${altValueText}</span><span class="fdb-unit">ft</span></div>`;

            const style = (currentMapMode === "terrain") ? FLIGHT_LINE_STYLES_TERRAIN[legData.lineType] : FLIGHT_LINE_STYLES_REGULAR[legData.lineType];
             if (map.getLayer(`plan-line-${stepId}-layer`)) {
                map.setPaintProperty(`plan-line-${stepId}-layer`, 'line-color', style['line-color']);
            }
        }

        const speed = legData.speed || '---';
        const headingToShow = appSettings.useTrueHeading ? legData.heading.true : legData.heading.magnetic;
        const headingUnit = appSettings.useTrueHeading ? '° T' : '° M';

        const fullHtml = `<div class="flight-data-block" style="transform: translate(-50%, -50%) scale(${appSettings.dataBlockScale});">
                            <div class="fdb-heading">${headingToShow}${headingUnit}</div>
                            <div class="fdb-row">
                                <div class="fdb-data-item fdb-airspeed"><span class="fdb-value">${speed}</span><span class="fdb-unit">kts</span></div>
                                ${altitudeHtml}
                            </div>
                          </div>`;

        markerElement.innerHTML = fullHtml;
    }
     function saveSettings() {
        localStorage.setItem('atcPlannerSettings', JSON.stringify(appSettings));
    }

    function loadSettings() {
        const savedSettings = localStorage.getItem('atcPlannerSettings');
        if (savedSettings) {
            const parsedSettings = JSON.parse(savedSettings);
            appSettings = { ...appSettings, ...parsedSettings };
        }
    }

    function savePlanToLocalStorage() {
        const planData = Object.keys(planLayers).map(key => {
            const layer = planLayers[key];
            return {
                stepId: key,
                start: layer.start,
                end: layer.end,
                labelPosition: layer.labelPosition,
                altitude: layer.altitude,
                speed: layer.speed,
                lineType: layer.lineType,
                hasBeenDragged: layer.hasBeenDragged,
                heading: layer.heading,
                startAltitude: layer.startAltitude,
                endAltitude: layer.endAltitude
            };
        });
        localStorage.setItem('flightPlan', JSON.stringify(planData));
    }
     function loadPlanFromLocalStorage() {
        const savedPlan = localStorage.getItem('flightPlan');
        if (savedPlan) {
            const planData = JSON.parse(savedPlan);
            planData.forEach(data => {
                const start = { lat: data.start.lat, lng: data.start.lng };
                const end = { lat: data.end.lat, lng: data.end.lng };

                createFinalLine(start, end, data.stepId, data.altitude, data.speed, false, data.lineType, data.startAltitude, data.endAltitude, data.heading);

                if (data.labelPosition) {
                    const labelPos = { lat: data.labelPosition.lat, lng: data.labelPosition.lng };
                    planLabels[data.stepId].setLngLat(labelPos);
                    planLayers[data.stepId].labelPosition = labelPos;
                }
                if(data.hasBeenDragged){
                    planLayers[data.stepId].hasBeenDragged = true;
                }
            });
        }
        updateAllFlightDataBlockStyles();
    }
     async function getElevationAndMag(latlng) {
    let magVarText = "Mag Var: N/A";
    if (wmmModel) {
         const point = wmmModel.field(latlng.lat, latlng.lng);
         magVarText = `Mag Var: ${point.declination.toFixed(2)}°`;
    }
    try {
        const response = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${latlng.lat}&longitude=${latlng.lng}`);
        if (!response.ok) throw new Error(`API error`);
        const data = await response.json();
        const elevationMeters = data.elevation[0];

        let msaText = "MSA: --"; 

        if (elevationMeters !== null && elevationMeters >= 0) {
            const terrainElevationFeet = elevationMeters * 3.28084;
            const calculatedMsa = terrainElevationFeet + 2000;
            const roundedAltitude = Math.round(calculatedMsa / 1000) * 1000;
            const displayAltitude = Math.max(roundedAltitude, 2000);
            msaText = `MSA: ${displayAltitude.toLocaleString()}'`;
        }
        mslPopup.innerHTML = `${msaText}<br>${magVarText}`;
    } catch (error) {
        console.error("Failed to fetch elevation data:", error);
        mslPopup.innerHTML = `MSA: Unavailable<br>${magVarText}`;
    }
}
     function getOptimalLabelPosition(start, end) {
        const midPoint = getMidPoint(start, end);
        const startPoint = turf.point([start.lng, start.lat]);
        if (!currentAirportCoords) return midPoint;

        const airportPoint = turf.point([currentAirportCoords.lng, currentAirportCoords.lat]);
        const distanceToAirport = turf.distance(turf.point([midPoint.lng, midPoint.lat]), airportPoint, { units: 'meters' });

        if (distanceToAirport > 3000) {
            return midPoint;
        }

        return {
            lat: start.lat + (end.lat - start.lat) * 0.75,
            lng: start.lng + (end.lng - start.lng) * 0.75
        };
    }
     function createOrShowPlanPanel() {
        let planPanel = document.getElementById('plan-panel');
        if (planPanel) {
            planPanel.style.display = 'block';
            const reopenPlanButton = document.getElementById('reopen-plan-panel');
            if (reopenPlanButton) reopenPlanButton.style.display = 'none';
            return;
        }

        const planHTML = `
            <button id="clear-plan" style="width: 100%; margin-bottom: 10px; background-color: var(--danger-color);">Clear Plan</button>
            <div style="font-size: 11px; color: #ccc; margin: 0 0 10px 2px; padding: 5px; text-align: center; border: 1px dashed #555; border-radius: 4px;">
                Right-click a flight plan leg to open the Altitude Profile Editor.
            </div>
            <div id="plan-sections">
                <div class="plan-section">
                    <div class="plan-section-header departure" data-section="departure">Departures</div>
                    <div class="plan-section-content" id="departure-steps" style="max-height: 150px; overflow-y: auto;"></div>
                </div>
                <div class="plan-section">
                    <div class="plan-section-header arrival" data-section="arrival">Arrivals</div>
                    <div class="plan-section-content" id="arrival-steps" style="max-height: 150px; overflow-y: auto;"></div>
                </div>
                <div class="plan-section">
                    <div class="plan-section-header standard" data-section="standard">Standard</div>
                    <div class="plan-section-content" id="standard-steps" style="max-height: 150px; overflow-y: auto;"></div>
                </div>
            </div>`;

        planPanel = createFloatingPanel('plan-panel', '<h2>Flight Plan</h2>', '20px', 'auto', planHTML);
        planPanel.style.right = '20px';

        planPanel.querySelector('#clear-plan').addEventListener('click', () => {
            Object.keys(planLayers).forEach(key => {
                 if (map.getLayer(`plan-line-${key}-layer`)) map.removeLayer(`plan-line-${key}-layer`);
                 if (map.getSource(`plan-line-${key}-source`)) map.removeSource(`plan-line-${key}-source`);
                 if (planLabels[key]) planLabels[key].remove();
                 delete planLabels[key];
                 delete planLayers[key];
            });

            planPanel.querySelectorAll('.plan-step').forEach(step => step.remove());
            localStorage.removeItem('flightPlan');
        });

        const allSectionHeaders = planPanel.querySelectorAll('.plan-section-header');
        allSectionHeaders.forEach(headerToListenOn => {
            headerToListenOn.addEventListener('click', (e) => {
                const clickedHeader = e.currentTarget;
                const contentToShow = clickedHeader.nextElementSibling;
                const isAlreadyVisible = contentToShow.style.display === 'block';

                allSectionHeaders.forEach(anyHeader => {
                    anyHeader.nextElementSibling.style.display = 'none';
                });

                if (!isAlreadyVisible) {
                    contentToShow.style.display = 'block';
                }
            });
        });
    }
     function addPlanStep(stepId, heading, distanceMeters, altitude = '', speed = '', lineType = 'standard') {
        createOrShowPlanPanel();
        const sectionMap = { standard: 'standard-steps', arrival: 'arrival-steps', departure: 'departure-steps' };
        const planContainerId = sectionMap[lineType] || 'standard-steps';
        const planContainer = document.getElementById(planContainerId);
        if (!planContainer) return;
        const allContentAreas = document.querySelectorAll('.plan-section-content');
        allContentAreas.forEach(area => {
            if (area.id !== planContainerId) {
                area.style.display = 'none';
            }
        });
        planContainer.style.display = 'block';
        const distanceNM = (distanceMeters / 1852).toFixed(1);
        const stepDiv = document.createElement('div');
        stepDiv.className = 'plan-step';
        stepDiv.id = stepId;
        stepDiv.innerHTML = `
            <div class="plan-step-details" title="Right-click to edit altitude profile">
                <span class="plan-leg-info"><b>Leg:</b> <span class="plan-heading-text" style="cursor: pointer; font-weight: bold;" title="Click to edit heading">Hdg ${heading.magnetic}° M</span> / ${distanceNM} NM</span>
                <button class="delete-step-btn" data-step-id="${stepId}">X</button>
            </div>
            <div class="plan-step-inputs">
                <div><label>Alt (ft):</label><input type="number" id="alt-${stepId}" value="${altitude}" placeholder="10000" step="100"></div>
                <div><label>Speed (kts):</label><input type="number" id="speed-${stepId}" value="${speed}" placeholder="250"></div>
            </div>`;
        planContainer.appendChild(stepDiv);
        stepDiv.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            createAltitudeProfilePanel(stepId);
        });
        const headingSpan = stepDiv.querySelector('.plan-heading-text');
        headingSpan.addEventListener('click', () => {
            const currentHeading = planLayers[stepId].heading.magnetic;
            const input = document.createElement('input');
            input.type = 'number';
            input.value = currentHeading;
            input.className = 'heading-edit-input';
            input.style.width = '40px';
            input.style.backgroundColor = '#333';
            input.style.color = '#fff';
            input.style.border = '1px solid #777';
            input.style.borderRadius = '4px';
            headingSpan.parentElement.replaceChild(input, headingSpan);
            input.focus();
            input.select();
            const saveHeading = () => {
                let newHeading = parseInt(input.value, 10);
                if (!isNaN(newHeading)) {
                    newHeading = (newHeading + 360) % 360;
                    const newHeadingText = newHeading.toString().padStart(3, '0');
                    planLayers[stepId].heading.magnetic = newHeadingText;
                    headingSpan.textContent = `Hdg ${newHeadingText}° M`;
                    updateDataBlock(stepId);
                }
                input.parentElement.replaceChild(headingSpan, input);
                savePlanToLocalStorage();
            };
            input.addEventListener('blur', saveHeading);
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    saveHeading();
                } else if (e.key === 'Escape') {
                    input.parentElement.replaceChild(headingSpan, input);
                }
            });
        });
        stepDiv.querySelector('.delete-step-btn').addEventListener('click', function() {
            const idToDelete = this.getAttribute('data-step-id');
             if (map.getLayer(`plan-line-${idToDelete}-layer`)) map.removeLayer(`plan-line-${idToDelete}-layer`);
             if (map.getSource(`plan-line-${idToDelete}-source`)) map.removeSource(`plan-line-${idToDelete}-source`);
             if (planLabels[idToDelete]) planLabels[idToDelete].remove();
             delete planLabels[idToDelete];
             delete planLayers[idToDelete];
             savePlanToLocalStorage();
            this.closest('.plan-step').remove();
        });
        document.getElementById(`alt-${stepId}`).addEventListener('input', (e) => {
            const legData = planLayers[stepId];
            const value = e.target.value;
            if (value === '') {
                legData.altitude = undefined;
                legData.startAltitude = undefined;
                legData.endAltitude = undefined;
            } else {
                const newAlt = parseInt(value, 10);
                if (!isNaN(newAlt)) {
                    legData.altitude = newAlt;
                    legData.startAltitude = newAlt;
                    legData.endAltitude = newAlt;
                }
            }
            updateAltitudeForLeg(stepId);
            savePlanToLocalStorage();
        });
        document.getElementById(`speed-${stepId}`).addEventListener('input', (e) => {
            const legData = planLayers[stepId];
            legData.speed = e.target.value;
            updateDataBlock(stepId);
            savePlanToLocalStorage();
        });
    }

    function adjustAllLabelPositions() {
        Object.keys(planLayers).forEach(key => {
            const layer = planLayers[key];
            if (!layer.hasBeenDragged) {
                const optimalPos = getOptimalLabelPosition(layer.start, layer.end);
                layer.label.setLngLat(optimalPos);
                layer.labelPosition = optimalPos;
            }
        });
    }
     function updateAltitudeForLeg(stepId) {
        const legData = planLayers[stepId];
        if (!legData) return;
        const startAlt = legData.startAltitude;
        const endAlt = legData.endAltitude;
        const altitudeInput = document.getElementById(`alt-${stepId}`);
        if (startAlt !== undefined && endAlt !== undefined && startAlt !== endAlt) {
            if (altitudeInput) altitudeInput.value = '';
            legData.altitude = '';
        } else {
            const displayAlt = legData.altitude || startAlt;
            if (altitudeInput) altitudeInput.value = displayAlt || '';
        }
        updateDataBlock(stepId);
    }
     function createAltitudeProfilePanel(stepId) {
        let panel = document.getElementById('altitude-profile-panel');
        if (panel) {
            panel.remove();
            if (altitudeChart) {
                altitudeChart.destroy();
                altitudeChart = null;
            }
        }

        const legData = planLayers[stepId];
        const title = `Altitude Profile: Leg ${legData.heading.magnetic}°`;

        const content = `
            <div style="display: flex; justify-content: space-between; gap: 10px; margin-bottom: 10px;">
                <div>
                    <label for="start-alt-input" style="font-size: 12px;">Start Alt (ft)</label>
                    <input type="number" id="start-alt-input" step="100">
                </div>
                <div>
                    <label for="end-alt-input" style="font-size: 12px;">End Alt (ft)</label>
                    <input type="number" id="end-alt-input" step="100">
                </div>
            </div>
            <canvas id="altitude-chart"></canvas>
        `;
        panel = createFloatingPanel('altitude-profile-panel', `<h2>${title}</h2>`, '150px', '150px', content);

        const ctx = document.getElementById('altitude-chart').getContext('2d');
        const startAltInput = document.getElementById('start-alt-input');
        const endAltInput = document.getElementById('end-alt-input');

        const startAltitude = legData.startAltitude || (legData.altitude ? parseInt(legData.altitude) : 10000);
        const endAltitude = legData.endAltitude || startAltitude;

        startAltInput.value = startAltitude;
        endAltInput.value = endAltitude;

        altitudeChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: ['Start', 'End'],
                datasets: [{
                    label: 'Altitude Profile (ft)',
                    data: [startAltitude, endAltitude],
                    borderColor: '#64b5f6',
                    backgroundColor: 'rgba(100, 181, 246, 0.5)',
                    fill: true,
                    tension: 0.1,
                    pointRadius: 10,
                    pointHoverRadius: 12
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    dragData: {
                        round: 100,
                        showTooltip: true,
                        onDragEnd: (e, datasetIndex, index, value) => {
                            if (index === 0) {
                                legData.startAltitude = value;
                            } else {
                                legData.endAltitude = value;
                            }
                            legData.altitude = '';
                            updateAltitudeForLeg(stepId);
                            savePlanToLocalStorage();
                        }
                    },
                    legend: { display: false }
                },
                scales: {
                    y: {
                        beginAtZero: false,
                        ticks: { color: '#fff', callback: (value) => value + ' ft' },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' }
                    },
                    x: {
                        ticks: { color: '#fff' },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' }
                    }
                }
            }
        });

        const updateFromInput = () => {
            const newStartAlt = parseInt(startAltInput.value);
            const newEndAlt = parseInt(endAltInput.value);
            legData.startAltitude = newStartAlt;
            legData.endAltitude = newEndAlt;
            legData.altitude = '';
            altitudeChart.data.datasets[0].data = [newStartAlt, newEndAlt];
            altitudeChart.update();
            updateAltitudeForLeg(stepId);
            savePlanToLocalStorage();
        };

        startAltInput.addEventListener('input', updateFromInput);
        endAltInput.addEventListener('input', updateFromInput);
    }
});