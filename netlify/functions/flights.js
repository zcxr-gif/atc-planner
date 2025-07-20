const fetch = require('node-fetch');

exports.handler = async function(event, context) {
  const apiKey = process.env.INFINITE_FLIGHT_API_KEY;
  const sessionId = event.path.split('/').pop();
  
  // URLs for the API endpoints
  const flightsUrl = `https://api.infiniteflight.com/public/v2/sessions/${sessionId}/flights`;
  const aircraftUrl = 'https://api.infiniteflight.com/public/v2/aircraft'; // New: URL for aircraft data

  try {
    // --- NEW: Fetch all aircraft models first ---
    const aircraftRes = await fetch(aircraftUrl, {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (!aircraftRes.ok) {
      return { statusCode: aircraftRes.status, body: JSON.stringify({ error: "Failed to fetch aircraft data" }) };
    }

    const aircraftJson = await aircraftRes.json();
    
    // Create a Map for easy lookup of aircraft names by their ID
    const aircraftMap = new Map(aircraftJson.result.map(ac => [ac.id, ac.name]));
    // --- End of new section ---

    // Fetch the flights for the given session
    const res = await fetch(flightsUrl, {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (!res.ok) {
      return { statusCode: res.status, body: JSON.stringify({ error: "Failed to fetch flights" }) };
    }

    const json = await res.json();

    if (json.result && json.result.length > 0) {
      console.log('[DEBUG] First flight object:', JSON.stringify(json.result[0], null, 2));
    }

    const flights = json.result.map((f, idx) => {
      // UPDATED: Look up the aircraft name using the map.
      // This assumes the flight object 'f' has an 'aircraftId' field.
      // It falls back to the original aircraftName or a default string if not found.
      const aircraftName = aircraftMap.get(f.aircraftId) || f.aircraftName || "Unknown Aircraft";

      return {
        flightId: f.flightId || f.id || f.callsign || `flight-${idx}`,
        latitude: f.latitude,
        longitude: f.longitude,
        heading: f.heading,
        callsign: f.callsign,
        aircraftName: aircraftName, // Use the name we found
        username: f.username,
        altitude: f.altitude,
        speed: f.speed
      };
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ result: flights })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};