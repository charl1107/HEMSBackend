import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class TimeAttendanceDto {
  @IsString()
  @MinLength(1)
  participantId!: string;
}

export class SyncAttendanceRecordDto {
  @IsString()
  @MinLength(1)
  clientRecordId!: string;

  @IsString()
  @MinLength(1)
  eventId!: string;

  @IsString()
  @MinLength(1)
  participantId!: string;

  @IsIn(['Present', 'Absent'])
  status!: 'Present' | 'Absent';

  @IsOptional()
  @IsDateString()
  timeIn?: string;

  @IsOptional()
  @IsDateString()
  timeOut?: string;

  @IsString()
  @MinLength(1)
  deviceId!: string;

  @IsDateString()
  recordedAt!: string;
}

export class SyncAttendanceDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => SyncAttendanceRecordDto)
  records!: SyncAttendanceRecordDto[];
}
