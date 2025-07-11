// netlify/functions/atc.js
const fetch = require('node-fetch');

exports.handler = async function(event, context) {
    // Extract the sessionId from the URL path
    const sessionId = event.path.split('/').pop();
    const apiKey = process.env.IF_API_KEY;

    if (!sessionId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Session ID is required.' }) };
    }

    const url = `https://api.infiniteflight.com/v2/sessions/${sessionId}/atc`;

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
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch ATC data.' }) };
    }
};