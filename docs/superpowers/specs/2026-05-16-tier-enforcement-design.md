# Thoftly Tier Enforcement Design

**Date:** 2026-05-16

## Problem

The app has two paid Ghost tiers ("+ a 2nd start" at $3/month, "Unlimited starts" at $5/month) but enforces them with a single `is_paid` boolean. A $3 subscriber gets the same access as a $5 subscriber. Additionally, Supabase is never updated when someone pays — the webhook sync is missing entirely.

## Solution

Replace the `is_paid` boolean with a `tier` text field throughout the stack. Add a Ghost webhook that updates Supabase whenever a subscription changes. Update the Ghost theme postMessage to send tier instead of isPaid.

## Tier Definitions

| Ghost tier name | App tier value | List limit |
|---|---|---|
| Free | `'free'` | 1 |
| + a 2nd start | `'basic'` | 2 |
| Unlimited starts | `'unlimited'` | no cap |

## Changes

### 1. Supabase

```sql
ALTER TABLE users ADD COLUMN tier text NOT NULL DEFAULT 'free';
UPDATE users SET tier = 'unlimited' WHERE is_paid = true;
ALTER TABLE users DROP COLUMN is_paid;
```

`saved_lists` table is unchanged. Limits are enforced by counting rows at runtime.

### 2. `api/ghost-webhook.js` (new file)

- Endpoint: `POST /api/ghost-webhook`
- Validates `GHOST_WEBHOOK_SECRET` against the `x-ghost-signature` header
- Reads `member.email` and `member.subscriptions[0].tier.name` from the Ghost payload
- Maps tier name → app tier value using the table above
- Upserts `users.tier` in Supabase using the service role key (`SUPABASE_SERVICE_KEY` env var)
- Fires on Ghost events: `member.updated`, `member.created`, `member.deleted`

### 3. Ghost theme `default.hbs`

Line ~90: replace `isPaid: !!(member.paid || ...)` with `tier: getTier(member)` where `getTier` maps `member.subscriptions[0]?.tier?.name` to the app tier value. Falls back to `'free'` for any unrecognised value.

### 4. `index.html`

- `window.thoftlyIsPaid` (boolean) → `window.thoftlyTier` (string)
- localStorage key `thoftly_is_paid` → `thoftly_tier`
- postMessage handler reads `data.tier` instead of `data.isPaid`
- `canCreateSecondList()` → `canAddList(count)`: returns allowed based on tier limit
- Supabase fallback reads `users.tier` instead of `users.is_paid`
- "add a 2nd start" modal: shows free→basic prompt for `'free'` users, basic→unlimited prompt for `'basic'` users at their 2-list cap

## User Setup Steps

1. Run Supabase SQL migration (above)
2. Add Vercel env vars: `GHOST_WEBHOOK_SECRET` (any strong password), `SUPABASE_SERVICE_KEY` (from Supabase → Settings → API → service_role key)
3. In Ghost admin → Settings → Integrations → Add webhook: URL = `https://app.thoftly.com/api/ghost-webhook`, secret = same value as `GHOST_WEBHOOK_SECRET`, events = member.updated, member.created, member.deleted
4. Upload updated theme zip in Ghost admin → Design

## Out of Scope

- Stripe-level refund or cancel handling (Ghost manages this; the webhook covers it via `member.updated`)
- Migrating existing users' tiers (existing `is_paid=true` users will default to `'free'` after migration; can be manually corrected in Supabase if needed, or handled by the webhook firing on next login)
