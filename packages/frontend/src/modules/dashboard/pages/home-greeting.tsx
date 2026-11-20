import { useWallpaperText } from '@/desktop/wallpaper-text';
import { useEffect, useState, type Ref } from 'react';

const minute = 60_000;
const dateFormat: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric' };

export function HomeGreeting({ headingRef, focusable }: { headingRef: Ref<HTMLHeadingElement>; focusable: boolean }) {
  const [date, setDate] = useState(() => new Date());
  const dateText = useWallpaperText<HTMLParagraphElement>();

  useEffect(() => {
    let timer: number;
    const refresh = () => {
      window.clearTimeout(timer);
      setDate(new Date());
      schedule();
    };
    const schedule = () => {
      timer = window.setTimeout(refresh, minute - (Date.now() % minute));
    };
    schedule();
    document.addEventListener('visibilitychange', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.clearTimeout(timer);
    };
  }, []);

  const hour = date.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const machineDate = [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((value) => String(value).padStart(2, '0')).join('-');

  return (
    <div className="workspace-heading-copy workspace-greeting">
      <h1 ref={headingRef} tabIndex={focusable ? -1 : undefined}>
        {greeting}
      </h1>
      <p className="workspace-subline" ref={dateText}>
        <time dateTime={machineDate}>{date.toLocaleDateString(undefined, dateFormat)}</time>
      </p>
    </div>
  );
}
