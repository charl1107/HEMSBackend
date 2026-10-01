import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
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

  it('does not set mustChangePassword for non-student', async () => {
    // UsersService.create rejects 'Admin' (DB-only grant), so use a different
    // non-student role to reach the mustChangePassword branch.
    prisma.role.findMany.mockResolvedValue([
      { id: 'r-instructor', name: 'Instructor' },
    ]);
    await service.create({
      email: 'a@x.com',
      password: 'ChangeMe123!',
      firstName: 'A',
      lastName: 'B',
      roles: ['Instructor'],
    });
    const data = prisma.user.create.mock.calls[0][0].data;
    expect(data.mustChangePassword).toBe(false);
  });
});
