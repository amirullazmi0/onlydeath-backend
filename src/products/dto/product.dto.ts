import { PartialType } from '@nestjs/mapped-types';
import { Transform, Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto.js';
import { PreOrderMode, ProductAvailability } from '../../generated/prisma/enums.js';

export class ProductImageDto {
  @IsString()
  url: string;

  @IsOptional()
  @IsString()
  file_id?: string;
}

export class ProductSizeDto {
  /** Present when updating an existing size, so order history keeps pointing at it */
  @IsOptional()
  @IsUUID()
  id?: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  label: string;

  @IsInt()
  @Min(0)
  stock: number;
}

export class ProductDiscountDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name: string;

  @IsInt()
  @Min(1)
  @Max(100)
  discount_pct: number;

  /** Optional window (ISO 8601); open-ended when omitted */
  @IsOptional()
  @IsDateString()
  start_at?: string;

  @IsOptional()
  @IsDateString()
  end_at?: string;

  @IsBoolean()
  is_active: boolean;
}

export class CreateProductDto {
  @IsString()
  @MinLength(2)
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsUUID()
  category_id?: string | null;

  /** IDR, whole rupiah */
  @IsInt()
  @Min(0)
  price: number;

  /** USD in cents, shown to buyers outside Indonesia */
  @IsInt()
  @Min(1)
  price_usd_cents: number;

  @IsInt()
  @Min(1)
  weight_gram: number;

  @IsInt()
  @Min(0)
  stock: number;

  @IsEnum(ProductAvailability)
  availability: ProductAvailability;

  @ValidateIf((o) => o.availability === ProductAvailability.PRE_ORDER)
  @IsInt()
  @Min(1)
  po_estimate_days?: number;

  @ValidateIf((o) => o.availability === ProductAvailability.PRE_ORDER)
  @IsEnum(PreOrderMode)
  po_mode?: PreOrderMode;

  /** PERIOD pre-orders only accept orders between these instants (ISO 8601) */
  @ValidateIf((o) => o.availability === ProductAvailability.PRE_ORDER && o.po_mode === PreOrderMode.PERIOD)
  @IsDateString()
  po_start_at?: string;

  @ValidateIf((o) => o.availability === ProductAvailability.PRE_ORDER && o.po_mode === PreOrderMode.PERIOD)
  @IsDateString()
  po_end_at?: string;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductImageDto)
  images: ProductImageDto[];

  /** Optional size options; when present, stock is tracked per size */
  @IsOptional()
  @IsArray()
  @ArrayUnique((s: ProductSizeDto) => s.label, { message: 'Size labels must be unique' })
  @ValidateNested({ each: true })
  @Type(() => ProductSizeDto)
  sizes?: ProductSizeDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductDiscountDto)
  discounts?: ProductDiscountDto[];
}

export class UpdateProductDto extends PartialType(CreateProductDto) {}

export class ProductQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(ProductAvailability)
  availability?: ProductAvailability;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  is_active?: boolean;
}
