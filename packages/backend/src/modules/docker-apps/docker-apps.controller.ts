import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { createArkDto } from 'nestjs-arktype';
import { type } from 'arktype';
import { AuthGuard } from '../auth/auth.guard';
import { DockerAppsService } from './docker-apps.service';

class UninstallDockerAppDto extends createArkDto(type({ reviewId: /^[a-f0-9]{64}$/, name: type('string').moreThanLength(0).lessThanLength(512) }), {
  name: 'UninstallDockerAppDto',
}) {}

@Controller('docker-apps')
@UseGuards(AuthGuard)
export class DockerAppsController {
  constructor(private readonly apps: DockerAppsService) {}

  @Get()
  list() {
    return this.apps.read();
  }

  @Get(':id/uninstall')
  review(@Param('id') id: string) {
    return this.apps.removalReview(id);
  }

  @Post(':id/uninstall')
  uninstall(@Param('id') id: string, @Body() body: UninstallDockerAppDto) {
    return this.apps.uninstall(id, body.reviewId, body.name);
  }
}
