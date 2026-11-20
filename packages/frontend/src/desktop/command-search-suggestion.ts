const calculations = ['24 × 7', '144 ÷ 12', '(50 + 20) × 3', '15% × 80'];
const currencies = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'SGD'];
const amounts = ['25', '50', '100', '250'];

type InstalledApp = { info: { available: boolean; name: string } };

function choose(values: readonly string[], random: () => number) {
  return values[Math.floor(random() * values.length)] ?? values[0] ?? '';
}

export function commandSearchSuggestion(
  installed: readonly InstalledApp[] | undefined,
  localCurrency: string | undefined,
  random = Math.random,
  settingLabels: readonly string[] = [],
) {
  const appNames = new Set<string>();
  for (const { info } of installed ?? []) {
    const name = info.name.trim();
    if (info.available && name) appNames.add(name);
  }
  const names = [...new Set(settingLabels.map((label) => label.trim()).filter(Boolean))];
  const category = Math.floor(random() * (2 + Number(appNames.size > 0) + Number(names.length > 0)));
  if (category === (appNames.size ? 3 : 2) && names.length) return choose(names, random);
  if (category === 2 && appNames.size) return choose([...appNames], random);
  if (category === 1) {
    const target = localCurrency ?? choose(currencies, random);
    const sources = currencies.filter((code) => code !== target);
    const source = choose(sources, random);
    return `${choose(amounts, random)} ${source} to ${target}`;
  }
  return choose(calculations, random);
}
