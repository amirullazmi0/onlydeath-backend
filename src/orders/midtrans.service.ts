import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CreatePaymentRequest,
  GatewayStatus,
  PAYMENT_WINDOW_MINUTES,
  PaymentGateway,
} from './payment-gateway.js';

/** "YYYY-MM-DD HH:MM:SS +0700", the only format Snap accepts */
const midtransTime = (date: Date) =>
  `${new Date(date.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')} +0700`;

export interface MidtransNotification {
  order_id: string;
  status_code: string;
  gross_amount: string;
  transaction_status: string;
  transaction_id?: string;
  payment_type?: string;
  fraud_status?: string;
}

/**
 * Midtrans Snap, used through its hosted redirect page. The payment is keyed
 * by our order number, which is also what Midtrans notifications carry.
 */
@Injectable()
export class MidtransService implements PaymentGateway {
  readonly name = 'midtrans' as const;
  private readonly logger = new Logger(MidtransService.name);

  constructor(private readonly config: ConfigService) {}

  private get isProduction() {
    return this.config.get('MIDTRANS_IS_PRODUCTION') === 'true';
  }

  private get apiBase() {
    return this.isProduction ? 'https://api.midtrans.com' : 'https://api.sandbox.midtrans.com';
  }

  get dashboardUrl() {
    return (
      this.config.get<string>('MIDTRANS_DASHBOARD_URL') ??
      (this.isProduction ? 'https://dashboard.midtrans.com' : 'https://dashboard.sandbox.midtrans.com')
    );
  }

  private get authHeader() {
    const key = this.config.getOrThrow<string>('MIDTRANS_SERVER_KEY');
    return `Basic ${Buffer.from(`${key}:`).toString('base64')}`;
  }

  async createPayment(req: CreatePaymentRequest) {
    const url = this.isProduction
      ? 'https://app.midtrans.com/snap/v1/transactions'
      : 'https://app.sandbox.midtrans.com/snap/v1/transactions';

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: this.authHeader, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        transaction_details: { order_id: req.orderNo, gross_amount: req.amount },
        ...(req.cardOnly && { enabled_payments: ['credit_card'] }),
        // Midtrans rejects item names over 50 chars
        item_details: req.items.map((i) => ({ ...i, name: i.name.slice(0, 50) })),
        customer_details: {
          first_name: req.customer.name,
          email: req.customer.email,
          phone: req.customer.phone,
        },
        callbacks: {
          finish: `${this.config.getOrThrow('FE_URL')}/orders/success?order_no=${req.orderNo}`,
        },
        // Without start_time the clock only starts once the buyer picks a method
        expiry: {
          start_time: midtransTime(new Date()),
          unit: 'minutes',
          duration: PAYMENT_WINDOW_MINUTES,
        },
      }),
    });

    const body = (await res.json().catch(() => ({}))) as {
      token?: string;
      redirect_url?: string;
      error_messages?: string[];
    };
    if (!res.ok || !body.token || !body.redirect_url) {
      this.logger.error(`Snap create failed: ${JSON.stringify(body.error_messages)}`);
      throw new BadGatewayException('Could not create payment, please try again');
    }
    return { ref: req.orderNo, paymentUrl: body.redirect_url };
  }

  /**
   * Current transaction state, or null when Midtrans has none: Snap only creates
   * one after the buyer picks a payment method.
   */
  async getStatus(orderNo: string): Promise<GatewayStatus | null> {
    const res = await fetch(`${this.apiBase}/v2/${encodeURIComponent(orderNo)}/status`, {
      headers: { Authorization: this.authHeader, Accept: 'application/json' },
    });

    const body = (await res.json().catch(() => ({}))) as Partial<MidtransNotification>;
    // Midtrans can answer HTTP 200 with the real code in the body
    if (res.status === 404 || body.status_code === '404') return null;
    if (!res.ok || !body.transaction_status) {
      throw new Error(`Midtrans status failed for ${orderNo}: ${res.status} ${body.status_code ?? ''}`);
    }

    const n = body as MidtransNotification;
    return {
      outcome: this.resolveOutcome(n),
      status: n.transaction_status,
      expired: n.transaction_status === 'expire',
      paymentType: n.payment_type,
      transactionId: n.transaction_id,
      raw: n,
    };
  }

  /** Voids a transaction the buyer has not paid yet, so its VA or QR stops working. */
  async close(orderNo: string) {
    const res = await fetch(`${this.apiBase}/v2/${encodeURIComponent(orderNo)}/cancel`, {
      method: 'POST',
      headers: { Authorization: this.authHeader, Accept: 'application/json' },
    });
    const body = (await res.json().catch(() => ({}))) as { status_code?: string; status_message?: string };
    // 404: buyer never picked a method, so there is nothing to void; 412: already final
    if (res.status === 404 || body.status_code === '404') return;
    if (!['200', '412'].includes(body.status_code ?? '')) {
      this.logger.error(`Midtrans cancel failed for ${orderNo}: ${body.status_code} ${body.status_message}`);
      throw new BadGatewayException('Could not cancel the payment, please try again');
    }
  }

  /** Maps Midtrans transaction state to our outcome. */
  resolveOutcome(n: Pick<MidtransNotification, 'transaction_status' | 'fraud_status'>): GatewayStatus['outcome'] {
    if (n.transaction_status === 'settlement') return 'PAID';
    if (n.transaction_status === 'capture') return n.fraud_status === 'accept' ? 'PAID' : 'PENDING';
    if (['expire', 'cancel', 'deny', 'failure'].includes(n.transaction_status)) return 'FAILED';
    return 'PENDING';
  }
}
