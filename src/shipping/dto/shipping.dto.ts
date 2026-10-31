import { PartialType } from '@nestjs/mapped-types';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsISO31661Alpha2,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export const POSTAL_CODE_REGEX = /^[A-Za-z0-9 -]{3,10}$/;

const toUpper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.toUpperCase() : value;

export class CartItemDto {
  @IsUUID()
  product_id: string;

  /** Required when the product has sizes */
  @IsOptional()
  @IsUUID()
  size_id?: string;

  @IsInt()
  @Min(1)
  @Max(999)
  quantity: number;
}

export class AreaQueryDto {
  @IsString()
  @MinLength(3)
  q: string;
}

export class RatesDto {
  @Transform(toUpper)
  @IsISO31661Alpha2()
  country_code: string;

  /** Optional Biteship area id; Indonesian rates are quoted by postal code */
  @IsOptional()
  @IsString()
  area_id?: string;

  /** With district: checks an Indonesian postal code against the chosen region */
  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  district?: string;

  @Matches(POSTAL_CODE_REGEX, { message: 'Invalid postal code' })
  postal_code: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CartItemDto)
  items: CartItemDto[];
}

/** Sender address used by Biteship. */
export class UpdateShippingOriginDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  contact_name: string;

  @Matches(/^(\+62|62|0)[0-9 -]{8,16}$/, { message: 'Invalid Indonesian phone number' })
  phone: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(10)
  address: string;

  @Matches(/^\d{5}$/, { message: 'Indonesian postal codes have 5 digits' })
  postal_code: string;
}

export class CreateShippingZoneDto {
  @IsString()
  @MinLength(2)
  name: string;

  @IsArray()
  @ArrayMinSize(1)
  @Transform(({ value }) => (Array.isArray(value) ? value.map((v) => String(v).toUpperCase()) : value))
  @IsISO31661Alpha2({ each: true })
  countries: string[];

  /** USD cents */
  @IsInt()
  @Min(0)
  base_rate_cents: number;

  /** USD cents per started kg */
  @IsInt()
  @Min(0)
  per_kg_rate_cents: number;

  @IsString()
  @IsNotEmpty()
  eta_text: string;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class UpdateShippingZoneDto extends PartialType(CreateShippingZoneDto) {}
