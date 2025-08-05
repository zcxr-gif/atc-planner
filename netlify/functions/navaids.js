// /netlify/functions/navaids.js

// Using 'node-fetch' for robust fetching in a Node.js environment.
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
  const requestUrl = `https://api.openaip.net/api/navaids?bbox=${bbox}`;

  try {
    const response = await fetch(requestUrl, {
      headers: {
        'x-openaip-client-id': openAipApiKey,
      },
    });

    // If OpenAIP returns an error (like 401 Unauthorized), pass it to the client.
    if (!response.ok) {
      return {
        statusCode: response.status,
        body: JSON.stringify({ message: `Error from OpenAIP: ${response.statusText}` }),
      };
    }

    // 4. Send the successful data back to the client application.
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