# Tier Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `is_paid` boolean with a three-value `tier` field (`'free'`/`'basic'`/`'unlimited'`) so Ghost's $3 and $5 plans are enforced separately.

**Architecture:** A new Vercel serverless function receives Ghost webhooks and updates `users.tier` in Supabase. The Ghost theme sends `tier` (not `isPaid`) via postMessage to the embedded app iframe. The app enforces list limits (1 / 2 / unlimited) based on the tier string throughout.

**Tech Stack:** Node.js (Vercel serverless), Supabase REST API, Ghost Members API, vanilla JS

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `api/ghost-webhook.js` | **Create** | Validate Ghost webhook, map tier name, update Supabase |
| `index.html` | **Modify** | Replace `isPaid` bool with `tier` string in 6 locations |
| `ghost theme/thoftly-theme/default.hbs` | **Modify** | Send `tier` string in postMessage instead of `isPaid` bool |

Supabase migration is already complete (done in session).

---

## Task 1: Create the Ghost webhook endpoint

**Files:**
- Create: `api/ghost-webhook.js`

- [ ] **Step 1: Create the file with the full implementation**

```javascript
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
```

- [ ] **Step 2: Commit**

```bash
git add api/ghost-webhook.js
git commit -m "feat: add Ghost webhook endpoint for tier sync"
```

---

## Task 2: Update `index.html` — global tier initialisation

**Files:**
- Modify: `index.html:835`

Replace the single line that reads `is_paid` from localStorage with one that reads `tier`.

- [ ] **Step 1: Replace line 835**

Find:
```javascript
window.thoftlyIsPaid = (function(){ try { return localStorage.getItem('thoftly_is_paid') === '1'; } catch(e){ return false; } })();
```

Replace with:
```javascript
window.thoftlyTier = (function(){ try { return localStorage.getItem('thoftly_tier') || 'free'; } catch(e){ return 'free'; } })();
```

- [ ] **Step 2: Commit**

```bash
git add index.html
git commit -m "refactor: replace thoftlyIsPaid global with thoftlyTier string"
```

---

## Task 3: Update `index.html` — `canCreateSecondList` → `canAddList`

**Files:**
- Modify: `index.html:1185-1207`

- [ ] **Step 1: Replace the function**

Find (entire function, lines 1185–1207):
```javascript
async function canCreateSecondList(){
  if(!currentUserEmail) return {allowed:false, needsEmail:true};
  // Ghost is the source of truth for payment status (set via postMessage from parent)
  let isPaid = false;
  if (typeof window.thoftlyIsPaid === 'boolean') {
    isPaid = window.thoftlyIsPaid;
  } else {
    try { isPaid = localStorage.getItem('thoftly_is_paid') === '1'; } catch(e){}
  }
  const db=getSupabase();
  if(!db) return {allowed:false, error:'Add your Supabase URL and anon key in index.html first.'};
  const email=currentUserEmail.trim().toLowerCase();
  // Fallback: if we don't have isPaid info from Ghost (e.g. direct visit to app subdomain),
  // check Supabase users table as a backup
  if (!isPaid) {
    const userRes=await db.from('users').select('is_paid').eq('email',email).maybeSingle();
    if(!userRes.error && userRes.data && userRes.data.is_paid) isPaid = true;
  }
  const countRes=await db.from('saved_lists').select('id',{count:'exact',head:true}).eq('user_email',email);
  if(countRes.error) return {allowed:false, error:countRes.error.message};
  const count=countRes.count || 0;
  return {allowed:isPaid || count<1, isPaid:isPaid, count:count};
}
```

