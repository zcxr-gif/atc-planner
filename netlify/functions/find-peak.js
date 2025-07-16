exports.handler = async function(event) {
    // 1. Get bounding box coordinates from the client's request
    const { north, south, east, west } = event.queryStringParameters;

    // 2. Validate that all coordinates were provided
    if (!north || !south || !east || !west) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: "Missing required bounding box parameters." }),
        };
    }

    // 3. Construct the URL for the external OpenTopography API
    // This uses the public SRTM 90m dataset. An API key is not strictly required
    // but is good practice for production apps. You could store it as a Netlify
    // environment variable and access it via process.env.OPENTOPOGRAPHY_API_KEY
    const dataset = 'SRTMGL3';
    const url = `https://portal.opentopography.org/API/globaldem?demtype=${dataset}&south=${south}&north=${north}&west=${west}&east=${east}&outputFormat=JSON`;

    try {
        // 4. Call the OpenTopography API from the serverless function
        const response = await fetch(url);
        if (!response.ok) {
            // If the external API fails, pass the error back to the client
            return {
                statusCode: response.status,
                body: JSON.stringify({ error: `OpenTopography API Error: ${response.statusText}` }),
            };
        }
        const data = await response.json();

        // 5. Return the successful response from OpenTopography back to the client
        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
        };

    } catch (error) {
        // Handle network errors or other issues
        return {
            statusCode: 500,
            body: JSON.stringify({ error: `Internal Server Error: ${error.message}` }),
        };
    }
};