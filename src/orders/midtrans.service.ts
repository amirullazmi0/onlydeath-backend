import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** How long a buyer has to pay, counted from checkout. */
export const PAYMENT_WINDOW_MINUTES = 10;

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

export interface SnapRequest {
  orderNo: string;
  grossAmount: number;
  items: { id: string; name: string; price: number; quantity: number }[];
  customer: { name: string; email: string; phone: string };
  /** Limits Snap to these methods; every enabled method is offered when omitted */
  enabledPayments?: string[];
}

@Injectable()
export class MidtransService {
  private readonly logger = new Logger(MidtransService.name);

  constructor(private readonly config: ConfigService) {}

  private get isProduction() {
    return this.config.get('MIDTRANS_IS_PRODUCTION') === 'true';
  }

  private get apiBase() {
    return this.isProduction ? 'https://api.midtrans.com' : 'https://api.sandbox.midtrans.com';
  }

  private get serverKey() {
    return this.config.getOrThrow<string>('MIDTRANS_SERVER_KEY');
  }

  async createSnap(req: SnapRequest) {
    const url = this.isProduction
      ? 'https://app.midtrans.com/snap/v1/transactions'
      : 'https://app.sandbox.midtrans.com/snap/v1/transactions';

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.serverKey}:`).toString('base64')}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        transaction_details: { order_id: req.orderNo, gross_amount: req.grossAmount },
        ...(req.enabledPayments && { enabled_payments: req.enabledPayments }),
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

    const body = (await res.json()) as {
      token?: string;
      redirect_url?: string;
      error_messages?: string[];
    };
    if (!res.ok || !body.token) {
      this.logger.error(`Snap create failed: ${JSON.stringify(body.error_messages)}`);
      throw new BadGatewayException('Could not create payment, please try again');
    }
    return { token: body.token, redirectUrl: body.redirect_url ?? null };
  }

  /**
   * Current transaction state, or null when Midtrans has none: Snap only creates
   * one after the buyer picks a payment method.
   */
  async getStatus(orderNo: string) {
    const res = await fetch(`${this.apiBase}/v2/${encodeURIComponent(orderNo)}/status`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.serverKey}:`).toString('base64')}`,
        Accept: 'application/json',
      },
    });

    const body = (await res.json().catch(() => ({}))) as Partial<MidtransNotification>;
    // Midtrans can answer HTTP 200 with the real code in the body
    if (res.status === 404 || body.status_code === '404') return null;
    if (!res.ok || !body.transaction_status) {
      throw new Error(`Midtrans status failed for ${orderNo}: ${res.status} ${body.status_code ?? ''}`);
    }
    return body as MidtransNotification;
  }

  /** Voids a transaction the buyer has not paid yet, so its VA or QR stops working. */
  async cancel(orderNo: string) {
    const res = await fetch(`${this.apiBase}/v2/${encodeURIComponent(orderNo)}/cancel`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.serverKey}:`).toString('base64')}`,
        Accept: 'application/json',
      },
    });
    const body = (await res.json().catch(() => ({}))) as { status_code?: string; status_message?: string };
    if (!res.ok || !['200', '412'].includes(body.status_code ?? '')) {
      this.logger.error(`Midtrans cancel failed for ${orderNo}: ${body.status_code} ${body.status_message}`);
      throw new BadGatewayException('Could not cancel the payment, please try again');
    }
  }

  /** Maps Midtrans transaction state to our outcome. */
  resolveOutcome(n: MidtransNotification): 'PAID' | 'FAILED' | 'PENDING' {
    if (n.transaction_status === 'settlement') return 'PAID';
    if (n.transaction_status === 'capture') return n.fraud_status === 'accept' ? 'PAID' : 'PENDING';
    if (['expire', 'cancel', 'deny', 'failure'].includes(n.transaction_status)) return 'FAILED';
    return 'PENDING';
  }

  get clientKey() {
    return this.config.get<string>('MIDTRANS_CLIENT_KEY') ?? '';
  }
}
