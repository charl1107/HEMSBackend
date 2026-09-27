import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Roles } from '../common/decorators/roles.decorator.js';
import { contentDisposition } from '../documents/document-file.js';
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

  @Get('events/:eventId/summary')
  getEventReport(@Param('eventId') eventId: string) {
    return this.reportsService.getEventReport(eventId);
  }

  @Get('events/:eventId/attendance.csv')
  async exportAttendanceCsv(
    @Param('eventId') eventId: string,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.reportsService.exportAttendanceCsv(eventId);
    this.send(res, file);
  }

  @Get('events/:eventId/participants.csv')
  async exportParticipantsCsv(
    @Param('eventId') eventId: string,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.reportsService.exportParticipantsCsv(eventId);
    this.send(res, file);
  }

  @Get('events/:eventId/report.pdf')
  async exportEventPdf(
    @Param('eventId') eventId: string,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.reportsService.exportEventPdf(eventId);
    this.send(res, file);
  }

  private send(
    res: Response,
    file: { buffer: Buffer; filename: string; mimeType: string },
  ): void {
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Length', file.buffer.length);
    res.setHeader('Content-Disposition', contentDisposition(file.filename));
    res.end(file.buffer);
  }
}
