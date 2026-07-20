import React, { createContext, useContext, useState, useEffect } from 'react';
import { TRANSLATIONS, Lang } from '../i18n/translations';

const LanguageContext = createContext<{ lang: Lang; setLang: (l: Lang) => void; t: (k: string) => string } | null>(null);

export const useTranslation = () => {
    const ctx = useContext(LanguageContext);
    if (!ctx) throw new Error("useTranslation must be used within LanguageProvider");
    return ctx;
};

const RTL_LANGS: ReadonlySet<Lang> = new Set<Lang>();

const LANG_LOCALE: Record<Lang, string> = {
    'zh': 'zh-CN',
    'zh-TW': 'zh-TW',
    'yue': 'zh-HK',
    'en': 'en',
    'ja': 'ja',
    'ko': 'ko',
    'tr': 'tr',
};

export const LanguageProvider = ({ children }: { children: React.ReactNode }) => {
    const [lang, setLang] = useState<Lang>(() => (localStorage.getItem('hrt-lang') as Lang) || 'en');

    useEffect(() => {
        localStorage.setItem('hrt-lang', lang);
        document.title = (lang.startsWith('zh') || lang === 'yue') ? "HRT 记录" : "HRT Tracker";
        document.documentElement.lang = LANG_LOCALE[lang] ?? lang;
        document.documentElement.dir = RTL_LANGS.has(lang) ? 'rtl' : 'ltr';
    }, [lang]);

    const t = (key: string) => {
        const pack = (TRANSLATIONS as any)[lang] || TRANSLATIONS.en;
        return pack[key] ?? TRANSLATIONS.en[key as keyof typeof TRANSLATIONS.en] ?? TRANSLATIONS.zh[key as keyof typeof TRANSLATIONS.zh] ?? key;
    };

    return (
        <LanguageContext.Provider value={{ lang, setLang, t }}>
            {children}
        </LanguageContext.Provider>
    );
};
