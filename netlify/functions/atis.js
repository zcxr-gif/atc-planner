// netlify/functions/atis.js

/**
 * Netlify serverless function to act as a secure proxy for the Infinite Flight ATIS API.
 * This version uses the corrected API endpoint path.
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

    // CORRECTED: The URL now uses "/airport/" (singular) as specified in the documentation.
    const url = `https://api.infiniteflight.com/public/v2/sessions/${sessionId}/airport/${icao}/atis`;

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                // Sending the API key as a bearer token header [cite: 4]
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();

        // Forward the successful response to the client. The client will handle
        // the different 'errorCode' values, such as 0 for "Ok" or 7 for "NoAtisAvailable" [cite: 6]
        return {
            statusCode: 200,
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