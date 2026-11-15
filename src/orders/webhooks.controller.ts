import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator.js';
import { OrdersService } from './orders.service.js';
import type { MayarWebhook } from './mayar.service.js';
import type { MidtransNotification } from './midtrans.service.js';
import type { BiteshipWebhook } from '../shipping/biteship.service.js';

@Public()
@SkipThrottle()
@Controller()
export class WebhooksController {
  constructor(
    private readonly orders: OrdersService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Set as the webhook URL on the Mayar dashboard (public HTTPS), with
   * `?token=<MAYAR_WEBHOOK_TOKEN>`. Mayar does not sign webhooks, so the
   * token keeps strangers from making us poll Mayar on their behalf.
   */
  @Post('payments/mayar/webhook')
  @HttpCode(200)
  mayar(@Query('token') token: string | undefined, @Body() body: MayarWebhook) {
    const expected = this.config.get<string>('MAYAR_WEBHOOK_TOKEN');
    if (!expected || token !== expected) throw new UnauthorizedException();
    // Empty body = test ping from the Mayar dashboard
    if (!body?.data) return;
    return this.orders.handleMayarWebhook(body);
  }

  /** Set as "Payment Notification URL" on the Midtrans dashboard (public HTTPS). */
  @Post('payments/midtrans/notification')
  @HttpCode(200)
  midtrans(@Body() body: MidtransNotification) {
    return this.orders.handleMidtransNotification(body);
  }

  /** Biteship does not sign webhooks; a shared header token guards this route. */
  @Post('shipping/biteship/webhook')
  @HttpCode(200)
  biteship(
    @Headers() headers: Record<string, string>,
    @Body() body: BiteshipWebhook,
  ) {
    const header = (this.config.get<string>('BITESHIP_WEBHOOK_HEADER') ?? 'x-biteship-token').toLowerCase();
    const token = this.config.get<string>('BITESHIP_WEBHOOK_TOKEN');
    // Empty body = installation ping from the Biteship dashboard
    if (!body?.order_id) return;
    if (!token || headers[header] !== token) throw new UnauthorizedException();
    return this.orders.handleBiteshipWebhook(body);
  }
}