Replace with:
```javascript
async function canAddList(){
  if(!currentUserEmail) return {allowed:false, needsEmail:true};
  let tier = (typeof window.thoftlyTier === 'string') ? window.thoftlyTier : 'free';
  try { if (tier === 'free') tier = localStorage.getItem('thoftly_tier') || 'free'; } catch(e){}
  const db=getSupabase();
  if(!db) return {allowed:false, error:'Add your Supabase URL and anon key in index.html first.'};
  const email=currentUserEmail.trim().toLowerCase();
  // Fallback: check Supabase in case postMessage hasn't fired (e.g. direct visit)
  if (tier === 'free') {
    const userRes=await db.from('users').select('tier').eq('email',email).maybeSingle();
    if(!userRes.error && userRes.data && userRes.data.tier) tier = userRes.data.tier;
  }
  const countRes=await db.from('saved_lists').select('id',{count:'exact',head:true}).eq('user_email',email);
  if(countRes.error) return {allowed:false, error:countRes.error.message};
  const count=countRes.count || 0;
  const limit = tier === 'unlimited' ? Infinity : tier === 'basic' ? 2 : 1;
  return {allowed:count < limit, tier:tier, count:count};
}
```

- [ ] **Step 2: Commit**

```bash
git add index.html
git commit -m "refactor: canCreateSecondList → canAddList with three-tier limits"
```

---

## Task 4: Update `index.html` — postMessage handler

**Files:**
- Modify: `index.html:1266-1320`

Two changes in the postMessage handler block.

- [ ] **Step 1: Replace the paid-status lines (1269–1272)**

Find:
```javascript
    // Always update the paid status from Ghost (source of truth for payments)
    const isPaid = !!data.isPaid;
    try { localStorage.setItem('thoftly_is_paid', isPaid ? '1' : '0'); } catch(e){}
    window.thoftlyIsPaid = isPaid;
```

Replace with:
```javascript
    // Always update tier from Ghost (source of truth for payments)
    const tier = ['basic', 'unlimited'].includes(data.tier) ? data.tier : 'free';
    try { localStorage.setItem('thoftly_tier', tier); } catch(e){}
    window.thoftlyTier = tier;
```

- [ ] **Step 2: Update the two console.log lines (1316 and 1319)**

Find:
```javascript
      console.log('[thoftly] Loaded data for', email, '— paid:', isPaid);
```
Replace with:
```javascript
      console.log('[thoftly] Loaded data for', email, '— tier:', tier);
```

Find:
```javascript
      console.log('[thoftly] Logged in as', email, '(no saved data yet) — paid:', isPaid);
```
Replace with:
```javascript
      console.log('[thoftly] Logged in as', email, '(no saved data yet) — tier:', tier);
```

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "refactor: postMessage handler reads tier string instead of isPaid bool"
```

---

## Task 5: Update `index.html` — `refreshAddColLabel` and `doLocalLogout`

**Files:**
- Modify: `index.html:1355-1386`

- [ ] **Step 1: Replace `refreshAddColLabel` (lines 1355–1368)**

Find:
```javascript
function refreshAddColLabel(){
  const label = document.getElementById('add-col-label');
  if (!label) return;
  const cols = document.querySelectorAll('.workspace-col').length;
  const isPaid = !!window.thoftlyIsPaid;
  if (isPaid) {
    // Paid users get unlimited lists
    label.textContent = 'another start';
  } else if (cols === 0 || cols === 1) {
    label.textContent = 'a 2nd start';
  } else {
    label.textContent = 'another start';
  }
}
```

Replace with:
```javascript
function refreshAddColLabel(){
  const label = document.getElementById('add-col-label');
  if (!label) return;
  const cols = document.querySelectorAll('.workspace-col').length;
  const tier = window.thoftlyTier || 'free';
  if (tier === 'unlimited' || cols > 1) {
    label.textContent = 'another start';
  } else {
    label.textContent = 'a 2nd start';
  }
}
```

- [ ] **Step 2: Replace the `doLocalLogout` lines that reference `is_paid` (lines 1378–1382)**

Find:
```javascript
  currentUserEmail = '';
  window.thoftlyIsPaid = false;
  localStorage.removeItem('thoftly_email');
  localStorage.removeItem('thoftly_is_paid');
```

Replace with:
```javascript
  currentUserEmail = '';
  window.thoftlyTier = 'free';
  localStorage.removeItem('thoftly_email');
  localStorage.removeItem('thoftly_tier');
```

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "refactor: refreshAddColLabel and doLocalLogout use tier string"
```

---

## Task 6: Update `index.html` — paywall modal + `handleAddCol`

**Files:**
- Modify: `index.html:800-826` (modal HTML)
- Modify: `index.html:2172` (`showPaywall` function)
- Modify: `index.html:2317` (`handleAddCol` call)

