// netlify/functions/flightplan.js
const fetch = require('node-fetch');

exports.handler = async function(event, context) {
    // Using the correct environment variable name from your flights.js file
    const apiKey = process.env.INFINITE_FLIGHT_API_KEY; 
    
    const flightId = event.path.split('/').pop();
    const url = `https://api.infiniteflight.com/v2/flights/${flightId}/flightplan`;

    if (!flightId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Flight ID is required.' }) };
    }

    try {
        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${apiKey}` }
        });

        if (!response.ok) {
            return { statusCode: response.status, body: JSON.stringify({ error: `API Error: ${response.statusText}` }) };
        }

        const data = await response.json();
        return { statusCode: 200, body: JSON.stringify(data) };

    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch flight plan.' }) };
    }
};