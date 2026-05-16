// api/ghost-webhook.js
const crypto = require('crypto');
const https = require('https');

const TIER_MAP = {
  '+ a 2nd start': 'basic',
  'Unlimited starts': 'unlimited',
};

function mapTier(tierName) {
  return TIER_MAP[tierName] || 'free';
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.GHOST_WEBHOOK_SECRET;
  if (!secret) return res.status(500).json({ error: 'No webhook secret configured' });

  const rawBody = await getRawBody(req);

  const signature = req.headers['x-ghost-signature'] || '';
  const sigMatch = signature.match(/sha256=([a-f0-9]+)/);
  if (!sigMatch) return res.status(401).json({ error: 'Missing signature' });

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  if (sigMatch[1] !== expected) return res.status(401).json({ error: 'Invalid signature' });

  let body;
  try { body = JSON.parse(rawBody); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }

  const member = (body.member && body.member.current) ? body.member.current : body.member;
  if (!member || !member.email) return res.status(400).json({ error: 'No member data' });

  const email = member.email.trim().toLowerCase();
  const activeSub = (member.subscriptions || []).find(s => s.status === 'active');
  const tierName = (activeSub && activeSub.tier && activeSub.tier.name) ? activeSub.tier.name : '';
  const tier = mapTier(tierName);

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: 'Supabase not configured' });

  const upsertBody = JSON.stringify({ email, tier });
  const parsed = new URL(supabaseUrl + '/rest/v1/users?on_conflict=email');

  return new Promise((resolve) => {
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceKey,
        'Authorization': 'Bearer ' + serviceKey,
        'Prefer': 'resolution=merge-duplicates',
        'Content-Length': Buffer.byteLength(upsertBody),
      },
    };
    const req2 = https.request(options, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => { data += chunk; });
      apiRes.on('end', () => {
        if (apiRes.statusCode >= 200 && apiRes.statusCode < 300) {
          res.status(200).json({ ok: true, email, tier });
        } else {
          res.status(500).json({ error: 'Supabase error', status: apiRes.statusCode, body: data.substring(0, 200) });
        }
        resolve();
      });
    });
    req2.on('error', (e) => { res.status(500).json({ error: e.message }); resolve(); });
    req2.write(upsertBody);
    req2.end();
  });
}

handler.config = { api: { bodyParser: false } };
module.exports = handler;
