/**
 * Cloudflare Pages Function — /functions/api/charge.js
 *
 * 1. Charge card via NMI
 * 2. Update GHL contact via DearDoc endpoint
 *
 * Environment variable required:
 *   NMI_SECURITY_KEY — private NMI security key (set in Cloudflare Pages Settings)
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

  let body;
  try { body = await request.json(); }
  catch { return respond({ success: false, error: 'Invalid request' }, 400, cors); }

  const { token, amount, name, email, phone, contact_id, trigger_link, session_id, ghl_webhook } = body;

  if (!token) return respond({ success: false, error: 'Missing token' }, 400, cors);
  if (!amount || parseFloat(amount) <= 0) return respond({ success: false, error: 'Invalid amount' }, 400, cors);

  const securityKey = env.NMI_SECURITY_KEY;
  if (!securityKey) return respond({ success: false, error: 'Missing NMI key' }, 500, cors);

  // ---- Step 1: Charge via NMI ----
  let nmi;
  try {
    nmi = await chargeNMI(securityKey, token, amount, name, email, phone);
  } catch (err) {
    console.error('[NMI] Error:', err.message);
    return respond({ success: false, error: 'Payment processor error. Please try again.' }, 502, cors);
  }

  console.log('[NMI] Result:', nmi.success, nmi.message, nmi.transactionId);

  if (!nmi.success) {
    return respond({ success: false, error: nmi.message || 'Payment declined.' }, 200, cors);
  }

  // ---- Step 2: Update GHL via DearDoc endpoint ----
  if (ghl_webhook) {
    try {
      await updateGHL(ghl_webhook, {
        name, email, phone,
        amount, contact_id,
        trigger_link, session_id,
        transactionId: nmi.transactionId
      });
    } catch (err) {
      console.error('[GHL] Error:', err.message);
    }
  }

  return respond({ success: true, transactionId: nmi.transactionId, amount }, 200, cors);
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
// GHL Update via DearDoc endpoint
//
// The original Pabbly integration passed data as URL query params:
//   webhookUrl?name=X&email=Y&amount_paid=Z&phone=W
//
// We replicate that exactly here.
// ============================================================
async function updateGHL(webhookUrl, data) {
  const amountPaid = parseFloat(data.amount).toFixed(2);

  // Build URL with query params — matching original Pabbly format
  const url = new URL(webhookUrl);
  url.searchParams.set('name',          data.name          || '');
  url.searchParams.set('email',         data.email         || '');
  url.searchParams.set('phone',         data.phone         || '');
  url.searchParams.set('amount_paid',   amountPaid);
  url.searchParams.set('contact_id',    data.contact_id    || '');
  url.searchParams.set('trigger_link',  data.trigger_link  || '');

  console.log('[GHL] POST to:', url.toString());

  const res = await fetch(url.toString(), {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    ''
  });

  const text = await res.text();
  console.log('[GHL] Response:', res.status, text);

  return { status: res.status, body: text };
}

function respond(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}
