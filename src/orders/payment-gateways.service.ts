import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MayarService } from './mayar.service.js';
import { MidtransService } from './midtrans.service.js';
import { PAYMENT_GATEWAYS, PaymentGateway, PaymentGatewayName } from './payment-gateway.js';

/**
 * Picks the gateway for new checkouts from PAYMENT_GATEWAY. Each payment row
 * records the gateway it was created with, so orders started before a switch
 * are still checked, cancelled and expired through their own gateway.
 */
@Injectable()
export class PaymentGatewaysService {
  constructor(
    private readonly config: ConfigService,
    private readonly mayar: MayarService,
    private readonly midtrans: MidtransService,
  ) {}

  /** Gateway for new checkouts. */
  get current(): PaymentGateway {
    const name = (this.config.get<string>('PAYMENT_GATEWAY') ?? 'mayar').trim().toLowerCase();
    if (!PAYMENT_GATEWAYS.includes(name as PaymentGatewayName)) {
      throw new Error(`PAYMENT_GATEWAY must be one of ${PAYMENT_GATEWAYS.join(', ')}, got "${name}"`);
    }
    return this.get(name);
  }

  /** Gateway a stored payment was created with. */
  get(name: string): PaymentGateway {
    return name === 'midtrans' ? this.midtrans : this.mayar;
  }
}
