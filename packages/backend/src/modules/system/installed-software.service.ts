import { Inject, Injectable } from '@nestjs/common';
import type Dockerode from 'dockerode';
import { DOCKERODE } from '../docker/docker.module';

type InstalledSoftware = { osName: string | null; osVersion: string | null; dockerVersion: string | null };
const unavailable: InstalledSoftware = { osName: null, osVersion: null, dockerVersion: null };

function reportedText(value: unknown) {
  if (typeof value !== 'string' || value.length > 160 || Array.from(value).some((character) => character.charCodeAt(0) < 32)) return null;
  return value.trim() || null;
}

@Injectable()
export class InstalledSoftwareService {
  private cache?: { value: InstalledSoftware; expires: number };
  private pending?: Promise<InstalledSoftware>;

  constructor(@Inject(DOCKERODE) private readonly docker: Dockerode) {}

  async read(): Promise<InstalledSoftware> {
    if (this.cache && this.cache.expires > Date.now()) return this.cache.value;
    this.pending ??= this.readEngine()
      .then((value) => {
        const ttl = value.osName || value.osVersion || value.dockerVersion ? 30_000 : 5_000;
        this.cache = { value, expires: Date.now() + ttl };
        return value;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  private async readEngine(): Promise<InstalledSoftware> {
    try {
      // Dockerode forwards these options, but its info type only declares zero arguments.
      const readInfo = this.docker.info.bind(this.docker) as (options: { abortSignal: AbortSignal }) => Promise<unknown>;
      const value = await readInfo({ abortSignal: AbortSignal.timeout(3000) });
      if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable;
      const info = value as Record<string, unknown>;
      return {
        osName: reportedText(info.OperatingSystem),
        osVersion: reportedText(info.OSVersion),
        dockerVersion: reportedText(info.ServerVersion),
      };
    } catch {
      return unavailable;
    }
  }
}
