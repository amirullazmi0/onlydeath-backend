import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator.js';
import { CurrentUser, type JwtPayload } from '../common/decorators/current-user.decorator.js';
import { ResponseMessage } from '../common/decorators/message.decorator.js';
import { OrdersService } from './orders.service.js';
import {
  CheckoutDto,
  ManualShipDto,
  OrderQueryDto,
  RejectOrderDto,
  TrackQueryDto,
} from './dto/order.dto.js';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('checkout')
  @ResponseMessage('Order placed, please complete the payment')
  checkout(@Body() dto: CheckoutDto) {
    return this.orders.checkout(dto);
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('track')
  track(@Query() query: TrackQueryDto) {
    return this.orders.track(query);
  }

  @Get()
  list(@Query() query: OrderQueryDto) {
    return this.orders.list(query);
  }

  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.detail(id);
  }

  @Patch(':id/confirm')
  @ResponseMessage('Order confirmed')
  confirm(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.orders.confirm(id, user.email);
  }

  @Patch(':id/ship')
  @ResponseMessage('Order marked as shipped')
  ship(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ManualShipDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.orders.ship(id, dto, user.email);
  }

  @Patch(':id/deliver')
  @ResponseMessage('Order marked as delivered')
  deliver(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.orders.deliver(id, user.email);
  }

  @Patch(':id/reject')
  @HttpCode(200)
  @ResponseMessage('Order rejected')
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectOrderDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.orders.reject(id, dto.reason, user.email);
  }
}
