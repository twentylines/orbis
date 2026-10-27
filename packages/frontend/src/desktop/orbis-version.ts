export function formatOrbisVersion(version: string): string {
  const prerelease = /^v?(\d+\.\d+\.\d+)-(beta|rc)\.(\d+)(?:\+[\w.-]+)?$/i.exec(version);
  if (prerelease) return `${prerelease[1]} ${prerelease[2]?.toLowerCase()} ${prerelease[3]}`;
  return version.replace(/^v(?=\d+\.\d+\.\d+(?:$|[+-]))/, '');
}
