import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Request } from 'express';
import type { Response } from 'express';
import type { AuthUser } from '../common/auth-user.js';
import { DocumentsService } from './documents.service.js';
import { UploadDocumentDto } from './dto/document.dto.js';
import {
  contentDisposition,
  DOC_MAX_BYTES,
  type DocumentUploadFile,
} from './document-file.js';

// The global JwtAuthGuard (app.module APP_GUARD) runs before any handler on
// this non-@Public controller, so req.user is always set here (401 otherwise).
type RequestWithUser = Request & { user: AuthUser };

@Controller('events/:eventId/documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Get()
  findMany(@Param('eventId') eventId: string, @Req() req: RequestWithUser) {
    return this.documentsService.findMany(eventId, req.user);
  }

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: DOC_MAX_BYTES },
    }),
  )
  upload(
    @Param('eventId') eventId: string,
    @Body() dto: UploadDocumentDto,
    @Req() req: RequestWithUser,
    @UploadedFile() file?: DocumentUploadFile,
  ) {
    return this.documentsService.upload(eventId, req.user, dto.docType, file);
  }

  @Get(':id/download')
  async download(
    @Param('eventId') eventId: string,
    @Param('id') id: string,
    @Req() req: RequestWithUser,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.documentsService.download(
      eventId,
      id,
      req.user,
    );
    if (result.kind === 'redirect') {
      res.redirect(result.url);
      return;
    }
    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Content-Length', result.buffer.length);
    res.setHeader('Content-Disposition', contentDisposition(result.filename));
    res.end(result.buffer);
  }

  @Delete(':id')
  remove(
    @Param('eventId') eventId: string,
    @Param('id') id: string,
    @Req() req: RequestWithUser,
  ) {
    return this.documentsService.remove(eventId, id, req.user);
  }
}
