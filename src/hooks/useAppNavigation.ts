import { useState, useRef, useEffect } from 'react';
import { Home, ListTodo, Settings as SettingsIcon } from 'lucide-react';
import CalibrationCurveIcon from '../components/CalibrationCurveIcon';
import { useTranslation } from '../contexts/LanguageContext';

export type ViewKey = 'home' | 'history' | 'lab' | 'lab-calibration' | 'settings' | 'pk-params' | 'settings-hrt-mode' | 'settings-language' | 'settings-appearance' | 'settings-weight' | 'settings-export' | 'settings-import' | 'settings-milk-tea';

export const useAppNavigation = () => {
    const { t } = useTranslation();

    // --- State ---
    const [currentView, setCurrentView] = useState<ViewKey>('home');
    const [transitionDirection, setTransitionDirection] = useState<'forward' | 'backward'>('forward');
    const mainScrollRef = useRef<HTMLDivElement>(null);

    const viewOrder: ViewKey[] = ['home', 'history', 'lab', 'lab-calibration', 'settings', 'pk-params', 'settings-hrt-mode', 'settings-language', 'settings-appearance', 'settings-weight', 'settings-export', 'settings-import', 'settings-milk-tea'];

    // --- Actions ---
    const handleViewChange = (view: ViewKey) => {
        if (view === currentView) return;
        const currentIndex = viewOrder.indexOf(currentView);
        const nextIndex = viewOrder.indexOf(view);
        setTransitionDirection(nextIndex >= currentIndex ? 'forward' : 'backward');
        setCurrentView(view);
    };

    // --- Effects ---
    // Reset scroll when switching tabs
    useEffect(() => {
        const el = mainScrollRef.current;
        if (el) el.scrollTo({ top: 0, behavior: 'smooth' });
    }, [currentView]);

    // --- Derived Data ---
    const navItems = [
        { id: 'home', label: t('nav.home'), icon: Home },
        { id: 'history', label: t('nav.history'), icon: ListTodo },
        { id: 'lab', label: t('nav.lab'), icon: CalibrationCurveIcon },
        { id: 'settings', label: t('nav.settings'), icon: SettingsIcon },
    ];

    return {
        currentView,
        transitionDirection,
        handleViewChange,
        mainScrollRef,
        navItems
    };
};
