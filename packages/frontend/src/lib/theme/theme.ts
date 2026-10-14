const THEMES = {
  christmas: {
    name: 'christmas',
    month: 11,
    day: 1,
    durationInDays: 26,
  },
};

type Theme = keyof typeof THEMES | 'default';

export const getAutoTheme = (): Theme => {
  const date = new Date();

  const theme = Object.entries(THEMES).find(([, { month, day, durationInDays }]) => {
    const startDate = new Date(date.getFullYear(), month, day);
    const endDate = new Date(date.getFullYear(), month, day + durationInDays);

    return startDate <= date && date <= endDate;
  });

  return theme ? (theme[0] as Theme) : 'default';
};

export const getLogo = (_autoTheme: boolean) => '/icons/orbis.svg';
