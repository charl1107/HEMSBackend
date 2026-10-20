export interface SanitizableUser {
  id: string;
  email: string;
  firstName: string;
  middleName?: string | null;
  lastName: string;
  suffix?: string | null;
  isActive: boolean;
  userRoles?: { role: { name: string } }[];
  roles?: string[];
  mustChangePassword?: boolean;
  studentId?: string | null;
  program?: string | null;
  yearLevel?: number | null;
}

export interface SafeUser {
  id: string;
  email: string;
  firstName: string;
  middleName?: string | null;
  lastName: string;
  suffix?: string | null;
  isActive: boolean;
  roles: string[];
  mustChangePassword: boolean;
  studentId?: string | null;
  program?: string | null;
  yearLevel?: number | null;
}

export function sanitizeUser(user: SanitizableUser): SafeUser {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    ...(user.middleName !== undefined ? { middleName: user.middleName } : {}),
    lastName: user.lastName,
    ...(user.suffix !== undefined ? { suffix: user.suffix } : {}),
    isActive: user.isActive,
    roles: user.userRoles?.map((ur) => ur.role.name) ?? user.roles ?? [],
    mustChangePassword: user.mustChangePassword ?? false,
    ...(user.studentId !== undefined ? { studentId: user.studentId } : {}),
    ...(user.program !== undefined ? { program: user.program } : {}),
    ...(user.yearLevel !== undefined ? { yearLevel: user.yearLevel } : {}),
  };
}
