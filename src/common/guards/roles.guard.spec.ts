import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard.js';
import { ROLES_KEY } from '../constants/metadata-keys.js';
import type { AuthUser } from '../auth-user.js';

function createContext(user?: AuthUser): ExecutionContext {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({
      getRequest: () => (user ? { user } : {}),
    }),
  } as unknown as ExecutionContext;
}

function guardWith(roles: string[] | undefined): RolesGuard {
  const reflector = {
    getAllAndOverride: vi.fn((key: string) =>
      key === ROLES_KEY ? roles : undefined,
    ),
  } as unknown as Reflector;
  return new RolesGuard(reflector);
}

function user(roles: string[]): AuthUser {
  return { userId: 'u1', email: 'u@hems.local', roles };
}

describe('RolesGuard matrix', () => {
  it('allows when no @Roles metadata is present', () => {
    expect(guardWith(undefined).canActivate(createContext())).toBe(true);
  });

  it('allows when @Roles metadata is empty', () => {
    expect(guardWith([]).canActivate(createContext(user(['Student'])))).toBe(
      true,
    );
  });

  it('allows matching role', () => {
    expect(guardWith(['Admin']).canActivate(createContext(user(['Admin'])))).toBe(
      true,
    );
  });

  it('denies non-matching role', () => {
    expect(
      guardWith(['Admin']).canActivate(createContext(user(['Student']))),
    ).toBe(false);
  });

  it('allows when user has any of multiple required roles', () => {
    expect(
      guardWith(['Admin', 'Instructor']).canActivate(
        createContext(user(['Instructor'])),
      ),
    ).toBe(true);
  });

  it('denies when user has none of multiple required roles', () => {
    expect(
      guardWith(['Admin', 'Instructor']).canActivate(
        createContext(user(['Student Officer'])),
      ),
    ).toBe(false);
  });

  it('denies when request has no authenticated user', () => {
    expect(guardWith(['Admin']).canActivate(createContext())).toBe(false);
  });

  it('requires an exact role name match', () => {
    expect(
      guardWith(['Department Head']).canActivate(
        createContext(user(['Dept Head'])),
      ),
    ).toBe(false);
  });
});
