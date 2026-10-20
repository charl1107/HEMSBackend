import { SetMetadata } from '@nestjs/common';
import { ROLES_KEY } from '../constants/metadata-keys.js';

export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
