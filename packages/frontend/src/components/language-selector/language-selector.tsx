import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { type Locale, locales } from '@/lib/i18n/locales';
import { IconExternalLink } from '@tabler/icons-react';
import i18next from 'i18next';
import React from 'react';
import { useTranslation } from 'react-i18next';

type IProps = {
  showLabel?: boolean;
  locale: Locale;
  className?: string;
};

const supportedLocale = (value: string): Locale => {
  const normalized = value.replaceAll('_', '-').toLowerCase();
  const keys = Object.keys(locales) as Locale[];
  return keys.find((key) => key.toLowerCase() === normalized) ?? keys.find((key) => key.split('-')[0] === normalized.split('-')[0]) ?? 'en-US';
};

const LanguageSelectorLabel = () => {
  const { t } = useTranslation();

  return (
    <span>
      {t('SETTINGS_GENERAL_LANGUAGE')}&nbsp;
      <a href="https://crowdin.com/project/runtipi" target="_blank" rel="noreferrer">
        {t('SETTINGS_GENERAL_LANGUAGE_HELP_TRANSLATE')}
        <IconExternalLink className="ms-1 mb-1" size={16} />
      </a>
    </span>
  );
};

export const LanguageSelector = (props: IProps) => {
  const { locale: initialLocale } = props;
  const [locale, setLocale] = React.useState<Locale>(() => supportedLocale(initialLocale));
  React.useEffect(() => setLocale(supportedLocale(initialLocale)), [initialLocale]);
  const { showLabel = false, className = 'mb-3' } = props;

  const onChange = (newLocale: Locale) => {
    i18next.changeLanguage(newLocale);
    setLocale(newLocale);
  };

  return (
    <Select value={locale} defaultValue="en-US" onValueChange={onChange}>
      <SelectTrigger className={className} name="language" label={showLabel && <LanguageSelectorLabel />}>
        <SelectValue placeholder="Language" />
      </SelectTrigger>
      <SelectContent>
        {Object.keys(locales).map((key) => (
          <SelectItem key={key} value={key}>
            {locales[key as Locale]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
