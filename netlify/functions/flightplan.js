// In a new file: /functions/flightplan.js

const fetch = require('node-fetch');

exports.handler = async function(event, context) {
  const apiKey = process.env.INFINITE_FLIGHT_API_KEY;
  const flightId = event.path.split('/').pop(); // Get flightId from the URL
  const url = `https://api.infiniteflight.com/public/v2/flights/${flightId}/flightplan`;

  if (!flightId) {
    return { statusCode: 400, body: JSON.stringify({ error: "Flight ID is required" }) };
  }

  try {
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (!res.ok) {
      return { statusCode: res.status, body: JSON.stringify({ error: "Failed to fetch flight plan" }) };
    }

    const json = await res.json();
    return {
      statusCode: 200,
      body: JSON.stringify(json) // Send the raw flight plan data back
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};