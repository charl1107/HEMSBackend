import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { NotificationType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

export interface NotifyInput {
  actorId: string;
  userIds: readonly string[];
  type: NotificationType;
  message: string;
  eventId?: string | null;
}

export interface RoleNotifyInput {
  actorId: string;
  type: NotificationType;
  message: string;
  eventId?: string | null;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Best-effort: creates notifications for userIds, skipping the actor
   * (no self-notification). Never throws so a notification failure can
   * never fail the primary action that triggered it.
   */
  async notify(input: NotifyInput): Promise<void> {
    try {
      const recipients = [
        ...new Set(input.userIds),
      ].filter((userId) => userId && userId !== input.actorId);
      if (recipients.length === 0) {
        return;
      }
      await this.prisma.notification.createMany({
        data: recipients.map((userId) => ({
          userId,
          eventId: input.eventId ?? null,
          type: input.type,
          message: input.message,
        })),
      });
    } catch (error) {
      this.logger.warn(
        `Failed to create ${input.type} notifications: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Best-effort: notifies every active user holding the given role,
   * skipping the actor. Never throws.
   */
  async notifyRole(role: string, input: RoleNotifyInput): Promise<void> {
    try {
      const users = await this.prisma.user.findMany({
        where: {
          isActive: true,
          userRoles: { some: { role: { name: role } } },
        },
        select: { id: true },
      });
      await this.notify({
        actorId: input.actorId,
        userIds: users.map((user) => user.id),
        type: input.type,
        message: input.message,
        eventId: input.eventId,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to notify role ${role} for ${input.type}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async findMany(userId: string) {
    return this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async markRead(userId: string, id: string) {
    const { count } = await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { isRead: true },
    });
    if (count === 0) {
      throw new NotFoundException('Notification not found');
    }
    const notification = await this.prisma.notification.findUnique({
      where: { id },
    });
    if (!notification) {
      throw new NotFoundException('Notification not found');
    }
    return notification;
  }
}
