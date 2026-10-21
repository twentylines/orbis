import { castAppUrn } from '@/common/helpers/app-helpers';
import { sanitizeFilename } from '@/common/helpers/file-helpers';
import { LoggerService } from '@/core/logger/logger.service';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiResponse } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AppLifecycleService } from '../app-lifecycle/app-lifecycle.service';
import { AuthGuard } from '../auth/auth.guard';
import { BackupsService } from './backups.service';
import { BackupUploadStorage, type BackupUploadFile } from './backup-upload.storage';
import { BackupRequestDto, DeleteAppBackupBodyDto, GetAppBackupsDto, GetAppBackupsQueryDto, RestoreAppBackupDto } from './dto/backups.dto';

@Injectable()
@UseGuards(AuthGuard)
@Controller('backups')
export class BackupsController {
  constructor(
    private readonly backupsService: BackupsService,
    private readonly appLifecycleService: AppLifecycleService,
    private readonly uploadStorage: BackupUploadStorage,
    private readonly logger: LoggerService,
  ) {}

  @Post(':urn/backup')
  @ApiResponse({ type: BackupRequestDto })
  async backupApp(@Param('urn') urn: string) {
    const res = await this.appLifecycleService.backupApp({ appUrn: castAppUrn(urn) });
    return BackupRequestDto.parse(res, { reportOnly: true });
  }

  @Post(':urn/restore')
  @ApiResponse({ type: BackupRequestDto })
  async restoreAppBackup(@Param('urn') urn: string, @Body() body: RestoreAppBackupDto) {
    const sanitizedFilename = sanitizeFilename(body.filename);

    if (sanitizedFilename !== body.filename || !sanitizedFilename.endsWith('.tar.gz')) {
      throw new BadRequestException('Invalid backup filename');
    }

    const res = await this.appLifecycleService.restoreApp({ appUrn: castAppUrn(urn), filename: sanitizedFilename });
    return BackupRequestDto.parse(res, { reportOnly: true });
  }

  @Get(':urn')
  @ApiResponse({ type: GetAppBackupsDto })
  async getAppBackups(@Param('urn') urn: string, @Query() query: GetAppBackupsQueryDto) {
    const backups = await this.backupsService.getAppBackups({ appUrn: castAppUrn(urn), page: query.page ?? 1, pageSize: query.pageSize ?? 10 });

    return GetAppBackupsDto.parse(backups, { reportOnly: true });
  }

  @Delete(':urn')
  async deleteAppBackup(@Param('urn') urn: string, @Body() body: DeleteAppBackupBodyDto) {
    const sanitizedFilename = sanitizeFilename(body.filename);

    if (sanitizedFilename !== body.filename || !sanitizedFilename.endsWith('.tar.gz')) {
      throw new BadRequestException('Invalid backup filename');
    }

    return this.backupsService.deleteAppBackup({ appUrn: castAppUrn(urn), filename: sanitizedFilename });
  }

  @Get(':urn/:filename/download')
  @ApiResponse({ status: 200, description: 'Backup file download' })
  async downloadBackup(@Param('urn') urn: string, @Param('filename') filename: string, @Res() res: Response) {
    const sanitizedFilename = sanitizeFilename(filename);

    if (sanitizedFilename !== filename || !sanitizedFilename.endsWith('.tar.gz')) {
      throw new BadRequestException('Invalid backup filename');
    }

    const filePath = await this.backupsService.getBackupFilePath({ appUrn: castAppUrn(urn), filename: sanitizedFilename });

    res.set({
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });

    return res.sendFile(filePath);
  }

  @Post(':urn/upload')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Backup uploaded successfully' })
  async uploadBackup(
    @Param('urn') urn: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @UploadedFile() file?: BackupUploadFile,
  ) {
    if (!file) {
      throw new BadRequestException('No backup file provided');
    }

    const aborted = new AbortController();
    let saved = false;
    let failure: unknown;
    const cancel = () => {
      if (!response.writableEnded) aborted.abort(new Error('The backup upload was cancelled'));
    };
    request.once('aborted', cancel);
    response.once('close', cancel);
    try {
      if (request.aborted) cancel();
      const sanitizedFilename = sanitizeFilename(file.originalname);

      if (sanitizedFilename !== file.originalname) throw new BadRequestException('Invalid backup filename');

      if (!sanitizedFilename.endsWith('.tar.gz')) throw new BadRequestException('File must be a .tar.gz backup file');

      await this.backupsService.uploadBackup({ appUrn: castAppUrn(urn), filename: sanitizedFilename, sourceFile: file.path, signal: aborted.signal });
      saved = true;
    } catch (error) {
      failure = error;
    } finally {
      request.removeListener('aborted', cancel);
      response.removeListener('close', cancel);
    }
    try {
      await this.uploadStorage.remove(file);
    } catch (error) {
      this.logger.warn(
        saved
          ? 'Backup saved; temporary upload cleanup will be retried on the next upload'
          : 'Temporary upload cleanup will be retried on the next upload',
        error,
      );
    }
    if (!saved) throw failure;
    return { success: true };
  }
}
