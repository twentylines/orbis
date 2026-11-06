import { backupMaintenanceActive, coreCaptureRecoveryRequired } from '@/common/backup-maintenance';
import { installationMode } from '@/common/installation-mode';

type ConsumerProof = {
  queueGeneration: number;
  queues: { name: string; messages: 0; consumers: 1 }[];
  recheck: () => Promise<void>;
};

type CoreCaptureStartupOptions = {
  initializeRecovery: () => Promise<void>;
  initializeServices: () => Promise<void>;
  preparePresentation: () => Promise<void>;
  startConsumers: () => Promise<void>;
  verifyConsumers: () => Promise<ConsumerProof>;
  activateTimers: () => void | Promise<void>;
};

const queueNames = ['app-events-queue', 'repo-queue', 'system-events-queue'];

function assertHeld() {
  if (installationMode().phase !== 'normal' || coreCaptureRecoveryRequired() !== false || backupMaintenanceActive() !== true) {
    throw new Error('Core capture startup requires normal mode and the maintenance hold.');
  }
}

function validateProof(proof: ConsumerProof) {
  if (
    !proof ||
    typeof proof !== 'object' ||
    Object.keys(proof).sort().join(',') !== 'queueGeneration,queues,recheck' ||
    !Number.isSafeInteger(proof.queueGeneration) ||
    proof.queueGeneration <= 0 ||
    typeof proof.recheck !== 'function' ||
    !Array.isArray(proof.queues) ||
    proof.queues.length !== queueNames.length
  )
    throw new Error('Invalid core capture consumer proof.');
  const names = new Set<string>();
  for (const queue of proof.queues) {
    if (
      !queue ||
      typeof queue !== 'object' ||
      Object.keys(queue).sort().join(',') !== 'consumers,messages,name' ||
      !queueNames.includes(queue.name) ||
      names.has(queue.name) ||
      queue.messages !== 0 ||
      queue.consumers !== 1
    )
      throw new Error('Invalid core capture consumer proof.');
    names.add(queue.name);
  }
}

export class CoreCaptureStartup {
  private preparation?: Promise<void>;
  private activation?: Promise<void>;
  private proof?: ConsumerProof;
  private prepared = false;

  constructor(private readonly options: CoreCaptureStartupOptions) {}

  private async guarded(operation: () => void | Promise<void>) {
    assertHeld();
    await operation();
    assertHeld();
  }

  prepare(): Promise<void> {
    if (!this.preparation) this.preparation = Promise.resolve().then(() => this.prepareOnce());
    return this.preparation;
  }

  private async prepareOnce() {
    await this.guarded(this.options.initializeRecovery);
    await this.guarded(this.options.initializeServices);
    await this.guarded(this.options.preparePresentation);
    await this.guarded(this.options.startConsumers);
    let proof: ConsumerProof | undefined;
    await this.guarded(async () => {
      proof = await this.options.verifyConsumers();
    });
    validateProof(proof as ConsumerProof);
    const verified = proof as ConsumerProof;
    await this.guarded(() => verified.recheck());
    validateProof(verified);
    await this.guarded(() => verified.recheck());
    validateProof(verified);
    this.proof = verified;
    this.prepared = true;
  }

  activate(): Promise<void> {
    if (!this.activation) this.activation = Promise.resolve().then(() => this.activateOnce());
    return this.activation;
  }

  private async activateOnce() {
    assertHeld();
    if (!this.prepared || !this.proof) throw new Error('Core capture startup has not been prepared.');
    validateProof(this.proof);
    await this.guarded(() => this.proof?.recheck());
    validateProof(this.proof);
    await this.guarded(this.options.activateTimers);
    await this.guarded(() => this.proof?.recheck());
    validateProof(this.proof);
  }
}
