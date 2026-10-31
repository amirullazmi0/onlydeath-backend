import {
  Body,
  Controller,
  Delete,
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
import { ResponseMessage } from '../common/decorators/message.decorator.js';
import { ShippingService } from './shipping.service.js';
import {
  AreaQueryDto,
  CreateShippingZoneDto,
  RatesDto,
  UpdateShippingOriginDto,
  UpdateShippingZoneDto,
} from './dto/shipping.dto.js';

@Controller('shipping')
export class ShippingController {
  constructor(private readonly shipping: ShippingService) {}

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('areas')
  areas(@Query() query: AreaQueryDto) {
    return this.shipping.searchAreas(query.q);
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('rates')
  @HttpCode(200)
  rates(@Body() dto: RatesDto) {
    return this.shipping.rates(dto);
  }

  @Get('origin')
  origin() {
    return this.shipping.getOrigin();
  }

  @Patch('origin')
  @ResponseMessage('Shipping origin updated')
  updateOrigin(@Body() dto: UpdateShippingOriginDto) {
    return this.shipping.updateOrigin(dto);
  }

  @Get('zones')
  zones() {
    return this.shipping.listZones();
  }

  @Post('zones')
  @ResponseMessage('Shipping zone created')
  createZone(@Body() dto: CreateShippingZoneDto) {
    return this.shipping.createZone(dto);
  }

  @Patch('zones/:id')
  @ResponseMessage('Shipping zone updated')
  updateZone(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateShippingZoneDto) {
    return this.shipping.updateZone(id, dto);
  }

  @Delete('zones/:id')
  @ResponseMessage('Shipping zone deleted')
  removeZone(@Param('id', ParseUUIDPipe) id: string) {
    return this.shipping.removeZone(id);
  }
}
