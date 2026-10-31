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

  @Matches(POSTAL_CODE_REGEX, { message: 'Invalid postal code' })
  postal_code: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CartItemDto)
  items: CartItemDto[];
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
