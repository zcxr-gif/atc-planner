// server.js
const express = require('express');
const fetch = require('node-fetch');
require('dotenv').config(); // Load environment variables from .env file

const app = express();
const port = 3000; // You can use any port you like

// Serve your existing HTML, CSS, and JS files
app.use(express.static('.'));

// The API key is now securely stored on the server
const OPENAIP_API_KEY = process.env.OPENAIP_API_KEY;

// Create the proxy endpoint
app.get('/api/navaids', async (req, res) => {
  if (!OPENAIP_API_KEY) {
    return res.status(500).json({ error: 'API key not configured on the server.' });
  }

  try {
    const { bbox } = req.query;
    if (!bbox) {
      return res.status(400).json({ error: 'Bbox parameter is required.' });
    }
    const apiUrl = `https://api.core.openaip.net/api/navaids?bbox=${bbox}&page=1&limit=500`;

    const apiResponse = await fetch(apiUrl, {
      headers: {
        'x-openaip-api-key': OPENAIP_API_KEY,
      },
    });

    if (!apiResponse.ok) {
        throw new Error(`OpenAIP API responded with status: ${apiResponse.status}`);
    }

    const data = await apiResponse.json();
    res.json(data);
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: 'An error occurred while fetching data.' });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});