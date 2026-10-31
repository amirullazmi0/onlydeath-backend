import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { MailService } from '../mail/mail.service.js';
import { paginate, PaginationDto } from '../common/dto/pagination.dto.js';
import { toPublicUser } from '../auth/auth.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { CreateUserDto, UpdateUserDto } from './dto/user.dto.js';

const generatePassword = () => randomBytes(9).toString('base64url');

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  async list(query: PaginationDto) {
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      ...(query.search && {
        OR: [
          { name: { contains: query.search, mode: 'insensitive' } },
          { email: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    };
    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.user.count({ where }),
    ]);
    return paginate(items.map(toPublicUser), total, query);
  }

  async create(dto: CreateUserDto) {
    const email = dto.email.toLowerCase();
    const exists = await this.prisma.user.findUnique({ where: { email } });
    if (exists) throw new ConflictException('Email is already registered');

    const password = generatePassword();
    const user = await this.prisma.user.create({
      data: { email, name: dto.name, password: await bcrypt.hash(password, 10) },
    });

    await this.mail.send(email, 'Your ONLYDEATH admin account', 'admin-invite', {
      name: user.name,
      email,
      password,
      loginUrl: `${this.config.getOrThrow('FE_URL')}/auth/sign-in`,
    });
    return toPublicUser(user);
  }

  async update(id: string, dto: UpdateUserDto, actorId: string) {
    await this.findOrThrow(id);
    if (id === actorId && dto.is_active === false) {
      throw new BadRequestException('You cannot deactivate your own account');
    }
    const user = await this.prisma.user.update({
      where: { id },
      data: {
        name: dto.name,
        isActive: dto.is_active,
        // Deactivation also kills the current session
        ...(dto.is_active === false && { refreshTokenHash: null }),
      },
    });
    return toPublicUser(user);
  }

  async resetPassword(id: string) {
    const user = await this.findOrThrow(id);
    const password = generatePassword();
    await this.prisma.user.update({
      where: { id },
      data: { password: await bcrypt.hash(password, 10), refreshTokenHash: null },
    });
    await this.mail.send(user.email, 'Your new admin password', 'admin-invite', {
      name: user.name,
      email: user.email,
      password,
      loginUrl: `${this.config.getOrThrow('FE_URL')}/auth/sign-in`,
    });
  }

  async remove(id: string, actorId: string) {
    if (id === actorId) throw new BadRequestException('You cannot delete your own account');
    await this.findOrThrow(id);
    await this.prisma.user.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false, refreshTokenHash: null },
    });
  }

  private async findOrThrow(id: string) {
    const user = await this.prisma.user.findFirst({ where: { id, deletedAt: null } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }
}
