import { AuthGuard } from '@/modules/auth/auth.guard';
import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { HostUpdatesGuard } from './host-updates.guard';
import { AutomaticUpdatesService } from './automatic-updates.service';

@UseGuards(AuthGuard, HostUpdatesGuard)
@Controller('host-updates/automatic')
export class AutomaticUpdatesController {
  constructor(private readonly automatic: AutomaticUpdatesService) {}
  @Get() read() {
    return this.automatic.read();
  }
  @Put() update(@Body() body: unknown) {
    return this.automatic.update(body);
  }
  @Get('system') readSystem() {
    return this.automatic.readSystem();
  }
  @Put('system') updateSystem(@Body() body: unknown) {
    return this.automatic.updateSystem(body);
  }
  @Get('apps/:urn') readApp(@Param('urn') urn: string) {
    return this.automatic.readApp(urn);
  }
  @Put('apps/:urn') updateApp(@Param('urn') urn: string, @Body() body: unknown) {
    return this.automatic.updateApp(urn, body);
  }
}
