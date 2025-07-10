const fetch = require('node-fetch');

exports.handler = async function(event, context) {
  const apiKey = process.env.INFINITE_FLIGHT_API_KEY;
  const url = 'https://api.infiniteflight.com/public/v2/sessions';

  try {
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (!res.ok) {
      return { statusCode: res.status, body: JSON.stringify({ error: "Failed to fetch sessions" }) };
    }

    const json = await res.json();
    // Filter for Training and Expert only (or show all if you want)
    const filtered = json.result.filter(s => 
      s.name && (s.name.toLowerCase().includes('training') || s.name.toLowerCase().includes('expert'))
    ).map(s => ({
      sessionId: s.id,
      name: s.name
    }));

    return {
      statusCode: 200,
      body: JSON.stringify({ result: filtered })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};