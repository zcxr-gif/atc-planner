// File location: netlify/functions/elevation.js

// Replace with your server's actual public IP address
const ORACLE_IP = '141.148.20.78';

exports.handler = async function(event, context) {
    // Get the 'locations' and 'dataset' parameters from the request URL
    const locations = event.queryStringParameters.locations;
    const dataset = event.queryStringParameters.dataset || 'srtm30m'; // Default to srtm30m

    if (!locations) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: "Missing 'locations' parameter." }),
        };
    }

    // Construct the URL to your private server
    const targetURL = `http://${ORACLE_IP}:5000/v1/${dataset}?locations=${locations}`;

    try {
        // Fetch data from your Oracle server
        const response = await fetch(targetURL);
        const data = await response.json();

        // Return the data back to your web app
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        };

    } catch (error) {
        console.error("Error fetching from Oracle server:", error);
        return {
            statusCode: 502, // Bad Gateway
            body: JSON.stringify({ error: "Failed to connect to the elevation service." }),
        };
    }
};