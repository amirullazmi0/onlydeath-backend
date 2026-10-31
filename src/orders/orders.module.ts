import { Module } from '@nestjs/common';
import { ShippingModule } from '../shipping/shipping.module.js';
import { MidtransService } from './midtrans.service.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { WebhooksController } from './webhooks.controller.js';

@Module({
  imports: [ShippingModule],
  controllers: [OrdersController, WebhooksController],
  providers: [OrdersService, MidtransService],
})
export class OrdersModule {}
