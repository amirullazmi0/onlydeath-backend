import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CreatePaymentRequest,
  GatewayStatus,
  PAYMENT_WINDOW_MINUTES,
  PaymentGateway,
} from './payment-gateway.js';

/** Payload Mayar posts to our webhook. Only ids are used; state is re-read from the API. */
export interface MayarWebhook {
  event?: string | { received?: string };
  data?: {
    id?: string;
    productId?: string;
    status?: unknown;
    amount?: number;
  };
}

/** A Mayar payment request as returned by GET /payments/{id}. */
export interface MayarPayment {
  id: string;
  status: string;
  amount: number;
  transactions?: Record<string, unknown>[];
}

type MayarEnvelope<T> = { statusCode?: number; messages?: string; data?: T };

/**
 * Mayar (mayar.id): accepts personal merchants verified with a KTP only.
 * Uses "payment requests", hosted pages with a single amount and an expiry.
 * Mayar does not sign webhooks and cannot limit the methods per payment.
 */
@Injectable()
export class MayarService implements PaymentGateway {
  readonly name = 'mayar' as const;
  private readonly logger = new Logger(MayarService.name);

  constructor(private readonly config: ConfigService) {}

  private get isProduction() {
    return this.config.get('MAYAR_IS_PRODUCTION') === 'true';
  }

  private get apiBase() {
    return this.isProduction ? 'https://api.mayar.id/hl/v2' : 'https://api.mayar.io/hl/v2';
  }

  get dashboardUrl() {
    return (
      this.config.get<string>('MAYAR_DASHBOARD_URL') ??
      (this.isProduction ? 'https://web.mayar.id' : 'https://web.mayar.io')
    );
  }

  private get headers() {
    return {
      Authorization: `Bearer ${this.config.getOrThrow<string>('MAYAR_API_KEY')}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  async createPayment(req: CreatePaymentRequest) {
    // A payment request has no line items, so they are summarised in the description
    const lines = req.items.map((i) => (i.quantity > 1 ? `${i.quantity}x ${i.name}` : i.name)).join(', ');
    const res = await fetch(`${this.apiBase}/payments/create`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        name: req.customer.name,
        email: req.customer.email,
        mobile: req.customer.phone,
        amount: req.amount,
        description: `${req.orderNo} - ${lines}`.slice(0, 500),
        redirectUrl: `${this.config.getOrThrow('FE_URL')}/orders/success?order_no=${req.orderNo}`,
        expiredAt: new Date(Date.now() + PAYMENT_WINDOW_MINUTES * 60 * 1000).toISOString(),
        extraData: { orderNo: req.orderNo },
      }),
    });

    const body = (await res.json().catch(() => ({}))) as MayarEnvelope<{ id?: string; link?: string }>;
    if (!res.ok || !body.data?.id || !body.data.link) {
      this.logger.error(`Mayar create failed for ${req.orderNo}: ${res.status} ${JSON.stringify(body)}`);
      throw new BadGatewayException('Could not create payment, please try again');
    }
    return { ref: body.data.id, paymentUrl: body.data.link };
  }

  async getStatus(ref: string): Promise<GatewayStatus | null> {
    const res = await fetch(`${this.apiBase}/payments/${encodeURIComponent(ref)}`, {
      headers: this.headers,
    });
    const body = (await res.json().catch(() => ({}))) as MayarEnvelope<MayarPayment>;
    // Mayar can answer HTTP 200 with the real code in the body
    if (res.status === 404 || body.statusCode === 404) return null;
    if (!res.ok || !body.data?.status) {
      throw new Error(`Mayar status failed for ${ref}: ${res.status} ${body.messages ?? ''}`);
    }

    const p = body.data;
    const outcome = this.resolveOutcome(p.status);
    const tx = p.transactions?.[0];
    return {
      outcome,
      status: p.status,
      // Mayar closes a payment page once its expiredAt passes
      expired: outcome === 'FAILED',
      paymentType: outcome === 'PAID' ? this.paymentMethod(p) : undefined,
      transactionId: typeof tx?.id === 'string' ? tx.id : undefined,
      raw: p,
    };
  }

  async close(ref: string) {
    const res = await fetch(`${this.apiBase}/payments/${encodeURIComponent(ref)}/close`, {
      method: 'POST',
      headers: this.headers,
    });
    const body = (await res.json().catch(() => ({}))) as MayarEnvelope<unknown>;
    if (res.status === 404 || body.statusCode === 404) return;
    if (!res.ok || body.messages !== 'success') {
      this.logger.error(`Mayar close failed for ${ref}: ${res.status} ${body.messages}`);
      throw new BadGatewayException('Could not cancel the payment, please try again');
    }
  }

  resolveOutcome(status: string): GatewayStatus['outcome'] {
    const s = status.toLowerCase();
    if (s === 'paid' || s === 'success' || s === 'settled') return 'PAID';
    if (s === 'closed' || s === 'expired' || s === 'failed') return 'FAILED';
    return 'PENDING';
  }

  /**
   * The channel the buyer used. Mayar's docs do not name this field, so the
   * likely candidates on the paid transaction are tried before falling back.
   */
  private paymentMethod(p: MayarPayment) {
    const tx = p.transactions?.[0] ?? {};
    const value = ['paymentMethod', 'paymentType', 'paymentChannel', 'method', 'channel']
      .map((k) => tx[k])
      .find((v) => typeof v === 'string' && v.length > 0);
    return (value as string | undefined) ?? 'mayar';
  }
}
