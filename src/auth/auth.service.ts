import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcrypt';
import { randomBytes, createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { sanitizeUser, type SafeUser } from '../common/utils/sanitize-user.js';

export const REFRESH_COOKIE = 'refresh_token';
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async validateUser(email: string, password: string): Promise<SafeUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { userRoles: { include: { role: true } } },
    });
    if (!user || !user.isActive) {
      return null;
    }
    const matches = await bcrypt.compare(password, user.passwordHash);
    if (!matches) {
      return null;
    }
    return sanitizeUser(user);
  }

  async login(
    email: string,
    password: string,
    res: Response,
  ): Promise<{ accessToken: string; user: SafeUser }> {
    const user = await this.validateUser(email, password);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return this.issueSession(user, res);
  }

  async refresh(rawToken: string | undefined, res: Response): Promise<{
    accessToken: string;
    user: SafeUser;
  }> {
    const stored = await this.findValidRefreshToken(rawToken);
    if (!stored) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: stored.userId },
      include: { userRoles: { include: { role: true } } },
    });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
    return this.issueSession(sanitizeUser(user), res);
  }

  async getMe(userId: string): Promise<SafeUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { userRoles: { include: { role: true } } },
    });
    if (!user) {
      throw new UnauthorizedException();
    }
    return sanitizeUser(user);
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<SafeUser> {
    if (newPassword.length < 8) {
      throw new BadRequestException('New password must be at least 8 characters');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { userRoles: { include: { role: true } } },
    });
    if (!user || !user.isActive) {
      throw new UnauthorizedException();
    }
    const matches = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!matches) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    const passwordHash = await bcrypt.hash(newPassword, 10);
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash, mustChangePassword: false },
      include: { userRoles: { include: { role: true } } },
    });
    return sanitizeUser(updated);
  }

  async logout(rawToken: string | undefined, res: Response): Promise<void> {
    if (rawToken) {
      const stored = await this.prisma.refreshToken.findUnique({
        where: { tokenHash: hashToken(rawToken) },
      });
      if (stored && !stored.revokedAt) {
        await this.prisma.refreshToken.update({
          where: { id: stored.id },
          data: { revokedAt: new Date() },
        });
      }
    }
    res.clearCookie(REFRESH_COOKIE, { path: '/auth' });
  }

  private async issueSession(user: SafeUser, res: Response) {
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
    });
    const rawToken = randomBytes(48).toString('base64url');
    await this.prisma.refreshToken.create({
      data: {
        tokenHash: hashToken(rawToken),
        userId: user.id,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      },
    });
    res.cookie(REFRESH_COOKIE, rawToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/auth',
      maxAge: REFRESH_TOKEN_TTL_MS,
    });
    return { accessToken, user };
  }

  private async findValidRefreshToken(rawToken: string | undefined) {
    if (!rawToken) {
      return null;
    }
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(rawToken) },
    });
    if (!stored || stored.revokedAt || stored.expiresAt.getTime() <= Date.now()) {
      return null;
    }
    return stored;
  }
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
