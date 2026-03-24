/**
 * Cloudflare Pages Function — /functions/api/charge.js
 *
 * Flow:
 * 1. Receive payment token + patient info from frontend
 * 2. Charge card via NMI Transaction API (uses NMI_SECURITY_KEY env var)
 * 3. On success, POST to GHL webhook to update contact Amount Paid field
 *    and trigger the "Text-to-Pay - Payment Submitted" workflow
 *
 * Environment variable required in Cloudflare Pages Settings:
 *   NMI_SECURITY_KEY — your private NMI security key
 */

export async function onRequestPost(context) {
  const { request, env } = context;

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  // ---- Parse request ----
  let body;
  try { body = await request.json(); }
  catch { return respond({ success: false, error: 'Invalid request' }, 400, cors); }

  const { token, amount, name, email, phone, ghl_webhook } = body;

  if (!token)                          return respond({ success: false, error: 'Missing token' }, 400, cors);
  if (!amount || parseFloat(amount) <= 0) return respond({ success: false, error: 'Invalid amount' }, 400, cors);

  const securityKey = env.NMI_SECURITY_KEY;
  if (!securityKey) return respond({ success: false, error: 'Server config error: missing NMI key' }, 500, cors);

  // ---- Step 1: Charge via NMI ----
  let nmi;
  try {
    nmi = await chargeNMI(securityKey, token, amount, name, email, phone);
  } catch (err) {
    console.error('[NMI] Charge error:', err.message);
    return respond({ success: false, error: 'Payment processor error. Please try again.' }, 502, cors);
  }

  console.log('[NMI] Result:', nmi.success, nmi.message, nmi.transactionId);

  if (!nmi.success) {
    return respond({ success: false, error: nmi.message || 'Payment declined.' }, 200, cors);
  }

  // ---- Step 2: Update GHL contact ----
  if (ghl_webhook) {
    try {
      const ghlResult = await updateGHL(ghl_webhook, { name, email, phone, amount, transactionId: nmi.transactionId });
      console.log('[GHL] Webhook status:', ghlResult.status);
    } catch (err) {
      // Don't fail the response — payment succeeded, log the GHL error
      console.error('[GHL] Webhook error:', err.message);
    }
  }

  return respond({ success: true, transactionId: nmi.transactionId, amount }, 200, cors);
}

// ============================================================
// NMI Transaction API
// Uses payment_token from Collect.js
// Returns { success, transactionId, message }
// ============================================================
async function chargeNMI(securityKey, token, amount, name, email, phone) {
  const firstName = (name || '').split(' ')[0] || '';
  const lastName  = (name || '').split(' ').slice(1).join(' ') || '';

  const params = new URLSearchParams({
    security_key:      securityKey,
    type:              'sale',
    amount:            parseFloat(amount).toFixed(2),
    payment_token:     token,
    first_name:        firstName,
    last_name:         lastName,
    email:             email || '',
    phone:             phone || '',
    order_description: 'Outstanding balance payment',
    currency:          'USD'
  });

  const res  = await fetch('https://secure.networkmerchants.com/api/transact.php', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params.toString()
  });

  const text   = await res.text();
  console.log('[NMI] Raw response:', text);

  const result = Object.fromEntries(
    text.split('&').map(pair => {
      const [k, ...v] = pair.split('=');
      return [decodeURIComponent(k), decodeURIComponent(v.join('='))];
    })
  );

  const approved = result.response === '1';
  return {
    success:       approved,
    transactionId: result.transactionid || '',
    message:       approved ? 'Approved' : (result.responsetext || 'Declined')
  };
}

// ============================================================
// GHL Webhook
//
// Your endpoint: https://externalconnections.getdeardoc.com/contacts/text-to-pay
// This is a DearDoc custom endpoint that expects specific fields
// to update the GHL contact's Amount Paid custom field and
// trigger the "Text-to-Pay - Payment Submitted" workflow.
//
// The payload mirrors what the old Pabbly webhook was sending.
// Field names match the GHL custom field keys used in your workflows.
// ============================================================
async function updateGHL(webhookUrl, data) {
  const now = new Date().toISOString();

  // Paperform-compatible payload — matches what the DearDoc endpoint expects
  const payload = {
    data: [
      {
        title:      "Name",
        description: "",
        type:       "text",
        key:        "",
        custom_key: "name",
        value:      data.name || ""
      },
      {
        title:      "Email",
        description: "",
        type:       "email",
        key:        "",
        custom_key: "email",
        value:      data.email || ""
      },
      {
        title:      "Phone",
        description: "",
        type:       "phone",
        key:        "",
        custom_key: "phone",
        value:      data.phone || ""
      },
      {
        title:      "Amount Paid",
        description: "",
        type:       "number",
        key:        "",
        custom_key: "amount_paid",
        value:      parseFloat(data.amount).toFixed(2)
      },
      {
        title:      "Transaction ID",
        description: "",
        type:       "text",
        key:        "",
        custom_key: "transaction_id",
        value:      data.transactionId || ""
      }
    ],
    form_id:      "ttp-nmi-form",
    slug:         "ttp-contact-form",
    submission_id: "nmi-" + data.transactionId,
    created_at:   now,
    ip_address:   "",
    team_id:      "",
    device: {
      type:         "desktop",
      device:       "NMI Payment Page",
      platform:     "Web",
      browser:      "NMI",
      embedded:     0,
      url:          "https://ttp-payment-page.pages.dev",
      user_agent:   "NMI-Payment-Page/1.0",
      utm_source:   "",
      utm_medium:   "",
      utm_campaign: "",
      utm_term:     "",
      utm_content:  "",
      ip_address:   ""
    }
  };

  console.log('[GHL] Firing webhook:', webhookUrl);
  console.log('[GHL] Payload:', JSON.stringify(payload));

  const res = await fetch(webhookUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload)
  });

  const responseText = await res.text();
  console.log('[GHL] Response:', res.status, responseText);

  return { status: res.status, body: responseText };
}

// ---- Helper ----
function respond(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}
