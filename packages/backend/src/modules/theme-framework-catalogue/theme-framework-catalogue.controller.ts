import { Controller, ForbiddenException, Get, Header, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { ThemeFrameworkCatalogueService } from './theme-framework-catalogue.service';

@Controller('theme-framework')
@UseGuards(AuthGuard)
export class ThemeFrameworkCatalogueController {
  constructor(private readonly catalogue: ThemeFrameworkCatalogueService) {}

  @Get('catalogue')
  @Header('Cache-Control', 'private, no-store')
  read(@Req() request: Request) {
    if (request.authMethod !== 'session' || request.user?.operator !== true) throw new ForbiddenException('An operator session is required.');
    return this.catalogue.read();
  }
}
