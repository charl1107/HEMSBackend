import { describe, expect, it } from 'vitest'
import { sanitizeUser } from './sanitize-user.js'

describe('sanitizeUser student fields', () => {
  it('passes through student profile and mustChangePassword', () => {
    const out = sanitizeUser({
      id: '1',
      email: 's@x.com',
      firstName: 'S',
      lastName: 'T',
      isActive: true,
      roles: ['Student'],
      mustChangePassword: true,
      studentId: '2026-001',
      program: 'BSHM',
      yearLevel: 2,
    })
    expect(out).toEqual({
      id: '1',
      email: 's@x.com',
      firstName: 'S',
      lastName: 'T',
      isActive: true,
      roles: ['Student'],
      mustChangePassword: true,
      studentId: '2026-001',
      program: 'BSHM',
      yearLevel: 2,
    })
    expect(out).not.toHaveProperty('passwordHash')
  })

  it('defaults mustChangePassword to false and omits undefined profile fields', () => {
    const out = sanitizeUser({
      id: '2',
      email: 'a@x.com',
      firstName: 'A',
      lastName: 'B',
      isActive: true,
      roles: ['Admin'],
    })
    expect(out).toEqual({
      id: '2',
      email: 'a@x.com',
      firstName: 'A',
      lastName: 'B',
      isActive: true,
      roles: ['Admin'],
      mustChangePassword: false,
    })
    expect(out).not.toHaveProperty('studentId')
    expect(out).not.toHaveProperty('program')
    expect(out).not.toHaveProperty('yearLevel')
    expect(out).not.toHaveProperty('passwordHash')
  })
})
