// netlify/functions/atis.js

/**
 * Netlify serverless function to fetch the full ATIS text for a specific airport in a session.
 */
exports.handler = async (event, context) => {
    // Extract sessionId and icao from the URL path, e.g., /.../atis/{sessionId}/{icao}
    const pathParts = event.path.split('/');
    const icao = pathParts.pop();
    const sessionId = pathParts.pop();

    if (!sessionId || !icao) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Session ID and Airport ICAO are required.' }),
        };
    }

    const API_KEY = process.env.INFINITE_FLIGHT_API_KEY;
    if (!API_KEY) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'API key is not configured on the server.' }),
        };
    }

    // This is the dedicated endpoint for fetching ATIS text.
    const url = `https://api.infiniteflight.com/public/v2/sessions/${sessionId}/airports/${icao}/atis`;

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();

        // The Infinite Flight API returns 200 OK even if ATIS is not available (with errorCode 7).
        // We pass this along so the frontend can handle it gracefully.
        return {
            statusCode: 200, // Always return 200 on successful API communication
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify(data),
        };

    } catch (error) {
        console.error('ATIS Proxy Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'An internal server error occurred while fetching ATIS.' }),
        };
    }
};