const fetch = require('node-fetch');

exports.handler = async function(event, context) {
  const apiKey = process.env.INFINITE_FLIGHT_API_KEY;
  const flightId = event.path.split('/').pop();
  const url = `https://api.infiniteflight.com/public/v2/flights/${flightId}/flightplan`;

  console.log(`[flightplan.js] Attempting to fetch flight plan for flightId: ${flightId}`);
  console.log(`[flightplan.js] Target URL: ${url}`);
  // IMPORTANT: Do NOT log your API key in production logs!
  // console.log(`[flightplan.js] Using API Key (first few chars): ${apiKey ? apiKey.substring(0, 5) + '...' : 'Not set'}`);

  if (!apiKey) {
    console.error("[flightplan.js] Error: INFINITE_FLIGHT_API_KEY environment variable is not set.");
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server error: Infinite Flight API Key is not configured." })
    };
  }

  try {
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    console.log(`[flightplan.js] Infinite Flight API Response Status: ${res.status}`);
    console.log(`[flightplan.js] Infinite Flight API Response Status Text: ${res.statusText}`);

    if (!res.ok) {
      // Pass the error from the Infinite Flight API to the client
      const errorBody = await res.text();
      console.error(`[flightplan.js] Infinite Flight API returned an error: ${res.status} - ${errorBody}`);
      return {
        statusCode: res.status,
        body: JSON.stringify({ error: `Failed to fetch flight plan from Infinite Flight API: ${errorBody}` })
      };
    }

    const json = await res.json();
    console.log("[flightplan.js] Successfully fetched flight plan.");
    
    return {
      statusCode: 200,
      body: JSON.stringify(json) // The response is already in the correct shape
    };
  } catch (e) {
    console.error(`[flightplan.js] Caught an exception: ${e.message}`);
    return { statusCode: 500, body: JSON.stringify({ error: `Server error during flight plan fetch: ${e.message}` }) };
  }
};