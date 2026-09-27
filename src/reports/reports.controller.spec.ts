import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ReportsController } from './reports.controller.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import type { AuthUser } from '../common/auth-user.js';

const guard = new RolesGuard(new Reflector());

function contextFor(
  handler: (...args: never[]) => unknown,
  user?: AuthUser,
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => ReportsController,
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

const coordinator: AuthUser = {
  userId: 'c1',
  email: 'c@hems.local',
  roles: ['Event Coordinator'],
};

const student: AuthUser = {
  userId: 's1',
  email: 's@hems.local',
  roles: ['Student'],
};

const handlers = [
  'getSummary',
  'getEventReport',
  'exportAttendanceCsv',
  'exportParticipantsCsv',
  'exportEventPdf',
] as const;

describe('ReportsController RBAC (Roles metadata + RolesGuard)', () => {
  it.each(handlers)('allows Admin on %s', (name) => {
    expect(
      guard.canActivate(contextFor(ReportsController.prototype[name], admin)),
    ).toBe(true);
  });

  it.each(handlers)('allows Department Head on %s', (name) => {
    expect(
      guard.canActivate(contextFor(ReportsController.prototype[name], head)),
    ).toBe(true);
  });

  it.each(handlers)('denies Event Coordinator on %s (403)', (name) => {
    expect(
      guard.canActivate(
        contextFor(ReportsController.prototype[name], coordinator),
      ),
    ).toBe(false);
  });

  it.each(handlers)('denies Student on %s (403)', (name) => {
    expect(
      guard.canActivate(contextFor(ReportsController.prototype[name], student)),
    ).toBe(false);
  });

  it.each(handlers)('denies unauthenticated request on %s (403)', (name) => {
    expect(guard.canActivate(contextFor(ReportsController.prototype[name]))).toBe(
      false,
    );
  });
});
