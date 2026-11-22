/**
 * UI language: English or Vietnamese. Every visible string is written as a pair next to where it
 * is used — `t('Save', 'Lưu')` — so there are no keys to keep in sync.
 *
 * - In components: `const t = useT()`. The function changes with the language, so the React
 *   Compiler re-renders the text when it switches (a plain `tr()` in JSX would stay cached).
 * - Elsewhere (actions, event handlers, alerts): `tr('…', '…')` reads the current language.
 */
import { useStore } from './store'
import type { Lang } from '../../shared/types'

export type T = (en: string, vi: string) => string

// the cached language, for CSS `:lang(vi)` rules from the first frame
document.documentElement.lang = useStore.getState().lang

const EN: T = (en) => en
const VI: T = (_en, vi) => vi

export const tr: T = (en, vi) => (useStore.getState().lang === 'vi' ? vi : en)

export function useT(): T {
  return useStore((s) => s.lang) === 'vi' ? VI : EN
}

/** Show the UI in `lang` and remember it (settings.json, read by the tray menu and pop-ups too). */
export async function setLang(lang: Lang): Promise<void> {
  useStore.setState({ lang })
  document.documentElement.lang = lang
  localStorage.setItem('vibe.lang', lang)
  const settings = await window.api.app.setSettings({ language: lang }).catch(() => null)
  if (settings) useStore.setState({ settings })
}

/** At boot: follow the saved language, or save the one guessed from the system on first run. */
export function syncLang(saved: Lang | ''): void {
  if (saved === 'en' || saved === 'vi') {
    if (saved !== useStore.getState().lang) useStore.setState({ lang: saved })
    localStorage.setItem('vibe.lang', saved)
    document.documentElement.lang = saved
  } else void setLang(useStore.getState().lang)
}
