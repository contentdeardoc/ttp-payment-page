/**
 * Cloudflare Pages Function
 * File location: /functions/api/charge.js
 *
 * This runs server-side (never in the browser).
 * It receives the NMI payment token from the frontend,
 * charges the card via NMI's Transaction API,
 * then fires the GHL webhook to update the contact.
 *
 * ============================================================
 * ENVIRONMENT VARIABLES — set in Cloudflare Pages dashboard
 * under Settings → Environment Variables
 * ============================================================
 *
 * NMI_SECURITY_KEY   : your NMI Security Key (private — never expose)
 * GHL_API_KEY        : GHL API key for the sub-account (optional, for direct field update)
 *
 * The GHL_WEBHOOK_URL is passed from the frontend payload
 * (set per-practice in CONFIG on the HTML page).
 * ============================================================
 */

export async function onRequestPost(context) {
  const { request, env } = context;

  // ---- CORS headers (tighten origin in production) ----
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  // Handle preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // ---- Parse body ----
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ success: false, error: 'Invalid request body' }, 400, corsHeaders);
  }

  const { token, amount, name, email, phone, ghl_webhook } = body;

  // ---- Validate ----
  if (!token)  return jsonResponse({ success: false, error: 'Missing payment token' }, 400, corsHeaders);
  if (!amount || parseFloat(amount) <= 0) {
    return jsonResponse({ success: false, error: 'Invalid amount' }, 400, corsHeaders);
  }

  const securityKey = env.NMI_SECURITY_KEY;
  if (!securityKey) {
    return jsonResponse({ success: false, error: 'Server configuration error' }, 500, corsHeaders);
  }

  // ---- Step 1: Charge card via NMI Transaction API ----
  let nmiResult;
  try {
    nmiResult = await chargeNMI({ securityKey, token, amount, name, email, phone });
  } catch (err) {
    console.error('NMI API error:', err);
    return jsonResponse({ success: false, error: 'Payment processor error. Please try again.' }, 502, corsHeaders);
  }

  if (!nmiResult.success) {
    return jsonResponse(
      { success: false, error: nmiResult.message || 'Payment was declined.' },
      200, // return 200 so frontend can read the JSON
      corsHeaders
    );
  }

  // ---- Step 2: Fire GHL webhook ----
  // This updates the contact's Amount Paid field and triggers the
  // "Text-to-Pay - Payment Submitted" workflow in GHL.
  if (ghl_webhook) {
    try {
      await fireGHLWebhook(ghl_webhook, {
        name,
        email,
        phone,
        amount_paid: amount,
        transaction_id: nmiResult.transactionId
      });
    } catch (err) {
      // Log but don't fail — payment already went through
      console.error('GHL webhook error:', err);
    }
  }

  return jsonResponse({
    success: true,
    transactionId: nmiResult.transactionId,
    amount
  }, 200, corsHeaders);
}

// ============================================================
// Charge card via NMI Transaction API
// Docs: https://docs.nmi.com/docs/transaction-api
// ============================================================
async function chargeNMI({ securityKey, token, amount, name, email, phone }) {
  // NMI Transaction API accepts application/x-www-form-urlencoded
  const params = new URLSearchParams({
    security_key:    securityKey,
    type:            'sale',
    amount:          parseFloat(amount).toFixed(2),
    payment_token:   token,   // token from Collect.js
    first_name:      (name || '').split(' ')[0] || '',
    last_name:       (name || '').split(' ').slice(1).join(' ') || '',
    email:           email || '',
    phone:           phone || '',
    order_description: 'Outstanding balance payment',
    currency:        'USD'
  });

  const response = await fetch('https://secure.networkmerchants.com/api/transact.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  const text = await response.text();

  // NMI returns key=value pairs separated by &
  const result = Object.fromEntries(
    text.split('&').map(pair => {
      const [k, ...v] = pair.split('=');
      return [decodeURIComponent(k), decodeURIComponent(v.join('='))];
    })
  );

  /*
    NMI response fields:
    response=1 → approved
    response=2 → declined
    response=3 → error
    responsetext → human-readable message
    transactionid → NMI transaction ID
  */
  const approved = result.response === '1';
  return {
    success:       approved,
    transactionId: result.transactionid || '',
    message:       approved ? 'Approved' : (result.responsetext || 'Declined')
  };
}

// ============================================================
// Fire GHL webhook
// This hits the GHL webhook trigger URL with payment data.
// GHL's "Payment Submitted" workflow listens for Amount Paid
// field changes — the webhook should update that field.
//
// Option A (used here): POST to the GHL webhook trigger URL
// directly (the URL you configured in GHL → Automation →
// Webhook triggers). GHL receives the payload and your
// workflow maps it to the Amount Paid custom field.
//
// Option B: Use GHL's REST API directly to update the contact
// field by phone/email lookup, then the workflow fires via the
// "Contact Changed → Amount Paid → Has changed" trigger.
// Uncomment the Option B block below if you prefer that.
// ============================================================
async function fireGHLWebhook(webhookUrl, data) {
  const payload = {
    name:           data.name || '',
    email:          data.email || '',
    phone:          data.phone || '',
    amount_paid:    parseFloat(data.amount_paid).toFixed(2),
    transaction_id: data.transaction_id || ''
  };

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error('GHL webhook returned ' + response.status);
  }

  return response;
}

/*
// ============================================================
// OPTION B: Update GHL contact directly via REST API
// Use this if you want to update the Amount Paid custom field
// directly without relying on a webhook trigger URL.
// Requires GHL_API_KEY and GHL_LOCATION_ID env vars.
// ============================================================
async function updateGHLContactDirect(env, data) {
  const apiKey     = env.GHL_API_KEY;
  const locationId = env.GHL_LOCATION_ID;

  // 1. Search for contact by phone
  const searchRes = await fetch(
    `https://rest.gohighlevel.com/v1/contacts/?locationId=${locationId}&phone=${encodeURIComponent(data.phone)}`,
    { headers: { Authorization: 'Bearer ' + apiKey } }
  );
  const searchJson = await searchRes.json();
  const contact = searchJson.contacts?.[0];
  if (!contact) throw new Error('Contact not found');

  // 2. Update Amount Paid custom field
  // Replace AMOUNT_PAID_FIELD_KEY with your actual GHL custom field key
  await fetch(`https://rest.gohighlevel.com/v1/contacts/${contact.id}`, {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      customField: {
        AMOUNT_PAID_FIELD_KEY: data.amount_paid
      }
    })
  });
}
*/

// ---- Helper ----
function jsonResponse(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}

