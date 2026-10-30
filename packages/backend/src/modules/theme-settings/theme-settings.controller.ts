import { AuthGuard } from '@/modules/auth/auth.guard';
import { Body, Controller, ForbiddenException, Get, HttpCode, Post, Put, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ThemeSettingsService } from './theme-settings.service';

@Controller('theme-settings')
@UseGuards(AuthGuard)
export class ThemeSettingsController {
  constructor(private readonly settings: ThemeSettingsService) {}
  private account(request: Request, response: Response) {
    if (!request.user?.id) throw new UnauthorizedException();
    if (request.authMethod !== 'session') throw new ForbiddenException('Use your signed-in browser to customise your interface.');
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return request.user.id;
  }
  @Get()
  snapshot(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    return this.settings.snapshot(this.account(request, response));
  }
  @Put()
  update(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Body() body: unknown) {
    return this.settings.update(this.account(request, response), body);
  }
  @Post('migrate')
  @HttpCode(200)
  migrate(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Body() body: unknown) {
    return this.settings.migrate(this.account(request, response), body);
  }
}
