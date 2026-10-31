import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser, type JwtPayload } from '../common/decorators/current-user.decorator.js';
import { ResponseMessage } from '../common/decorators/message.decorator.js';
import { PaginationDto } from '../common/dto/pagination.dto.js';
import { UsersService } from './users.service.js';
import { CreateUserDto, UpdateUserDto } from './dto/user.dto.js';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(@Query() query: PaginationDto) {
    return this.users.list(query);
  }

  @Post()
  @ResponseMessage('Admin created, password sent by email')
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }

  @Patch(':id')
  @ResponseMessage('Admin updated')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.users.update(id, dto, actor.sub);
  }

  @Post(':id/reset-password')
  @ResponseMessage('New password sent by email')
  resetPassword(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.resetPassword(id);
  }

  @Delete(':id')
  @ResponseMessage('Admin deleted')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: JwtPayload) {
    return this.users.remove(id, actor.sub);
  }
}
