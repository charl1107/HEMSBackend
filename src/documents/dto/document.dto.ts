import { IsIn } from 'class-validator';
import { DOC_TYPES } from '../document-file.js';

export class UploadDocumentDto {
  @IsIn([...DOC_TYPES])
  docType!: string;
}
