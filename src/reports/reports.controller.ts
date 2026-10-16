import { Controller, Get } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator.js';
import { ReportsService } from './reports.service.js';
import { REPORT_ROLES } from './reports.constants.js';

@Controller('reports')
@Roles(...REPORT_ROLES)
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('summary')
  getSummary() {
    return this.reportsService.getSummary();
  }
}
