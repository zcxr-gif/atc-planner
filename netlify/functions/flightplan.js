const fetch = require('node-fetch');

exports.handler = async function(event, context) {
  const apiKey = process.env.INFINITE_FLIGHT_API_KEY;
  const flightId = event.path.split('/').pop();
  const url = `https://api.infiniteflight.com/public/v2/flights/${flightId}/flightplan`;

  try {
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (!res.ok) {
      // Pass the error from the Infinite Flight API to the client
      const errorBody = await res.text();
      return { statusCode: res.status, body: JSON.stringify({ error: `Failed to fetch flight plan: ${errorBody}` }) };
    }

    const json = await res.json();
    
    return {
      statusCode: 200,
      body: JSON.stringify(json) // The response is already in the correct shape
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};