import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator.js';
import { ApprovalsService } from './approvals.service.js';
import { PageQueryDto } from '../common/dto/page-query.dto.js';
import { SUBMIT_EVENT_ROLES } from '../events/events.constants.js';

@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvalsService: ApprovalsService) {}

  @Get('pending')
  @Roles(...SUBMIT_EVENT_ROLES)
  findPending(@Query() query: PageQueryDto) {
    return this.approvalsService.findPage(query);
  }
}
