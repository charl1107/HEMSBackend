import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ROLES_KEY } from '../common/constants/metadata-keys.js';
import { DIRECTORY_READ_ROLES } from '../events/events.constants.js';
import { UsersController } from './users.controller.js';

/** The exact reader set for GET /users: task-assignee and committee-member
 *  pickers need directory reads; Students stay excluded. */
const DIRECTORY_READERS = [
  'Admin',
  'Department Head',
  'Event Coordinator',
  'Instructor',
  'Student Officer',
];

function readRoles(method: 'findAll' | 'findOne'): string[] {
  return Reflect.getMetadata(
    ROLES_KEY,
    UsersController.prototype[method],
  ) as string[];
}

describe('GET /users reader set (F30 directory pickers)', () => {
  it.each(['findAll', 'findOne'] as const)(
    '%s is readable by exactly Admin + Department Head + Event Coordinator + Instructor + Student Officer',
    (method) => {
      expect([...new Set(readRoles(method))].sort()).toEqual(
        [...DIRECTORY_READERS].sort(),
      );
    },
  );

  it('derives the reader list from DIRECTORY_READ_ROLES (roster naming removed)', () => {
    expect(readRoles('findAll')).toEqual(['Admin', ...DIRECTORY_READ_ROLES]);
    expect(readRoles('findOne')).toEqual(['Admin', ...DIRECTORY_READ_ROLES]);
  });
});
