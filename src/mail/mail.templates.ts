import Handlebars from 'handlebars';

// Templates live in TS so they ship with the build without asset copying.
const layout = (body: string) => `
<!doctype html>
<html><body style="margin:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif;color:#111">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
    <table width="600" cellpadding="0" cellspacing="0" style="background:#fff">
      <tr><td style="background:#000;color:#fff;padding:20px 24px;font-size:22px;font-weight:900;letter-spacing:1px">{{appName}}</td></tr>
      <tr><td style="padding:24px;font-size:14px;line-height:1.6">${body}</td></tr>
      <tr><td style="padding:16px 24px;font-size:12px;color:#777;border-top:1px solid #e5e5e5">This is an automated email from {{appName}}.</td></tr>
    </table>
  </td></tr></table>
</body></html>`;

const button = (href: string, label: string) =>
  `<a href="${href}" style="display:inline-block;background:#000;color:#fff;padding:12px 20px;text-decoration:none;font-weight:bold;letter-spacing:1px;text-transform:uppercase;font-size:12px">${label}</a>`;

const sources = {
  'reset-password': layout(`
    <p>Hi {{name}},</p>
    <p>We received a request to reset your admin password. This link expires in {{expiresMinutes}} minutes.</p>
    <p>${button('{{resetUrl}}', 'Reset Password')}</p>
    <p style="font-size:12px;color:#777">If you did not request this, you can ignore this email.</p>`),

  'admin-invite': layout(`
    <p>Hi {{name}},</p>
    <p>Your admin account is ready.</p>
    <p>Email: <b>{{email}}</b><br/>Temporary password: <b>{{password}}</b></p>
    <p>${button('{{loginUrl}}', 'Admin Login')}</p>
    <p style="font-size:12px;color:#777">Please change your password after logging in.</p>`),

  // Standalone document (not the shared layout) so it reads like a printed invoice
  invoice: `
<!doctype html>
<html><body style="margin:0;background:#e9e9e9;font-family:'Courier New',Courier,monospace;color:#111">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table width="640" cellpadding="0" cellspacing="0" style="background:#fff;max-width:640px;width:100%">
  <tr><td style="padding:40px 40px 0">
    <!-- Header: logo left, "Invoice" right, lined up with the PRICE column -->
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td valign="top">
        <img src="{{logoUrl}}" alt="{{store.name}}" height="34" style="display:block;height:34px;width:auto;font-size:20px;font-weight:700" />
        {{#if store.tagline}}<div style="font-size:11px;color:#777;margin-top:4px">{{store.tagline}}</div>{{/if}}
      </td>
      <td valign="top" width="280">
        <div style="font-size:34px;font-weight:700;letter-spacing:4px;line-height:1">Invoice</div>
        <table cellpadding="0" cellspacing="0" style="margin-top:8px;font-size:12px;font-family:'Courier New',Courier,monospace">
          <tr><td style="font-weight:700;padding-right:12px">Invoice#:</td><td style="color:#555">{{orderNo}}</td></tr>
          <tr><td style="font-weight:700;padding-right:12px">Date:</td><td style="color:#555">{{invoiceDate}}</td></tr>
        </table>
      </td>
    </tr></table>

    <!-- Bill to / total due -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:36px;font-family:'Courier New',Courier,monospace"><tr>
      <td valign="top" style="font-size:12px;line-height:1.6;padding-right:16px">
        <div>Bill To:</div>
        <div style="font-size:14px;font-weight:700">{{customerName}}</div>
        <div style="color:#555">{{fullAddress}}</div>
        <div style="color:#555">{{customerPhone}}</div>
        <div style="color:#555">{{customerEmail}}</div>
      </td>
      <td valign="top" width="280" style="font-size:12px">
        <div>Total Paid:</div>
        <div style="font-size:17px;font-weight:700;margin-top:2px">{{total}}</div>
      </td>
    </tr></table>

    <!-- Items -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:32px;border-collapse:collapse;font-size:12px;font-family:'Courier New',Courier,monospace">
      <tr style="font-size:12px;font-weight:700">
        <td style="padding:8px 0;border-bottom:2px solid #111">ITEM DESCRIPTION</td>
        <td width="120" align="right" style="padding:8px;border-bottom:2px solid #111">PRICE</td>
        <td width="40" align="center" style="padding:8px 0;border-bottom:2px solid #111">QTY</td>
        <td width="120" align="right" style="padding:8px 0 8px 8px;border-bottom:2px solid #111">TOTAL</td>
      </tr>
      {{#each items}}
      <tr>
        <td style="padding:12px 8px 12px 0;border-bottom:1px solid #ddd">
          <div style="font-weight:700">{{name}}</div>
          {{#if details}}<div style="color:#666;margin-top:2px">{{details}}</div>{{/if}}
        </td>
        <td align="right" style="padding:12px 8px;border-bottom:1px solid #ddd;border-left:1px solid #111;white-space:nowrap">{{price}}</td>
        <td align="center" style="padding:12px 0;border-bottom:1px solid #ddd;border-left:1px solid #111">{{quantity}}</td>
        <td align="right" style="padding:12px 0 12px 8px;border-bottom:1px solid #ddd;border-left:1px solid #111;white-space:nowrap">{{lineTotal}}</td>
      </tr>
      {{/each}}
      {{#each blankRows}}
      <tr>
        <td height="40" style="border-bottom:1px solid #ddd">&nbsp;</td>
        <td style="border-bottom:1px solid #ddd;border-left:1px solid #111">&nbsp;</td>
        <td style="border-bottom:1px solid #ddd;border-left:1px solid #111">&nbsp;</td>
        <td style="border-bottom:1px solid #ddd;border-left:1px solid #111">&nbsp;</td>
      </tr>
      {{/each}}
      <tr><td colspan="4" style="border-top:2px solid #111;font-size:0;line-height:0">&nbsp;</td></tr>
    </table>

    <!-- Summary -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px"><tr>
      <td></td>
      <td width="280">
        <table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;font-family:'Courier New',Courier,monospace">
          <tr><td style="padding:4px 0;font-weight:700">SUB TOTAL</td><td align="right" style="padding:4px 0;font-weight:700">{{subtotal}}</td></tr>
          {{#if discountTotal}}<tr><td style="padding:4px 0;color:#555">Discount</td><td align="right" style="padding:4px 0;color:#555">{{discountTotal}}</td></tr>{{/if}}
          <tr><td style="padding:4px 0;color:#555">Shipping<br/><span style="font-size:11px">{{courierName}}</span></td><td align="right" valign="top" style="padding:4px 0;color:#555">{{shippingCost}}</td></tr>
          <tr><td colspan="2" style="padding-top:10px;border-bottom:1.5px solid #111;font-size:0;line-height:0">&nbsp;</td></tr>
          <tr><td style="padding:10px 0;font-size:14px;font-weight:700">Grand Total</td><td align="right" style="padding:10px 0;font-size:14px;font-weight:700">{{total}}</td></tr>
          {{#if chargedIdr}}<tr><td colspan="2" style="font-size:11px;color:#777">Charged as {{chargedIdr}} via Midtrans</td></tr>{{/if}}
        </table>
      </td>
    </tr></table>

    <!-- Footer: payment, contact, terms | signature -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:36px;font-size:11px;line-height:1.6;font-family:'Courier New',Courier,monospace"><tr>
      <td valign="top" style="padding-right:16px">
        <div style="font-size:13px;font-weight:700">Payment Method</div>
        <div style="color:#555"><b style="color:#111">Paid via:</b> {{paymentMethod}}</div>
        <div style="color:#555"><b style="color:#111">Order no.:</b> {{orderNo}}</div>

        <div style="font-size:13px;font-weight:700;margin-top:18px">Contact</div>
        {{#if store.address}}<div style="color:#555">{{store.address}}</div>{{/if}}
        <div style="color:#555">{{store.phone}}{{#if store.email}} | {{store.email}}{{/if}}</div>
        {{#if store.website}}<div style="font-weight:700">{{store.website}}</div>{{/if}}
      </td>
      <td valign="bottom" align="right" width="200">
        <div style="font-family:'Brush Script MT','Segoe Script',cursive;font-size:26px">{{store.name}}</div>
        <div style="font-size:12px;font-weight:700">{{store.name}} Team</div>
        <div style="color:#777">Authorized</div>
      </td>
    </tr></table>

    <div style="margin-top:22px;font-size:13px;font-weight:700">Terms &amp; Condition</div>
    <div style="font-size:11px;color:#555;line-height:1.6">
      Pre-order items ship once production is complete. Keep this invoice and order number for tracking,
      returns and support requests.
    </div>
  </td></tr>

  <!-- Actions -->
  <tr><td style="padding:28px 40px 40px">
    ${button('{{invoiceUrl}}', 'View / Download Invoice')}
    &nbsp;
    <a href="{{trackUrl}}" style="display:inline-block;border:1px solid #000;color:#000;padding:11px 19px;text-decoration:none;font-weight:bold;letter-spacing:1px;text-transform:uppercase;font-size:12px">Track Order</a>
  </td></tr>
</table>
</td></tr></table>
</body></html>`,

  'order-placed': layout(`
    <p>Hi {{customerName}},</p>
    <p>Thanks for your order! Complete your payment within <b>{{paymentMinutes}} minutes</b> to secure your items. After that the order expires automatically.</p>
    <p>Order number: <b>{{orderNo}}</b></p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px">
      {{#each items}}
      <tr>
        <td style="padding:8px 8px 8px 0;border-bottom:1px solid #e5e5e5">{{name}}{{#if details}}<br/><span style="font-size:12px;color:#777">{{details}}</span>{{/if}}<br/><span style="font-size:12px;color:#777">Qty {{quantity}}</span></td>
        <td align="right" style="padding:8px 0;border-bottom:1px solid #e5e5e5;white-space:nowrap">{{lineTotal}}</td>
      </tr>
      {{/each}}
      <tr><td style="padding:8px 0">Shipping<br/><span style="font-size:12px;color:#777">{{courierName}}</span></td><td align="right" valign="top" style="padding:8px 0;white-space:nowrap">{{shippingCost}}</td></tr>
      <tr><td style="padding:8px 0;border-top:2px solid #000;font-weight:bold">Total</td><td align="right" style="padding:8px 0;border-top:2px solid #000;font-weight:bold;white-space:nowrap">{{total}}</td></tr>
      {{#if chargedIdr}}<tr><td colspan="2" style="font-size:12px;color:#777">Charged as {{chargedIdr}} via Midtrans</td></tr>{{/if}}
    </table>
    <p style="margin-top:24px">${button('{{payUrl}}', 'Pay Now')}</p>
    <p style="font-size:12px;color:#777">Changed your mind, or want a different payment method? <a href="{{cancelUrl}}" style="color:#111">Cancel this order</a>. Your items go back to your cart so you can check out again.</p>`),

  'order-status': layout(`
    <p>Hi {{customerName}},</p>
    <p>Your order <b>{{orderNo}}</b> is now: <b>{{statusLabel}}</b>.</p>
    {{#if note}}<p>{{note}}</p>{{/if}}
    {{#if waybill}}<p>Courier: {{courierName}}<br/>Tracking number: <b>{{waybill}}</b>{{#if trackingUrl}}<br/><a href="{{trackingUrl}}">Track with courier</a>{{/if}}</p>{{/if}}
    <p>${button('{{trackUrl}}', 'Track Order')}</p>`),
} as const;

export type MailTemplate = keyof typeof sources;

export const templates = Object.fromEntries(
  Object.entries(sources).map(([key, src]) => [key, Handlebars.compile(src)]),
) as Record<MailTemplate, HandlebarsTemplateDelegate>;
