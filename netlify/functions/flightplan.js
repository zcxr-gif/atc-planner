// flightplan.js
const fetch = require('node-fetch');

exports.handler = async function(event, context) {
  // --- 1. Get API Key and Flight ID ---
  const apiKey = process.env.INFINITE_FLIGHT_API_KEY;
  const flightId = event.path.split('/').pop(); // Extract flightId from the URL (e.g., /flightplan/some-id)
  const url = `https://api.infiniteflight.com/public/v2/flights/${flightId}/flightplan`;

  console.log(`[FPL Handler] Fetching FPL for flightId: ${flightId}`);

  // --- 2. API Key Validation ---
  if (!apiKey) {
    console.error("[FPL Handler] CRITICAL: INFINITE_FLIGHT_API_KEY is not set in environment variables.");
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server configuration error: API key is missing." })
    };
  }

  // --- 3. API Call ---
  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    // --- 4. Handle Non-OK Responses ---
    // If the API returns a 404 (Not Found) or other error, handle it gracefully.
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[FPL Handler] Infinite Flight API returned an error. Status: ${response.status}. Body: ${errorText}`);
      return {
        statusCode: response.status, // Pass the original status code through
        body: JSON.stringify({
          error: `The Infinite Flight API returned an error.`,
          details: errorText
        })
      };
    }

    // --- 5. Success Case ---
    const flightPlanData = await response.json();
    console.log(`[FPL Handler] Successfully fetched and returned flight plan for ${flightId}.`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(flightPlanData) // Forward the successful JSON response
    };

  } catch (err) {
    // --- 6. Handle Network or other unexpected errors ---
    console.error(`[FPL Handler] An unexpected error occurred: ${err.message}`);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `A server error occurred while trying to fetch the flight plan.` })
    };
  }
};