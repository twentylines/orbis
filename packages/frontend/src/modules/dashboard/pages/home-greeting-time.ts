export function greetingForHour(hour: number): string {
  if (hour < 5 || hour >= 18) return 'Good evening';
  return hour < 12 ? 'Good morning' : 'Good afternoon';
}
