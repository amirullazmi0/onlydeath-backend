import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { IsString, MinLength } from 'class-validator';
import { Public } from '../common/decorators/public.decorator.js';
import { ResponseMessage } from '../common/decorators/message.decorator.js';
import { CategoriesService } from './categories.service.js';

export class UpsertCategoryDto {
  @IsString()
  @MinLength(2)
  name: string;
}

@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Public()
  @Get()
  list() {
    return this.categories.list();
  }

  @Post()
  @ResponseMessage('Category created')
  create(@Body() dto: UpsertCategoryDto) {
    return this.categories.create(dto.name);
  }

  @Patch(':id')
  @ResponseMessage('Category updated')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpsertCategoryDto) {
    return this.categories.update(id, dto.name);
  }

  @Delete(':id')
  @ResponseMessage('Category deleted')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.categories.remove(id);
  }
}
