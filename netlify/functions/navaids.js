// File: netlify/functions/navaids.js
const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  // Get the API key from Netlify's environment variables
  const OPENAIP_API_KEY = process.env.OPENAIP_API_KEY;

  if (!OPENAIP_API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'API key not configured on the server.' })
    };
  }

  try {
    // Get the 'bbox' query parameter from the event object
    const { bbox } = event.queryStringParameters;
    if (!bbox) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Bbox parameter is required.' })
      };
    }

    const apiUrl = `https://api.core.openaip.net/api/navaids?bbox=${bbox}&page=1&limit=500`;

    const apiResponse = await fetch(apiUrl, {
      headers: {
        'x-openaip-api-key': OPENAIP_API_KEY,
      },
    });

    if (!apiResponse.ok) {
      throw new Error(`OpenAIP API responded with status: ${apiResponse.status}`);
    }

    const data = await apiResponse.json();

    // Return a success response
    return {
      statusCode: 200,
      body: JSON.stringify(data)
    };
  } catch (error) {
    console.error('Function error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'An error occurred while fetching data.' })
    };
  }
};