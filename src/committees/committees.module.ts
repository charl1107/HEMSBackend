import { Module } from '@nestjs/common';
import { CommitteesController } from './committees.controller.js';
import { CommitteesService } from './committees.service.js';

@Module({
  controllers: [CommitteesController],
  providers: [CommitteesService],
  exports: [CommitteesService],
})
export class CommitteesModule {}
