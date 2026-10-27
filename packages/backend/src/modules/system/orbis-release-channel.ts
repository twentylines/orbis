import { BadRequestException } from '@nestjs/common';

export function requireReleaseChannel(channel: unknown): 'stable' | 'nightly' | undefined {
  if (channel === undefined || channel === 'stable' || channel === 'nightly') return channel;
  throw new BadRequestException('Choose a valid Orbis release channel.');
}
