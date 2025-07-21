// You may need to install node-fetch: npm install node-fetch
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

exports.handler = async function(event) {
    // Extract the latitude and longitude query parameters from the request URL
    const { latitude, longitude } = event.queryStringParameters;

    // Check if the required parameters are present
    if (!latitude || !longitude) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Missing latitude or longitude parameters' }),
        };
    }

    // Construct the URL for the external Open-Meteo API
    const API_ENDPOINT = `https://api.open-meteo.com/v1/elevation?latitude=${latitude}&longitude=${longitude}`;

    try {
        // Forward the request to the Open-Meteo API
        const response = await fetch(API_ENDPOINT);
        if (!response.ok) {
            throw new Error(`API responded with status: ${response.status}`);
        }
        const data = await response.json();

        // Return the data from the API to the client
        return {
            statusCode: 200,
            body: JSON.stringify(data),
        };
    } catch (error) {
        console.error("Elevation Proxy Error:", error);
        return {
            statusCode: 502, // Bad Gateway
            body: JSON.stringify({ error: 'Failed to fetch elevation data from the provider.' }),
        };
    }
};