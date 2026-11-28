'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { english } from './english';

type Language = 'vi' | 'en';
const storageKey = 'juee-language';
const titles: Record<string, string> = {
  '/login': 'Đăng nhập',
  '/register': 'Đăng ký',
  '/register/google': 'Hoàn tất đăng ký Google',
  '/verify-email': 'Xác minh email',
  '/forgot-password': 'Quên mật khẩu',
  '/reset-password': 'Đặt lại mật khẩu',
  '/pricing': 'Bảng giá',
};

function isLanguage(value: string | null): value is Language {
  return value === 'vi' || value === 'en';
}

function interpolate(text: string, values: unknown[]) {
  return values.length ? text.replace(/\{(\d+)\}/g, (_, index: string) => String(values[Number(index)])) : text;
}

function vietnamese(text: string, ...values: unknown[]): string;
function vietnamese(text: undefined, ...values: unknown[]): undefined;
function vietnamese(text: string | undefined, ...values: unknown[]): string | undefined;
function vietnamese(text: string | undefined, ...values: unknown[]) {
  return text === undefined ? undefined : interpolate(text, values);
}

function translateToEnglish(text: string, ...values: unknown[]): string;
function translateToEnglish(text: undefined, ...values: unknown[]): undefined;
function translateToEnglish(text: string | undefined, ...values: unknown[]): string | undefined;
function translateToEnglish(text: string | undefined, ...values: unknown[]) {
  return text === undefined ? undefined : interpolate(Object.hasOwn(english, text) ? english[text] : text, values);
}

const LanguageContext = createContext({
  language: 'vi' as Language,
  setLanguage: (_language: Language) => {},
  t: vietnamese,
  homeHref: '/',
});

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>('vi');
  const pathname = usePathname();

  function selectLanguage(choice: Language) {
    setLanguage(choice);
    try { localStorage.setItem(storageKey, choice); } catch { /* Storage may be blocked by the browser. */ }
  }

  useEffect(() => {
    const url = new URL(window.location.href);
    const requested = url.searchParams.get('lang');
    if (isLanguage(requested)) {
      selectLanguage(requested);
      url.searchParams.delete('lang');
      window.history.replaceState(null, '', url);
    } else {
      try {
        const saved = localStorage.getItem(storageKey);
        if (isLanguage(saved)) setLanguage(saved);
      } catch { /* Use the default language. */ }
    }
    const sync = (event: StorageEvent) => {
      if (event.key === storageKey && isLanguage(event.newValue)) setLanguage(event.newValue);
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  const t = language === 'en' ? translateToEnglish : vietnamese;

  useEffect(() => {
    document.documentElement.lang = language;
    const title = titles[pathname] ?? (pathname.startsWith('/check-in/') ? 'Check-in hội viên' : pathname.startsWith('/dat-truoc/') ? 'Đặt trước' : undefined);
    const localizedTitle = title ? t(title) + ' | JUEE POS' : 'JUEE POS';
    const syncTitle = () => {
      if (document.title !== localizedTitle) document.title = localizedTitle;
    };
    syncTitle();
    // Next.js can insert its route metadata after the client has rendered.
    const observer = new MutationObserver(syncTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [language, pathname, t]);

  return <LanguageContext.Provider value={{ language, setLanguage: selectLanguage, t, homeHref: language === 'en' ? '/en' : '/' }}>
    {children}
  </LanguageContext.Provider>;
}

export function useLanguage() {
  return useContext(LanguageContext);
}
