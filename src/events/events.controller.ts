import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Request } from 'express';
import { Roles } from '../common/decorators/roles.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import { EventsService } from './events.service.js';
import { ApprovalsService } from '../approvals/approvals.service.js';
import {
  ApproveEventDto,
  RejectEventDto,
  RequestRevisionDto,
  SubmitForApprovalDto,
} from '../approvals/dto/approval.dto.js';
import {
  AdvanceEventDto,
  CreateEventDto,
  EventListQueryDto,
  UpdateEventDto,
} from './dto/event.dto.js';
import {
  REVIEW_EVENT_ROLES,
  SUBMIT_EVENT_ROLES,
} from './events.constants.js';
import { COVER_MAX_BYTES, type CoverUploadFile } from './cover-file.js';

type RequestWithUser = Request & { user?: AuthUser };

@Controller('events')
export class EventsController {
  constructor(
    private readonly eventsService: EventsService,
    private readonly approvalsService: ApprovalsService,
  ) {}

  @Get()
  findAll(@Query() query: EventListQueryDto, @Req() req: RequestWithUser) {
    if (!req.user) {
      throw new ForbiddenException('Authentication required');
    }
    return this.eventsService.findPage(query, req.user);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: RequestWithUser) {
    if (!req.user) {
      throw new ForbiddenException('Authentication required');
    }
    return this.eventsService.findOneVisible(id, req.user);
  }

  @Post()
  @Roles(...SUBMIT_EVENT_ROLES)
  create(@Body() dto: CreateEventDto, @Req() req: RequestWithUser) {
    return this.eventsService.create(dto, req.user?.userId);
  }

  @Put(':id')
  @Roles(...SUBMIT_EVENT_ROLES)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateEventDto,
    @Req() req: RequestWithUser,
  ) {
    return this.eventsService.update(id, dto, req.user);
  }

  @Delete(':id')
  @Roles(...SUBMIT_EVENT_ROLES)
  remove(@Param('id') id: string, @Req() req: RequestWithUser) {
    return this.eventsService.remove(id, req.user);
  }

  @Post(':id/cover')
  @Roles(...SUBMIT_EVENT_ROLES)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: COVER_MAX_BYTES },
    }),
  )
  uploadCover(
    @Param('id') id: string,
    @UploadedFile() file: CoverUploadFile | undefined,
    @Req() req: RequestWithUser,
  ) {
    return this.eventsService.setCover(id, file, req.user);
  }

  @Delete(':id/cover')
  @Roles(...SUBMIT_EVENT_ROLES)
  removeCover(@Param('id') id: string, @Req() req: RequestWithUser) {
    return this.eventsService.removeCover(id, req.user);
  }

  /** Lifecycle advance along EVENT_TRANSITIONS (F17): ongoing, completed,
   *  cancel and resume. Authorization lives in the service: the event
   *  owner, Admin or Department Head. */
  @Post(':id/advance')
  @HttpCode(200)
  advance(
    @Param('id') id: string,
    @Body() dto: AdvanceEventDto,
    @Req() req: RequestWithUser,
  ) {
    if (!req.user) {
      throw new ForbiddenException('Authentication required');
    }
    return this.eventsService.advance(id, dto.to, req.user);
  }

  @Post(':id/submit')
  submit(
    @Param('id') id: string,
    @Body() dto: SubmitForApprovalDto,
    @Req() req: RequestWithUser,
  ) {
    if (!req.user) {
      throw new ForbiddenException('Authentication required');
    }
    return this.approvalsService.submit(id, req.user, dto);
  }

  @Post(':id/approve')
  @Roles(...REVIEW_EVENT_ROLES)
  approve(
    @Param('id') id: string,
    @Body() dto: ApproveEventDto,
    @Req() req: RequestWithUser,
  ) {
    if (!req.user) {
      throw new ForbiddenException('Authentication required');
    }
    return this.approvalsService.approve(id, req.user, dto);
  }

  @Post(':id/reject')
  @Roles(...REVIEW_EVENT_ROLES)
  reject(
    @Param('id') id: string,
    @Body() dto: RejectEventDto,
    @Req() req: RequestWithUser,
  ) {
    if (!req.user) {
      throw new ForbiddenException('Authentication required');
    }
    return this.approvalsService.reject(id, req.user, dto);
  }

  @Post(':id/request-revision')
  @Roles(...REVIEW_EVENT_ROLES)
  requestRevision(
    @Param('id') id: string,
    @Body() dto: RequestRevisionDto,
    @Req() req: RequestWithUser,
  ) {
    if (!req.user) {
      throw new ForbiddenException('Authentication required');
    }
    return this.approvalsService.requestRevision(id, req.user, dto);
  }

  @Get(':id/approval-history')
  async approvalHistory(@Param('id') id: string, @Req() req: RequestWithUser) {
    if (!req.user) {
      throw new ForbiddenException('Authentication required');
    }
    await this.eventsService.findOneVisible(id, req.user);
    return this.approvalsService.findApprovalHistory(id);
  }
}
