// app.js (Updated with AWS Terrain and all previous functionality)
document.addEventListener('DOMContentLoaded', () => {
    // --- API & SETTINGS ---
    maptilersdk.config.apiKey = 'ety8GjHG3ccnoSZfOULB';

    // --- MAP INITIALIZATION ---
    const map = new maptilersdk.Map({
        container: 'map',
        style: 'https://api.maptiler.com/maps/01980624-ad9c-736d-a1c0-b481bf180ccf/style.json?key=ety8GjHG3ccnoSZfOULB',
        center: [-98.57, 39.82],
        zoom: 4,
        // *** MODIFICATION 1: Tell the map to use a terrain source named 'aws-terrain' ***
        terrain: {
            source: 'aws-terrain',
            exaggeration: 1.5 // Optional: Makes mountains look more dramatic
        }
    });

    // --- GLOBAL VARIABLES & LAYER MANAGEMENT ---
    // Instead of FeatureGroups, we'll manage layers and sources directly
    const layerAndSourceIds = new Set();
    const liveFlightMarkers = {};
    const planLabels = {};
	
	let lastUpdatedBounds = null;

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

    // --- Style configs (remain mostly the same, but used differently) ---
    const RUNWAY_STYLE_REGULAR = { 'line-color': '#FFFFFF', 'line-width': 1.5, 'fill-color': '#4E4E4E', 'fill-opacity': 1 };
    const RUNWAY_STYLE_HIGHLIGHT = { 'line-color': '#FFD700', 'line-width': 2, 'fill-color': '#FFD700', 'fill-opacity': 0.7 };
    const RUNWAY_CENTERLINE_STYLE_REGULAR = { 'line-color': '#FFFFFF', 'line-width': 1.5, 'line-dasharray': [10, 8] }; // 
    const FLIGHT_LINE_STYLES_REGULAR = {
        standard: { 'line-color': '#000000', 'line-width': 3, 'line-opacity': 0.85 },
        arrival: { 'line-color': '#2979FF', 'line-width': 3, 'line-opacity': 1 },
        departure: { 'line-color': '#FF3D00', 'line-width': 3, 'line-opacity': 1 }
    };
    const RUNWAY_STYLE_TERRAIN = { 'line-color': '#CCCCCC', 'line-width': 2, 'fill-color': '#444', 'fill-opacity': 0.95, 'line-opacity': 1 };
    const RUNWAY_CENTERLINE_STYLE_TERRAIN = { 'line-color': '#F5F5F5', 'line-width': 2, 'line-dasharray': [10, 8], 'line-opacity': 1 };
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

	/**
	 * Fetches elevation from the public Open-Meteo Elevation API.
	 * @param {object} latlng - An object with lat and lng properties.
	 * @returns {Promise<number|null>} The elevation in meters, or null if an error occurs.
	 */
	async function getPublicElevation(latlng) {
		const API_ENDPOINT = `https://api.open-meteo.com/v1/elevation?latitude=${latlng.lat}&longitude=${latlng.lng}`;

		try {
			const response = await fetch(API_ENDPOINT);
			if (!response.ok) {
				console.error(`Public elevation API returned an error:`, response.status);
				return null;
			}

			const data = await response.json();

			// The API returns an array of elevations. We only requested one point.
			if (data && data.elevation && data.elevation.length > 0) {
				return data.elevation[0];
			} else {
				console.warn(`API did not return elevation for this location.`, data);
				return null;
			}
		} catch (error) {
			console.error(`Failed to connect to the public elevation API:`, error);
			return null;
		}
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
		// Construct the URL for the secure Netlify serverless function.
		const url = `/.netlify/functions/navaids?bbox=${bbox.join(',')}`;

		try {
			const response = await fetch(url);

			// If the server returned an error (e.g., 4xx or 5xx), handle it gracefully.
			if (!response.ok) {
				const errorData = await response.json();
				console.error("Error response from navaids proxy function:", errorData.error || response.statusText);
				// Return an empty array to prevent downstream errors.
				return [];
			}

			const data = await response.json();
			// The API nests the results in an 'items' property. Return it, or an empty array if it doesn't exist.
			return data.items || [];

		} catch (error) {
			// Handle network errors or other unexpected issues during the fetch.
			console.error("Failed to fetch VOR data via the proxy function:", error);
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
        Object.values(liveFlightMarkers).forEach(marker => marker.remove());
        Object.keys(liveFlightMarkers).forEach(key => delete liveFlightMarkers[key]);

        Object.values(planLabels).forEach(marker => marker.remove());
        Object.keys(planLabels).forEach(key => delete planLabels[key]);
    }


   
 /**
 * Programmatically creates a compass rose image for VORs.
 * @param {number} size - The width and height of the image in pixels.
 * @returns {ImageData} The generated image data for use with map.addImage.
 */
/**
 * Programmatically creates a compass rose image for VORs.
 * @param {number} size - The width and height of the image in pixels.
 * @returns {ImageData} The generated image data for use with map.addImage.
 */
function createVorCompassImage(size = 256) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const center = size / 2;
    const radius = size / 2 - 8;

    // Style settings
    ctx.strokeStyle = 'black';
    ctx.fillStyle = 'black';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${size * 0.08}px "Open Sans", sans-serif`;

    // --- 1. Draw the outer circle ---
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(center, center, radius, 0, 2 * Math.PI);
    ctx.stroke();

    // --- 2. Draw all tick marks ---
    for (let i = 0; i < 360; i += 10) {
        const angleRad = (i - 90) * Math.PI / 180;
        const isMajorTick = (i % 30 === 0);
        const tickStart = isMajorTick ? radius - (size * 0.12) : radius - (size * 0.07);
        const startX = center + tickStart * Math.cos(angleRad);
        const startY = center + tickStart * Math.sin(angleRad);
        const endX = center + radius * Math.cos(angleRad);
        const endY = center + radius * Math.sin(angleRad);
        ctx.lineWidth = isMajorTick ? 2.5 : 1.5;
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(endX, endY);
        ctx.stroke();
    }
    
    // --- 3. Draw the 4 cardinal heading numbers ---
    const textRadius = radius - (size * 0.22);
    const headings = [
        { angle: 0,   label: '0' },
        { angle: 90,  label: '9' },
        { angle: 180, label: '18' },
        { angle: 270, label: '27' }
    ];
    headings.forEach(heading => {
        const angleRad = (heading.angle - 90) * Math.PI / 180;
        const textX = center + textRadius * Math.cos(angleRad);
        const textY = center + textRadius * Math.sin(angleRad);
        ctx.fillText(heading.label, textX, textY);
    });

    // --- 4. Draw the North-pointing needle (MODIFIED) ---
    ctx.save();
    ctx.lineWidth = 2.5;
    // Calculate where the '0' text is and stop the line just before it.
    const needleEndPointY = center - textRadius - (size * 0.04);
    ctx.beginPath();
    ctx.moveTo(center, center);
    ctx.lineTo(center, needleEndPointY);
    ctx.stroke();
    ctx.restore();

    // --- 5. Draw the center VOR/DME hexagon symbol ---
    const symRadius = size * 0.06;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3 * i) + (Math.PI / 6);
        const x = center + symRadius * Math.cos(angle);
        const y = center + symRadius * Math.sin(angle);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.lineWidth = 2;
    ctx.stroke();

    return ctx.getImageData(0, 0, size, size);
}

    // --- INITIALIZATION ---
    async function initializeApp() {
        loadSettings();
        createMainPanel();
        await initializeWMM();

        await getAirports();
        await getRunways();
        await getWaypoints();

        map.addSource('aws-terrain', {
    type: 'raster-dem',
    tiles: [
        'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
    ],
    tileSize: 256,
    encoding: 'terrarium'
});

map.setTerrain({
    source: 'aws-terrain',
    exaggeration: 1.5
});


            map.addLayer({
                id: 'hillshade',
                source: 'aws-terrain',
                type: 'hillshade',
                paint: {
                    'hillshade-exaggeration': 0.4,
                    'hillshade-shadow-color': '#000000'
                }
            });

            // --- NEW: GENERATE AND LOAD VOR COMPASS IMAGE ---
            if (!map.hasImage('vor-compass-rose')) {
                const vorCompassImage = createVorCompassImage(300); // Generate the image
                map.addImage('vor-compass-rose', vorCompassImage);   // Add it to the map
            }
            // --- END NEW ---

            // --- MOUNTAIN PEAKS MBTILES DATA - START ---
            // This section adds your custom mountain peak data from Google Cloud Storage.

            // 1. Add the MBTiles file as a new vector source.
            map.addSource('peaks-source', {
                type: 'vector',
                url: 'https://storage.googleapis.com/peaks_mountains/peaks.mbtiles',
            });

            // 2. Add a layer to display the data from the source.
            map.addLayer({
                'id': 'peaks-labels-layer', // A unique ID for this new layer
                'type': 'symbol',           // We are displaying text labels
                'source': 'peaks-source',   

                
                'source-layer': 'peak',

                'layout': {
                    
                    'text-field': ['get', 'name'],

                    'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
                    'text-size': [ // Text size will increase slightly with zoom to improve readability
                        'interpolate', ['linear'], ['zoom'],
                        8, 9,   // At zoom level 8, text size is 9px
                        14, 12  // At zoom level 14, text size is 12px
                    ],
                    'text-optional': true, // Helps with label decluttering
                },
                'paint': {
                    'text-color': '#E0E0E0',      // A light gray for the text
                    'text-halo-color': '#111111', // A dark outline to make text stand out
                    'text-halo-width': 1.5
                },
                // To avoid cluttering the map, only show these labels at zoom level 8 and higher.
                'minzoom': 8
            });
            // --- MOUNTAIN PEAKS MBTILES DATA - END ---
            
            // --- FIX: HANDLE MISSING IMAGES (e.g., for waypoints) ---
            map.on('styleimagemissing', (e) => {
                if (e.id === 'triangle-15') {
                    const width = 12; // Changed from 15 to 12
                    const height = 12; // Changed from 15 to 12
                    const bytesPerPixel = 4; // R, G, B, A
                    const data = new Uint8Array(width * height * bytesPerPixel);

                    // Create a black, downward-pointing, isosceles triangle
                    for (let x = 0; x < width; x++) {
                        for (let y = 0; y < height; y++) {
                            const invertedY = height - 1 - y;
                            const rowWidth = (invertedY / (height - 1)) * width;
                            const rowStart = (width - rowWidth) / 2;
                            const rowEnd = rowStart + rowWidth;

                            if (x >= rowStart && x <= rowEnd) {
                                const offset = (y * width + x) * bytesPerPixel;
                                data[offset] = 0;     // R (black)
                                data[offset + 1] = 0; // G (black)
                                data[offset + 2] = 0; // B (black)
                                data[offset + 3] = 255; // A (opaque)
                            }
                        }
                    }
                    // Add the generated image to the map style
                    map.addImage('triangle-15', { width, height, data: data });
                }
            });
            // --- END FIX ---

            setupEventListeners();
            
            // Initial data load
            updateAirports();
            updateNavaids();
            updateWaypoints();
            
            loadPlanFromLocalStorage();
            
            // Initialize mobile navigation
            setupMobileNav();

            const loader = document.getElementById('loader');
            if (loader) {
                loader.classList.add('hidden');
            }
        });
    }
    initializeApp();

    // --- MOBILE NAVIGATION LOGIC ---

    /**
     * Toggles the visibility of a mobile panel (bottom sheet).
     * @param {string} panelId The ID of the panel to show (e.g., 'main-panel').
     * @param {HTMLElement} clickedButton The button element that was clicked.
     */
    function toggleMobilePanel(panelId, clickedButton) {
        const allPanels = document.querySelectorAll('.floating-panel');
        const targetPanel = document.getElementById(panelId);
        const isAlreadyVisible = targetPanel && targetPanel.classList.contains('visible');

        // Deactivate all nav buttons and hide all panels
        document.querySelectorAll('.mobile-nav-btn').forEach(btn => btn.classList.remove('active'));
        allPanels.forEach(p => p.classList.remove('visible'));

        // If the clicked panel was not already visible, show it and activate its button.
        if (!isAlreadyVisible) {
            if (targetPanel) {
                targetPanel.classList.add('visible');
            }
            if (clickedButton) {
                clickedButton.classList.add('active');
            }
        }
    }


    /**
     * Sets up all event listeners for the mobile navigation bar.
     */
    function setupMobileNav() {
        const mobileNav = document.getElementById('mobile-nav');
        if (!mobileNav || window.innerWidth > 768) {
            if(mobileNav) mobileNav.style.display = 'none';
            return;
        }
        
        // By default, show the main planner panel on mobile load
        const mainPanel = document.getElementById('main-panel');
        if (mainPanel) {
            mainPanel.classList.add('visible');
            document.getElementById('mobile-nav-planner').classList.add('active');
        }

        document.getElementById('mobile-nav-planner').addEventListener('click', (e) => {
            createMainPanel(); // Ensure it exists
            toggleMobilePanel('main-panel', e.currentTarget);
        });

        document.getElementById('mobile-nav-live').addEventListener('click', (e) => {
            createLiveControlPanel(); // Ensure it exists
            toggleMobilePanel('live-control-panel', e.currentTarget);
        });

        document.getElementById('mobile-nav-traffic').addEventListener('click', (e) => {
            createTrafficScanPanel(); // Ensure it exists
            toggleMobilePanel('traffic-scan-panel', e.currentTarget);
        });

        document.getElementById('mobile-nav-settings').addEventListener('click', (e) => {
            createSettingsPanel(); // Ensure it exists
            toggleMobilePanel('settings-panel', e.currentTarget);
        });

        // A helper to close any open panel by tapping on the map
        map.on('click', () => {
             if (window.innerWidth <= 768) {
                document.querySelectorAll('.floating-panel.visible').forEach(panel => {
                    panel.classList.remove('visible');
                });
                document.querySelectorAll('.mobile-nav-btn.active').forEach(btn => {
                    btn.classList.remove('active');
                });
            }
        });
    }

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

        // UPDATED: Added touch handlers for mobile support
        map.on('mousedown', handleMouseDown);
        map.on('mousemove', handleMouseMove);
        map.on('mouseup', handleMouseUp);
        map.on('touchstart', handleMouseDown);
        map.on('touchmove', handleMouseMove);
        map.on('touchend', handleMouseUp);

        map.on('zoomend', handleMapMoveEnd);
        map.on('moveend', handleMapMoveEnd);

        function handleMapMoveEnd() {
            // No direct equivalent for checkAirportDetailsVisibility etc.
            // Visibility is now handled by zoom levels in layer styles or by re-rendering.
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

        // DOM event listeners remain the same
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
    // Note: Layer control is handled differently. We'll add custom UI for this.

    // --- UI PANELS (no changes here) ---
    function createFloatingPanel(id, titleHTML, top, left, contentHTML) {
        const existingPanel = document.getElementById(id);
        if (existingPanel) {
            // UPDATED: On mobile, just make it visible instead of removing/recreating
            if (window.innerWidth <= 768) {
                existingPanel.classList.add('visible');
                return existingPanel;
            }
            existingPanel.remove();
        }

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

        // UPDATED: If on mobile, immediately add the 'visible' class to trigger the slide-up animation
        if (window.innerWidth <= 768) {
            // Use a short timeout to allow the element to be added to the DOM before transitioning
            setTimeout(() => {
                // This class is now controlled by the mobile nav logic,
                // so we don't automatically make it visible here.
                panel.classList.add('visible');
            }, 10);
        }

        // Prevent map interaction when clicking on panel
        panel.addEventListener('mousedown', (e) => e.stopPropagation());
        panel.addEventListener('wheel', (e) => e.stopPropagation());


        const closeButton = panel.querySelector('.close-panel');
        closeButton.addEventListener('click', () => {
            // UPDATED: Modified close logic for mobile vs desktop
            if (window.innerWidth <= 768) {
                // On mobile, just hide the panel by removing the 'visible' class
                panel.classList.remove('visible');
                // Also deactivate any active nav button
                document.querySelectorAll('.mobile-nav-btn.active').forEach(btn => btn.classList.remove('active'));
            } else {
                // Original desktop behavior
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
        // UPDATED: Disable dragging on mobile devices
        if (window.innerWidth <= 768) {
            return;
        }

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
            if (window.innerWidth <= 768) existingPanel.classList.add('visible'); // Mobile support
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

            <div class="desktop-tool-buttons">
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

                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 15px;">
                    <button id="live-mode-btn">Live Mode</button>
                    <button id="traffic-scan-btn">Traffic Scan</button>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px;">
                    <button id="settings-btn">Settings</button>
                    <button id="help-btn">Help</button>					
                </div>
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
            // Logic for final approach visibility can be tied to layer visibility property
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
		mainPanel.querySelector('#traffic-scan-btn').addEventListener('click', createTrafficScanPanel);
    }
    
	// ... all other UI panel creation functions (createLiveControlPanel, etc.)...

    function createTrafficScanPanel() {
        const existingPanel = document.getElementById('traffic-scan-panel');
        if (existingPanel) {
            existingPanel.style.display = 'block';
            if (window.innerWidth <= 768) existingPanel.classList.add('visible');
            return;
        }

        const content = `
            <div class="info-card">
                <p style="font-size: 13px; color: var(--text-secondary); margin-bottom: 15px;">
                    This tool scans for inbounds and outbounds of the most active airports. Re-scan in order to get the latest data.
                </p>
                <button id="begin-traffic-scan-btn" style="width: 100%;">Begin Scan</button>
            </div>
            <div id="traffic-scan-results" class="info-card" style="display: none;">
                </div>
        `;

        const panel = createFloatingPanel('traffic-scan-panel', '<h2>Server Traffic Scan</h2>', '100px', '400px', content);

        panel.querySelector('#begin-traffic-scan-btn').addEventListener('click', generateTrafficHotspotReport);
    }


    async function generateTrafficHotspotReport() {
        const resultsContainer = document.getElementById('traffic-scan-results');
        const scanButton = document.getElementById('begin-traffic-scan-btn');
        if (!resultsContainer || !scanButton) return;

        resultsContainer.style.display = 'block';
        resultsContainer.innerHTML = `<div class="loader-dual-ring"></div>`;
        scanButton.disabled = true;
        scanButton.textContent = 'Scanning...';

        try {
            if (!isLiveModeActive) {
                throw new Error("Live Mode is not active. Please connect to a server first.");
            }
            const serverSelect = document.getElementById('server-select');
            const sessionId = serverSelect ? serverSelect.value : null;
            if (!sessionId) {
                throw new Error("No server selected in Live Mode.");
            }

            const [worldResponse, flightsResponse, atcResponse] = await Promise.all([
                fetch(`/.netlify/functions/world/${sessionId}`),
                fetch(`/.netlify/functions/flights/${sessionId}`),
                fetch(`/.netlify/functions/atc/${sessionId}`)
            ]);

            if (!worldResponse.ok || !flightsResponse.ok || !atcResponse.ok) {
                throw new Error("Failed to fetch server data.");
            }

            const worldData = await worldResponse.json();
            const flightsData = await flightsResponse.json();
            const atcData = await atcResponse.json();
            const allAirports = await getAirports();
            const flightsMap = new Map((flightsData.result || []).map(f => [f.flightId, f]));
            const activeAirports = worldData.result || [];

            const frequencyTypeMap = { 0: 'Ground', 1: 'Tower', 4: 'Approach', 5: 'Departure', 7: 'ATIS' };
            const freqInitialMap = { 'Ground': 'G', 'Tower': 'T', 'ATIS': 'S', 'Approach': 'A', 'Departure': 'D' };
            const activeFrequenciesByAirport = {};

            // Define the desired sorting order for frequency types.
            const gtsadOrder = ['Ground', 'Tower', 'ATIS', 'Approach', 'Departure'];

            if (atcData.result) {
                atcData.result.forEach(facility => {
                    const icao = facility.airportName;
                    if (!icao || icao === "Center") return;
                    const typeName = frequencyTypeMap[facility.type];
                    if (typeName && freqInitialMap[typeName]) {
                        if (!activeFrequenciesByAirport[icao]) {
                            activeFrequenciesByAirport[icao] = new Set();
                        }
                        activeFrequenciesByAirport[icao].add(typeName);
                    }
                });
            }
            
            const lowAndSlowFlights = (flightsData.result || []).filter(f => f.speed < 150);
            const activeAirportLocations = new Map();
            activeAirports.forEach(activeAirport => {
                const airportInfo = allAirports.find(a => a.ident === activeAirport.airportIcao);
                if (airportInfo) {
                    const lat = parseFloat(airportInfo.latitude_deg);
                    const lon = parseFloat(airportInfo.longitude_deg);
                    const elev = parseFloat(airportInfo.elevation_ft);
                    if (!isNaN(lat) && !isNaN(lon) && !isNaN(elev)) {
                        activeAirportLocations.set(activeAirport.airportIcao, { lat, lon, elev });
                    }
                }
            });
            
            const onGroundByAirport = {};
            for (const icao of activeAirportLocations.keys()) {
                onGroundByAirport[icao] = 0;
            }

            lowAndSlowFlights.forEach(flight => {
                const aircraftPoint = turf.point([flight.longitude, flight.latitude]);
                let closestIcao = null;
                let minDistance = Infinity;
                for (const [icao, coords] of activeAirportLocations.entries()) {
                    const airportPoint = turf.point([coords.lon, coords.lat]);
                    const distance = turf.distance(aircraftPoint, airportPoint, { units: 'nauticalmiles' });
                    if (distance < minDistance) {
                        minDistance = distance;
                        closestIcao = icao;
                    }
                }
                if (closestIcao && minDistance < 3) {
                    const airportCoords = activeAirportLocations.get(closestIcao);
                    const airportElevation = airportCoords.elev;
                    const aircraftAltitude = flight.altitude;
                    if (Math.abs(aircraftAltitude - airportElevation) < 500) {
                        onGroundByAirport[closestIcao]++;
                    }
                }
            });

            if (activeAirports.length === 0) {
                resultsContainer.innerHTML = '<p>No airports with active traffic found on the server.</p>';
                scanButton.disabled = false;
                scanButton.textContent = 'Re-Scan';
                return;
            }

            const airportTrafficData = {};
            activeAirports.forEach(airportStatus => {
                const calculatedOnGroundCount = onGroundByAirport[airportStatus.airportIcao] || 0;
                if (!airportStatus.inboundFlightsCount && !airportStatus.outboundFlightsCount && calculatedOnGroundCount === 0) {
                    return;
                }
                const airportInfo = allAirports.find(a => a.ident === airportStatus.airportIcao);
                if (!airportInfo) return;
                const airportLon = parseFloat(airportInfo.longitude_deg);
                const airportLat = parseFloat(airportInfo.latitude_deg);
                if (isNaN(airportLon) || isNaN(airportLat)) {
                    console.warn(`Skipping airport ${airportInfo.ident} due to invalid coordinates in database.`);
                    return;
                }
                const airportPosition = turf.point([airportLon, airportLat]);
                
                const data = {
                    icao: airportStatus.airportIcao,
                    name: airportStatus.airportName.replace(/"/g, ''),
                    inboundTotal: airportStatus.inboundFlightsCount || 0,
                    outboundOnGround: calculatedOnGroundCount,
                    outboundTotal: airportStatus.outboundFlightsCount || 0,
                    inboundBuckets: { in20: 0, in60: 0, over60: 0 },
                    // **MODIFIED LINE**: Implement custom sorting based on the gtsadOrder array.
                    activeFrequencies: activeFrequenciesByAirport[airportStatus.airportIcao] ? Array.from(activeFrequenciesByAirport[airportStatus.airportIcao]).sort((a, b) => gtsadOrder.indexOf(a) - gtsadOrder.indexOf(b)) : []
                };

                const inboundFlightIds = new Set(airportStatus.inboundFlights || []);
                inboundFlightIds.forEach(flightId => {
                    const flight = flightsMap.get(flightId);
                    if (flight && flight.speed > 50) { 
                        const flightLon = parseFloat(flight.longitude);
                        const flightLat = parseFloat(flight.latitude);
                        if (!isNaN(flightLon) && !isNaN(flightLat)) {
                            const aircraftPosition = turf.point([flightLon, flightLat]);
                            const distanceNM = turf.distance(aircraftPosition, airportPosition, { units: 'nauticalmiles' });
                            const eteMinutes = Math.round((distanceNM / flight.speed) * 60);
                            if (eteMinutes <= 20) data.inboundBuckets.in20++;
                            else if (eteMinutes <= 60) data.inboundBuckets.in60++;
                            else data.inboundBuckets.over60++;
                        }
                    }
                });
                airportTrafficData[data.icao] = data;
            });
            
            const sortedAirports = Object.values(airportTrafficData).sort((a, b) => b.inboundTotal - a.inboundTotal).slice(0, 20);

            if (sortedAirports.length === 0) {
                resultsContainer.innerHTML = '<p>No inbound flights detected on the server.</p>';
            } else {
                let htmlContent = sortedAirports.map(data => {
                    const frequencyBubbles = data.activeFrequencies.map(freqName => {
                        const initial = freqInitialMap[freqName];
                        const className = `freq-bubble freq-type-${freqName.toLowerCase()}`;
                        return `<span class="${className}" title="${freqName}">${initial}</span>`;
                    }).join('');

                    return `
                    <div class="traffic-card" data-icao="${data.icao}">
                        <div class="traffic-card-header">
                            <div class="airport-name">${data.name}</div>
                            <div class="airport-icao">${data.icao}</div>
                        </div>
                        <div class="traffic-card-body">
                            <div class="traffic-col">
                                <div class="col-header">
                                    <span class="icon-inbound"></span> Inbound
                                </div>
                                <div class="total-count">${data.inboundTotal}</div>
                                <div class="detail-breakdown">
                                    <span><span class="detail-value">${data.inboundBuckets.in20}</span> in &lt; 20 min</span>
                                    <span><span class="detail-value">${data.inboundBuckets.in60}</span> in &lt; 1 hr</span>
                                    <span><span class="detail-value">${data.inboundBuckets.over60}</span> in &gt; 1 hr</span>
                                </div>
                            </div>
                            <div class="traffic-col">
                                <div class="col-header">
                                    <span class="icon-outbound"></span> Outbound
                                </div>
                                <div class="total-count">${data.outboundOnGround}</div>
                                <div class="detail-breakdown">
                                    <span class="on-ground-text">on ground</span>
                                    <span class="total-departures-text"><span class="detail-value">${data.outboundTotal}</span> total departures</span>
                                </div>
                            </div>
                        </div>
                        ${frequencyBubbles ? `<div class="traffic-card-frequencies">${frequencyBubbles}</div>` : ''}
                    </div>
                `}).join('');

                resultsContainer.innerHTML = htmlContent;
                
                resultsContainer.querySelectorAll('.traffic-card').forEach(item => {
                    item.addEventListener('click', (e) => {
                        const selectedIcao = e.currentTarget.dataset.icao;
                        displayAirportDetails(selectedIcao);
                        const scanPanel = document.getElementById('traffic-scan-panel');
                        if (scanPanel) {
                            if (window.innerWidth <= 768) {
                               scanPanel.classList.remove('visible');
                            } else {
                               scanPanel.remove();
                            }
                        }
                    });
                });
            }
        } catch (error) {
            resultsContainer.innerHTML = `<p style="color: var(--danger-color); text-align: center;">Error: ${error.message}</p>`;
        } finally {
            scanButton.disabled = false;
            scanButton.textContent = 'Re-Scan';
        }
    }
     async function createLiveControlPanel() {
        const existingPanel = document.getElementById('live-control-panel');
        if (existingPanel) {
            existingPanel.style.display = 'block';
             if (window.innerWidth <= 768) existingPanel.classList.add('visible');
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

        Object.values(liveFlightMarkers).forEach(marker => marker.remove());
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

   function updateFlightMarkers(flights, sessionId) {
    const bounds = map.getBounds();
    const visibleFlightIds = new Set();
    const now = Date.now();

    // Create a lookup map for faster access
    const flightsById = new Map(flights.map(f => [f.flightId, f]));

    // First, update existing markers and identify visible ones
    for (const flightId in liveFlightMarkers) {
        const marker = liveFlightMarkers[flightId];
        const flight = flightsById.get(flightId);

        if (flight && bounds.contains([flight.longitude, flight.latitude])) {
            // The flight is still visible, so update its position and rotation.
            visibleFlightIds.add(flightId);

            marker.setLngLat([flight.longitude, flight.latitude]);
            const iconElement = marker.getElement().getElementsByTagName('img')[0];
            const isSelected = flight.flightId === selectedFlightId;

            if (iconElement) {
                // Only update the rotation and icon if they have changed.
                const newRotation = `rotate(${flight.heading}deg)`;
                if (iconElement.style.transform !== newRotation) {
                    iconElement.style.transform = newRotation;
                }
                const newIconPath = getAircraftIconPath(flight.aircraftName, isSelected);
                // Check against the full URL to be safe
                if (!iconElement.src.endsWith(newIconPath)) {
                   iconElement.src = newIconPath;
                }
            }
            
            // Only update popup if it's open
            if (marker.getPopup().isOpen()) {
                 const callsign = flight.callsign || 'N/A';
                 const altitude = (typeof flight.altitude === 'number') ? Math.round(flight.altitude) : null;
                 const speed = (typeof flight.speed === 'number') ? Math.round(flight.speed) : null;
                 const altitudeText = altitude !== null ? `${altitude.toLocaleString()}` : 'N/A';
                 const speedText = speed !== null ? `${speed}` : 'N/A';

                 // **FIXED**: This block now contains the full, correct HTML content.
                 const popupContent = `
                    <div class="flight-popup-header">
                        <div class="flight-popup-callsign">${callsign}</div>
                        <div class="flight-popup-aircraft">${flight.aircraftName || 'N/A'}</div>
                    </div>
                    <div class="flight-popup-body">
                         <div class="flight-popup-row"><span class="label">Altitude:</span><span class="value">${altitudeText} ft</span></div>
                         <div class="flight-popup-row"><span class="label">Speed:</span><span class="value">${speedText} kts</span></div>
                         <div class="flight-popup-row"><span class="label">User:</span><span class="value">${flight.username || 'N/A'}</span></div>
                    </div>
                    ${ flight.flightId ? `<div class="flight-popup-footer"><button class="cta-button view-fpl-btn" data-flight-id="${flight.flightId}" data-session-id="${sessionId}" data-callsign="${callsign}" data-altitude="${altitudeText} ft" data-speed="${speedText} kts GS">View FPL</button></div>` : '' }
                `;
                marker.getPopup().setHTML(popupContent);
            }

        } else {
            // The flight is no longer in the API data or is off-screen. Remove it.
            marker.remove();
            delete liveFlightMarkers[flightId];
        }
    }

    // Second, add only the new markers that have appeared
    flights.forEach(flight => {
        const flightId = flight.flightId;
        // If the flight is in the viewport but NOT in our list of already-updated markers, it's new.
        if (!visibleFlightIds.has(flightId) && bounds.contains([flight.longitude, flight.latitude])) {
            const lat = Number(flight.latitude);
            const lon = Number(flight.longitude);
            const isSelected = flight.flightId === selectedFlightId;
            
            const el = document.createElement('div');
            el.className = 'custom-map-marker';
            el.innerHTML = `<img src="${getAircraftIconPath(flight.aircraftName, isSelected)}" width="24" height="24" style="transform: rotate(${flight.heading}deg);">`;

            const popup = new maptilersdk.Popup({
                offset: 25,
                className: 'custom-popup',
                closeButton: false
            });

            const marker = new maptilersdk.Marker({ element: el })
                .setLngLat([lon, lat])
                .setPopup(popup)
                .addTo(map);

            // Add an event listener to generate content just-in-time when the popup opens.
            marker.on('popupopen', () => {
                const callsign = flight.callsign || 'N/A';
                const altitude = (typeof flight.altitude === 'number') ? Math.round(flight.altitude) : null;
                const speed = (typeof flight.speed === 'number') ? Math.round(flight.speed) : null;
                const altitudeText = altitude !== null ? `${altitude.toLocaleString()}` : 'N/A';
                const speedText = speed !== null ? `${speed}` : 'N/A';

                const popupContent = `
                    <div class="flight-popup-header">
                        <div class="flight-popup-callsign">${callsign}</div>
                        <div class="flight-popup-aircraft">${flight.aircraftName || 'N/A'}</div>
                    </div>
                    <div class="flight-popup-body">
                         <div class="flight-popup-row"><span class="label">Altitude:</span><span class="value">${altitudeText} ft</span></div>
                         <div class="flight-popup-row"><span class="label">Speed:</span><span class="value">${speedText} kts</span></div>
                         <div class="flight-popup-row"><span class="label">User:</span><span class="value">${flight.username || 'N/A'}</span></div>
                    </div>
                    ${ flight.flightId ? `<div class="flight-popup-footer"><button class="cta-button view-fpl-btn" data-flight-id="${flight.flightId}" data-session-id="${sessionId}" data-callsign="${callsign}" data-altitude="${altitudeText} ft" data-speed="${speedText} kts GS">View FPL</button></div>` : '' }
                `;
                // Now we set the HTML, only for the one popup that was opened.
                marker.getPopup().setHTML(popupContent);
            });

            liveFlightMarkers[flight.flightId] = marker;
        }
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

        // --- CORRECTED LOGIC ---
        // This new logic correctly processes nested waypoints.
        flightPlanItems.forEach(item => {
            // If an item has children, it's a procedure (like a SID/STAR).
            // We should only add the children waypoints to the route.
            if (item.children && item.children.length > 0) {
                allWaypoints.push(...item.children.filter(c => c.location));
            }
            // If it has no children but has a location, it's a standalone waypoint.
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

    /**
     * Helper function to compare two Sets for equality.
     * @param {Set} setA The first set.
     * @param {Set} setB The second set.
     * @returns {boolean} True if the sets contain the same elements.
     */
    function setsAreEqual(setA, setB) {
        if (setA.size !== setB.size) return false;
        for (const item of setA) {
            if (!setB.has(item)) return false;
        }
        return true;
    }

    // In app.js, replace the existing updateAtcList function with this one.
    async function updateAtcList(sessionId) {
        const atcListElement = document.getElementById('atc-list');
        if (!atcListElement) return;

        const frequencyTypeMap = { 0: 'Ground', 1: 'Tower', 2: 'Unicom', 3: 'Clearance', 4: 'Approach', 5: 'Departure', 6: 'Center', 7: 'ATIS' };

        try {
            const atcResponse = await fetch(`/.netlify/functions/atc/${sessionId}`);
            const atcData = await atcResponse.json();
            
            const airports = await getAirports(); // Ensure airport data is available

            // --- Track active ATC airports ---
            const newActiveAtisIcaos = new Set();
            const newActiveAtcIcaos = new Set();
            if (atcData.result) {
                atcData.result.forEach(facility => {
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
            // --- End tracking ---

            if (!atcResponse.ok || atcData.errorCode !== 0 || !atcData.result) {
                atcListElement.innerHTML = '<div class="atc-item">No active ATC on this server.</div>';
                return;
            }

            const atcByAirport = atcData.result
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

                // Find the full airport name from the cached data
                const airportInfo = airports.find(a => a.ident === icao);
                const airportFullName = airportInfo ? airportInfo.name.replace(/"/g, '') : (icao === "Center" ? "Center Control" : icao);

                const frequencyItems = airportData.frequencies.map(facility => {
                    const typeName = frequencyTypeMap[facility.type];
                    const controller = facility.username || "N/A";

                    // Calculate duration on frequency
                    let durationText = '';
                    if (facility.startTime) {
                        const startTime = new Date(facility.startTime);
                        const now = new Date();
                        const durationMs = now - startTime;
                        const hours = Math.floor(durationMs / 3600000);
                        const minutes = Math.floor((durationMs % 3600000) / 60000);
                        
                        if (hours > 0) {
                            durationText = `${hours}h ${minutes.toString().padStart(2, '0')}m`;
                        } else {
                            durationText = `${minutes}m`;
                        }
                    }

                    return `<li class="atc-frequency">
                              <span class="atc-type atc-type-${typeName.toLowerCase()}">${typeName}</span>
                              <div class="atc-controller-info">
                                  <span class="atc-controller">${controller}</span>
                                  <span class="atc-duration">${durationText}</span>
                              </div>
                            </li>`;
                }).join('');

                return `<div class="atc-item">
                          <div class="atc-airport-header">
                            <strong>${airportFullName}</strong>
                            <span>${icao}</span>
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
            updateAllFlightDataBlockStyles(); // Changed from toggleDataBlockVisibility()
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

    // Inside app.js

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
                <h3>Aircraft Speed Guidelines</h3>
                <p style="font-size: 13px; color: var(--text-secondary); margin-bottom: 15px;">
                    Use these minimum speeds as a reference for sequencing traffic. All speeds are for a "clean" configuration (no flaps).
                </p>

                <h4 class="guide-header">Narrow-Body Aircraft (e.g., A320, B737)</h4>
                <table class="speed-guide-table">
                    <thead>
                        <tr>
                            <th>Altitude Range</th>
                            <th>Suggested Minimum Speed</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr><td>Above FL280</td><td>Mach 0.76 - 0.78</td></tr>
                        <tr><td>FL180 to FL280</td><td>260 - 280 KIAS</td></tr>
                        <tr><td>12,000 ft to FL180</td><td>250 - 260 KIAS</td></tr>
                        <tr><td>Below 12,000 ft</td><td>210 - 240 KIAS</td></tr>
                    </tbody>
                </table>

                <h4 class="guide-header">Wide-Body Aircraft (e.g., A350, B777, B747)</h4>
                <table class="speed-guide-table">
                    <thead>
                        <tr>
                            <th>Altitude Range</th>
                            <th>Suggested Minimum Speed</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr><td>Above FL280</td><td>Mach 0.80 - 0.82</td></tr>
                        <tr><td>FL180 to FL280</td><td>280 - 300 KIAS</td></tr>
                        <tr><td>FL180 to FL180</td><td>260 - 280 KIAS</td></tr>
                        <tr><td>Below 12,000 ft</td><td>220 - 250 KIAS</td></tr>
                    </tbody>
                </table>
                <p class="guide-notes">
                    <strong>Remember:</strong> This are rough estimates, speeds may differ based on the situation.
                </p>
            </div>
            `;
        createFloatingPanel('help-panel', '<h2>Help</h2>', '150px', '150px', helpContent);
    }

    // --- MAP DRAWING AND UPDATING (Rewritten for MapTiler) ---
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
        
        // Also explicitly remove the info panel itself to ensure a clean state
        const infoPanel = document.getElementById('airport-info-panel');
        if (infoPanel) {
            infoPanel.remove();
        }
    }

    // This is a new function to clear airport-specific layers before drawing new ones.
    async function updateNavaids() {
    const navaidsCheckbox = document.getElementById('filter-navaids');
    const sourceId = 'openaip-navaids-source';
    const layerId = 'openaip-navaids-layer';

    if (!navaidsCheckbox || !navaidsCheckbox.checked) {
        if (map.getLayer(layerId)) {
            map.setLayoutProperty(layerId, 'visibility', 'none');
        }
        return;
    }

    const currentZoom = map.getZoom();
    if (currentZoom < 7) {
        if (map.getLayer(layerId)) {
            map.setLayoutProperty(layerId, 'visibility', 'none');
        }
        return;
    }

    const bounds = map.getBounds();
    const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
    const navaids = await getVORsFromOpenAIP(bbox);

    const VOR_TYPES = [3, 4, 5, 6, 7]; // VOR, VOR-DME, DME, NDB, TACAN
    const navaidFeatures = navaids
        .filter(navaid =>
            navaid &&
            VOR_TYPES.includes(navaid.type) &&
            navaid.geometry &&
            navaid.geometry.coordinates
        )
        .map(navaid => {
            const lat = navaid.geometry.coordinates[1];
            const lon = navaid.geometry.coordinates[0];
            let declination = 0;
            if (wmmModel) {
                declination = wmmModel.field(lat, lon).declination;
            }

            const frequencyText = navaid.frequency ? `${(navaid.frequency.value / 1000).toFixed(3)} MHz` : '';
            const identifierText = navaid.identifier || '';
            const secondLine = `${frequencyText} ${identifierText}`.trim();

            return {
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: [lon, lat]
                },
                properties: {
                    name: navaid.name,
                    rotation: declination,
                    details: secondLine
                }
            };
        });

    const geojsonData = {
        type: 'FeatureCollection',
        features: navaidFeatures
    };

    const source = map.getSource(sourceId);
    if (source) {
        source.setData(geojsonData);
    } else {
        map.addSource(sourceId, {
            type: 'geojson',
            data: geojsonData
        });

        map.addLayer({
            id: layerId,
            type: 'symbol',
            source: sourceId,
            layout: {
                'icon-image': 'vor-compass-rose',
                'icon-size': 0.5,
                'icon-allow-overlap': true,
                'icon-rotation-alignment': 'map',
                'icon-rotate': ['get', 'rotation'],
                
                'text-field': [
                    'concat',
                    ['upcase', ['get', 'name']],
                    '\n',
                    ['get', 'details']
                ],
                'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
                'text-size': 14,
                'text-line-height': 1.1,
                'text-justify': 'center',
                'text-anchor': 'top',
                // --- MODIFIED: Increased offset to move text down ---
                'text-offset': [0, 5]
            },
            paint: {
                'text-color': '#FFFFFF',
                'text-halo-color': '#000000',
                'text-halo-width': 1.5
            }
        });
    }

    if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, 'visibility', 'visible');
    }
}

	async function updateWaypoints() {
		const waypointsCheckbox = document.getElementById('filter-waypoints');
		const layerId = 'waypoints-layer';
		const sourceId = 'waypoints-source';
	
		// If the checkbox is unchecked, ensure the layer is hidden and exit.
		if (!waypointsCheckbox || !waypointsCheckbox.checked) {
			if (map.getLayer(layerId)) {
				map.setLayoutProperty(layerId, 'visibility', 'none');
			}
			return;
		}
	
		const bounds = map.getBounds();
		const waypoints = await getWaypoints();
	
		const waypointFeatures = waypoints.filter(wp => {
			if (!Array.isArray(wp.coords) || wp.coords.length < 2) return false;
			const lon = wp.coords[0];
			const lat = wp.coords[1];
			return lat >= bounds.getSouth() && lat <= bounds.getNorth() && lon >= bounds.getWest() && lon <= bounds.getEast();
		}).map(wp => ({
			type: 'Feature',
			geometry: {
				type: 'Point',
				coordinates: [wp.coords[0], wp.coords[1]]
			},
			properties: {
				name: wp.name
			}
		}));
	
		// If the source already exists, just update its data. Otherwise, create source and layer.
		if (map.getSource(sourceId)) {
			map.getSource(sourceId).setData({ type: 'FeatureCollection', features: waypointFeatures });
		} else {
			map.addSource(sourceId, {
				type: 'geojson',
				data: { type: 'FeatureCollection', features: waypointFeatures }
			});
	
			// Add the layer with new styling for waypoints.
			map.addLayer({
				id: layerId,
				type: 'symbol',
				source: sourceId,
				minzoom: 8, // Show waypoint icons from zoom level 8+
				layout: {
                    // --- Icon: A smaller black triangle ---
                    'icon-image': 'triangle-15',
                    'icon-size': 0.8, // Make the icon smaller on the map
                    'icon-allow-overlap': false,

                    // --- Label: The waypoint name, shown conditionally ---
                    'text-field': ['get', 'name'],
                    'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
                    'text-size': [
                        'step',
                        ['zoom'],
                        0,
                        11,
                        10
                    ],
                    'text-anchor': 'top',
                    'text-offset': [0, 0.8],
                    'text-allow-overlap': false,
                    'text-optional': true,
                },
                paint: {
                    // --- Icon Color: Black triangle with a white halo ---
                    'icon-color': '#000000',
                    'icon-halo-color': '#FFFFFF',
                    'icon-halo-width': 1,

                    // --- Label Color ---
                    'text-color': '#ddd',
                    'text-halo-color': '#000',
                    'text-halo-width': 1.5
                }
			});
		}
	
		// Finally, ensure the layer is visible (if the checkbox is checked).
		if (map.getLayer(layerId)) {
			map.setLayoutProperty(layerId, 'visibility', 'visible');
		}
	}

    function updateAirports() {
        if (activeAirportIcao) {
            // If an airport is selected, hide the general airport dots and pulse layer.
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
                // Add a property to track if ATC is active, used for the pulse filter
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

            // Add the pulse layer first, so it appears underneath the main dot
            map.addLayer({
                id: pulseLayerId,
                type: 'circle',
                source: sourceId,
                filter: ['==', ['get', 'hasActiveAtc'], true], // Only show for active airports
                paint: {
                    'circle-radius': 10, // This will be animated
                    'circle-color': '#EABFFF', // Accent Purple
                    'circle-opacity': 0.5, // This will be animated
                    'circle-stroke-width': 2,
                    'circle-stroke-color': '#FFFFFF'
                }
            });

            // Add the main airport dot layer
            map.addLayer({
                id: layerId,
                type: 'circle',
                source: sourceId,
                paint: {
                    'circle-radius': ['match', ['get', 'type'], 'large_airport', 7, 'medium_airport', 5, 3],
                    // --- MODIFICATION START ---
                    // This 'case' expression checks for active ATC first.
                    // If an airport has active ATC, its color is set to a dark blue.
                    // Otherwise, it falls back to the color based on airport type.
                    'circle-color': [
                        'case',
                        ['==', ['get', 'hasActiveAtc'], true],
                        '#4169E1', // Royal Blue for active ATC
                        ['match', ['get', 'type'],
                            'large_airport', '#FF0000',     // Bravo
                            'medium_airport', '#FFA500',    // Charlie
                            'small_airport', '#2980b9',     // Small/Other
                            '#95a5a6'                       // Default fallback
                        ]
                    ],
                    // --- MODIFICATION END ---
                    'circle-stroke-color': '#000',
                    'circle-stroke-width': 1
                }
            });

            // Technical Note on Layering: The plane icons (maptilersdk.Marker) are HTML elements
            // that are rendered on top of the map canvas. The airport dots are GeoJSON layers
            // drawn directly on the canvas. Because of this, the HTML markers for planes will
            // always appear on top of the canvas-drawn airport dots. Changing this behavior
            // would require refactoring the flight markers to be a GeoJSON symbol layer.

            map.on('click', layerId, (e) => {
                const icao = e.features[0].properties.icao;
                displayAirportDetails(icao);
            });

            map.on('mouseenter', layerId, () => { map.getCanvas().style.cursor = 'pointer'; });
            map.on('mouseleave', layerId, () => { map.getCanvas().style.cursor = ''; });
        }

        // Ensure layers are visible
        if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', 'visible');
        if (map.getLayer(pulseLayerId)) map.setLayoutProperty(pulseLayerId, 'visibility', 'visible');
    }

    /**
     * Animates the pulsating halo for active airports.
     */
    function animatePulse() {
        if (!isLiveModeActive || !map.getLayer('airport-dots-pulse-layer')) {
            pulseAnimationId = null;
            return; // Stop animation if not in live mode or layer is gone
        }

        const duration = 2000; // 2-second pulse cycle
        const t = (performance.now() % duration) / duration;

        // A sine wave makes the pulse expand and contract smoothly
        const pulseAmount = Math.sin(t * Math.PI);

        const maxRadiusIncrease = 10;
        const radius = pulseAmount * maxRadiusIncrease;
        const opacity = 1 - pulseAmount;

        map.setPaintProperty('airport-dots-pulse-layer', 'circle-radius', [
            '+',
            ['match', ['get', 'type'], 'large_airport', 7, 'medium_airport', 5, 3], // Base radius
            radius // Add animated pulse radius
        ]);
        map.setPaintProperty('airport-dots-pulse-layer', 'circle-opacity', opacity);
        map.setPaintProperty('airport-dots-pulse-layer', 'circle-stroke-opacity', opacity);

        pulseAnimationId = requestAnimationFrame(animatePulse);
    }
    async function displayAirportDetails(icao) {
        clearAirportLayers(); // Clear everything
        activeAirportIcao = icao;
        updateAirports(); // This will now hide the airport dots

        try {
            const airports = await getAirports();
            const airport = airports.find(a => a.ident === icao);
            if (!airport) return alert(`Airport with ICAO ${icao} not found.`);

            const lat = parseFloat(airport.latitude_deg);
            const lon = parseFloat(airport.longitude_deg);
            currentAirportCoords = { lat, lng: lon };

            const airportRunways = await getRunwaysForAirport(icao);
            drawRunwaysForAirport(icao); // Rewritten to use GeoJSON
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

     /**
     * Formats and displays ATIS information in the airport info panel.
     * @param {string} atisText The raw ATIS text.
     * @param {boolean} isStale Whether the ATIS is from a controller who is no longer active.
     */
    function displayAtis(atisText, isStale) {
        const atisContentElement = document.getElementById('atis-content');
        if (!atisContentElement) return;

        // Use a regular expression to find and bold the ATIS information letter/word.
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

        // Fetch and display ATIS if in live mode, with caching.
        const atisContentElement = document.getElementById('atis-content');
        if (isLiveModeActive) {
            const serverSelect = document.getElementById('server-select');
            const sessionId = serverSelect ? serverSelect.value : null;
            const airportIdent = airport.ident;

            if (sessionId) {
                // If an ATIS controller is active for this airport, fetch fresh data.
                if (activeAtisStationIcaos.has(airportIdent)) {
                    try {
                        const atisResponse = await fetch(`/.netlify/functions/atis/${sessionId}/${airportIdent}`);
                        const atisData = await atisResponse.json();

                        if (atisResponse.ok && atisData.errorCode === 0 && atisData.result) {
                            // Cache the fresh data and display it.
                            atisCache[airportIdent] = atisData.result;
                            displayAtis(atisData.result, false);
                        } else {
                            // The controller is active, but ATIS fetch failed (maybe they just left).
                            // Fallback to cache if it exists, and display as stale.
                            if (atisCache[airportIdent]) {
                                displayAtis(atisCache[airportIdent], true);
                            } else {
                                atisContentElement.textContent = 'No active ATIS for this airport.';
                            }
                        }
                    } catch (error) {
                        console.error('Failed to fetch ATIS:', error);
                        // On network error, fallback to cache if it exists, and display as stale.
                        if (atisCache[airportIdent]) {
                            displayAtis(atisCache[airportIdent], true);
                        } else {
                            atisContentElement.textContent = 'Error loading ATIS data.';
                        }
                    }
                } else {
                    // No active controller, so rely entirely on the cache for "Last ATIS".
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
            // Not in live mode.
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

                // Add labels and final approach cones
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

            // Add sources and layers to the map
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
                ['==', ['get', 'id'], runwayId], '#FFD700', // Highlight color
                RUNWAY_STYLE_REGULAR['fill-color'] // Default color
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
        if (!isDrawingEnabled || (e.originalEvent.button && e.originalEvent.button !== 0)) return;

        // Prevent drawing when clicking on a UI panel
        if (e.originalEvent.target.closest('.floating-panel')) return;

        isDrawing = true;
        const startPoint = e.lngLat;

        // Initialize a GeoJSON source for the temporary line
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

        // Create a temporary label marker
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
        if (!source || !source._data.coordinates[0]) return; // Guard against race condition

        const startPointLngLat = source._data.coordinates[0];
        const startPoint = { lat: startPointLngLat[1], lng: startPointLngLat[0] };

        // Update the line's endpoint
        source.setData({
            type: 'LineString',
            coordinates: [[startPoint.lng, startPoint.lat], [currentPoint.lng, currentPoint.lat]]
        });

        // Update the label
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
        if (!source || !source._data.coordinates[0]) return; // Guard

        const startPointLngLat = source._data.coordinates[0];
        const startPoint = { lat: startPointLngLat[1], lng: startPointLngLat[0] };

        // Remove the temporary line and label
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
        // Collision check needs rework for MapTiler's coordinate system if still needed
        // For now, we'll use the optimal position.

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

    // --- HELPER FUNCTIONS (Updated for MapTiler / Turf.js) ---

    /**
     * Determines the appropriate icon path for an aircraft based on its type.
     * @param {string} aircraftName - The name of the aircraft (e.g., "Airbus A380-800").
     * @param {boolean} isSelected - Whether the aircraft is currently selected.
     * @returns {string} The path to the icon image.
     */
    function getAircraftIconPath(aircraftName, isSelected) {
        // If the flight is selected, always use the highlight icon to show its state.
        if (isSelected) {
            return '/whiteplane.png';
        }

        // Use a case-insensitive search for robust matching.
        const lowerCaseName = (aircraftName || "").toLowerCase();

        // --- Aircraft to Image Mapping ---
        // Add more mappings here as you add more aircraft images.
        const aircraftMap = {
            'a380': '/a380.png',
            '747': '/a380.png',
        };

        // Find the first matching keyword in the aircraft name.
        for (const key in aircraftMap) {
            if (lowerCaseName.includes(key)) {
                return aircraftMap[key]; // Return the custom image path.
            }
        }

        // If no specific type is found, return the default icon.
        return '/plane.png';
    }

    function calculateHeading(start, end) {
        // Turf.js calculates bearing from north, which is what we need.
        const bearing = turf.bearing(
            turf.point([start.lng, start.lat]),
            turf.point([end.lng, end.lat])
        );
        return (bearing + 360) % 360; // Normalize to 0-360
    }

    const getMidPoint = (start, end) => ({
        lat: (start.lat + end.lat) / 2,
        lng: (start.lng + end.lng) / 2
    });

    function createDistanceRings(lat, lon) {
        // Defines the distances and labels for the rings
        const ringSpecs = [
            { nm: 10, label: "10 NM" },
            { nm: 20, label: "20 NM" },
            { nm: 30, label: "30 NM" }
        ];

        const ringLineFeatures = [];
        const ringLabelFeatures = [];

        // Generate the GeoJSON features for each ring
        ringSpecs.forEach(spec => {
            // Create a circle for the ring line
            const circle = turf.circle([lon, lat], spec.nm, { units: 'nauticalmiles', steps: 128 });
            ringLineFeatures.push(circle);

            // Create a point on the ring to place the distance label
            // Positioned at a 45-degree angle (NE) from the center
            const labelPoint = turf.destination(
                turf.point([lon, lat]),
                spec.nm,
                45, // Bearing
                { units: 'nauticalmiles' }
            );
            labelPoint.properties = {
                labelText: spec.label
            };
            ringLabelFeatures.push(labelPoint);
        });

        const ringLinesGeoJSON = { type: 'FeatureCollection', features: ringLineFeatures };
        const ringLabelsGeoJSON = { type: 'FeatureCollection', features: ringLabelFeatures };

        // To create a "halo" effect for better visibility, we'll draw two lines:
        // 1. A wider, darker, semi-transparent line as the background (casing).
        // 2. A thinner, bright, dashed line on top.

        // Add the background "casing" layer
        addSourceAndLayer('distance-rings-casing',
            { type: 'geojson', data: ringLinesGeoJSON },
            {
                type: 'line',
                paint: {
                    'line-color': '#000000', // Black
                    'line-width': 3,         // Wider
                    'line-opacity': 0.6      // Semi-transparent
                }
            }
        );

        // Add the main, visible dashed line layer
        addSourceAndLayer('distance-rings',
            { type: 'geojson', data: ringLinesGeoJSON },
            {
                type: 'line',
                paint: {
                    'line-color': '#FFFFFF',     // Bright white for high contrast
                    'line-width': 1.5,
                    'line-dasharray': [4, 6] // A clear dash pattern
                }
            }
        );

        // Add the text labels for each ring
        addSourceAndLayer('distance-ring-labels',
            { type: 'geojson', data: ringLabelsGeoJSON },
            {
                type: 'symbol',
                layout: {
                    'text-field': ['get', 'labelText'],
                    'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
                    'text-size': 14,
                    'text-allow-overlap': true // Ensures labels are always shown
                },
                paint: {
                    'text-color': '#FFFFFF',
                    'text-halo-color': '#000000', // Black halo for readability
                    'text-halo-width': 2
                }
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
    function toggleDataBlockVisibility() {
        const visibility = appSettings.showDataBlocks ? 'visible' : 'none';
        Object.values(planLabels).forEach(marker => {
            marker.getElement().style.visibility = visibility;
        });
    }

     function updateAllFlightDataBlockStyles() {
        Object.keys(planLayers).forEach(stepId => updateDataBlock(stepId));
    }

     function updateDataBlock(stepId) {
        const legData = planLayers[stepId];
        if (!legData || !legData.label) return;

        const markerElement = legData.label.getElement();

        // If blocks are hidden, set display to none and exit.
        if (!appSettings.showDataBlocks) {
            markerElement.style.display = 'none';
            return;
        }

        // If blocks are shown, ensure the element is visible.
        markerElement.style.display = 'block';

        const startAlt = legData.startAltitude;
        const endAlt = legData.endAltitude;
        let altitudeHtml;

        if (startAlt !== undefined && endAlt !== undefined && startAlt !== endAlt) {
            altitudeHtml = `<div class="fdb-data-item fdb-altitude"><span class="fdb-value" style="font-size: 12px; color: #FFD700;">${(startAlt / 1000).toFixed(1).replace('.0','')}k &rarr; ${(endAlt / 1000).toFixed(1).replace('.0','')}k</span><span class="fdb-unit">ft</span></div>`;
            const color = endAlt < startAlt ? '#FF8C00' : '#39FF14';
            // Update line color if needed
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

            // Revert line color
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
    // ... all other functions should be reviewed and updated if they contained any map-specific logic.
    // For brevity, only the most critical rewrites are shown in detail.
    // The structure for functions like createHelpPanel, createAltitudeProfilePanel, etc., remains the same.
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
            // adjustAllLabelPositions();
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
            const elevationMeters = await getPublicElevation(latlng);

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
            console.error("Failed to display elevation data:", error);
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

        // Return a point 75% of the way along the line
        return {
            lat: start.lat + (end.lat - start.lat) * 0.75,
            lng: start.lng + (end.lng - start.lng) * 0.75
        };
    }
     function createOrShowPlanPanel() {
        let planPanel = document.getElementById('plan-panel');
        if (planPanel) {
            planPanel.style.display = 'block';
            if (window.innerWidth <= 768) planPanel.classList.add('visible');
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
            // Clear all plan-related layers and markers
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

            // Treat an empty input as clearing the altitude values to undefined.
            if (value === '') {
                legData.altitude = undefined;
                legData.startAltitude = undefined;
                legData.endAltitude = undefined;
            } else {
                // Otherwise, parse the number and update the state if it's valid.
                const newAlt = parseInt(value, 10);
                if (!isNaN(newAlt)) {
                    legData.altitude = newAlt;
                    legData.startAltitude = newAlt;
                    legData.endAltitude = newAlt;
                }
            }
            // Update the UI and save the changes.
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
        // This is complex with MapTiler as it requires screen coordinate conversions
        // For now, this function is simplified. A full implementation would need
        // a more robust collision detection system based on map.project().
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