import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class PaginationDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 10;

  @IsOptional()
  @IsString()
  search?: string;
}

export const paginate = <T>(items: T[], total: number, { page, limit }: PaginationDto) => ({
  items,
  meta: {
    total_data: total,
    total_page: Math.max(1, Math.ceil(total / limit)),
    current_page: page,
    limit,
  },
});
