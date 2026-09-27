import { IsOptional, IsString, MinLength } from 'class-validator';

export class CreateCommitteeDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  description?: string;
}

export class AddCommitteeMemberDto {
  @IsString()
  @MinLength(1)
  userId!: string;
}
