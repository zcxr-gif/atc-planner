// Located at: netlify/functions/flightplan.js

// Using node-fetch to make server-side API requests in a Node.js environment.
const fetch = require('node-fetch');

exports.handler = async function(event, context) {
    // --- 1. Get Flight ID from the URL ---
    // We split the path (e.g., "/api/flightplan/some-flight-id") and take the last part.
    const flightId = event.path.split('/').pop();

    // If no flightId is provided in the URL, return a clear error.
    if (!flightId) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'A Flight ID must be provided in the URL.' }),
        };
    }

    // --- 2. Securely Get API Key ---
    // Keys should be stored in Netlify environment variables, not in the code.
    const apiKey = process.env.INFINITE_FLIGHT_API_KEY;
    if (!apiKey) {
        // This error is for the developer/server side, not the end-user.
        console.error('API key is not configured in environment variables.');
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Server configuration error.' }),
        };
    }

    // --- 3. Prepare and Fetch from the API ---
    const apiUrl = `https://api.infiniteflight.com/v2/flights/${flightId}/flightplan`;

    try {
        const response = await fetch(apiUrl, {
            headers: {
                // The API requires a Bearer token for authorization.
                'Authorization': `Bearer ${apiKey}`
            }
        });

        // If the API returns a non-successful status (e.g., 404 Not Found), handle it.
        if (!response.ok) {
            return {
                statusCode: response.status,
                body: JSON.stringify({ error: `API Error: ${response.statusText}` })
            };
        }

        // Parse the successful JSON response from the API.
        const flightplanData = await response.json();

        // --- 4. DEBUGGER ---
        // This logs the full data structure received from the API to your Netlify function log.
        // The 'null, 2' part formats the JSON to be easily readable.
        console.log('--- Infinite Flight API Response ---');
        console.log(JSON.stringify(flightplanData, null, 2));
        console.log('------------------------------------');


        // --- 5. Return Successful Response ---
        // Send the fetched data back to the client that called this function.
        return {
            statusCode: 200,
            body: JSON.stringify(flightplanData)
        };

    } catch (error) {
        // This catches network errors or other issues with the fetch request itself.
        console.error('Error fetching from Infinite Flight API:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fetch flight plan data.' })
        };
    }
};