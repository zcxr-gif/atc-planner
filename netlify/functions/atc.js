const fetch = require('node-fetch');

exports.handler = async function(event, context) {
  const apiKey = process.env.INFINITE_FLIGHT_API_KEY;
  const sessionId = event.path.split('/').pop();
  const url = `https://api.infiniteflight.com/public/v2/sessions/${sessionId}/atc`;

  try {
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (!res.ok) {
      return { statusCode: res.status, body: JSON.stringify({ error: "Failed to fetch ATC" }) };
    }

    const json = await res.json();
    // Map to frontend shape: show ICAO, frequency type, frequency, controller, and ATIS if available
    const atcList = json.result.map(atc => ({
      icao: atc.airport?.icao || '',
      name: atc.facilityType,
      frequency: atc.frequency,
      username: atc.username,
      atis: atc.atis // May be undefined unless facilityType is ATIS
    }));

    return {
      statusCode: 200,
      body: JSON.stringify({ result: atcList })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};