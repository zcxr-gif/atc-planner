/**
 * Netlify serverless function to act as a secure proxy for the Infinite Flight ATC API.
 * This function handles the API key securely on the server-side.
 */
exports.handler = async (event, context) => {
    // Extract the sessionId from the URL path (e.g., /.netlify/functions/atc/{sessionId})
    const pathParts = event.path.split('/');
    const sessionId = pathParts[pathParts.length - 1];

    if (!sessionId) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Session ID is required.' }),
        };
    }

    const API_KEY = process.env.INFINITE_FLIGHT_API_KEY;
    if (!API_KEY) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'API key is not configured on the server.' }),
        };
    }

    const url = `https://api.infiniteflight.com/public/v2/sessions/${sessionId}/atc`;

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        // If the API call was not successful, forward the error
        if (!response.ok) {
            return {
                statusCode: response.status,
                body: JSON.stringify({ error: `Failed to fetch ATC data from Infinite Flight API. Status: ${response.statusText}` }),
            };
        }

        const data = await response.json();

        // Return the successful response to the client
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*' // Allow requests from your web app
            },
            body: JSON.stringify(data),
        };
    } catch (error) {
        console.error('Proxy Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'An internal server error occurred.' }),
        };
    }
};