import { Module } from '@nestjs/common';
import {
  AttendanceController,
  EventAttendanceController,
} from './attendance.controller.js';
import { AttendanceService } from './attendance.service.js';

@Module({
  controllers: [AttendanceController, EventAttendanceController],
  providers: [AttendanceService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
