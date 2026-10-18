import LanguageDetector, { type CustomDetector } from 'i18next-browser-languagedetector';

export function createStorageSafeLanguageDetector() {
  const detector = new LanguageDetector(undefined, {
    order: ['querystring', 'safe-cookie', 'safe-localStorage', 'safe-sessionStorage', 'navigator', 'htmlTag'],
    caches: ['safe-localStorage'],
  });
  for (const name of ['cookie', 'localStorage', 'sessionStorage']) {
    const original = detector.detectors[name] as CustomDetector;
    detector.addDetector({
      name: `safe-${name}`,
      lookup(options) {
        try {
          return original.lookup(options);
        } catch {
          return undefined;
        }
      },
      cacheUserLanguage(language, options) {
        try {
          original.cacheUserLanguage?.(language, options);
        } catch {
          // Language selection remains usable without browser storage.
        }
      },
    });
  }
  return detector;
}
