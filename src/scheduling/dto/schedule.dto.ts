import {
  IsDateString,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class CreateScheduleDto {
  @IsString()
  @MinLength(1)
  activityName!: string;

  @IsDateString()
  startTime!: string;

  @IsDateString()
  endTime!: string;
}

export class UpdateScheduleDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  activityName?: string;

  @IsOptional()
  @IsDateString()
  startTime?: string;

  @IsOptional()
  @IsDateString()
  endTime?: string;
}
