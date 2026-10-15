import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { validate } from 'class-validator';
import { EventsController } from './events.controller.js';
import type { AuthUser } from '../common/auth-user.js';
import { AdvanceEventDto } from './dto/event.dto.js';

const studentOfficer: AuthUser = {
  userId: 's1',
  email: 's@hems.local',
  roles: ['Student Officer'],
};

describe('POST :id/advance endpoint contract', () => {
  function makeController(advance: ReturnType<typeof vi.fn>) {
    return new EventsController({ advance } as never);
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
