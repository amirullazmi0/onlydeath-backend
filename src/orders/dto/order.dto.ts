import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsISO31661Alpha2,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto.js';
import { CartItemDto, POSTAL_CODE_REGEX } from '../../shipping/dto/shipping.dto.js';
import { OrderStatus } from '../../generated/prisma/enums.js';

export class CheckoutDto {
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  customer_name: string;

  @IsEmail()
  customer_email: string;

  @Matches(/^\+?[0-9 ()-]{7,20}$/, { message: 'Invalid phone number' })
  customer_phone: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @IsISO31661Alpha2()
  country_code: string;

  @IsString()
  @MinLength(5)
  address: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  city: string;

  /** Province (Indonesia) or state/province (abroad) */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  state: string;

  /** Kecamatan (Indonesia) or district/area (abroad) */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  district: string;

  /** Kelurahan/desa (Indonesia) or sub-district (abroad) */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  sub_district: string;

  /** Optional Biteship area id (legacy); rates are quoted by postal code */
  @IsOptional()
  @IsString()
  area_id?: string;

  @Matches(POSTAL_CODE_REGEX, { message: 'Invalid postal code' })
  postal_code: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsString()
  @IsNotEmpty()
  courier_code: string;

  @IsString()
  @IsNotEmpty()
  courier_service: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CartItemDto)
  items: CartItemDto[];
}

export class TrackQueryDto {
  @IsString()
  @IsNotEmpty()
  order_no: string;

  @IsEmail()
  email: string;
}

export class OrderQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;
}

export class RejectOrderDto {
  @IsString()
  @MinLength(5)
  reason: string;
}

/** Manual shipment details for international orders (no Biteship). */
export class ManualShipDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  courier_name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  tracking_number?: string;

  @IsOptional()
  @IsUrl()
  tracking_url?: string;
}
