import { Module } from '@nestjs/common';
import { ShippingModule } from '../shipping/shipping.module.js';
import { MayarService } from './mayar.service.js';
import { MidtransService } from './midtrans.service.js';
import { PaymentGatewaysService } from './payment-gateways.service.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { WebhooksController } from './webhooks.controller.js';

@Module({
  imports: [ShippingModule],
  controllers: [OrdersController, WebhooksController],
  providers: [OrdersService, MayarService, MidtransService, PaymentGatewaysService],
  exports: [PaymentGatewaysService],
})
export class OrdersModule {}
