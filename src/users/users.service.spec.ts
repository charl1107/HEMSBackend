import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { UsersService } from './users.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

function makePrisma() {
  return {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    role: { findMany: vi.fn() },
    userRole: { findUnique: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
  };
}

describe('UsersService.create student', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: UsersService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new UsersService(prisma as unknown as PrismaService);
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.role.findMany.mockResolvedValue([{ id: 'r-student', name: 'Student' }]);
    prisma.user.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'u1',
        email: data.email,
        firstName: data.firstName,
        lastName: data.lastName,
        isActive: data.isActive,
        studentId: data.studentId,
        program: data.program,
        yearLevel: data.yearLevel,
        mustChangePassword: data.mustChangePassword,
        userRoles: [{ role: { name: 'Student' } }],
      }),
    );
  });

  it('creates student with profile fields and mustChangePassword true', async () => {
    const out = await service.create({
      email: 's@x.com',
      password: 'ChangeMe123!',
      firstName: 'Sam',
      lastName: 'Lee',
      roles: ['Student'],
      studentId: '2026-001',
      program: 'BSHM',
      yearLevel: 1,
      isActive: true,
    });
    expect(prisma.user.create).toHaveBeenCalled();
    const data = prisma.user.create.mock.calls[0][0].data;
    expect(data.mustChangePassword).toBe(true);
    expect(data.studentId).toBe('2026-001');
    expect(data.passwordHash).toMatch(/^\$2/);
    expect(out).not.toHaveProperty('passwordHash');
    expect(out.mustChangePassword).toBe(true);
  });

  it('conflicts on duplicate studentId', async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'other' });
    await expect(
      service.create({
        email: 'other@x.com',
        password: 'ChangeMe123!',
        firstName: 'A',
        lastName: 'B',
        roles: ['Student'],
        studentId: '2026-001',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('requires studentId when role is Student', async () => {
    await expect(
      service.create({
        email: 's2@x.com',
        password: 'ChangeMe123!',
        firstName: 'A',
        lastName: 'B',
        roles: ['Student'],
      }),
    ).rejects.toThrow(/studentId/i);
  });

  it('creates a staff user holding Instructor with mustChangePassword forced true', async () => {
    // UsersService.create rejects 'Admin' (DB-only grant), so use Instructor
    // to reach the mustChangePassword branch for a non-student role.
    prisma.role.findMany.mockResolvedValue([
      { id: 'r-instructor', name: 'Instructor' },
    ]);
    prisma.user.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'u-inst',
        email: data.email,
        firstName: data.firstName,
        lastName: data.lastName,
        isActive: data.isActive,
        mustChangePassword: data.mustChangePassword,
        userRoles: [{ role: { name: 'Instructor' } }],
      }),
    );

    const out = await service.create({
      email: 'i@x.com',
      password: 'ChccAY2026!',
      firstName: 'Ida',
      lastName: 'Inst',
      roles: ['Instructor'],
    });

    const data = prisma.user.create.mock.calls[0][0].data;
    expect(data.mustChangePassword).toBe(true);
    expect(out.roles).toEqual(['Instructor']);
    expect(out.mustChangePassword).toBe(true);
    expect(out).not.toHaveProperty('passwordHash');
  });

  it('refuses to grant the Admin role through the API', async () => {
    const attempt = service.create({
      email: 'admin@x.com',
      password: 'ChccAY2026!',
      firstName: 'Ad',
      lastName: 'Min',
      roles: ['Admin'],
    });
    await expect(attempt).rejects.toThrow(
      'Admin role can only be granted directly in the database',
    );
    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('rejects a role that does not exist', async () => {
    prisma.role.findMany.mockResolvedValue([]);
    const attempt = service.create({
      email: 'w@x.com',
      password: 'ChccAY2026!',
      firstName: 'Wi',
      lastName: 'Zard',
      roles: ['Wizard'],
    });

    await expect(attempt).rejects.toThrow('One or more roles do not exist');
    await expect(attempt).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });
});
