const fetch = require('node-fetch');

exports.handler = async function(event, context) {
  const apiKey = process.env.INFINITE_FLIGHT_API_KEY;
  const sessionId = event.path.split('/').pop();
  const url = `https://api.infiniteflight.com/public/v2/sessions/${sessionId}/flights`;

  try {
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (!res.ok) {
      return { statusCode: res.status, body: JSON.stringify({ error: "Failed to fetch flights" }) };
    }

    const json = await res.json();

    // Debug: Log the first flight object for inspection (remove/comment out in production)
    if (json.result && json.result.length > 0) {
      console.log('[DEBUG] First flight object:', JSON.stringify(json.result[0], null, 2));
    }

    // Use the first available unique identifier for each flight
    const flights = json.result.map((f, idx) => ({
      flightId: f.flightId || f.id || f.callsign || `flight-${idx}`,
      latitude: f.latitude,
      longitude: f.longitude,
      heading: f.heading,
      callsign: f.callsign,
      aircraftName: f.aircraftName || "",
      username: f.username,
      altitude: f.altitude,
      speed: f.speed
    }));

    return {
      statusCode: 200,
      body: JSON.stringify({ result: flights })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};