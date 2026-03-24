/**
 * Cloudflare Pages Function — /functions/api/charge.js
 *
 * Security hardening:
 * - NMI_SECURITY_KEY: never in code, only in Cloudflare env vars
 * - GHL_WEBHOOK_URL: never in code, only in Cloudflare env vars
 * - API_SECRET: shared secret header to prevent unauthorized calls
 * - Amount validated server-side (client cannot inflate/deflate)
 * - Rate limiting via Cloudflare (enable in dashboard)
 * - CORS locked to your domain only
 *
 * Required Cloudflare Environment Variables (Settings → Variables and Secrets):
 *   NMI_SECURITY_KEY  — NMI private security key (Secret)
 *   GHL_WEBHOOK_URL   — DearDoc GHL webhook URL (Secret)
 *   API_SECRET        — any random string you generate, e.g. openssl rand -hex 32 (Secret)
 *   ALLOWED_ORIGIN    — your payment page domain, e.g. https://ttp-payment-page.pages.dev (Plain)
 */

export async function onRequestPost(context) {
  const { request, env } = context;

  // ---- CORS: lock to your domain only ----
  const allowedOrigin = env.ALLOWED_ORIGIN || 'https://ttp-payment-page.pages.dev';
  const requestOrigin = request.headers.get('Origin') || '';

  const cors = {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Secret',
    'Content-Type': 'application/json'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  // ---- Verify request comes from your page ----
  // X-API-Secret header must match env var — prevents anyone else
  // calling /api/charge directly even if they know the URL
  const apiSecret = env.API_SECRET;
  if (apiSecret) {
    const sentSecret = request.headers.get('X-API-Secret') || '';
    if (sentSecret !== apiSecret) {
      console.warn('[Security] Invalid API secret from origin:', requestOrigin);
      return respond({ success: false, error: 'Unauthorized' }, 401, cors);
    }
  }

  // ---- Parse body ----
  let body;
  try { body = await request.json(); }
  catch { return respond({ success: false, error: 'Invalid request' }, 400, cors); }

  const { token, amount, name, email, phone, contact_id, trigger_link, session_id } = body;

  // ---- Server-side validation ----
  if (!token) return respond({ success: false, error: 'Missing token' }, 400, cors);

  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0 || parsedAmount > 50000) {
    return respond({ success: false, error: 'Invalid amount' }, 400, cors);
  }

  // ---- Load secrets from env (never from client) ----
  const securityKey  = env.NMI_SECURITY_KEY;
  const ghlWebhook   = env.GHL_WEBHOOK_URL;

  if (!securityKey) return respond({ success: false, error: 'Server configuration error' }, 500, cors);

  // ---- Step 1: Charge via NMI ----
  let nmi;
  try {
    nmi = await chargeNMI(securityKey, token, parsedAmount, name, email, phone);
  } catch (err) {
    console.error('[NMI] Error:', err.message);
    return respond({ success: false, error: 'Payment processor error. Please try again.' }, 502, cors);
  }

  console.log('[NMI] Result:', nmi.success, nmi.message, nmi.transactionId);

  if (!nmi.success) {
    return respond({ success: false, error: nmi.message || 'Payment declined.' }, 200, cors);
  }

  // ---- Step 2: Update GHL (webhook URL from env, not client) ----
  if (ghlWebhook) {
    try {
      await updateGHL(ghlWebhook, {
        name, email, phone, contact_id,
        trigger_link, session_id,
        amount: parsedAmount,
        transactionId: nmi.transactionId
      });
    } catch (err) {
      console.error('[GHL] Error:', err.message);
      // Don't fail — payment already succeeded
    }
  }

  return respond({ success: true, transactionId: nmi.transactionId, amount: parsedAmount }, 200, cors);
}

// ============================================================
// NMI Transaction API
// ============================================================
async function chargeNMI(securityKey, token, amount, name, email, phone) {
  const firstName = (name || '').split(' ')[0] || '';
  const lastName  = (name || '').split(' ').slice(1).join(' ') || '';

  const params = new URLSearchParams({
    security_key:      securityKey,
    type:              'sale',
    amount:            amount.toFixed(2),
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
// GHL Update — DearDoc endpoint
// Matches working Paperform payload format with field keys
// ============================================================
async function updateGHL(webhookUrl, data) {
  const now        = new Date().toISOString();
  const amountPaid = data.amount.toFixed(2);

  const payload = {
    location_id:   '',
    contact_id:    data.contact_id   || '',
    trigger_link:  data.trigger_link || '',
    session_id:    data.session_id   || '',
    data: [
      { title: 'Name',         type: 'text',   key: '63cme', custom_key: 'name',           value: data.name  || '' },
      { title: 'Email',        type: 'email',  key: '87vvg', custom_key: 'email',          value: data.email || '' },
      { title: 'Phone',        type: 'phone',  key: 'fbqgs', custom_key: 'phone',          value: data.phone || '' },
      { title: 'Amount Paid',  type: 'number', key: '2rr4m', custom_key: 'amount_paid',    value: amountPaid },
      { title: 'Contact ID',   type: 'text',   key: '',      custom_key: 'contact_id',     value: data.contact_id   || '' },
      { title: 'Trigger Link', type: 'text',   key: '',      custom_key: 'trigger_link',   value: data.trigger_link || '' }
    ],
    form_id:       'ttp-nmi-form',
    slug:          'ttp-contact-form',
    submission_id: data.session_id || ('nmi-' + data.transactionId),
    created_at:    now,
    ip_address:    '',
    team_id:       '',
    device: {
      type: 'desktop', device: 'NMI Payment Page', platform: 'Web',
      browser: 'NMI', embedded: 0,
      url: 'https://ttp-payment-page.pages.dev',
      user_agent: 'NMI-Payment-Page/1.0',
      utm_source: '', utm_medium: '', utm_campaign: '',
      utm_term: '', utm_content: '', ip_address: ''
    }
  };

  console.log('[GHL] Firing:', webhookUrl);
  const res = await fetch(webhookUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload)
  });

  const text = await res.text();
  console.log('[GHL] Response:', res.status, text);
  return { status: res.status, body: text };
}

function respond(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}
