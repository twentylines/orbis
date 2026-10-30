import { useEffect, useRef, useState } from 'react';

export function usePreferenceNameDraft(serverName: string) {
  const [name, setName] = useState(serverName);
  const baseline = useRef(serverName);
  useEffect(() => {
    const previous = baseline.current;
    baseline.current = serverName;
    setName((draft) => (draft === previous ? serverName : draft));
  }, [serverName]);

  const acknowledge = (submitted: string, saved: string) => {
    setName((draft) => (draft === submitted ? saved : draft));
  };
  return { name, setName, acknowledge };
}
