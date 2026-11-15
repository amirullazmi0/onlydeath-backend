/** How long a buyer has to pay, counted from checkout. */
export const PAYMENT_WINDOW_MINUTES = 10;

export const PAYMENT_GATEWAYS = ['mayar', 'midtrans'] as const;
export type PaymentGatewayName = (typeof PAYMENT_GATEWAYS)[number];

export interface CreatePaymentRequest {
  orderNo: string;
  amount: number;
  items: { id: string; name: string; price: number; quantity: number }[];
  customer: { name: string; email: string; phone: string };
  /** International buyers: only cards work without an Indonesian account */
  cardOnly?: boolean;
}

export interface CreatedPayment {
  /** What the gateway's status API is queried with */
  ref: string;
  /** Hosted payment page the buyer is sent to */
  paymentUrl: string;
}

/** A gateway's view of a payment, already mapped to our outcome. */
export interface GatewayStatus {
  outcome: 'PAID' | 'FAILED' | 'PENDING';
  /** The gateway's own status string, stored for the record */
  status: string;
  /** True when a FAILED payment ran out of time rather than being refused */
  expired: boolean;
  paymentType?: string;
  transactionId?: string;
  raw: unknown;
}

/**
 * One payment provider. Both are hosted pages: checkout creates a payment, the
 * buyer is redirected, and the state is always re-read from the gateway's
 * authenticated API, never trusted from a webhook body.
 */
export interface PaymentGateway {
  readonly name: PaymentGatewayName;
  readonly dashboardUrl: string;
  createPayment(req: CreatePaymentRequest): Promise<CreatedPayment>;
  /** null when the gateway has no record of the payment */
  getStatus(ref: string): Promise<GatewayStatus | null>;
  /** Stops an unpaid payment from accepting money */
  close(ref: string): Promise<void>;
}
