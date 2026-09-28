import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../common/decorators/public.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import { AuthService, REFRESH_COOKIE } from './auth.service.js';
import { LoginDto } from './dto/login.dto.js';
import { RefreshDto } from './dto/refresh.dto.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import type { SafeUser } from '../common/utils/sanitize-user.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string; refreshToken: string; user: SafeUser }> {
    return this.authService.login(dto.email, dto.password, res);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(
    @Req() req: Request,
    @Body() dto: RefreshDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cookies = (req.cookies ?? {}) as Record<string, string | undefined>;
    const token = dto?.refreshToken || cookies[REFRESH_COOKIE];
    return this.authService.refresh(token, res);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() req: Request,
    @Body() dto: RefreshDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const cookies = (req.cookies ?? {}) as Record<string, string | undefined>;
    const token = dto?.refreshToken || cookies[REFRESH_COOKIE];
    await this.authService.logout(token, res);
  }

  @Get('me')
  me(@Req() req: { user: AuthUser }): Promise<SafeUser> {
    return this.authService.getMe(req.user.userId);
  }

  @Post('change-password')
  @HttpCode(200)
  changePassword(
    @Req() req: { user: AuthUser },
    @Body() dto: ChangePasswordDto,
  ): Promise<SafeUser> {
    return this.authService.changePassword(
      req.user.userId,
      dto.currentPassword,
      dto.newPassword,
    );
  }
}
