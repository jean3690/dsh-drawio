/**
 * 画板 surface copy lookup (mirrors the toolbox i18n helper).
 *
 * @module dsh-drawio/client/i18n
 */

import { ZH, EN } from './locales.ts'

export type DrawioLang = 'zh' | 'en'

export type DrawioKey = keyof typeof ZH

const DICTS: Record<DrawioLang, Record<DrawioKey, string>> = { zh: ZH, en: EN }

/** The current UI language (document lang or zh fallback). */
export function currentLang(): DrawioLang {
  return (typeof document !== 'undefined' && document.documentElement.lang === 'en') ? 'en' : 'zh'
}

/** Look up one copy string, substituting {placeholders}. */
export function lookup(lang: DrawioLang, key: DrawioKey, params: Record<string, string | number> = {}): string {
  let text: string = DICTS[lang][key] ?? DICTS.zh[key] ?? key
  for (const [name, value] of Object.entries(params)) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

/** Look up in the current UI language. */
export function t(key: DrawioKey, params: Record<string, string | number> = {}): string {
  return lookup(currentLang(), key, params)
}
