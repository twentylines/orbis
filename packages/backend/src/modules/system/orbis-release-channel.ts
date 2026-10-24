import { BadRequestException } from '@nestjs/common';

export function requireStableReleaseChannel(channel: unknown) {
  if (channel === undefined || channel === 'stable') return;
  throw new BadRequestException(
    channel === 'nightly' ? 'Nightly is inactive during beta. Use the Stable channel.' : 'Choose a valid Orbis release channel.',
  );
}
