import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EventsController } from './events.controller.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import type { AuthUser } from '../common/auth-user.js';

const guard = new RolesGuard(new Reflector());

function contextFor(
  handler: (...args: never[]) => unknown,
  user?: AuthUser,
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => EventsController,
    switchToHttp: () => ({
      getRequest: () => (user ? { user } : {}),
    }),
  } as unknown as ExecutionContext;
}

const coordinator: AuthUser = {
  userId: 'c1',
  email: 'c@hems.local',
  roles: ['Event Coordinator'],
};

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

const instructor: AuthUser = {
  userId: 'i1',
  email: 'i@hems.local',
  roles: ['Instructor'],
};

const studentOfficer: AuthUser = {
  userId: 's1',
  email: 's@hems.local',
  roles: ['Student Officer'],
};

const approvalHandlers = ['approve', 'reject', 'requestRevision'] as const;

describe('EventsController approval RBAC (Roles metadata + RolesGuard)', () => {
  it.each(approvalHandlers)(
    'denies non-review users on %s',
    (name) => {
      const handler = EventsController.prototype[name];
      expect(guard.canActivate(contextFor(handler, instructor))).toBe(false);
      expect(guard.canActivate(contextFor(handler, studentOfficer))).toBe(false);
      expect(guard.canActivate(contextFor(handler))).toBe(false);
    },
  );

  it.each(approvalHandlers)('allows review roles on %s', (name) => {
    expect(
      guard.canActivate(contextFor(EventsController.prototype[name], head)),
    ).toBe(true);
    expect(
      guard.canActivate(contextFor(EventsController.prototype[name], coordinator)),
    ).toBe(true);
    expect(
      guard.canActivate(contextFor(EventsController.prototype[name], admin)),
    ).toBe(true);
  });
});