- [ ] **Step 1: Add IDs to the two pricing sections in the modal HTML**

Find (lines 805–822):
```html
    <div style="font-size:10px;color:var(--muted);margin-bottom:10px;font-weight:600;">2nd start</div>
    <div class="m-pricing" style="margin-bottom:10px;">
      <div class="pc sel" id="pc-mo" onclick="selPlan('mo')">
        <div class="pc-amt">$3</div><div class="pc-per">per month</div><div class="pc-note">2 lists</div>
      </div>
      <div class="pc" id="pc-yr" onclick="selPlan('yr')">
        <div class="pc-amt">$25</div><div class="pc-per">per year</div><div class="pc-note">2 lists · save $11</div>
      </div>
    </div>
    <div style="font-size:10px;color:var(--muted);margin-bottom:10px;font-weight:600;">unlimited starts</div>
    <div class="m-pricing" style="margin-bottom:12px;">
      <div class="pc" onclick="selPlan('unlmo')">
        <div class="pc-amt">$5</div><div class="pc-per">per month</div><div class="pc-note">unlimited lists</div>
      </div>
      <div class="pc" onclick="selPlan('unlyr')">
        <div class="pc-amt">$39</div><div class="pc-per">per year</div><div class="pc-note">unlimited · save $21</div>
      </div>
    </div>
```

Replace with:
```html
    <div id="paywall-basic-section">
    <div style="font-size:10px;color:var(--muted);margin-bottom:10px;font-weight:600;">2nd start</div>
    <div class="m-pricing" style="margin-bottom:10px;">
      <div class="pc sel" id="pc-mo" onclick="selPlan('mo')">
        <div class="pc-amt">$3</div><div class="pc-per">per month</div><div class="pc-note">2 lists</div>
      </div>
      <div class="pc" id="pc-yr" onclick="selPlan('yr')">
        <div class="pc-amt">$25</div><div class="pc-per">per year</div><div class="pc-note">2 lists · save $11</div>
      </div>
    </div>
    </div>
    <div id="paywall-unl-section">
    <div style="font-size:10px;color:var(--muted);margin-bottom:10px;font-weight:600;">unlimited starts</div>
    <div class="m-pricing" style="margin-bottom:12px;">
      <div class="pc" onclick="selPlan('unlmo')">
        <div class="pc-amt">$5</div><div class="pc-per">per month</div><div class="pc-note">unlimited lists</div>
      </div>
      <div class="pc" onclick="selPlan('unlyr')">
        <div class="pc-amt">$39</div><div class="pc-per">per year</div><div class="pc-note">unlimited · save $21</div>
      </div>
    </div>
    </div>
```

- [ ] **Step 2: Replace `showPaywall` (line 2172)**

Find:
```javascript
function showPaywall(){document.getElementById('paywall').classList.add('open');}
```

Replace with:
```javascript
function showPaywall(currentTier){
  const tier = currentTier || window.thoftlyTier || 'free';
  const ttl = document.querySelector('#paywall .m-ttl');
  const body = document.querySelector('#paywall .m-body');
  const basicSection = document.getElementById('paywall-basic-section');
  const unlSection = document.getElementById('paywall-unl-section');
  if (tier === 'basic') {
    if (ttl) ttl.textContent = 'add unlimited starts';
    if (body) body.textContent = "you've reached your 2-list limit. upgrade to unlimited starts.";
    if (basicSection) basicSection.style.display = 'none';
    if (unlSection) unlSection.style.display = '';
  } else {
    if (ttl) ttl.textContent = 'add a 2nd start';
    if (body) body.textContent = 'a 2nd start requires a paid subscription.';
    if (basicSection) basicSection.style.display = '';
    if (unlSection) unlSection.style.display = '';
  }
  document.getElementById('paywall').classList.add('open');
}
```

- [ ] **Step 3: Update `handleAddCol` to use `canAddList` and pass tier to `showPaywall` (line 2317)**

Find:
```javascript
  const result=await canCreateSecondList();
```
Replace with:
```javascript
  const result=await canAddList();
```

