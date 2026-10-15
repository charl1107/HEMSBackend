import type { EventCampusScope, EventStatus } from '@prisma/client';

export const PUBLIC_EVENT_STATUSES = [
  'Planning',
  'Ongoing',
  'Completed',
] as const satisfies readonly EventStatus[];

export const ALL_EVENT_STATUSES = [
  'Planning',
  'Ongoing',
  'Completed',
  'Cancelled',
] as const satisfies readonly EventStatus[];

export const EVENT_CAMPUS_SCOPES = [
  'OnCampus',
  'OffCampus',
] as const satisfies readonly EventCampusScope[];

export const EDITABLE_EVENT_STATUSES = [
  'Planning',
  'Ongoing',
] as const satisfies readonly EventStatus[];

export const CONFLICT_EXCLUDED_STATUSES = [
  'Cancelled',
] as const satisfies readonly EventStatus[];

export const SUBMIT_EVENT_ROLES = [
  'Event Coordinator',
  'Student Officer',
  'Department Head',
  'Admin',
] as const;

export const REVIEW_EVENT_ROLES = [
  'Department Head',
  'Event Coordinator',
  'Admin',
] as const;

export const ROSTER_MANAGER_ROLES = [
  'Event Coordinator',
  'Instructor',
  'Student Officer',
  'Department Head',
  'Admin',
] as const;

export const STUDENT_SELF_REGISTER_ROLES = [
  'Student',
  'Student Officer',
] as const;

export const COMMITTEE_MANAGER_ROLES = [
  'Admin',
  'Department Head',
] as const;

export const ATTENDANCE_SUPERVISOR_ROLES = [
  'Event Coordinator',
  'Instructor',
  'Student Officer',
  'Admin',
  'Department Head',
] as const;

export const ATTENDANCE_LATE_FIX_ROLES = [
  'Event Coordinator',
  'Admin',
  'Department Head',
] as const;
