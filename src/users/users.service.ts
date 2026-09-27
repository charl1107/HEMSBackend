import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service.js';
import { sanitizeUser, type SafeUser } from '../common/utils/sanitize-user.js';
import { AssignRoleDto, CreateUserDto, UpdateUserDto } from './dto/user.dto.js';

const USER_INCLUDE = {
  userRoles: { include: { role: true } },
} as const;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<SafeUser[]> {
    const users = await this.prisma.user.findMany({
      include: USER_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
    return users.map(sanitizeUser);
  }

  async findOne(id: string): Promise<SafeUser> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: USER_INCLUDE,
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return sanitizeUser(user);
  }

  async create(dto: CreateUserDto): Promise<SafeUser> {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existing) {
      throw new ConflictException('Email already in use');
    }
    const roleNames = [...new Set(dto.roles ?? [])];
    if (roleNames.includes('Admin')) {
      throw new BadRequestException('Admin role can only be granted directly in the database');
    }
    const isStudent = roleNames.includes('Student');
    if (isStudent && !dto.studentId) {
      throw new ConflictException('studentId is required for Student accounts');
    }
    if (dto.studentId) {
      const dup = await this.prisma.user.findUnique({
        where: { studentId: dto.studentId },
      });
      if (dup) {
        throw new ConflictException('Student ID already in use');
      }
    }
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const roles = roleNames.length
      ? await this.prisma.role.findMany({
          where: { name: { in: roleNames } },
        })
      : [];
    if (roles.length !== roleNames.length) {
      throw new NotFoundException('One or more roles do not exist');
    }
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        firstName: dto.firstName,
        middleName: dto.middleName?.trim() || null,
        lastName: dto.lastName,
        suffix: dto.suffix?.trim() || null,
        isActive: dto.isActive ?? true,
        studentId: dto.studentId,
        program: dto.program,
        yearLevel: dto.yearLevel,
        mustChangePassword: isStudent,
        userRoles: {
          create: roles.map((role) => ({ roleId: role.id })),
        },
      },
      include: USER_INCLUDE,
    });
    return sanitizeUser(user);
  }

  async update(id: string, dto: UpdateUserDto): Promise<SafeUser> {
    await this.findOne(id);
    const { password, ...rest } = dto;
    const data: Record<string, unknown> = { ...rest };
    if (password) {
      data.passwordHash = await bcrypt.hash(password, 10);
    }
    const user = await this.prisma.user.update({
      where: { id },
      data,
      include: USER_INCLUDE,
    });
    return sanitizeUser(user);
  }

  async remove(id: string): Promise<void> {
    await this.findOne(id);
    await this.prisma.user.delete({ where: { id } });
  }

  async assignRole(id: string, dto: AssignRoleDto): Promise<SafeUser> {
    const [user, role] = await Promise.all([
      this.prisma.user.findUnique({ where: { id } }),
      this.prisma.role.findUnique({ where: { name: dto.role } }),
    ]);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (!role) {
      throw new NotFoundException(`Role "${dto.role}" not found`);
    }
    await this.prisma.userRole.upsert({
      where: { userId_roleId: { userId: id, roleId: role.id } },
      create: { userId: id, roleId: role.id },
      update: {},
    });
    return this.findOne(id);
  }

  async removeRole(id: string, roleId: string): Promise<SafeUser> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    const link = await this.prisma.userRole.findUnique({
      where: { userId_roleId: { userId: id, roleId } },
      include: { role: true },
    });
    if (!link) {
      throw new NotFoundException('Role assignment not found');
    }
    if (link.role.name === 'Student' || link.role.name === 'Admin') {
      throw new BadRequestException(`${link.role.name} role cannot be removed`);
    }
    await this.prisma.userRole.delete({
      where: { userId_roleId: { userId: id, roleId } },
    });
    return this.findOne(id);
  }

  async removeRoleByName(id: string, roleName: string): Promise<SafeUser> {
    if (roleName === 'Student' || roleName === 'Admin') {
      throw new BadRequestException(`${roleName} role cannot be removed`);
    }
    const role = await this.prisma.role.findUnique({ where: { name: roleName } });
    if (!role) {
      throw new NotFoundException(`Role "${roleName}" not found`);
    }
    return this.removeRole(id, role.id);
  }
}
