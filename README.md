# Text-to-Pay — NMI/RAC Payment Page
## Deployment Guide

---

## What's in this folder

```
/index.html              ← The payment page (frontend)
/functions/api/charge.js ← Serverless backend (Cloudflare Pages Function)
/README.md               ← This file
```

---

## Step 1 — Configure the payment page (index.html)

Open `index.html` and edit the `window.CONFIG` block near the top:

```js
window.CONFIG = {
  NMI_PUBLIC_KEY:  "YOUR_NMI_PUBLIC_KEY_HERE",   // from NMI dashboard — safe to expose
  PRACTICE_NAME:   "Your Practice Name",
  PRACTICE_LOGO:   "https://yourpractice.com/logo.png",  // or "" to hide
  BACKEND_URL:     "/api/charge",                // leave this as-is for Cloudflare
  GHL_WEBHOOK_URL: "https://YOUR_GHL_WEBHOOK_URL_HERE",  // from GHL → Automation → Webhooks
  PRIMARY_COLOR:   "#1a1a2e"                     // brand hex color
};
```

**Where to find each value:**
- `NMI_PUBLIC_KEY`: NMI dashboard → Settings → Security Keys → Public Key
- `GHL_WEBHOOK_URL`: In GHL, go to Automation → Workflows → Text-to-Pay - Payment Submitted → Trigger → copy the webhook URL. OR create a new Inbound Webhook trigger and copy that URL.

---

## Step 2 — Deploy to Cloudflare Pages (free)

### 2a. Create a Cloudflare account
Go to https://pages.cloudflare.com and sign up (free tier is sufficient).

### 2b. Push code to GitHub
Create a new GitHub repo and push this entire folder to it.

### 2c. Connect to Cloudflare Pages
1. In Cloudflare dashboard → Pages → Create a project
2. Connect your GitHub repo
3. Build settings:
   - Framework preset: None
   - Build command: (leave blank)
   - Build output directory: `/` (root)
4. Click Deploy

### 2d. Set environment variables
In Cloudflare Pages → Settings → Environment Variables, add:

| Variable name      | Value                          |
|--------------------|-------------------------------|
| `NMI_SECURITY_KEY` | Your NMI Security Key (private) |

The Security Key is ONLY used in the serverless function (never the browser).

### 2e. Add a custom domain (recommended)
In Cloudflare Pages → Custom Domains → add `pay.yourdomain.com`

---

## Step 3 — Get the payment page URL

Your page will be live at:
```
https://pay.yourdomain.com
```

With URL parameters, a full link looks like:
```
https://pay.yourdomain.com?m={{contact.outstanding_balance}}&name={{contact.name}}&email={{contact.email}}&phone={{contact.phone}}
```

---

## Step 4 — Update GHL Trigger Link

1. Go to GHL → Marketing → Trigger Links
2. Find "Text-to-Pay Trigger Link" → Edit
3. Paste the payment page URL before the `?`:
   ```
   https://pay.yourdomain.com?m={{contact.outstanding_balance}}&name={{contact.name}}&email={{contact.email}}&phone={{contact.phone}}
   ```
4. Save

---

## Step 5 — Test the full flow

NMI test card numbers (use any future expiry + any CVV):
```
Visa (approved):     4111 1111 1111 1111
Mastercard approved: 5431 1111 1111 1111
Declined:            4111 1111 1111 1129
```

1. Add a test contact in GHL with Outstanding Balance = 1.00
2. Manually trigger the "Text-to-Pay - Patient Text" workflow
3. Open the SMS link
4. Enter a test card and submit
5. Confirm: thank-you screen appears, GHL contact shows Amount Paid = 1.00, opportunity moves to "Payment Submitted"

---

## Multi-practice deployment

### Option A — One deployment per practice (simplest)
- Fork/copy the folder per practice
- Edit CONFIG in index.html for each
- Deploy each to a separate Cloudflare Pages project
- Each gets its own URL: `pay.practice-a.com`, `pay.practice-b.com`

### Option B — One deployment, practice identified by URL param
Add `?pid=practice-id` to the URL. Store practice configs in a JSON file
or Cloudflare KV store and load them in the serverless function.
Contact your dev team to implement this if you manage 5+ practices.

---

## GHL Webhook Payload

When a payment succeeds, the backend sends this to your GHL webhook URL:

```json
{
  "name": "Jane Doe",
  "email": "jane@example.com",
  "phone": "+15551234567",
  "amount_paid": "125.00",
  "transaction_id": "NMI_TRANSACTION_ID"
}
```

In GHL, map `amount_paid` to the "Amount Paid" custom field in your
webhook trigger configuration so the "Payment Submitted" workflow fires.

---

## Troubleshooting

**"Invalid tokenization key"** — Check NMI_PUBLIC_KEY in CONFIG is correct.

**Payment page loads but card fields don't appear** — Collect.js failed to load.
Check browser console. Ensure NMI_PUBLIC_KEY is set before the script tag loads.

**Payment goes through but GHL doesn't update** — Check GHL_WEBHOOK_URL in CONFIG.
Open browser DevTools → Network → look for the /api/charge POST, check the response.

**CORS error** — If deploying to a different domain than Cloudflare Pages,
update the `Access-Control-Allow-Origin` header in charge.js to your domain.
