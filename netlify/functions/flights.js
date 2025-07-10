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
    // Map to your frontend's expected shape
    const flights = json.result.map(f => ({
  flightId: f.id,
  latitude: f.latitude,
  longitude: f.longitude,
  heading: f.heading,
  callsign: f.callsign,
  aircraftName: f.aircraft?.name || "",
  username: f.username,
  altitude: f.altitude,
  speed: f.groundSpeed  
}));

    return {
      statusCode: 200,
      body: JSON.stringify({ result: flights })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};