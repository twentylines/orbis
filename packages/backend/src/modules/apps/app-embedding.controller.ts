import { castAppUrn } from '@/common/helpers/app-helpers';
import { BadRequestException, Controller, Get, Header, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { AppEmbeddingService, embeddingUrl } from './app-embedding.service';

@Controller('apps')
export class AppEmbeddingController {
  constructor(private readonly embedding: AppEmbeddingService) {}

  @Get(':urn/embedding-compatibility')
  @UseGuards(AuthGuard)
  @Header('Cache-Control', 'private, no-store')
  async check(@Param('urn') urn: string, @Query() query: Record<string, unknown>) {
    if (Object.keys(query).length !== 2 || !Object.hasOwn(query, 'destination') || !Object.hasOwn(query, 'parentOrigin'))
      throw new BadRequestException('Provide one destination and parentOrigin.');
    const target = embeddingUrl(query.destination);
    const parent = embeddingUrl(query.parentOrigin, true);
    if (!target || !parent) throw new BadRequestException('Use complete HTTP or HTTPS addresses without credentials.');
    let appUrn: ReturnType<typeof castAppUrn>;
    try {
      appUrn = castAppUrn(urn);
    } catch {
      throw new BadRequestException('Use a local installed app identifier.');
    }
    return this.embedding.check(appUrn, target, parent);
  }
}
