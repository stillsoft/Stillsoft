const https = require(‘https’);

module.exports = async function handler(req, res) {
res.setHeader(‘Access-Control-Allow-Origin’, ‘*’);
res.setHeader(‘Access-Control-Allow-Methods’, ‘POST, OPTIONS’);
res.setHeader(‘Access-Control-Allow-Headers’, ‘Content-Type’);

if (req.method === ‘OPTIONS’) {
return res.status(200).end();
}

if (req.method !== ‘POST’) {
return res.status(405).json({ error: ‘Method not allowed’ });
}

if (!process.env.ANTHROPIC_API_KEY) {
return res.status(500).json({ error: ‘No API key configured’ });
}

let bodyData = req.body;
if (typeof bodyData === ‘string’) {
try { bodyData = JSON.parse(bodyData); } catch(e) {}
}

const body = JSON.stringify(bodyData);

const options = {
hostname: ‘api.anthropic.com’,
path: ‘/v1/messages’,
method: ‘POST’,
headers: {
‘Content-Type’: ‘application/json’,
‘x-api-key’: process.env.ANTHROPIC_API_KEY,
‘anthropic-version’: ‘2023-06-01’,
‘Content-Length’: Buffer.byteLength(body),
},
};

return new Promise((resolve) => {
const apiReq = https.request(options, (apiRes) => {
let data = ‘’;
apiRes.on(‘data’, (chunk) => { data += chunk; });
apiRes.on(‘end’, () => {
try {
res.status(apiRes.statusCode).json(JSON.parse(data));
} catch (e) {
res.status(500).json({ error: ‘Parse error’, raw: data.substring(0, 300) });
}
resolve();
});
});
apiReq.on(‘error’, (e) => {
res.status(500).json({ error: e.message });
resolve();
});
apiReq.write(body);
apiReq.end();
});
};
