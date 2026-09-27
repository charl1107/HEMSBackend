import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuditController } from './audit.controller.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import type { AuthUser } from '../common/auth-user.js';

const guard = new RolesGuard(new Reflector());

function contextFor(
  handler: (...args: never[]) => unknown,
  user?: AuthUser,
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => AuditController,
    switchToHttp: () => ({
      getRequest: () => (user ? { user } : {}),
    }),
  } as unknown as ExecutionContext;
}

const admin: AuthUser = {
  userId: 'a1',
  email: 'a@hems.local',
  roles: ['Admin'],
};

const head: AuthUser = {
  userId: 'h1',
  email: 'h@hems.local',
  roles: ['Department Head'],
};

const student: AuthUser = {
  userId: 's1',
  email: 's@hems.local',
  roles: ['Student'],
};

describe('AuditController RBAC (Roles metadata + RolesGuard)', () => {
  it('allows Admin on list', () => {
    expect(
      guard.canActivate(contextFor(AuditController.prototype.list, admin)),
    ).toBe(true);
  });

  it('denies Department Head on list', () => {
    expect(
      guard.canActivate(contextFor(AuditController.prototype.list, head)),
    ).toBe(false);
  });

  it('denies Student on list', () => {
    expect(
      guard.canActivate(contextFor(AuditController.prototype.list, student)),
    ).toBe(false);
  });

  it('denies unauthenticated request on list', () => {
    expect(guard.canActivate(contextFor(AuditController.prototype.list))).toBe(
      false,
    );
  });
});
