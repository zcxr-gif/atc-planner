// /netlify/functions/navaids.js

/**
 * Netlify serverless function to fetch navaid data from the OpenAIP API.
 * This function acts as a secure proxy to protect the API key.
 */
exports.handler = async function(event) {
  // --- CONFIGURATION ---
  // IMPORTANT: Your OpenAIP API key must be set as an environment variable
  // in your Netlify project settings.
  const apiKey = process.env.OPENAIP_API_KEY;

  // 1. Validate API Key
  if (!apiKey) {
    console.error("OpenAIP API key is not configured in environment variables.");
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server configuration error: API key is missing." })
    };
  }

  // 2. Validate Bounding Box Parameter
  const { bbox } = event.queryStringParameters;
  if (!bbox) {
    return {
      statusCode: 400, // Bad Request
      body: JSON.stringify({ error: "The 'bbox' (bounding box) query parameter is required." })
    };
  }

  // 3. Construct the OpenAIP API URL
  const apiURL = `https://api.openaip.net/api/navaids?bbox=${bbox}`;

  // 4. Fetch Data from OpenAIP
  try {
    const response = await fetch(apiURL, {
      method: 'GET',
      headers: {
        // The API key is sent as a header for security
        'x-openaip-client-id': apiKey
      }
    });

    // Handle non-successful responses from OpenAIP
    if (!response.ok) {
        const errorText = await response.text();
        console.error(`OpenAIP API Error (Status: ${response.status}): ${errorText}`);
        return {
            statusCode: response.status,
            body: JSON.stringify({ error: `Failed to fetch data from OpenAIP. Status: ${response.status}` })
        };
    }

    const data = await response.json();

    // 5. Return a successful response to the client
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*' // Allows the function to be called from any domain
      },
      // The frontend expects the data to be in the body of the response
      body: JSON.stringify(data)
    };

  } catch (error) {
    console.error("An unexpected error occurred in the navaids function:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "An internal server error occurred while fetching navaid data." })
    };
  }
};