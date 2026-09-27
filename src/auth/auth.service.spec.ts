import { describe, expect, it, vi, beforeEach } from 'vitest';
import bcrypt from 'bcrypt';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { JwtService } from '@nestjs/jwt';

const userWithRoles = {
  id: 'user-1',
  email: 'admin@hems.local',
  passwordHash: '',
  firstName: 'Demo',
  lastName: 'Admin',
  isActive: true,
  userRoles: [{ role: { name: 'Admin' } }],
};

describe('AuthService.validateUser', () => {
  let service: AuthService;
  let prisma: { user: { findUnique: ReturnType<typeof vi.fn> } };

  beforeEach(async () => {
    userWithRoles.passwordHash = await bcrypt.hash('ChangeMe123!', 4);
    prisma = {
      user: {
        findUnique: vi.fn().mockResolvedValue({ ...userWithRoles }),
      },
    };
    service = new AuthService(
      prisma as unknown as PrismaService,
      {} as JwtService,
    );
  });

  it('returns sanitized user on valid credentials', async () => {
    const result = await service.validateUser(
      'admin@hems.local',
      'ChangeMe123!',
    );

    expect(result).not.toBeNull();
    expect(result).toEqual({
      id: 'user-1',
      email: 'admin@hems.local',
      firstName: 'Demo',
      lastName: 'Admin',
      isActive: true,
      roles: ['Admin'],
      mustChangePassword: false,
    });
    expect(result).not.toHaveProperty('passwordHash');
  });

  it('returns null on wrong password', async () => {
    const result = await service.validateUser(
      'admin@hems.local',
      'wrong-password',
    );
    expect(result).toBeNull();
  });

  it('returns null on unknown email', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const result = await service.validateUser(
      'nobody@hems.local',
      'ChangeMe123!',
    );
    expect(result).toBeNull();
  });

  it('returns null for inactive user', async () => {
    prisma.user.findUnique.mockResolvedValue({
      ...userWithRoles,
      isActive: false,
    });
    const result = await service.validateUser(
      'admin@hems.local',
      'ChangeMe123!',
    );
    expect(result).toBeNull();
  });
});

describe('AuthService.changePassword', () => {
  let service: AuthService;
  let prisma: {
    user: {
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    userWithRoles.passwordHash = await bcrypt.hash('OldPass123!', 4);
    prisma = {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          ...userWithRoles,
          mustChangePassword: true,
        }),
        update: vi.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            ...userWithRoles,
            ...data,
            userRoles: userWithRoles.userRoles,
          }),
        ),
      },
    };
    service = new AuthService(
      prisma as unknown as PrismaService,
      {} as JwtService,
    );
  });

  it('updates hash and clears mustChangePassword', async () => {
    const oldHash = userWithRoles.passwordHash;

    const result = await service.changePassword(
      'user-1',
      'OldPass123!',
      'NewPass456!',
    );

    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    const updateArg = prisma.user.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: 'user-1' });
    expect(updateArg.data.mustChangePassword).toBe(false);
    expect(updateArg.data.passwordHash).not.toBe(oldHash);
    await expect(
      bcrypt.compare('NewPass456!', updateArg.data.passwordHash),
    ).resolves.toBe(true);
    expect(result.mustChangePassword).toBe(false);
    expect(result).not.toHaveProperty('passwordHash');
  });

  it('allows first-time password changes without the current password', async () => {
    const result = await service.changePassword('user-1', undefined, 'NewPass456!');
    const updateArg = prisma.user.update.mock.calls[0][0];
    await expect(bcrypt.compare('NewPass456!', updateArg.data.passwordHash)).resolves.toBe(true);
    expect(result.mustChangePassword).toBe(false);
  });

  it('rejects wrong current password', async () => {
    await expect(
      service.changePassword('user-1', 'WrongPass1!', 'NewPass456!'),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      service.changePassword('user-1', 'WrongPass1!', 'NewPass456!'),
    ).rejects.toThrow('Current password is incorrect');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('rejects newPassword shorter than 8', async () => {
    await expect(
      service.changePassword('user-1', 'OldPass123!', 'short'),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('rejects missing user', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(
      service.changePassword('user-1', 'OldPass123!', 'NewPass456!'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects inactive user', async () => {
    prisma.user.findUnique.mockResolvedValue({
      ...userWithRoles,
      isActive: false,
    });
    await expect(
      service.changePassword('user-1', 'OldPass123!', 'NewPass456!'),
    ).rejects.toThrow(UnauthorizedException);
  });
});
