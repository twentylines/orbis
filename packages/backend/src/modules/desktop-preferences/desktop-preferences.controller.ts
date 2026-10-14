import { AuthGuard } from '@/modules/auth/auth.guard';
import { Body, Controller, Get, Put, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import type { Request } from 'express';
import { DesktopPreferencesDto } from './desktop-preferences.dto';
import { DesktopPreferencesService } from './desktop-preferences.service';

@Controller('desktop-preferences')
@UseGuards(AuthGuard)
export class DesktopPreferencesController {
  constructor(private readonly preferences: DesktopPreferencesService) {}

  @Get()
  @ApiResponse({ type: DesktopPreferencesDto })
  get(@Req() request: Request) {
    if (!request.user?.id) throw new UnauthorizedException();
    return this.preferences.read(request.user.id);
  }

  @Put()
  @ApiResponse({ type: DesktopPreferencesDto })
  put(@Req() request: Request, @Body() body: DesktopPreferencesDto) {
    if (!request.user?.id) throw new UnauthorizedException();
    return this.preferences.write(request.user.id, body);
  }
}
