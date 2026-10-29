import { AuthGuard } from '@/modules/auth/auth.guard';
import { Body, Controller, Delete, Get, Param, Post, Put, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { createArkDto } from 'nestjs-arktype';
import { type } from 'arktype';
import { themePackIdSchema, themePackVersionSchema, themePackReferenceSchema } from '@runtipi/common/schemas/theme-pack';
import type { Request, Response } from 'express';
import { ThemePacksService } from './theme-packs.service';

const installSchema = type({ id: themePackIdSchema, 'version?': themePackVersionSchema }).onUndeclaredKey('reject');
export class InstallThemeDto extends createArkDto(installSchema, { name: 'InstallThemeDto', input: true }) {}
export class SelectThemeDto extends createArkDto(type({ selected: themePackReferenceSchema.or('null') }).onUndeclaredKey('reject'), {
  name: 'SelectThemeDto',
  input: true,
}) {}

@Controller('theme-packs')
@UseGuards(AuthGuard)
export class ThemePacksController {
  constructor(private readonly themes: ThemePacksService) {}
  private account(request: Request) {
    if (!request.user?.id) throw new UnauthorizedException();
    return request.user.id;
  }
  @Get()
  snapshot(@Req() request: Request) {
    return this.themes.snapshot(this.account(request));
  }
  @Post('install')
  install(@Req() request: Request, @Body() body: InstallThemeDto) {
    return this.themes.install(this.account(request), body.id, body.version);
  }
  @Put('selection')
  select(@Req() request: Request, @Body() body: SelectThemeDto) {
    return this.themes.select(this.account(request), body.selected);
  }
  @Post(':id/update')
  update(@Req() request: Request, @Param('id') id: string) {
    return this.themes.install(this.account(request), id, undefined, true);
  }
  @Post(':id/rollback')
  rollback(@Req() request: Request, @Param('id') id: string) {
    return this.themes.rollback(this.account(request), id);
  }
  @Delete(':id')
  remove(@Req() request: Request, @Param('id') id: string) {
    return this.themes.remove(this.account(request), id);
  }
  @Get(':id/:version/assets/:hash')
  async asset(
    @Req() request: Request,
    @Res() response: Response,
    @Param('id') id: string,
    @Param('version') version: string,
    @Param('hash') hash: string,
  ) {
    const result = await this.themes.asset(this.account(request), id, version, hash);
    response.set({
      'Content-Type': result.mime,
      'Content-Length': String(result.data.length),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      ETag: `"${hash}"`,
    });
    response.send(result.data);
  }
}
