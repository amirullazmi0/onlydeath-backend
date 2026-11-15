// Local stand-in for the Mayar API (https://docs.mayar.id/api-reference-v2), for
// testing checkout while the Mayar sandbox is unreachable or the account is not
// verified yet. Development only; never point production at it.
//
//   yarn mock:mayar          (reads .env)
//   .env: MAYAR_API_URL=http://localhost:4010/hl/v2
//
// It implements what MayarService calls: create, detail and close payment
// requests, plus a fake hosted payment page. Paying there posts the same kind of
// webhook Mayar sends to /api/payments/mayar/webhook, then redirects the buyer to
// redirectUrl, just like the real page.
//
// What is a guess: Mayar's docs do not show a real webhook body or the field that
// names the payment method, so the shapes below follow the documented field list.
// Re-check both against real Mayar once the account is verified.

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.MAYAR_MOCK_PORT ?? 4010);
const BASE = `http://localhost:${PORT}`;
const WEBHOOK_URL =
  process.env.MAYAR_MOCK_WEBHOOK_URL ??
  `http://localhost:${process.env.PORT ?? 4000}/api/payments/mayar/webhook?token=${encodeURIComponent(
    process.env.MAYAR_WEBHOOK_TOKEN ?? '',
  )}`;

/** id -> payment request */
const payments = new Map();

const METHODS = [
  ['qris', 'QRIS'],
  ['va/bni', 'Virtual Account BNI'],
  ['va/bri', 'Virtual Account BRI'],
  ['va/mandiri', 'Virtual Account Mandiri'],
  ['ewallet/gopay', 'GoPay'],
  ['ewallet/dana', 'DANA'],
  ['card', 'Credit / Debit Card'],
];

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const html = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
};
const readBody = async (req) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const rupiah = (n) => `Rp ${Number(n).toLocaleString('id-ID')}`;

/** Unpaid requests close themselves once expiredAt passes, like Mayar's. */
const current = (p) => {
  if (p.status === 'unpaid' && p.expiredAt && Date.now() > Date.parse(p.expiredAt)) p.status = 'closed';
  return p;
};

const detail = (p) => ({
  id: p.id,
  link: p.slug,
  name: p.name,
  type: 'payment_request',
  amount: p.amount,
  status: p.status,
  description: p.description,
  transactions: p.transaction ? [p.transaction] : [],
  linkUrl: `${BASE}/pay/${p.id}`,
  linkPayment: `${BASE}/pay/${p.id}`,
});

async function sendWebhook(p) {
  const body = {
    event: 'payment.received',
    data: {
      id: p.transaction.id,
      productId: p.id,
      status: true,
      amount: p.amount,
      createdAt: p.createdAt,
      updatedAt: new Date().toISOString(),
      customerName: p.name,
      customerEmail: p.email,
      customerMobile: p.mobile,
      productName: p.description,
      productType: 'payment_request',
    },
  };
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    console.log(`[mayar-mock] webhook ${p.id} -> HTTP ${res.status}`);
  } catch (err) {
    console.error(`[mayar-mock] webhook ${p.id} failed: ${err.message}`);
  }
}

