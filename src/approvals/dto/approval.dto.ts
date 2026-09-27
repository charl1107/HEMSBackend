import {
  IsBoolean,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class SubmitForApprovalDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  comments?: string;
}

export class ApproveEventDto {
  @IsOptional()
  @IsBoolean()
  overrideConflict?: boolean;

  @IsOptional()
  @IsString()
  @MinLength(1)
  comments?: string;
}

export class RejectEventDto {
  @IsString()
  @MinLength(1)
  reason!: string;
}

export class RequestRevisionDto {
  @IsString()
  @MinLength(1)
  comments!: string;
}
