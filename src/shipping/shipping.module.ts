import { Module } from '@nestjs/common';
import { BiteshipService } from './biteship.service.js';
import { ShippingController } from './shipping.controller.js';
import { ShippingService } from './shipping.service.js';

@Module({
  controllers: [ShippingController],
  providers: [BiteshipService, ShippingService],
  exports: [BiteshipService, ShippingService],
})
export class ShippingModule {}
