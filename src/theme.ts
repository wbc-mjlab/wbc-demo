/**
 * Light / dark theme for the demo site.
 * Persists to localStorage; default is dark (current brand look).
 */

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'wbc-demo-theme';
export const THEME_EVENT = 'wbc-demo-theme';

export function getTheme(): Theme {
  const attr = document.documentElement.dataset.theme;
  if (attr === 'light' || attr === 'dark') return attr;
  return 'dark';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* private mode */
  }
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: theme }));
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  return next;
}

/** Read stored theme (or default dark) and apply before UI paints. */
export function initTheme(): Theme {
  let theme: Theme = 'dark';
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') theme = stored;
  } catch {
    /* ignore */
  }
  applyTheme(theme);
  return theme;
}

/** Small toggle control; call `syncThemeButton` after theme changes. */
export function themeToggleHtml(id = 'theme-toggle'): string {
  return `<button type="button" class="theme-toggle" id="${id}" title="Toggle light / dark mode" aria-label="Toggle light / dark mode">☀</button>`;
}

export function syncThemeButton(btn: HTMLElement | null): void {
  if (!btn) return;
  const dark = getTheme() === 'dark';
  btn.textContent = dark ? '☀' : '☾';
  btn.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
  btn.setAttribute('aria-label', btn.title);
}

export function wireThemeToggle(btn: HTMLElement | null): void {
  if (!btn) return;
  syncThemeButton(btn);
  btn.addEventListener('click', () => {
    toggleTheme();
    syncThemeButton(btn);
  });
  window.addEventListener(THEME_EVENT, () => syncThemeButton(btn));
}
