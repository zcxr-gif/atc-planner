// netlify/functions/infiniteflight.js

// Use node-fetch version 2 if you get errors with version 3
const fetch = require('node-fetch');

// Your API key should be set in the Netlify UI, not here.
const IF_API_KEY = process.env.INFINITE_FLIGHT_API_KEY;
const IF_API_URL = 'https://api.infiniteflight.com/v2';

exports.handler = async function (event, context) {
  // The end of the URL path will tell us what to fetch.
  // E.g., /api/sessions -> event.path is /api/sessions
  const path = event.path.replace('/api/', '');
  const fullUrl = `${IF_API_URL}/${path}`;

  try {
    const response = await fetch(fullUrl, {
      headers: {
        'Authorization': `Bearer ${IF_API_KEY}`,
      },
    });

    if (!response.ok) {
        return { statusCode: response.status, body: response.statusText };
    }

    const data = await response.json();

    return {
      statusCode: 200,
      body: JSON.stringify(data),
    };
  } catch (error) {
    return { statusCode: 500, body: error.toString() };
  }
};