const page = (p, note = '') => {
  const open = p.status === 'unpaid';
  const remaining = p.expiredAt ? Math.max(0, Math.round((Date.parse(p.expiredAt) - Date.now()) / 1000)) : null;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mayar Mock</title>
<style>
  body{font-family:system-ui,sans-serif;background:#f4f5fb;margin:0;padding:24px 16px;color:#111}
  .card{max-width:440px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 2px 12px #0001}
  .tag{display:inline-block;background:#fde68a;color:#78350f;font-size:12px;font-weight:600;padding:2px 8px;border-radius:99px}
  h1{font-size:28px;margin:12px 0 4px}
  .muted{color:#666;font-size:14px}
  label{display:flex;gap:8px;align-items:center;padding:10px;border:1px solid #ddd;border-radius:8px;margin-top:8px;cursor:pointer}
  button{width:100%;padding:12px;border:0;border-radius:8px;font-weight:600;font-size:15px;margin-top:12px;cursor:pointer}
  .pay{background:#1d4ed8;color:#fff}.leave{background:#eee}
  .status{padding:12px;border-radius:8px;background:#f3f4f6;margin-top:16px}
</style></head><body><div class="card">
  <span class="tag">MOCK, not real Mayar</span>
  <p class="muted">${esc(p.name)} · ${esc(p.email)}</p>
  <h1>${rupiah(p.amount)}</h1>
  <p class="muted">${esc(p.description)}</p>
  ${note ? `<div class="status">${esc(note)}</div>` : ''}
  ${
    open
      ? `<form method="post" action="/pay/${p.id}">
    ${METHODS.map(([v, l], i) => `<label><input type="radio" name="method" value="${v}" ${i ? '' : 'checked'}> ${l}</label>`).join('')}
    <button class="pay" type="submit">Pay ${rupiah(p.amount)}</button>
  </form>
  ${p.redirectUrl ? `<a href="${esc(p.redirectUrl)}"><button class="leave" type="button">Leave without paying</button></a>` : ''}
  ${remaining !== null ? `<p class="muted">Closes in ${Math.floor(remaining / 60)}m ${remaining % 60}s</p>` : ''}`
      : `<div class="status">This payment is <b>${esc(p.status)}</b>.</div>
  ${p.redirectUrl ? `<p><a href="${esc(p.redirectUrl)}">Back to the store</a></p>` : ''}`
  }
</div></body></html>`;
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', BASE);
  const path = url.pathname.replace(/\/+$/, '');
  try {
    // ---------- API ----------
    if (path.startsWith('/hl/v2/')) {
      if (!/^Bearer \S+/.test(req.headers.authorization ?? '')) {
        return json(res, 401, { statusCode: 401, messages: 'Unauthorized' });
      }

      if (req.method === 'POST' && path === '/hl/v2/payments/create') {
        const b = JSON.parse((await readBody(req)) || '{}');
        if (!b.name || !Number.isInteger(b.amount) || b.amount <= 0) {
          return json(res, 400, { statusCode: 400, messages: 'name and a positive integer amount are required' });
        }
        const id = randomUUID();
        const p = {
          id,
          slug: id.slice(0, 11),
          name: b.name,
          email: b.email,
          mobile: b.mobile,
          amount: b.amount,
          description: b.description ?? '',
          redirectUrl: b.redirectUrl ?? null,
          expiredAt: b.expiredAt ?? null,
          extraData: b.extraData ?? null,
          status: 'unpaid',
          transaction: null,
          createdAt: new Date().toISOString(),
        };
        payments.set(id, p);
        console.log(`[mayar-mock] created ${id} ${rupiah(p.amount)} ${p.description}`);
        return json(res, 200, {
          statusCode: 200,
          messages: 'success',
          data: { id, transactionId: randomUUID(), link: `${BASE}/pay/${id}`, redirectUrl: p.redirectUrl },
        });
      }

      const m = path.match(/^\/hl\/v2\/payments\/([^/]+)(?:\/([^/]+))?$/);
      const p = m && payments.get(decodeURIComponent(m[1]));
      if (m && !m[2] && req.method === 'GET') {
        if (!p) return json(res, 404, { statusCode: 404, messages: 'Not Found' });
        return json(res, 200, { statusCode: 200, messages: 'success', data: detail(current(p)) });
      }
      if (m && m[2] && req.method === 'POST') {
        if (!p) return json(res, 404, { statusCode: 404, messages: 'Product not found' });
        const action = m[2];
        if (!['close', 'closed', 'open', 'active', 'unlisted'].includes(action)) {
          return json(res, 400, { statusCode: 400, messages: `${action}. allowed: active, closed, unlisted` });
        }
        if (current(p).status === 'paid') return json(res, 200, { statusCode: 200, messages: 'failed' });
        p.status = action.startsWith('close') ? 'closed' : 'unpaid';
        console.log(`[mayar-mock] ${action} ${p.id}`);
        return json(res, 200, { statusCode: 200, messages: 'success' });
      }
      return json(res, 404, { statusCode: 404, messages: 'Not Found' });
    }

    // ---------- Hosted payment page ----------
    const pay = path.match(/^\/pay\/([^/]+)$/);
    if (pay) {
      const p = payments.get(pay[1]);
      if (!p) return html(res, 404, '<p>Payment not found (the mock forgets everything on restart).</p>');
      current(p);
      if (req.method === 'GET') return html(res, 200, page(p));
      if (req.method === 'POST') {
        if (p.status !== 'unpaid') return html(res, 409, page(p, 'This payment can no longer be paid.'));
        const method = new URLSearchParams(await readBody(req)).get('method') ?? 'qris';
        p.status = 'paid';
        p.transaction = { id: randomUUID(), paymentMethod: method, status: 'paid', createdAt: new Date().toISOString() };
        console.log(`[mayar-mock] paid ${p.id} via ${method}`);
        await sendWebhook(p);
        if (p.redirectUrl) {
          res.writeHead(303, { Location: p.redirectUrl });
          return res.end();
        }
        return html(res, 200, page(p, 'Paid.'));
      }
    }

    if (path === '' || path === '/') {
      const rows = [...payments.values()]
        .reverse()
        .map((p) => `<li><a href="/pay/${p.id}">${esc(p.description)}</a> · ${rupiah(p.amount)} · <b>${current(p).status}</b></li>`)
        .join('');
      return html(res, 200, `<h2>Mayar mock</h2><p>Webhook: <code>${esc(WEBHOOK_URL.replace(/token=[^&]+/, 'token=***'))}</code></p><ul>${rows || '<li>No payments yet</li>'}</ul>`);
    }

    html(res, 404, 'Not found');
  } catch (err) {
    console.error('[mayar-mock]', err);
    json(res, 500, { statusCode: 500, messages: 'Mock error' });
  }
});

server.listen(PORT, () => {
  console.log(`[mayar-mock] API      ${BASE}/hl/v2  (set MAYAR_API_URL to this)`);
  console.log(`[mayar-mock] payments ${BASE}/`);
  console.log(`[mayar-mock] webhook  ${WEBHOOK_URL.replace(/token=[^&]+/, 'token=***')}`);
  if (!process.env.MAYAR_MOCK_WEBHOOK_URL && !process.env.MAYAR_WEBHOOK_TOKEN) console.warn('[mayar-mock] MAYAR_WEBHOOK_TOKEN is empty; the backend will reject webhooks');
});
