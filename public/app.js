// app.js (updated for real-time magnetic declination and Infinite Flight Live API)
document.addEventListener('DOMContentLoaded', () => {
    // --- API & SETTINGS ---
    // The API key is handled by the server-side proxy, not here.

    delete L.Icon.Default.prototype._getIconUrl;
    L.Icon.Default.mergeOptions({
        iconRetinaUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        iconUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        shadowUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
    });

    // --- MAP INITIALIZATION ---
    const map = L.map('map', {
        center: [39.82, -98.57],
        zoom: 5,
        scrollWheelZoom: true,
        wheelPxPerZoomLevel: 150,
        maxBounds: [[-90, -180], [90, 180]],
        minZoom: 2
    });

    const darkBaseLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
        noWrap: true
    }).addTo(map);

    const hillshadeLayer = L.tileLayer(
        'https://services.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}', {
            attribution: 'Hillshade: &copy; Esri, USGS, NOAA',
            opacity: 0.85,
            noWrap: true
        }
    );

    const stamenTerrainLayer = L.tileLayer('https://stamen-tiles-{s}.a.ssl.fastly.net/terrain/{z}/{x}/{y}{r}.png', {
        attribution: 'Map tiles by <a href="http://stamen.com">Stamen Design</a>, <a href="http://creativecommons.org/licenses/by/3.0">CC BY 3.0</a> &mdash; Map data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        subdomains: 'abcd',
        minZoom: 0,
        maxZoom: 18,
    });

    const esriWorldShadedRelief = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Shaded_Relief/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; Esri &mdash; Source: Esri',
        maxZoom: 13
    });

    // --- GLOBAL VARIABLES & LAYER GROUPS ---
    const hubDotsGroup = new L.FeatureGroup().addTo(map);
	const flightPlanRouteGroup = new L.FeatureGroup().addTo(map);
    const airportDetailsGroup = new L.FeatureGroup().addTo(map);
    const runwayLabelsGroup = new L.FeatureGroup().addTo(map);
    const dynamicRunwaysGroup = new L.FeatureGroup().addTo(map);
    const planItemsGroup = new L.FeatureGroup().addTo(map);
    const planLabelsGroup = new L.FeatureGroup().addTo(map);
    const navaidsGroup = new L.FeatureGroup().addTo(map);
    const waypointsGroup = new L.FeatureGroup().addTo(map);
    const finalApproachGroup = new L.FeatureGroup().addTo(map);
    const liveAircraftGroup = new L.FeatureGroup().addTo(map); // NEW: For live aircraft

    const mslPopup = document.getElementById('msl-popup');
    const reopenButton = document.getElementById('reopen-main-panel');

    let isDrawingEnabled = false;
    let isDrawing = false;
    let tempLine, tempLabel;
    let elevationRequestTimeout;
    let navaidRequestTimeout;
    let currentLineType = 'standard';

    const planLayers = {};
    let currentAirportCoords = null;
    let activeAirportIcao = null;
    let currentMapMode = "regular";
    let runwayLayers = {};
    let appSettings = { dataBlockScale: 1.0, showDataBlocks: true, useTrueHeading: false };
    let altitudeChart = null;
    let wmmModel = null;

    // --- NEW: Live Mode Variables ---
    let inactivityTimer;
    let liveUpdateInterval;
    let liveFlightMarkers = {};
    let isLiveModeActive = false;

    // --- Layer control with all terrain and navaid options ---
    const baseLayers = { "Dark Map": darkBaseLayer };
    const overlayLayers = {
        "Terrain (Hillshade)": hillshadeLayer,
        "Terrain (3D Feel)": stamenTerrainLayer,
        "Terrain (Drastic 3D)": esriWorldShadedRelief,
        "Live Aircraft": liveAircraftGroup // NEW: Layer control for live traffic
    };
    L.control.layers(baseLayers, overlayLayers, {position: 'bottomright'}).addTo(map);

    // --- Style configs ---
    const RUNWAY_STYLE_REGULAR = { color: '#AAAAAA', weight: 1, fillColor: '#707070', fillOpacity: 1 };
    const RUNWAY_STYLE_HIGHLIGHT = { color: '#FFD700', weight: 2, fillColor: '#FFD700', fillOpacity: 0.7 };
    const RUNWAY_CENTERLINE_STYLE_REGULAR = { color: '#FFFFFF', weight: 1, dashArray: '10, 15' };
    const FLIGHT_LINE_STYLES_REGULAR = {
        standard: { color: 'white', weight: 2, opacity: 1 },
        arrival: { color: '#64b5f6', weight: 2, opacity: 1 },
        departure: { color: '#e57373', weight: 2, opacity: 1 }
    };
    const RUNWAY_STYLE_TERRAIN = { color: '#222', weight: 2, fillColor: '#444', fillOpacity: 0.95, opacity: 1 };
    const RUNWAY_CENTERLINE_STYLE_TERRAIN = { color: '#F5F5F5', weight: 2, dashArray: '6, 12', opacity: 1 };
    const FLIGHT_LINE_STYLES_TERRAIN = {
        standard: { color: '#000', weight: 4, opacity: 1 },
        arrival:  { color: '#2979FF', weight: 4, opacity: 1 },
        departure:{ color: '#FF3D00', weight: 4, opacity: 1 }
    };
    const FINAL_APPROACH_STYLE = {
        color: 'rgba(0, 255, 255, 0.5)',
        weight: 1,
        fillColor: 'rgba(0, 255, 255, 0.1)',
        fillOpacity: 0.5
    };
    const FINAL_APPROACH_CENTERLINE_STYLE = {
        color: 'rgba(0, 255, 255, 0.8)',
        weight: 1,
        dashArray: '5, 5'
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
            // Path is relative to the root of the site (the Public folder)
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
            wmmModel = geomag; // Assign the global geomag object from geomag.min.js
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
        
        updateAirports();
        // ★★★ FIX APPLIED HERE ★★★
        updateNavaids(); 
        setupEventListeners();
        loadPlanFromLocalStorage();

        const loader = document.getElementById('loader');
        if (loader) {
            loader.classList.add('hidden');
        }
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
        if (isLiveModeActive) {
            startInactivityTimer();
        }
    }

    // --- EVENT HANDLERS ---
    map.on('overlayadd', function(e) {
        if (e.layer === hillshadeLayer || e.layer === stamenTerrainLayer || e.layer === esriWorldShadedRelief) {
            currentMapMode = "terrain";
            restyleAllRunwaysAndLines();
        }
    });
    map.on('overlayremove', function(e) {
        if (e.layer === hillshadeLayer || e.layer === stamenTerrainLayer || e.layer === esriWorldShadedRelief) {
            if (!map.hasLayer(hillshadeLayer) && !map.hasLayer(stamenTerrainLayer) && !map.hasLayer(esriWorldShadedRelief)) {
                currentMapMode = "regular";
                restyleAllRunwaysAndLines();
            }
        }
    });

    function setupEventListeners() {
        map.getContainer().addEventListener('contextmenu', (e) => e.preventDefault());
        map.on('mousedown', handleMouseDown);
        map.on('mousemove', handleMouseMove);
        map.on('mouseup', handleMouseUp);
        map.on('zoomend moveend', () => { 
            checkAirportDetailsVisibility();
            checkPlanLabelVisibility();
            checkRunwayLabelVisibility();
            updateAirports();
            updateWaypoints(); 
            adjustAllLabelPositions();

            clearTimeout(navaidRequestTimeout);
            navaidRequestTimeout = setTimeout(updateNavaids, 500); 
        });
        
        map.on('mousemove', (e) => {
            if (isDrawingEnabled || !mslPopup) return;
            mslPopup.style.left = `${e.containerPoint.x + 15}px`;
            mslPopup.style.top = `${e.containerPoint.y}px`;
            mslPopup.style.display = 'block';

            let magVarText = "Mag Var: N/A";
            if (wmmModel) {
                const point = wmmModel.field(e.latlng.lat, e.latlng.lng);
                const declination = point.declination;
                magVarText = `Mag Var: ${declination.toFixed(2)}°`;
            }

            mslPopup.innerHTML = 'MSL: Loading...<br>' + magVarText;
            
            clearTimeout(elevationRequestTimeout);
            elevationRequestTimeout = setTimeout(() => getElevationAndMag(e.latlng), 50);
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
        
        // Add listeners for inactivity reset
        document.addEventListener('mousemove', resetInactivityTimer, false);
        document.addEventListener('keydown', resetInactivityTimer, false);
        document.addEventListener('click', resetInactivityTimer, false);
    }
	
	document.addEventListener('click', async function (e) {
    // Only run if the button was clicked
    if (e.target && e.target.classList.contains('view-fpl-btn')) {
        e.preventDefault();

        // Try to get flightId and callsign safely
        const flightId = e.target.getAttribute('data-flight-id') || '';
        let callsign = 'Unknown';
        try {
            const popup = e.target.closest('.leaflet-popup-content');
            if (popup) {
                const boldTag = popup.querySelector('b');
                if (boldTag && boldTag.textContent) {
                    // Use the first word before space as callsign
                    callsign = boldTag.textContent.split(' ')[0];
                }
            }
        } catch (err) {
            console.warn("Could not extract callsign:", err);
        }

        // Log for debugging
        console.log('[FPL Button] Clicked:', { flightId, callsign });

        if (!flightId) {
            alert('No valid flight plan ID found.');
            return;
        }

        // Call the new fetch/display function
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

        L.DomEvent.disableClickPropagation(panel);
        L.DomEvent.disableScrollPropagation(panel);

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
            <h3>Filters</h3>
            <div id="airport-filters">
                <input type="checkbox" id="filter-large" value="large_airport" checked> <label for="filter-large" style="color: #fff; font-weight: normal;">Large</label><br>
                <input type="checkbox" id="filter-medium" value="medium_airport" checked> <label for="filter-medium" style="color: #fff; font-weight: normal;">Medium</label><br>
                <input type="checkbox" id="filter-small" value="small_airport" checked> <label for="filter-small" style="color: #fff; font-weight: normal;">Small</label>
            </div>
            <div id="navaid-filters" style="margin-top: 10px;">
                <input type="checkbox" id="filter-navaids" checked> <label for="filter-navaids" style="color: #fff; font-weight: normal;">Show VORs</label><br>
                <input type="checkbox" id="filter-waypoints" checked> <label for="filter-waypoints" style="color: #fff; font-weight: normal;">Show Waypoints</label>
            </div>
            <h3 style="margin-top: 15px;">Tools</h3>
            <div id="drawing-toggle">
                 <input type="checkbox" id="enable-drawing">
                 <label for="enable-drawing" style="color: #fff; font-weight: normal;">Enable Drawing Mode</label>
                 <span id="drawing-mode-text" style="font-size: 11px; color: #ccc; display: none; padding-left: 18px;">Uncheck to move the map</span>
            </div>
            <div id="line-type-selector" style="margin-top: 10px;">
                <label style="color: #fff; font-weight: normal; width: 100%; margin-bottom: 5px;">Line Type:</label>
                <div>
                    <span><input type="radio" id="line-standard" name="line-type" value="standard" checked> <label for="line-standard" style="color: #fff; font-weight: normal;">Standard</label></span>
                    <span><input type="radio" id="line-arrival" name="line-type" value="arrival"> <label for="line-arrival" style="color: #64b5f6; font-weight: normal;">Arrival</label></span>
                    <span><input type="radio" id="line-departure" name="line-type" value="departure"> <label for="line-departure" style="color: #e57373; font-weight: normal;">Departure</label></span>
                </div>
            </div>
            <div id="final-approach-toggle" style="margin-top: 10px;">
                <input type="checkbox" id="enable-final-approach" checked>
                <label for="enable-final-approach" style="color: #fff; font-weight: normal;">Show 10nm Final</label>
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
        mainPanel.querySelector('#clear-selection-btn').addEventListener('click', () => {
            activeAirportIcao = null;
            airportDetailsGroup.clearLayers();
            runwayLabelsGroup.clearLayers();
            finalApproachGroup.clearLayers();
            const infoPanel = document.getElementById('airport-info-panel');
            if (infoPanel) infoPanel.remove();
            
            mainPanel.querySelector('#clear-selection-btn').style.display = 'none';
            const clearText = document.getElementById('clear-selection-text');
            if (clearText) clearText.style.display = 'none';

            updateAirports();
        });
        mainPanel.querySelector('#airport-filters').addEventListener('change', updateAirports);
        mainPanel.querySelector('#navaid-filters').addEventListener('change', (e) => {
            updateNavaids();
            updateWaypoints();
        });
				
        mainPanel.querySelector('#enable-drawing').addEventListener('change', (e) => {
            isDrawingEnabled = e.target.checked;
            const drawingText = document.getElementById('drawing-mode-text');
            if (isDrawingEnabled) {
                map.dragging.disable();
                map.getContainer().style.cursor = 'crosshair';
                if (drawingText) drawingText.style.display = 'block';
                createOrShowPlanPanel();
            } else {
                map.dragging.enable();
                map.getContainer().style.cursor = '';
                if (drawingText) drawingText.style.display = 'none';
            }
        });
        mainPanel.querySelector('#line-type-selector').addEventListener('change', (e) => {
            if (e.target.name === 'line-type') {
                currentLineType = e.target.value;
            }
        });
        mainPanel.querySelector('#enable-final-approach').addEventListener('change', (e) => {
            if (e.target.checked) {
                map.addLayer(finalApproachGroup);
            } else {
                map.removeLayer(finalApproachGroup);
            }
        });

        // Add listeners for new buttons
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

    // Check if we are currently connected to a server
    if (connectBtn.textContent === 'Disconnect') {
        if (newSessionId) {
            // If a new server is selected, automatically switch
            stopLiveUpdates();
            startLiveUpdates(newSessionId);
        } else {
            // If the user chose the blank "Select a Server", disconnect
            stopLiveUpdates();
            connectBtn.textContent = 'Connect';
            connectBtn.style.backgroundColor = 'var(--accent)';
            statusIndicator.textContent = "Disconnected";
            statusIndicator.style.backgroundColor = '#777';
        }
      }
});
    }
    
    // --- LIVE MODE: DATA FETCHING AND DISPLAY ---
    function startLiveUpdates(sessionId) {
        stopLiveUpdates(); // Ensure no other loops are running
        isLiveModeActive = true;

        fetchAndDisplayData(sessionId);
        liveUpdateInterval = setInterval(() => fetchAndDisplayData(sessionId), 10000); // Update every 10 seconds

        startInactivityTimer();
    }

    function stopLiveUpdates() {
        clearInterval(liveUpdateInterval);
        clearTimeout(inactivityTimer);
        isLiveModeActive = false;
        liveAircraftGroup.clearLayers();
        liveFlightMarkers = {};
        const atcList = document.getElementById('atc-list');
        if (atcList) atcList.innerHTML = '<li>No ATC data.</li>';
    }

    async function fetchAndDisplayData(sessionId) {
    try {
        // Fetch flights
        const flightsResponse = await fetch(`/.netlify/functions/flights/${sessionId}`);
        const flightsData = await flightsResponse.json();
        if (flightsData.result) {
            updateFlightMarkers(flightsData.result);
        };

        // Fetch ATC
        const atcResponse = await fetch(`/.netlify/functions/atc/${sessionId}`);
        const atcData = await atcResponse.json();
        if (atcData.result) {
            // MODIFICATION: Pass flightsData.result here
            updateAtcList(atcData.result, flightsData.result || []); 
        };

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
    
    // THIS FUNCTION IS CORRECTED AND INCLUDES DEBUGGING LOGS
    function updateFlightMarkers(flights) {
    // --- DEBUGGING: Log what we received from the API ---
    console.log(`Received ${flights.length} flights from the API.`);

    const existingFlightIds = Object.keys(liveFlightMarkers);
    const incomingFlightIds = flights.map(f => f.flightId);
    let renderedCount = 0; // Counter for successfully rendered aircraft

    // Remove markers for flights that are no longer present
    existingFlightIds.forEach(flightId => {
        if (!incomingFlightIds.includes(flightId)) {
            if (liveFlightMarkers[flightId]) {
                map.removeLayer(liveFlightMarkers[flightId]);
            }
            delete liveFlightMarkers[flightId];
        }
    });

    flights.forEach((flight, index) => {
        // --- DEBUGGING: Log the actual values for the first 3 flights ---
        if (index < 3) {
            console.log(`Processing flight #${index}:`, {
                id: flight.id,
                flightId: flight.flightId,
                latitude: flight.latitude,
                longitude: flight.longitude,
                heading: flight.heading,
                callsign: flight.callsign,
                aircraftName: flight.aircraftName,
                username: flight.username,
                altitude: flight.altitude,
                speed: flight.speed
            });
        }

        // Parse latitude and longitude as numbers (handles both string and number)
        const lat = Number(flight.latitude);
        const lon = Number(flight.longitude);

        // Only skip if lat/lon are not valid numbers or flightId is null/undefined
        if (isNaN(lat) || isNaN(lon) || flight.flightId == null) {
            if (index < 3) {
                console.log(`--> SKIPPING flight #${index} due to missing/invalid coordinates or flightId.`, {
                    flightId: flight.flightId,
                    latitude: flight.latitude,
                    longitude: flight.longitude
                });
            }
            return;
        }

        const heading = flight.heading;
        const callsign = flight.callsign || 'N/A';

        const altitude = (typeof flight.altitude === 'number') ? Math.round(flight.altitude) : 
                         (typeof flight.altitude === 'string' && !isNaN(Number(flight.altitude))) ? Math.round(Number(flight.altitude)) : null;
        const speed = (typeof flight.speed === 'number') ? Math.round(flight.speed) :
                      (typeof flight.speed === 'string' && !isNaN(Number(flight.speed))) ? Math.round(Number(flight.speed)) : null;

        const altitudeText = altitude !== null ? `${altitude.toLocaleString()} ft` : '---';
        const speedText = speed !== null ? `${speed} kts GS` : '---';

const ownerUsername = "_ServerNoob";
let iconSrc = "/plane.png"; // Default icon

// Check if the flight belongs to the owner
if (flight.username === ownerUsername) {
    iconSrc = "/plane-yellow.png"; // Use the yellow icon for the owner
}

// Use the selected icon in the HTML
const iconHtml = `<img src="${iconSrc}" width="24" height="24" style="transform: rotate(${heading}deg);">`;

const aircraftIcon = L.divIcon({
    html: iconHtml,
    className: 'custom-map-marker',
    iconSize: [24, 24]
});

        const popupContent = `<b>${callsign} (${flight.aircraftName || 'N/A'})</b><br>
  User: ${flight.username || 'N/A'}<br>
  Altitude: ${altitudeText}<br>
  Speed: ${speedText}<br>
  ${
    flight.flightId
      ? `<button class="cta-button view-fpl-btn" data-flight-id="${flight.flightId}" style="width:100%; margin-top: 8px; padding: 5px 10px; font-size: 0.8rem;">View FPL</button>`
      : `<span style="font-size:0.8rem;color:#999;">No FPL</span>`
  }`;

if (liveFlightMarkers[flight.flightId]) {
    // Update existing marker
    liveFlightMarkers[flight.flightId].setLatLng([lat, lon]);
    liveFlightMarkers[flight.flightId].setIcon(aircraftIcon);
    liveFlightMarkers[flight.flightId].setPopupContent(popupContent); // Update the popup content
} else {
    // Create new marker
    const marker = L.marker([lat, lon], { icon: aircraftIcon });
    marker.bindPopup(popupContent);
    marker.addTo(liveAircraftGroup);
    liveFlightMarkers[flight.flightId] = marker;
}
        renderedCount++; // Increment the counter for successful renders
    });

    // --- DEBUGGING: Log the final count of rendered aircraft ---
    console.log(`Successfully rendered ${renderedCount} out of ${flights.length} aircraft.`);
}

	// app.js

async function fetchAndDisplayFlightPlan(flightId, callsign) {
    console.log(`[FPL] Initiating fetch for callsign: ${callsign} (Flight ID: ${flightId})`);

    // --- 1. Clear Previous Route ---
    // Ensure the layer group for the route exists and is cleared before drawing a new one.
    if (!flightPlanRouteGroup) {
        console.error("[FPL] Aborting: flightPlanRouteGroup is not defined on the map.");
        return;
    }
    flightPlanRouteGroup.clearLayers();

    // --- 2. Call the Serverless Function ---
    try {
        const response = await fetch(`/.netlify/functions/flightplan/${flightId}`);
        const data = await response.json();

        // --- 3. Handle Errors from the Serverless Function ---
        if (!response.ok || data.error) {
            console.error(`[FPL] Error response from server. Status: ${response.status}`, data);
            alert(`Could not retrieve flight plan for ${callsign}. Reason: ${data.details || data.error || 'Unknown server error'}`);
            return;
        }
        
        console.log(`[FPL] Received data for ${callsign}:`, data);

        // --- 4. Validate the Flight Plan Data ---
        // Ensure the flight plan has a 'result' object with a non-empty 'waypoints' array.
        if (!data.result || !Array.isArray(data.result.waypoints) || data.result.waypoints.length === 0) {
            console.warn(`[FPL] No flight plan waypoints found for ${callsign}.`);
            alert(`No flight plan has been filed for ${callsign}.`);
            return;
        }

        const waypoints = data.result.waypoints;

        // --- 5. Extract Coordinates ---
        const latLngs = waypoints.map(wp => {
            // Ensure latitude and longitude are valid numbers before adding them.
            const lat = Number(wp.latitude);
            const lon = Number(wp.longitude);
            if (isNaN(lat) || isNaN(lon)) {
                return null;
            }
            return [lat, lon];
        }).filter(coord => coord !== null); // Filter out any null entries

        if (latLngs.length < 2) {
             alert(`The flight plan for ${callsign} does not contain enough valid waypoints to draw a route.`);
             return;
        }

        // --- 6. Draw the Route and Markers on the Map ---
        // Create the main flight path line
        L.polyline(latLngs, {
            color: '#FFD600', // A bright, visible color
            weight: 3,
            opacity: 0.9,
            dashArray: '8, 8'
        }).addTo(flightPlanRouteGroup);

        // Add a small circle marker for each waypoint
        waypoints.forEach(wp => {
            // FIX APPLIED HERE: Check for malformed waypoint data
            if (!wp || isNaN(Number(wp.latitude)) || isNaN(Number(wp.longitude))) return;

            const lat = Number(wp.latitude);
            const lon = Number(wp.longitude);
            const name = wp.name || 'Waypoint'; // Provide a fallback for the name

            L.circleMarker([lat, lon], {
                radius: 4,
                color: '#FFD600',
                fillColor: '#1a1a1a',
                fillOpacity: 1
            }).bindTooltip(name, { // Use the safe name variable
                direction: 'top',
                className: 'waypoint-tooltip'
            }).addTo(flightPlanRouteGroup);
        });

        // --- 7. Fit Map to the New Route ---
        // Adjust the map view to show the entire flight plan with some padding.
        map.fitBounds(L.polyline(latLngs).getBounds().pad(0.1));

        console.log(`[FPL] Successfully displayed flight plan for ${callsign}.`);

    } catch (err) {
        console.error("[FPL] A critical error occurred during the fetch/display process:", err);
        alert(`An unexpected error occurred while trying to display the flight plan for ${callsign}.`);
    }
}
	
async function updateAtcList(atcFacilities, allFlights) {
    const atcList = document.getElementById('atc-list');
    if (!atcList) return;

    try {
        if (!atcFacilities || atcFacilities.length === 0) {
            atcList.innerHTML = '<div class="atc-airport-row">No active ATC on this server.</div>';
            return;
        }

        // This object will group ATC facilities by their ICAO code.
        const atcByIcao = {};
        const allAirports = await getAirports();

        // 1. Group all unique ATC positions by airport ICAO
        atcFacilities.forEach(facility => {
            if (facility && facility.icao && facility.name) {
                if (!atcByIcao[facility.icao]) {
                    // Create a new entry for the airport if it's not already in our list
                    atcByIcao[facility.icao] = new Set();
                }
                // Add the facility type (e.g., "Tower", "Ground") to the airport's set
                atcByIcao[facility.icao].add(facility.name);
            }
        });

        if (Object.keys(atcByIcao).length === 0) {
            atcList.innerHTML = '<div class="atc-airport-row">No active ATC at any airport.</div>';
            return;
        }

        // Clear the list before adding the corrected rows
        atcList.innerHTML = '';

        const atcPositionOrder = [
            { key: 'ATIS', display: 'ATS' },
            { key: 'Ground', display: 'GND' },
            { key: 'Tower', display: 'TWR' },
            { key: 'Approach', display: 'APP' },
            { key: 'Departure', display: 'DEP' }
        ];

        // 2. Loop through the grouped airports, which are now unique
        for (const icao in atcByIcao) {
            const airportInfo = allAirports.find(a => a.ident === icao);

            if (!airportInfo) {
                console.warn(`ATC facility found for an unknown or filtered ICAO: ${icao}. Skipping.`);
                continue;
            }

            const airportName = airportInfo.name;
            const activePositions = atcByIcao[icao];

            const row = document.createElement('div');
            row.className = 'atc-airport-row';

            let positionsHtml = '';
            atcPositionOrder.forEach(pos => {
                const isActive = activePositions.has(pos.key);
                positionsHtml += `<span class="${isActive ? 'atc-pos-active' : 'atc-pos-inactive'}">${pos.display}</span>`;
            });
            
            // 3. Create a single row for the airport with all its active positions
            row.innerHTML = `
                <div class="atc-airport-info">
                    <strong>${icao}</strong>
                    <span>${airportName}</span>
                </div>
                <div class="atc-arrivals-info">
                    ✈ --
                </div>
                <div class="atc-positions">
                    ${positionsHtml}
                </div>
            `;
            atcList.appendChild(row);
        }
    } catch (error) {
        console.error("A critical error occurred in updateAtcList. This may be due to unexpected API data.", error);
        if (atcList) {
            atcList.innerHTML = '<div class="atc-airport-row" style="color: red;">Error loading ATC data.</div>';
        }
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
            toggleDataBlockVisibility();
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
    
    // UPDATED: Now respects the useTrueHeading setting
    function updateDataBlock(stepId) {
        const legData = planLayers[stepId];
        if (!legData || !legData.label) return;

        const startAlt = legData.startAltitude;
        const endAlt = legData.endAltitude;
        let altitudeHtml;

        if (startAlt !== undefined && endAlt !== undefined && startAlt !== endAlt) {
            altitudeHtml = `<div class="fdb-data-item fdb-altitude"><span class="fdb-value" style="font-size: 12px; color: #FFD700;">${(startAlt / 1000).toFixed(1).replace('.0','')}k &rarr; ${(endAlt / 1000).toFixed(1).replace('.0','')}k</span><span class="fdb-unit">ft</span></div>`;
            const color = endAlt < startAlt ? '#FF8C00' : '#39FF14';
            if (legData.line) legData.line.setStyle({ color: color, weight: 4 });
            if (legData.outline) legData.outline.setStyle({ weight: 0 });
        } else {
            const displayAlt = legData.altitude || startAlt;
            let altValueText = '---';
            if (displayAlt || displayAlt === 0) {
                if (displayAlt % 1000 === 0) {
                    altValueText = `${displayAlt / 1000}k`;
                } else {
                    altValueText = (displayAlt / 1000).toFixed(1) + 'k';
                }
            }
            altitudeHtml = `<div class="fdb-data-item fdb-altitude"><span class="fdb-value">${altValueText}</span><span class="fdb-unit">ft</span></div>`;

            const style = (currentMapMode === "terrain") ? FLIGHT_LINE_STYLES_TERRAIN[legData.lineType] : FLIGHT_LINE_STYLES_REGULAR[legData.lineType];
            if (legData.line) legData.line.setStyle(style);
            if (legData.outline && currentMapMode === "regular") legData.outline.setStyle({ color: '#000', weight: 6, opacity: 1 });
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
        
        legData.label.setIcon(L.divIcon({
            className: 'custom-map-marker',
            html: fullHtml
        }));
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

    function updateAirports() {
        if (activeAirportIcao) {
            hubDotsGroup.clearLayers();
            dynamicRunwaysGroup.clearLayers();
            return;
        }

        const zoom = map.getZoom();
        hubDotsGroup.clearLayers();
        dynamicRunwaysGroup.clearLayers();
        finalApproachGroup.clearLayers();

        if (!airportsDataCache) return;
        const mainPanel = document.getElementById('main-panel');
        if (!mainPanel) return;

        const selectedTypes = Array.from(mainPanel.querySelectorAll('#airport-filters input:checked')).map(input => input.value);
        const bounds = map.getBounds();

        const airportsToShow = airportsDataCache.filter(airport => {
            if (!selectedTypes.includes(airport.type)) return false;
            const lat = parseFloat(airport.latitude_deg);
            const lon = parseFloat(airport.longitude_deg);
            if (isNaN(lat) || isNaN(lon) || !bounds.contains([lat, lon])) return false;
            if (zoom < 6) return airport.type === 'large_airport';
            if (zoom < 8) return ['large_airport', 'medium_airport'].includes(airport.type);
            return true;
        });

        const drawnRunwayAirports = new Set();

        if (zoom >= 13) {
            airportsToShow.forEach(airport => {
                if (['large_airport', 'medium_airport'].includes(airport.type)) {
                    drawRunwaysForAirport(airport.ident, dynamicRunwaysGroup, finalApproachGroup);
                    drawnRunwayAirports.add(airport.ident);
                }
            });
        }

        airportsToShow.forEach(airport => {
            if (drawnRunwayAirports.has(airport.ident)) return;
            const coords = [parseFloat(airport.latitude_deg), parseFloat(airport.longitude_deg)];
            createAirportDot(coords, airport.ident, getAirportColor(airport.type), getAirportRadius(airport.type))
                .addTo(hubDotsGroup)
                .on('click', () => displayAirportDetails(airport.ident));
        });
    }
	
	async function updateNavaids() {
        const navaidsCheckbox = document.getElementById('filter-navaids');
        const waypointsCheckbox = document.getElementById('filter-waypoints');
        const zoom = map.getZoom();
        const bounds = map.getBounds();

        navaidsGroup.clearLayers();
        waypointsGroup.clearLayers();

        if (zoom < 7) return;

        if (navaidsCheckbox.checked) {
            const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
            const navaids = await getVORsFromOpenAIP(bbox);
            navaids.forEach(navaid => {
                const VOR_TYPES = [3, 4, 5, 6, 7];
                if (VOR_TYPES.includes(navaid.type) && navaid.geometry && navaid.geometry.coordinates) {
                    const coords = [navaid.geometry.coordinates[1], navaid.geometry.coordinates[0]];
                    createNavaidMarker(coords, navaid).addTo(navaidsGroup);
                }
            });
        }

        if (waypointsCheckbox.checked) {
            const waypoints = await getWaypoints();
            if(waypoints){
                waypoints.forEach(waypoint => {
                    const coords = [waypoint.coords[1], waypoint.coords[0]];
                    if (bounds.contains(coords)) {
                        createWaypointMarker(coords, waypoint).addTo(waypointsGroup);
                    }
                });
            }
        }
    }

    function createCompassRoseSVG(navaid) {
        const magVar = navaid.declination || 0;
        const rotation = `transform="rotate(${-magVar}, 50, 50)"`;

        const vorSymbol = `<g>
            <circle cx="50" cy="50" r="6" stroke="white" stroke-width="1.5" fill="black"/>
            <path d="M50 44 L53.5 38 M50 44 L46.5 38 M50 56 L53.5 62 M50 56 L46.5 62 M44 50 L38 53.5 M44 50 L38 46.5" stroke="white" stroke-width="1.5"/>
        </g>`;

        const svg = `
            <svg width="100" height="100" viewBox="0 0 100 100" class="vor-compass-rose">
                <g class="rose-rotating-g" ${rotation}>
                    <circle cx="50" cy="50" r="48" stroke="rgba(255,255,255,0.7)" stroke-width="1.5" fill="rgba(0,0,0,0.4)" />
                    ${Array.from({length: 36}).map((_, i) => {
                        const angle = i * 10;
                        const isCardinal = angle % 90 === 0;
                        const r1 = isCardinal ? 38 : 43;
                        return `<line x1="50" y1="${50 - r1}" x2="50" y2="4" stroke="white" stroke-width="${isCardinal ? 1.5 : 0.75}" transform="rotate(${angle}, 50, 50)" />`;
                    }).join('')}
                    <text x="50" y="18" text-anchor="middle" alignment-baseline="middle" fill="white" font-size="10" font-family="Roboto Mono">0</text>
                    <text x="85" y="50" text-anchor="middle" alignment-baseline="middle" fill="white" font-size="10" font-family="Roboto Mono">9</text>
                    <text x="50" y="82" text-anchor="middle" alignment-baseline="middle" fill="white" font-size="10" font-family="Roboto Mono">18</text>
                    <text x="15" y="50" text-anchor="middle" alignment-baseline="middle" fill="white" font-size="10" font-family="Roboto Mono">27</text>
                </g>
                ${vorSymbol}
            </svg>`;

        return svg;
    }

    function createNavaidMarker(latlng, navaid) {
        const iconHtml = createCompassRoseSVG(navaid);
        const tooltipContent = `<b>${navaid.name} (${navaid.identifier})</b><br>Type: ${navaid.typeName}<br>Freq: ${navaid.frequency ? navaid.frequency.value + ' ' + navaid.frequency.unit : 'N/A'}<br>Mag Var: ${navaid.declination || 0}°`;
        const icon = L.divIcon({
            html: iconHtml,
            className: 'vor-compass-icon',
            iconSize: [80, 80],
            iconAnchor: [40, 40]
        });

        return L.marker(latlng, { icon: icon }).bindTooltip(tooltipContent, {
            direction: 'top'
        });
    }

    async function displayAirportDetails(icao) {
        airportDetailsGroup.clearLayers();
        runwayLabelsGroup.clearLayers();
        finalApproachGroup.clearLayers();
        runwayLayers = {};
        const infoPanel = document.getElementById('airport-info-panel');
        if (infoPanel) infoPanel.remove();

        activeAirportIcao = icao;
        updateAirports();

        try {
            const airports = await getAirports();
            const airport = airports.find(a => a.ident === icao);
            if (!airport) return alert(`Airport with ICAO ${icao} not found.`);
            
            const lat = parseFloat(airport.latitude_deg);
            const lon = parseFloat(airport.longitude_deg);
            currentAirportCoords = L.latLng(lat, lon);

            const airportRunways = await getRunwaysForAirport(icao);

            airportRunways.forEach(runway => drawRunway(runway, airportDetailsGroup, runwayLabelsGroup, finalApproachGroup));
            updateAirportInfoPanel(airport, airportRunways);

            createDistanceRings(lat, lon, planLayers).forEach(ring => ring.addTo(airportDetailsGroup));
            if(map.getZoom() < 13) map.setView([lat, lon], 13);
            else map.panTo([lat,lon]);

            const clearBtn = document.getElementById('clear-selection-btn');
            if(clearBtn) clearBtn.style.display = 'block';
            const clearText = document.getElementById('clear-selection-text');
            if (clearText) clearText.style.display = 'block';

            checkAirportDetailsVisibility();
            checkRunwayLabelVisibility();
        } catch (err) {
            console.error(`Failed to fetch details for ${icao}:`, err);
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
            const point = wmmModel.field(lat, lon);
            declination = point.declination;
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
                const runwayName = (runway.le_ident && runway.he_ident) ?
                    `${runway.le_ident}/${runway.he_ident}` :
                    (runway.le_ident || runway.he_ident || 'Unnamed');

                let le_true_hdg = parseFloat(runway.le_heading_degT);
                let he_true_hdg = parseFloat(runway.he_heading_degT);

                let le_mag_hdg_raw = le_true_hdg - declination;
                let he_mag_hdg_raw = he_true_hdg - declination;

                le_mag_hdg_raw = (le_mag_hdg_raw + 360) % 360;
                he_mag_hdg_raw = (he_mag_hdg_raw + 360) % 360;
                
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
                <h3>Runways 🧭</h3>
                ${runwaysHTML}
            </div>`;

        const panel = createFloatingPanel('airport-info-panel', `<h2>${panelTitle}</h2>`, '20px', '360px', content);

        panel.querySelectorAll('[data-runway-id]').forEach(row => {
            const runwayId = row.dataset.runwayId;
            row.addEventListener('mouseover', () => highlightRunway(runwayId));
            row.addEventListener('mouseout', () => unhighlightRunway(runwayId));
        });
    }

	function updateWaypoints() {
    const showWaypoints = document.getElementById('filter-waypoints')?.checked;
    const zoom = map.getZoom();
    waypointsGroup.clearLayers();

    if (!showWaypoints || zoom < 8) {
        return;
    }

    if (!waypointsDataCache) return;

    const bounds = map.getBounds();

    waypointsDataCache.forEach(waypoint => {
        if (!waypoint.coords || waypoint.coords.length < 2) return;
        
        const lon = parseFloat(waypoint.coords[0]);
        const lat = parseFloat(waypoint.coords[1]);

        if (isNaN(lat) || isNaN(lon) || !bounds.contains([lat, lon])) {
            return;
        }

        const waypointIcon = L.divIcon({
            className: 'custom-map-marker',
            // This SVG creates a solid white triangle
            html: `<svg width="12" height="12" viewbox="0 0 12 12"><polygon points="6,1 11,11 1,11" fill="white"/></svg>`,
            iconSize: [12, 12]
        });

        L.marker([lat, lon], { icon: waypointIcon })
         .bindTooltip(waypoint.name, { direction: 'top' })
         .addTo(waypointsGroup);
    });
}

    function highlightRunway(runwayId) {
        if (runwayLayers[runwayId]) {
            runwayLayers[runwayId].setStyle(RUNWAY_STYLE_HIGHLIGHT);
        }
    }

    function unhighlightRunway(runwayId) {
        if (runwayLayers[runwayId]) {
            const style = (currentMapMode === "terrain") ? RUNWAY_STYLE_TERRAIN : RUNWAY_STYLE_REGULAR;
            runwayLayers[runwayId].setStyle(style);
        }
    }
    
    // UPDATED: Now uses the heading object {magnetic, true}
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
                    planLayers[stepId].heading.magnetic = newHeadingText; // Only update magnetic part
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
            if (planLayers[idToDelete]) {
                if (planLayers[idToDelete].line) planItemsGroup.removeLayer(planLayers[idToDelete].line);
                if (planLayers[idToDelete].outline) planItemsGroup.removeLayer(planLayers[idToDelete].outline);
                if (planLayers[idToDelete].label) planLabelsGroup.removeLayer(planLayers[idToDelete].label);
                delete planLayers[idToDelete];
                savePlanToLocalStorage();
            }
            this.closest('.plan-step').remove();
        });

        document.getElementById(`alt-${stepId}`).addEventListener('input', (e) => {
            const legData = planLayers[stepId];
            const newAlt = parseInt(e.target.value);
            legData.altitude = newAlt;
            legData.startAltitude = newAlt;
            legData.endAltitude = newAlt;
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

    function checkAirportDetailsVisibility() {
        if (!map.hasLayer(airportDetailsGroup) && map.getZoom() >= 10) { map.addLayer(airportDetailsGroup); }
        if (map.hasLayer(airportDetailsGroup) && map.getZoom() < 10) { map.removeLayer(airportDetailsGroup); }
    }
    function checkRunwayLabelVisibility() {
        if (!map.hasLayer(runwayLabelsGroup) && map.getZoom() >= 13) { map.addLayer(runwayLabelsGroup); }
        if (map.hasLayer(runwayLabelsGroup) && map.getZoom() < 13) { map.removeLayer(runwayLabelsGroup); }
    }

    function toggleDataBlockVisibility() {
        if (appSettings.showDataBlocks) {
            if (!map.hasLayer(planLabelsGroup)) { map.addLayer(planLabelsGroup); }
        } else {
            if (map.hasLayer(planLabelsGroup)) { map.removeLayer(planLabelsGroup); }
        }
        checkPlanLabelVisibility();
    }

    function checkPlanLabelVisibility() {
        if (appSettings.showDataBlocks) {
            if (!map.hasLayer(planLabelsGroup) && map.getZoom() >= 9) { map.addLayer(planLabelsGroup); }
            if (map.hasLayer(planLabelsGroup) && map.getZoom() < 9) { map.removeLayer(planLabelsGroup); }
        }
    }
    
    function updateAllFlightDataBlockStyles() {
        Object.keys(planLayers).forEach(stepId => updateDataBlock(stepId));
    }

    // UPDATED: Temporary label creation and styling
    function handleMouseDown(e) {
        if (!isDrawingEnabled || e.originalEvent.button !== 0 || e.originalEvent.target.closest('.floating-panel')) { return; }
        
        if (tempLine) map.removeLayer(tempLine);
        if (tempLabel) map.removeLayer(tempLabel);
        
        Object.values(planLayers).forEach(layer => {
            if (layer.label && layer.label.dragging) { layer.label.dragging.disable(); }
        });
    
        isDrawing = true;
        const startPoint = e.latlng;
        tempLine = L.polyline([startPoint, startPoint], { color: '#007bff', weight: 3, dashArray: '10, 10' }).addTo(map);
        tempLabel = L.marker(startPoint, { 
            icon: L.divIcon({ 
                className: 'custom-map-marker', // Use a transparent container class
                html: `<div class="drawing-temp-heading">---</div>` 
            }) 
        }).addTo(map);
    }
    
    // UPDATED: Logic for updating the temporary heading label
    function handleMouseMove(e) {
        if (!isDrawing || !tempLine) return;
        
        const startPoint = tempLine.getLatLngs()[0];
        const currentPoint = e.latlng;
        tempLine.setLatLngs([startPoint, currentPoint]);

        const midPoint = getMidPoint(startPoint, currentPoint);
        tempLabel.setLatLng(midPoint);

        const trueHeading = calculateHeading(startPoint, currentPoint);
        let magneticHeading = trueHeading;
        let declination = 0;

        if (wmmModel) {
            declination = wmmModel.field(midPoint.lat, midPoint.lng).declination;
            magneticHeading = (trueHeading - declination + 360) % 360;
        }

        const headingText = Math.round(magneticHeading).toString().padStart(3, '0');
        
        // Only show magnetic heading now with the new style
        if(tempLabel.getElement()) {
            tempLabel.getElement().innerHTML = `<div class="drawing-temp-heading">${headingText}° M</div>`;
        }
    }
    
    // UPDATED: Now creates a full heading object {magnetic, true}
    function handleMouseUp(e) {
        if (!isDrawing) return;
    
        isDrawing = false; 
    
        if (tempLine) {
            const startPoint = tempLine.getLatLngs()[0];
            const endPoint = e.latlng;

            if (startPoint.distanceTo(endPoint) > 50) { // minimum distance to draw
                const lineType = currentLineType;

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

                createFinalLine(startPoint, endPoint, `step-${Date.now()}`, '', '', true, lineType, null, null, finalHeading);
                savePlanToLocalStorage();
            }
            map.removeLayer(tempLine);
            map.removeLayer(tempLabel);
            tempLine = null;
            tempLabel = null;
        }

        Object.values(planLayers).forEach(layer => {
            if (layer.label && layer.label.dragging) { layer.label.dragging.enable(); }
        });
    }

    // UPDATED: Now expects a heading object {magnetic, true}
    function createFinalLine(start, end, stepId, altitude = '', speed = '', performCollisionCheck = false, lineType = 'standard', startAltitude, endAltitude, heading) {
        let line, outline;
        if (lineType === 'standard' && currentMapMode === "regular") {
            outline = L.polyline([start, end], { color: '#000', weight: 6, opacity: 1 }).addTo(planItemsGroup);
            line = L.polyline([start, end], { color: '#fff', weight: 3, opacity: 1 }).addTo(planItemsGroup);
        } else {
            const style = (currentMapMode === "terrain") ? FLIGHT_LINE_STYLES_TERRAIN[lineType] : FLIGHT_LINE_STYLES_REGULAR[lineType];
            line = L.polyline([start, end], style).addTo(planItemsGroup);
        }
        
        if (!heading) {
             const trueHeading = calculateHeading(start, end);
             let magneticHeading = trueHeading;
             if (wmmModel) {
                 const midPoint = getMidPoint(start, end);
                 const declination = wmmModel.field(midPoint.lat, midPoint.lng).declination;
                 magneticHeading = (trueHeading - declination + 360) % 360;
             }
             heading = { 
                magnetic: Math.round(magneticHeading).toString().padStart(3, '0'),
                true: Math.round(trueHeading).toString().padStart(3, '0')
             };
        }

        let labelPos = getOptimalLabelPosition(start, end);
        if (performCollisionCheck) { labelPos = findNonCollidingPosition(labelPos); }
        
        const initialHtml = `<div class="flight-data-block"><div class="fdb-heading">${heading.magnetic}° M</div><div class="fdb-row"><div class="fdb-data-item fdb-airspeed"><span class="fdb-value">---</span><span class="fdb-unit">kts</span></div><div class="fdb-data-item fdb-altitude"><span class="fdb-value">---</span><span class="fdb-unit">ft</span></div></div></div>`;

        const label = L.marker(labelPos, {
            draggable: true,
            icon: L.divIcon({
                className: 'custom-map-marker',
                html: initialHtml
            })
        });
        
        if (appSettings.showDataBlocks) { label.addTo(planLabelsGroup); }

        label.on('mousedown', (e) => { L.DomEvent.stopPropagation(e.originalEvent); });
        label.on('dragend', (event) => {
            planLayers[stepId].labelPosition = event.target.getLatLng();
            planLayers[stepId].hasBeenDragged = true;
            savePlanToLocalStorage();
        });

        planLayers[stepId] = { line, outline, start, end, labelPosition: labelPos, altitude, speed, lineType, hasBeenDragged: false, label, heading, startAltitude, endAltitude };
        
        addPlanStep(stepId, heading, start.distanceTo(end), altitude, speed, lineType);
        updateAltitudeForLeg(stepId);

        checkPlanLabelVisibility();
        updateAllFlightDataBlockStyles();
    }

    function findNonCollidingPosition(optimalPosition, excludeStepId = null) {
        const labelWidth = 100 * appSettings.dataBlockScale;
        const labelHeight = 70 * appSettings.dataBlockScale;
        const startScreenPoint = map.latLngToContainerPoint(optimalPosition);
        const candidates = [ startScreenPoint, startScreenPoint.add([0, -labelHeight]), startScreenPoint.add([0, labelHeight]), startScreenPoint.add([labelWidth / 2, -labelHeight / 2]), startScreenPoint.add([-labelWidth / 2, labelHeight / 2]), ];
        const existingRects = Object.entries(planLayers).map(([key, layer]) => {
            if (key === excludeStepId) return null;
            const point = map.latLngToContainerPoint(layer.labelPosition);
            return L.bounds( point.subtract([labelWidth / 2, labelHeight / 2]), point.add([labelWidth / 2, labelHeight / 2]) );
        }).filter(Boolean);
        for (const candidate of candidates) {
            const newRect = L.bounds( candidate.subtract([labelWidth / 2, labelHeight / 2]), candidate.add([labelWidth / 2, labelHeight / 2]) );
            let isOverlapping = existingRects.some(rect => newRect.intersects(rect));
            if (!isOverlapping) { return map.containerPointToLatLng(candidate); }
        }
        return map.containerPointToLatLng(candidates[0]);
    }

    function adjustAllLabelPositions() {
        if(Object.keys(planLayers).length === 0) return;
        const updatedPositions = {};
        for (const key in planLayers) {
            const layer = planLayers[key];
            if (layer.hasBeenDragged) {
                updatedPositions[key] = layer.labelPosition;
                continue;
            }
            const optimalPos = getOptimalLabelPosition(layer.start, layer.end);
            const newPos = findNonCollidingPosition(optimalPos, key);
            updatedPositions[key] = newPos;
        }
        for (const key in updatedPositions) {
            planLayers[key].label.setLatLng(updatedPositions[key]);
            planLayers[key].labelPosition = updatedPositions[key];
        }
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

    // UPDATED: Now saves the full heading object
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
                heading: layer.heading, // Save the whole heading object
                startAltitude: layer.startAltitude,
                endAltitude: layer.endAltitude
            };
        });
        localStorage.setItem('flightPlan', JSON.stringify(planData));
    }

    // UPDATED: Handles both old and new saved plan formats
    function loadPlanFromLocalStorage() {
        const savedPlan = localStorage.getItem('flightPlan');
        if (savedPlan) {
            const planData = JSON.parse(savedPlan);
            planData.forEach(data => {
                const start = L.latLng(data.start.lat, data.start.lng);
                const end = L.latLng(data.end.lat, data.end.lng);
                
                let heading;
                if (data.heading) { // New format with heading object
                    heading = data.heading;
                } else if (data.headingText) { // Backwards compatibility for old format
                    const trueHeading = calculateHeading(start, end);
                    heading = {
                        magnetic: data.headingText,
                        true: Math.round(trueHeading).toString().padStart(3, '0')
                    };
                }

                createFinalLine(start, end, data.stepId, data.altitude, data.speed, false, data.lineType, data.startAltitude, data.endAltitude, heading);
                
                if (data.labelPosition) {
                    const labelPos = L.latLng(data.labelPosition.lat, data.labelPosition.lng);
                    planLayers[data.stepId].label.setLatLng(labelPos);
                    planLayers[data.stepId].labelPosition = labelPos;
                }
                if(data.hasBeenDragged){
                    planLayers[data.stepId].hasBeenDragged = true;
                }
            });
            adjustAllLabelPositions();
        }
        toggleDataBlockVisibility();
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
            let mslText = "MSL: Sea Level";
            if (elevationMeters !== null && elevationMeters > 0) {
                let elevationFeet = Math.round(elevationMeters * 3.28084);
                const rounded = Math.round(elevationFeet / 100) * 100;
                mslText = `MSL: ${rounded.toLocaleString()}'`;
            }
             mslPopup.innerHTML = `${mslText}<br>${magVarText}`;

        } catch (error) {
            console.error("Failed to fetch elevation data:", error);
            mslPopup.innerHTML = `MSL: Unavailable<br>${magVarText}`;
        }
    }

    function getOptimalLabelPosition(start, end) {
        const midPoint = getMidPoint(start, end);
        if (!currentAirportCoords || midPoint.distanceTo(currentAirportCoords) > 3000) { return midPoint; }
        return L.latLng(start.lat + (end.lat - start.lat) * 0.75, start.lng + (end.lng - start.lng) * 0.75);
    }

    async function getRunwaysForAirport(icao) {
        const allRunways = await getRunways();
        return allRunways.filter(r => r.airport_ident === icao);
    }

    async function drawRunwaysForAirport(icao, runwayLayerGroup, finalApproachGroup) {
        try {
            const runways = await getRunwaysForAirport(icao);
            const labelGroup = L.featureGroup().addTo(runwayLayerGroup);
            runways.forEach(runway => drawRunway(runway, runwayLayerGroup, labelGroup, finalApproachGroup));
        } catch (err) {
            console.error(`Could not auto-draw runways for ${icao}:`, err);
        }
    }

    function drawRunway(runwayData, polygonGroup, labelGroup, finalApproachGroup) {
        const le_lat = parseFloat(runwayData.le_latitude_deg);
        const le_lon = parseFloat(runwayData.le_longitude_deg);
        const he_lat = parseFloat(runwayData.he_latitude_deg);
        const he_lon = parseFloat(runwayData.he_longitude_deg);
        const width_ft = parseFloat(runwayData.width_ft);

        if ([le_lat, le_lon, he_lat, he_lon, width_ft].some(isNaN) || width_ft <= 0) { return; }
        
        const widthMeters = width_ft * 0.3048;
        const runwayLineString = turf.lineString([[le_lon, le_lat], [he_lon, he_lat]]);
        const bufferRadiusKm = (widthMeters / 2) / 1000;
        const runwayPolygon = turf.buffer(runwayLineString, bufferRadiusKm, { units: 'kilometers' });
        const style = (currentMapMode === "terrain") ? RUNWAY_STYLE_TERRAIN : RUNWAY_STYLE_REGULAR;
        const runwayLayer = L.geoJSON(runwayPolygon, { style: style }).addTo(polygonGroup);
        runwayLayers[runwayData.id] = runwayLayer;
        const clStyle = (currentMapMode === "terrain") ? RUNWAY_CENTERLINE_STYLE_TERRAIN : RUNWAY_CENTERLINE_STYLE_REGULAR;
        L.polyline([[le_lat, le_lon], [he_lat, he_lon]], clStyle).addTo(polygonGroup);
        addRunwayLabel(runwayData, [le_lon, le_lat], [he_lon, he_lat], labelGroup);
        
        const le_point = turf.point([le_lon, le_lat]);
        const he_point = turf.point([he_lon, he_lat]);
        
        if (runwayData.le_ident) {
            const bearing_he_to_le = turf.bearing(he_point, le_point);
            drawFinalApproachCone(le_point, bearing_he_to_le, finalApproachGroup);
        }

        if (runwayData.he_ident) {
            const bearing_le_to_he = turf.bearing(le_point, he_point);
            drawFinalApproachCone(he_point, bearing_le_to_he, finalApproachGroup);
        }
    }

    function drawFinalApproachCone(runwayEnd, bearing, group) {
        const finalDistNM = 10;
        const finalWidthNM = 1.0; 

        const apex = runwayEnd;
        const baseCenter = turf.destination(runwayEnd, finalDistNM, bearing, { units: 'nauticalmiles' });
        const p1 = turf.destination(baseCenter, finalWidthNM, bearing - 90, { units: 'nauticalmiles' });
        const p2 = turf.destination(baseCenter, finalWidthNM, bearing + 90, { units: 'nauticalmiles' });
        
        const coneCoords = [[
            p1.geometry.coordinates,
            p2.geometry.coordinates,
            apex.geometry.coordinates,
            p1.geometry.coordinates 
        ]];

        const conePoly = turf.polygon(coneCoords);
        L.geoJSON(conePoly, { style: FINAL_APPROACH_STYLE }).addTo(group);

        const centerline = L.polyline([
            [apex.geometry.coordinates[1], apex.geometry.coordinates[0]],
            [baseCenter.geometry.coordinates[1], baseCenter.geometry.coordinates[0]]
        ], FINAL_APPROACH_CENTERLINE_STYLE).addTo(group);
    }

    function addRunwayLabel(runwayData, p1, p2, labelGroup) {
        const le_point = turf.point(p1);
        const he_point = turf.point(p2);
        const bearing_le_to_he = turf.bearing(le_point, he_point);
        const bearing_he_to_le = turf.bearing(he_point, le_point);
        const createLabel = (ident, point, bearing) => {
            if (!ident) return;
            const axialOffset = 0.35;
            const separationDistance = 0.15;
            let pos = turf.destination(point, axialOffset, bearing, { units: 'kilometers' });
            if (ident.endsWith('L') || ident.endsWith('R')) {
                let offsetBearing = ident.endsWith('L') ? bearing + 90 : bearing - 90;
                pos = turf.destination(pos, separationDistance, offsetBearing, { units: 'kilometers' });
            }
            L.marker([pos.geometry.coordinates[1], pos.geometry.coordinates[0]], {
                icon: L.divIcon({ className: 'runway-label-halo', html: `<span>${ident}</span>`, iconAnchor: [ident.length * 5, 8] })
            }).addTo(labelGroup);
        };
        createLabel(runwayData.le_ident, le_point, bearing_he_to_le);
        createLabel(runwayData.he_ident, he_point, bearing_le_to_he);
    }

    function segmentsIntersect(p1, p2, p3, p4) {
        const toPoint = (p) => ({ x: p.x, y: p.y });
        const det = (a, b) => a.x * b.y - a.y * b.x;

        const a = toPoint(p1), b = toPoint(p2), c = toPoint(p3), d = toPoint(p4);
        const C_A = { x: c.x - a.x, y: c.y - a.y };
        const D_C = { x: d.x - c.x, y: d.y - c.y };
        const B_A = { x: b.x - a.x, y: b.y - a.y };

        const det_D_C_B_A = det(D_C, B_A);
        if (det_D_C_B_A === 0) return false;

        const t = det(C_A, D_C) / det_D_C_B_A;
        const u = det(C_A, B_A) / det_D_C_B_A;

        return t >= 0 && t <= 1 && u >= 0 && u <= 1;
    }

    function doesArcIntersectPlanLines(arcPoints, planLayers) {
        for (const key in planLayers) {
            const line = planLayers[key].line;
            if (!line) continue;
            const linePoints = line.getLatLngs();
            for (let i = 0; i < linePoints.length - 1; i++) {
                for (let j = 0; j < arcPoints.length - 1; j++) {
                    if (segmentsIntersect( map.latLngToLayerPoint(linePoints[i]), map.latLngToLayerPoint(linePoints[i+1]), map.latLngToLayerPoint(arcPoints[j]), map.latLngToLayerPoint(arcPoints[j+1]) )) return true;
                }
            }
        }
        return false;
    }

    function createDistanceRings(lat, lon, planLayers, speedKts = 240) {
        const ringSpecs = [{ nm: 10 }, { nm: 20 }, { nm: 30 }];
        const groups = [];
        const candidateAngles = [0, 90, 180, 270, 45, 135, 225, 315];
        ringSpecs.forEach((spec, idx) => {
            const radius = spec.nm * 1852;
            const circle = L.circle([lat, lon], { radius, color: '#FFD600', weight: 2, fill: false, dashArray: '5, 10', opacity: 1 });
            const timeHours = spec.nm / speedKts;
            const totalSeconds = Math.round(timeHours * 3600);
            const minutes = Math.floor(totalSeconds / 60);
            const seconds = totalSeconds % 60;
            const labelText = `${spec.nm} NM – ${(minutes > 0 ? `${minutes}m` : '')}${seconds}s @${speedKts}kt`;
            let labelPath;
            for (let angleDeg of candidateAngles) {
                const arcSweep = 80, arcStep = 6;
                const arcLatLngs = [];
                for (let a = -arcSweep/2; a <= arcSweep/2; a += arcStep) {
                    const theta = (angleDeg + a) * Math.PI / 180;
                    const dLat = (radius * Math.cos(theta)) / 111320;
                    const dLon = (radius * Math.sin(theta)) / (111320 * Math.cos(lat * Math.PI/180));
                    arcLatLngs.push([lat + dLat, lon + dLon]);
                }
                const arcPoints = arcLatLngs.map(([la, lo]) => L.latLng(la, lo));
                if (!doesArcIntersectPlanLines(arcPoints, planLayers)) {
                    labelPath = L.polyline(arcPoints, { opacity: 0 });
                    break;
                }
            }
            if (!labelPath) {
                groups.push(circle);
            } else {
                labelPath.addTo(map);
                if (typeof labelPath.setText === "function") {
                    labelPath.setText(labelText, { repeat: false, center: true, attributes: { fill: '#FFD600', stroke: '#222', 'stroke-width': 4, 'paint-order': 'stroke fill', 'font-size': '16px', 'font-weight': 'bold', 'text-shadow': '0 2px 6px #000, 0 0 2px #FFD600' } });
                }
                groups.push(L.layerGroup([circle, labelPath]));
            }
        });
        return groups;
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
    function createAirportDot(latlng, icao, color, radius) {
        return L.circleMarker(latlng, {
            radius: radius, color: '#000', weight: 1,
            fillColor: color, fillOpacity: 1, icao: icao
        }).bindTooltip(icao, { permanent: false, direction: 'top', offset: [0, -radius] });
    }

    function calculateHeading(start, end) {
        const p1 = map.latLngToContainerPoint(start);
        const p2 = map.latLngToContainerPoint(end);
        const radians = Math.atan2(p2.y - p1.y, p2.x - p1.x);
        const degrees = radians * (180 / Math.PI);
        const trueBearing = (degrees + 90 + 360) % 360;
        return trueBearing;
    }

    const getMidPoint = (start, end) => L.latLng((start.lat + end.lat) / 2, (start.lng + end.lng) / 2);
	
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
            planItemsGroup.clearLayers();
            planLabelsGroup.clearLayers();
            Object.keys(planLayers).forEach(key => delete planLayers[key]);
            planPanel.querySelectorAll('.plan-step').forEach(step => step.remove());
            localStorage.removeItem('flightPlan');

            if (isDrawing) {
                if (tempLine) map.removeLayer(tempLine);
                if (tempLabel) map.removeLayer(tempLabel);
                tempLine = null;
                tempLabel = null;
                isDrawing = false;
            }
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
});