Find (line 2332):
```javascript
  showPaywall();
```
Replace with:
```javascript
  showPaywall(result.tier);
```

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: paywall shows correct tier upgrade prompt based on current plan"
```

---

## Task 7: Update Ghost theme `default.hbs`

**Files:**
- Modify: `ghost theme/thoftly-theme/default.hbs:86-91`

- [ ] **Step 1: Add `getTier` helper and replace `isPaid` in the postMessage broadcast**

Find (lines 86–91 inside `syncLoginToIframe`):
```javascript
        if (newEmail) {
          broadcastToIframe({
            type: 'thoftly-login',
            email: newEmail,
            isPaid: !!(member.paid || (member.subscriptions && member.subscriptions.length > 0))
          });
```

Replace with:
```javascript
        if (newEmail) {
          broadcastToIframe({
            type: 'thoftly-login',
            email: newEmail,
            tier: getTier(member)
          });
```

- [ ] **Step 2: Add `getTier` function just above `fetchMember`**

Find:
```javascript
    function fetchMember(){
```

Replace with:
```javascript
    function getTier(member) {
      if (!member || !member.subscriptions || !member.subscriptions.length) return 'free';
      var activeSub = member.subscriptions.find(function(s) { return s.status === 'active'; });
      if (!activeSub || !activeSub.tier) return 'free';
      var name = activeSub.tier.name || '';
      if (name === '+ a 2nd start') return 'basic';
      if (name === 'Unlimited starts') return 'unlimited';
      return 'free';
    }

    function fetchMember(){
```

- [ ] **Step 3: Commit the theme file**

```bash
git add "ghost theme/thoftly-theme/default.hbs"
git commit -m "feat: Ghost theme sends tier string in postMessage instead of isPaid bool"
```

---

## Task 8: Repackage theme zip

**Files:**
- Update: `ghost theme/thoftly-theme.zip`

- [ ] **Step 1: Delete old zip and create new one from updated folder**

In PowerShell:
```powershell
Remove-Item "ghost theme\thoftly-theme.zip"
Compress-Archive -Path "ghost theme\thoftly-theme\*" -DestinationPath "ghost theme\thoftly-theme.zip"
```

- [ ] **Step 2: Commit**

```bash
git add "ghost theme/thoftly-theme.zip"
git commit -m "chore: repackage Ghost theme zip with tier postMessage update"
```

---

## Task 9: Vercel + Ghost setup (user steps)

No code changes. These are the manual steps the user must complete.

- [ ] **Step 1: Add Vercel environment variables**

In Vercel dashboard → Project → Settings → Environment Variables, add:

| Name | Value |
|---|---|
| `GHOST_WEBHOOK_SECRET` | Any strong password you choose (copy it — you'll need it again in Ghost) |
| `SUPABASE_URL` | `https://vnsqorbrcxiesewbhzsb.supabase.co` |
| `SUPABASE_SERVICE_KEY` | From Supabase → Settings → API → **service_role** secret (not the anon key) |

Redeploy after adding (Vercel → Deployments → Redeploy latest).

- [ ] **Step 2: Add Ghost webhook**

In Ghost admin → Settings → Integrations → Add custom integration → name it "thoftly tier sync".

Add three webhooks (one per event):

| Event | URL |
|---|---|
| Member updated | `https://app.thoftly.com/api/ghost-webhook` |
| Member created | `https://app.thoftly.com/api/ghost-webhook` |
| Member deleted | `https://app.thoftly.com/api/ghost-webhook` |

Set the **secret** field to the same value you used for `GHOST_WEBHOOK_SECRET`.

- [ ] **Step 3: Upload updated Ghost theme**

Ghost admin → Settings → Design → scroll to "Theme" → Upload theme → select the new `thoftly-theme.zip`.

- [ ] **Step 4: Smoke test**

1. Open `https://thoftly.com` in an incognito window
2. Subscribe free (enter email → Ghost portal)
3. Open browser dev tools → Console
4. Look for `[thoftly] Logged in as ... — tier: free`
5. Click "+ a 2nd start" — paywall should show both pricing tiers
6. In Supabase → Table Editor → users, verify the row shows `tier = 'free'`
