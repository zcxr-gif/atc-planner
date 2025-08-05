// /netlify/functions/navaids.js

const fetch = require('node-fetch');

/**
 * Handles requests for VOR navaid data.
 * It securely fetches data from the OpenAIP API using a server-side API key.
 */
exports.handler = async (event) => {
  // 1. Get the API key from server environment variables.
  const openAipApiKey = process.env.OPENAIP_API_KEY;
  if (!openAipApiKey) {
    console.error("FATAL: OPENAIP_API_KEY is not set on the server.");
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Server is not configured correctly." }),
    };
  }

  // 2. Get the required bounding box from the request URL.
  const { bbox } = event.queryStringParameters;
  if (!bbox) {
    return {
      statusCode: 400, // Bad Request
      body: JSON.stringify({ message: "A 'bbox' query parameter is required." }),
    };
  }

  // 3. Prepare and send the request to the OpenAIP service.
  const requestUrl = `https://api.core.openaip.net/api/navaids?bbox=${bbox}&page=1&limit=500`;

  try {
    const response = await fetch(requestUrl, {
      headers: {
        // CORRECTED: Use the correct header 'x-openaip-api-key'
        'x-openaip-api-key': openAipApiKey,
      },
    });

    if (!response.ok) {
      return {
        statusCode: response.status,
        body: JSON.stringify({ message: `Error from OpenAIP: ${response.statusText}` }),
      };
    }
    
    const data = await response.json();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };

  } catch (error) {
    console.error("An unexpected network error occurred:", error);
    return {
      statusCode: 502, // Bad Gateway
      body: JSON.stringify({ message: "There was a problem communicating with the navaid data service." }),
    };
  }
};