import { createHash } from 'node:crypto';
import { valid } from 'semver';
import { decodeControllerCaptureAuthority, type ControllerCaptureAuthorityReceipt } from '../host-updates/host-controller-capture-authority';
import { verifyCapturedControllerPublication, type CapturedRuntimeInput } from './time-machine-runtime-payload';

export function versionMatchesControllerAuthority(version: string, authority: ControllerCaptureAuthorityReceipt | null | undefined): boolean {
  const publication = authority?.metadata.publication;
  if (!valid(version) || !publication || typeof publication !== 'object' || Array.isArray(publication) || !('tag' in publication)) return false;
  return typeof publication.tag === 'string' && valid(publication.tag) !== null && version === publication.tag;
}

export function captureHasControllerVersion(version: string, runtime: CapturedRuntimeInput): boolean {
  if (!runtime.coherence || !runtime.controllerAuthority || !versionMatchesControllerAuthority(version, runtime.controllerAuthority)) return false;
  try {
    const proof = verifyCapturedControllerPublication(runtime);
    const image = runtime.images.capture.inventory.images.find((item) => item.imageId === runtime.configuration.metadata.controller.imageId);
    if (!image) return false;
    const authority = decodeControllerCaptureAuthority(
      JSON.parse(runtime.controllerAuthority.read().toString('utf8')),
      runtime.publicationExpectation,
      proof,
      image,
    );
    return createHash('sha256').update(authority.read()).digest('hex') === runtime.coherence.controllerAuthoritySha256;
  } catch {
    return false;
  }
}
