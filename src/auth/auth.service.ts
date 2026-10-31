import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { MailService } from '../mail/mail.service.js';
import type { JwtPayload } from '../common/decorators/current-user.decorator.js';
import type { User } from '../generated/prisma/client.js';
import {
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  ResetPasswordDto,
} from './dto/auth.dto.js';

const RESET_TOKEN_MINUTES = 30;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export const toPublicUser = (user: User) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: 'ADMIN' as const,
  is_active: user.isActive,
  created_at: user.createdAt,
});

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
  ) {}

  async login({ email, password }: LoginDto) {
    const user = await this.prisma.user.findFirst({
      where: { email: email.toLowerCase(), deletedAt: null },
    });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      throw new UnauthorizedException('Invalid email or password');
    }
    if (!user.isActive) throw new UnauthorizedException('Account is inactive');
    return this.issueTokens(user);
  }

  async refresh(refreshToken: string) {
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(refreshToken, {
        secret: this.config.getOrThrow('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Refresh token expired');
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    // Rotation: only the most recently issued refresh token is accepted
    if (!user || !user.isActive || user.deletedAt || user.refreshTokenHash !== sha256(refreshToken)) {
      throw new UnauthorizedException('Refresh token revoked');
    }
    return this.issueTokens(user);
  }

  async logout(userId: string) {
    await this.prisma.user.update({ where: { id: userId }, data: { refreshTokenHash: null } });
  }

  async me(userId: string) {
    const user = await this.prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
    if (!user) throw new UnauthorizedException();
    return toPublicUser(user);
  }

  async forgotPassword({ email }: ForgotPasswordDto) {
    const user = await this.prisma.user.findFirst({
      where: { email: email.toLowerCase(), deletedAt: null, isActive: true },
    });
    // Same response whether or not the email exists, to avoid account enumeration
    if (!user) return;

    const token = randomBytes(32).toString('hex');
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        resetTokenHash: sha256(token),
        resetTokenExpiry: new Date(Date.now() + RESET_TOKEN_MINUTES * 60_000),
      },
    });

    await this.mail.send(user.email, 'Reset your admin password', 'reset-password', {
      name: user.name,
      expiresMinutes: RESET_TOKEN_MINUTES,
      resetUrl: `${this.config.getOrThrow('FE_URL')}/auth/reset-password?token=${token}`,
    });
  }

  async resetPassword({ token, password }: ResetPasswordDto) {
    const user = await this.prisma.user.findFirst({
      where: { resetTokenHash: sha256(token), resetTokenExpiry: { gt: new Date() } },
    });
    if (!user) throw new BadRequestException('Reset token is invalid or has expired');

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        password: await bcrypt.hash(password, 10),
        resetTokenHash: null,
        resetTokenExpiry: null,
        refreshTokenHash: null,
      },
    });
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await bcrypt.compare(dto.current_password, user.password))) {
      throw new BadRequestException('Current password is incorrect');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { password: await bcrypt.hash(dto.new_password, 10) },
    });
  }

  private async issueTokens(user: User) {
    const payload: JwtPayload = { sub: user.id, email: user.email };
    const accessTtl = Number(this.config.get('JWT_ACCESS_EXPIRES_IN') ?? 900);
    const refreshTtl = Number(this.config.get('JWT_REFRESH_EXPIRES_IN') ?? 604800);

    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(payload, {
        secret: this.config.getOrThrow('JWT_ACCESS_SECRET'),
        expiresIn: accessTtl,
      }),
      this.jwt.signAsync(
        { ...payload, jti: randomBytes(8).toString('hex') },
        { secret: this.config.getOrThrow('JWT_REFRESH_SECRET'), expiresIn: refreshTtl },
      ),
    ]);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { refreshTokenHash: sha256(refreshToken) },
    });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: accessTtl,
      user: toPublicUser(user),
    };
  }
}
