import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator.js';
import { AuditService } from './audit.service.js';
import { AuditQueryDto, type AuditPage } from './dto/audit-query.dto.js';

@Controller('audit')
@Roles('Admin')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Query() query: AuditQueryDto): Promise<AuditPage> {
    return this.audit.list(query);
  }
}
