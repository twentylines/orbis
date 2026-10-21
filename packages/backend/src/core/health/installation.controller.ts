import { installationMode } from '@/common/installation-mode';
import { Controller, Get, Header } from '@nestjs/common';

@Controller('installation')
export class InstallationController {
  @Get('status')
  @Header('Cache-Control', 'no-store')
  status() {
    const mode = installationMode();
    return {
      schema: 'orbis.installation-state.v1',
      phase: mode.phase,
      transactionId: mode.transactionId,
      applicationsHeld: mode.phase === 'hold',
      requiresRecreateToRelease: mode.phase === 'hold',
    };
  }
}
