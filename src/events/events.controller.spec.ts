import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { validate } from 'class-validator';
import { EventsController } from './events.controller.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import type { AuthUser } from '../common/auth-user.js';
import { AdvanceEventDto } from './dto/event.dto.js';

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

describe('POST :id/advance endpoint contract', () => {
  function makeController(advance: ReturnType<typeof vi.fn>) {
    return new EventsController(
      { advance } as never,
      {} as never,
    );
  }

  it('rejects unauthenticated requests before touching the service', () => {
    const advance = vi.fn();
    const controller = makeController(advance);

    expect(() =>
      controller.advance('evt-1', { to: 'Cancelled' }, {} as never),
    ).toThrow(ForbiddenException);
    expect(advance).not.toHaveBeenCalled();
  });

  it.each(['Ongoing', 'Completed', 'Cancelled', 'Planning'] as const)(
    'delegates to=%s to the service with the request user',
    async (to) => {
      const advance = vi.fn().mockResolvedValue({ id: 'evt-1', status: to });
      const controller = makeController(advance);

      await controller.advance('evt-1', { to }, { user: studentOfficer } as never);

      expect(advance).toHaveBeenCalledWith('evt-1', to, studentOfficer);
    },
  );

  it('DTO accepts every lifecycle target', async () => {
    for (const to of ['Ongoing', 'Completed', 'Cancelled', 'Planning'] as const) {
      const dto = Object.assign(new AdvanceEventDto(), { to });
      await expect(validate(dto)).resolves.toEqual([]);
    }
  });

  it('DTO rejects statuses outside the four-status lifecycle', async () => {
    const dto = Object.assign(new AdvanceEventDto(), { to: 'Rejected' });
    expect(await validate(dto)).not.toEqual([]);
  });
});
