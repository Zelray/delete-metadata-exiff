import { useEffect } from 'react';
import { useUiStore } from '../state/store';

/** Apply the persisted theme choice (dark | light | system) to <html>. */
export function ThemeApplier() {
  const theme = useUiStore((s) => s.theme);

  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const effective =
        theme === 'system'
          ? window.matchMedia('(prefers-color-scheme: light)').matches
            ? 'light'
            : 'dark'
          : theme;
      root.classList.toggle('dark', effective === 'dark');
      root.classList.toggle('light', effective === 'light');
    };
    apply();
    if (theme === 'system') {
      const media = window.matchMedia('(prefers-color-scheme: light)');
      media.addEventListener('change', apply);
      return () => media.removeEventListener('change', apply);
    }
  }, [theme]);

  return null;
}
