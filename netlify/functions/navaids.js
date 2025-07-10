// /netlify/functions/navaids.js

// Use require for node-fetch in Node.js environments
const fetch = require('node-fetch');

exports.handler = async function(event) {
    // 1. Get the API Key from Netlify's environment variables
    const apiKey = process.env.OPENAIP_API_KEY;

    // 2. Check if the API key exists
    if (!apiKey) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "API key is missing. Please set OPENAIP_API_KEY in your Netlify environment." })
        };
    }

    // 3. Get the bounding box from the query parameters
    const bbox = event.queryStringParameters.bbox;
    if (!bbox) {
        return {
            statusCode: 400, // Bad Request
            body: JSON.stringify({ error: "Bounding box (bbox) query parameter is required." })
        };
    }

    // 4. Construct the secure URL to the openAIP API
    const apiUrl = `https://api.openaip.net/api/navdata?type=VOR&bbox=${bbox}&apiKey=${apiKey}`;

    try {
        // 5. Fetch data from the openAIP API
        const response = await fetch(apiUrl);
        
        // Handle non-successful responses from openAIP
        if (!response.ok) {
            const errorText = await response.text();
            console.error("openAIP API Error:", errorText);
            return {
                statusCode: response.status,
                body: JSON.stringify({ error: `Failed to fetch from openAIP: ${errorText}` })
            };
        }
        
        const data = await response.json();

        // 6. Return the successful response to the browser
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        };

    } catch (error) {
        // 7. Catch any other network or runtime errors
        console.error("Serverless function error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "An internal error occurred while fetching VOR data." })
        };
    }
};