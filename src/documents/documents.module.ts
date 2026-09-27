import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';
import {
  createDocumentStorage,
  DOCUMENT_STORAGE,
} from './document-storage.js';

@Module({
  controllers: [DocumentsController],
  providers: [
    DocumentsService,
    {
      provide: DOCUMENT_STORAGE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createDocumentStorage({
          SUPABASE_URL: config.get<string>('SUPABASE_URL'),
          SUPABASE_SERVICE_ROLE_KEY: config.get<string>(
            'SUPABASE_SERVICE_ROLE_KEY',
          ),
          SUPABASE_STORAGE_BUCKET: config.get<string>(
            'SUPABASE_STORAGE_BUCKET',
          ),
        }),
    },
  ],
  exports: [DocumentsService],
})
export class DocumentsModule {}
