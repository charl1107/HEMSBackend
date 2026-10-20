import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import type { EventCampusScope, EventStatus } from '@prisma/client';
import { PageQueryDto } from '../../common/dto/page-query.dto.js';
import {
  ALL_EVENT_STATUSES,
  EVENT_CAMPUS_SCOPES,
} from '../events.constants.js';

export class CreateEventDto {
  @IsString()
  @MinLength(1)
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsDateString()
  eventDate!: string;

  @IsString()
  @MinLength(1)
  venue!: string;

  @IsOptional()
  @IsString()
  campusScope?: 'OnCampus' | 'OffCampus';

  @IsOptional()
  @IsString()
  eventTypeId?: string;
}

export class UpdateEventDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsDateString()
  eventDate?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  venue?: string;

  @IsOptional()
  @IsString()
  campusScope?: 'OnCampus' | 'OffCampus';

  @IsOptional()
  @IsString()
  eventTypeId?: string;
}

/**
 * Body of POST /events/:id/advance. Accepts any real event status so the
 * service can answer lifecycle-only targets with 409 (not 400); values that
 * are not an EventStatus at all still fail validation with 400.
 */
export class AdvanceEventDto {
  @IsIn([...ALL_EVENT_STATUSES])
  to!: EventStatus;
}

export class EventListQueryDto extends PageQueryDto {
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    const parts = value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    return parts.length > 0 ? parts : undefined;
  })
  @IsIn([...ALL_EVENT_STATUSES], { each: true })
  status?: EventStatus[];

  @IsOptional()
  @IsIn([...EVENT_CAMPUS_SCOPES])
  campusScope?: EventCampusScope;

  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined,
  )
  @IsString()
  type?: string;
}
