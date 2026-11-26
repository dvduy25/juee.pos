'use client';

import { Languages } from 'lucide-react';
import { useLanguage } from '@/i18n/language';

export function LanguageSwitch() {
  const { language, setLanguage } = useLanguage();
  const next = language === 'vi' ? 'en' : 'vi';
  const label = next === 'en' ? 'Switch to English' : 'Chuyển sang Tiếng Việt';

  return <button type="button" className="plain language-switch" onClick={() => setLanguage(next)}
    aria-label={label} title={label}>
    <Languages size={16} aria-hidden="true"/><span lang={next}>{next === 'en' ? 'EN' : 'VI'}</span>
  </button>;
}
