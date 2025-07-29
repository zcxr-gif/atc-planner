const fetch = require('node-fetch');

exports.handler = async function(event, context) {
  // Get the API key from your Netlify environment variables
  const apiKey = process.env.INFINITE_FLIGHT_API_KEY;

  // Get the session ID from the request URL
  const sessionId = event.path.split('/').pop();

  if (!sessionId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Session ID is required.' }),
    };
  }

  // This is the official 'Get World Status' API endpoint [cite: 12]
  const apiUrl = `https://api.infiniteflight.com/public/v2/sessions/${sessionId}/world`;

  try {
    const response = await fetch(apiUrl, {
      headers: {
        // Authorize the request with your API key [cite: 13]
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (!response.ok) {
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: `API Error: ${response.statusText}` })
      };
    }

    const data = await response.json();

    return {
      statusCode: 200,
      body: JSON.stringify(data)
    };

  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to fetch world status data.' })
    };
  }
};