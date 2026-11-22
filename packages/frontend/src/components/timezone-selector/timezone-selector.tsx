import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { useTranslation } from 'react-i18next';
import { allTimezones, useTimezoneSelect } from 'react-timezone-select';

type IProps = {
  timeZone?: string;
  onChange: (timeZone: string) => void;
};

export const TimeZoneSelector = (props: IProps) => {
  const { onChange, timeZone } = props;
  const { options, parseTimezone } = useTimezoneSelect({ labelStyle: 'abbrev', timezones: allTimezones });
  const { t } = useTranslation();

  const onTimezoneChange = (e: string) => {
    if (!e) return;
    onChange(e);
  };

  const selected = parseTimezone(timeZone || 'Etc/GMT') || parseTimezone('Etc/GMT') || { value: 'Etc/GMT', label: 'GMT' };
  const displayedOptions = options.some((option) => option.value === selected.value) ? options : [selected, ...options];

  return (
    <Select value={selected.value} onValueChange={onTimezoneChange}>
      <SelectTrigger className="mb-3" name="timezone" label={t('TIMEZONE_SELECTOR_LABEL')}>
        <SelectValue placeholder={t('TIMEZONE_SELECTOR_PLACEHOLDER')} />
      </SelectTrigger>
      <SelectContent className="select-content">
        {displayedOptions.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
