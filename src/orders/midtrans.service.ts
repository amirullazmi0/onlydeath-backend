import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';

export interface MidtransNotification {
  order_id: string;
  status_code: string;
  gross_amount: string;
  signature_key: string;
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
}

@Injectable()
export class MidtransService {
  private readonly logger = new Logger(MidtransService.name);

  constructor(private readonly config: ConfigService) {}

  private get isProduction() {
    return this.config.get('MIDTRANS_IS_PRODUCTION') === 'true';
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
        expiry: { unit: 'hours', duration: 24 },
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

  /** signature_key = SHA512(order_id + status_code + gross_amount + server_key) */
  verifySignature(n: MidtransNotification) {
    const expected = createHash('sha512')
      .update(`${n.order_id}${n.status_code}${n.gross_amount}${this.serverKey}`)
      .digest('hex');
    const given = Buffer.from(n.signature_key ?? '');
    return given.length === expected.length && timingSafeEqual(given, Buffer.from(expected));
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
