import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export class AddParticipantDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  userId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  externalName?: string;

  @IsOptional()
  @IsIn(['Student', 'Staff'])
  participantType?: 'Student' | 'Staff';
}
