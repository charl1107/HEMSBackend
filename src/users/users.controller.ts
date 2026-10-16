import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator.js';
import { DIRECTORY_READ_ROLES } from '../events/events.constants.js';
import { UsersService } from './users.service.js';
import { AssignRoleDto, CreateUserDto, UpdateUserDto } from './dto/user.dto.js';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // Reads are open to directory readers so pickers can resolve system users
  // (F30, U12); every write route stays Admin-only.
  @Get()
  @Roles('Admin', ...DIRECTORY_READ_ROLES)
  findAll() {
    return this.usersService.findAll();
  }

  @Get(':id')
  @Roles('Admin', ...DIRECTORY_READ_ROLES)
  findOne(@Param('id') id: string) {
    return this.usersService.findOne(id);
  }

  @Post()
  @Roles('Admin')
  create(@Body() dto: CreateUserDto) {
    return this.usersService.create(dto);
  }

  @Patch(':id')
  @Roles('Admin')
  update(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.usersService.update(id, dto);
  }

  @Delete(':id')
  @Roles('Admin')
  remove(@Param('id') id: string) {
    return this.usersService.remove(id);
  }

  @Post(':id/roles')
  @Roles('Admin')
  assignRole(@Param('id') id: string, @Body() dto: AssignRoleDto) {
    return this.usersService.assignRole(id, dto);
  }

  @Delete(':id/roles/by-name/:roleName')
  @Roles('Admin')
  removeRoleByName(
    @Param('id') id: string,
    @Param('roleName') roleName: string,
  ) {
    return this.usersService.removeRoleByName(id, roleName);
  }

  @Delete(':id/roles/:roleId')
  @Roles('Admin')
  removeRole(
    @Param('id') id: string,
    @Param('roleId') roleId: string,
  ) {
    return this.usersService.removeRole(id, roleId);
  }
}
