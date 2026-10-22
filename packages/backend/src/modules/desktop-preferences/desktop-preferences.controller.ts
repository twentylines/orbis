import { AuthGuard } from '@/modules/auth/auth.guard';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Put,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiResponse } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { DesktopPreferencesDto } from './desktop-preferences.dto';
import { DesktopPreferencesService } from './desktop-preferences.service';
import { DesktopWallpaperService, WALLPAPER_LIMIT } from './desktop-wallpaper.service';

@Controller('desktop-preferences')
@UseGuards(AuthGuard)
export class DesktopPreferencesController {
  constructor(
    private readonly preferences: DesktopPreferencesService,
    private readonly wallpapers: DesktopWallpaperService,
  ) {}

  @Get('wallpaper/info')
  wallpaperInfo(@Req() request: Request) {
    if (!request.user?.id) throw new UnauthorizedException();
    return this.wallpapers.info(request.user.id);
  }

  @Get('wallpaper')
  async wallpaper(@Req() request: Request, @Res() response: Response, @Query('version') version?: string) {
    if (!request.user?.id) throw new UnauthorizedException();
    const { data, hash, mime } = await this.wallpapers.read(request.user.id, version);
    response.set({
      'Content-Type': mime,
      'Content-Length': String(data.length),
      'Content-Disposition': 'inline; filename="wallpaper"',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      ETag: `"${hash}"`,
    });
    response.send(data);
  }

  @Post('wallpaper')
  @UseInterceptors(FileInterceptor('image', { limits: { fileSize: WALLPAPER_LIMIT, files: 1, fields: 0, parts: 2 } }))
  uploadWallpaper(@Req() request: Request, @UploadedFile() file?: { buffer: Buffer }) {
    if (!request.user?.id) throw new UnauthorizedException();
    if (!file?.buffer) throw new BadRequestException('Choose a PNG, JPEG or WebP image.');
    return this.wallpapers.upload(request.user.id, file.buffer);
  }

  @Delete('wallpaper')
  deleteWallpaper(@Req() request: Request) {
    if (!request.user?.id) throw new UnauthorizedException();
    return this.wallpapers.remove(request.user.id);
  }

  @Get('onboarding')
  @ApiResponse({ schema: { type: 'object', properties: { complete: { type: 'boolean' } }, required: ['complete'] } })
  onboarding(@Req() request: Request) {
    if (!request.user?.id) throw new UnauthorizedException();
    return this.preferences.onboarding(request.user.id);
  }

  @Post('onboarding')
  @ApiResponse({ status: 201, schema: { type: 'object', properties: { complete: { type: 'boolean' } }, required: ['complete'] } })
  completeOnboarding(@Req() request: Request) {
    if (!request.user?.id) throw new UnauthorizedException();
    return this.preferences.completeOnboarding(request.user.id);
  }

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
