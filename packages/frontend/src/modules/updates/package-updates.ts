export type PackageCandidate = { name: string; installedVersion: string; candidateVersion: string; ready?: boolean };
export const packageUpdateLimit = 250;
const identifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type PackagePlan = {
  planId: string;
  createdAt: number;
  expiresAt: number;
  selected: PackageCandidate[];
  operations: Array<{ name: string; candidateVersion: string; action: 'install' | 'upgrade' }>;
};
export type StartedPackageUpdate = { jobId: string; state: 'queued' | 'running' };
export type PackageUpdateRequest = <T>(path: string, body: object) => Promise<T>;

export function selectedPackageNames(available: readonly PackageCandidate[], chosen: readonly string[] | null) {
  const names = new Set(available.filter((item) => item.ready === true).map((item) => item.name));
  return chosen === null
    ? [...names].slice(0, packageUpdateLimit)
    : [...new Set(chosen)].filter((name) => names.has(name)).slice(0, packageUpdateLimit);
}

export function packageRestartRequired(
  inventory: { available: boolean; rebootRequired?: boolean } | undefined,
  restart: { available: boolean; rebootRequired?: boolean } | undefined,
) {
  return inventory?.available === true && inventory.rebootRequired === true && restart?.available === true && restart.rebootRequired === true;
}

export async function startPackageUpdate(
  selected: readonly PackageCandidate[],
  request: PackageUpdateRequest,
  stage: (value: 'checking' | 'starting') => void = () => undefined,
  now: () => number = Date.now,
): Promise<StartedPackageUpdate> {
  const wanted = new Map(selected.map((item) => [item.name, { ...item }]));
  if (!wanted.size || wanted.size > packageUpdateLimit || wanted.size !== selected.length)
    throw new Error('Choose between 1 and 250 distinct package updates.');
  stage('checking');
  const plan = await request<PackagePlan>('packages/plan', { names: [...wanted.keys()] });
  if (
    !plan ||
    !identifier.test(plan.planId) ||
    !Number.isFinite(plan.createdAt) ||
    plan.createdAt <= 0 ||
    !Number.isFinite(plan.expiresAt) ||
    plan.expiresAt <= plan.createdAt ||
    plan.expiresAt - plan.createdAt > 900 ||
    plan.expiresAt * 1000 <= now() ||
    !Array.isArray(plan.selected) ||
    plan.selected.length !== wanted.size ||
    new Set(plan.selected.map((item) => item?.name)).size !== wanted.size ||
    !plan.selected.every((item) => {
      const expected = wanted.get(item?.name);
      return expected && item.installedVersion === expected.installedVersion && item.candidateVersion === expected.candidateVersion;
    }) ||
    !Array.isArray(plan.operations) ||
    !plan.operations.length ||
    !plan.operations.every(
      (item) => item && typeof item.name === 'string' && typeof item.candidateVersion === 'string' && ['install', 'upgrade'].includes(item.action),
    ) ||
    !plan.selected.every((item) =>
      plan.operations.some(
        (operation) => operation.name === item.name && operation.action === 'upgrade' && operation.candidateVersion === item.candidateVersion,
      ),
    )
  )
    throw new Error('The package candidates changed or could not be verified. Check for updates before trying again.');
  stage('starting');
  const accepted = await request<StartedPackageUpdate>('packages/apply', { planId: plan.planId });
  if (!accepted || !identifier.test(accepted.jobId) || accepted.jobId !== plan.planId || !['queued', 'running'].includes(accepted.state))
    throw new Error('The update start was not confirmed. Check package progress before trying again.');
  return accepted;
}
