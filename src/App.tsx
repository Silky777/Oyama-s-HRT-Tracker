import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslation, LanguageProvider } from './contexts/LanguageContext';
import { useDialog, DialogProvider } from './contexts/DialogContext';
import { HRTModeProvider } from './contexts/HRTModeContext';
import ErrorBoundary from './components/ErrorBoundary';
import { APP_VERSION, AppTheme, PUBLIC_HOST } from './constants';
import { DoseEvent, LabResult, decompressData, encryptData, decryptData } from '../logic';
import { useAppData } from './hooks/useAppData';
import { useAppNavigation, ViewKey } from './hooks/useAppNavigation';
import { loadState, saveState, StateConflictError } from './services/state';

import WeightEditorModal from './components/WeightEditorModal';
import DoseFormModal from './components/DoseFormModal';
import ImportModal from './components/ImportModal';
import ExportModal from './components/ExportModal';
import Sidebar from './components/Sidebar';
import PasswordInputModal from './components/PasswordInputModal';
import DisclaimerModal from './components/DisclaimerModal';
import LabResultModal from './components/LabResultModal';

// Pages
import Home from './pages/Home';
import History from './pages/History';
import Lab from './pages/Lab';
import CalibrationSettings from './pages/CalibrationSettings';
import Settings from './pages/Settings';
import PKParamsPage from './pages/PKParams';
import HRTModeSettings from './pages/HRTModeSettings';
import LanguageSettings from './pages/LanguageSettings';
import AppearanceSettings from './pages/AppearanceSettings';
import WeightSettings from './pages/WeightSettings';
import ExportSettings from './pages/ExportSettings';
import ImportSettings from './pages/ImportSettings';
import MilkTeaEasterEgg from './pages/MilkTeaEasterEgg';
import PublicDashboard from './pages/PublicDashboard';

const hasMeaningfulLocalState = (payload: any): boolean => {
    const modes = payload?.modes;
    const hasModeData = modes && ['transfem', 'transmasc'].some(mode => {
        const block = modes[mode];
        return ['events', 'labResults', 'doseTemplates', 'quickDoses']
            .some(key => Array.isArray(block?.[key]) && block[key].length > 0);
    });
    return Boolean(hasModeData || payload?.pkParams || (typeof payload?.weight === 'number' && payload.weight !== 70));
};

const AppContent = () => {
    const { t, lang, setLang } = useTranslation();
    const { showDialog } = useDialog();

    // Use Custom Hooks
    const {
        events, setEvents,
        weight, setWeight,
        labResults, setLabResults,
        doseTemplates, setDoseTemplates,
        simulation,
        currentTime,
        calibrationFn,
        calibrationMethod, setCalibrationMethod,
        calibrationHistoryMode, setCalibrationHistoryMode,
        calibration,
        currentLevel,
        currentCPA,
        currentT,
        currentStatus,
        groupedEvents,
        addEvent, addEvents, updateEvent, deleteEvent, deleteEvents, clearAllEvents,
        addLabResult, updateLabResult, deleteLabResult, clearLabResults,
        addTemplate, deleteTemplate,
        addQuickDose, deleteQuickDose,
        quickDoses,
        pkParams, setPkParams, clearPkParams,
        processImportedData,
        buildExportPayload,
        buildServerPayload,
        stateSignature,
        isPublicProjectionDirty,
        hydrateFromServer,
    } = useAppData(showDialog);

    const {
        currentView,
        transitionDirection,
        handleViewChange,
        mainScrollRef,
        navItems,
    } = useAppNavigation();

    // --- Local UI State (Modals & Forms) ---
    const [isWeightModalOpen, setIsWeightModalOpen] = useState(false);
    const [isFormOpen, setIsFormOpen] = useState(false);
    const [editingEvent, setEditingEvent] = useState<DoseEvent | null>(null);
    const [isImportModalOpen, setIsImportModalOpen] = useState(false);
    const [isExportModalOpen, setIsExportModalOpen] = useState(false);
    const [isPasswordInputOpen, setIsPasswordInputOpen] = useState(false);
    const [isQuickAddOpen, setIsQuickAddOpen] = useState(false);
    const [isQuickAddLabOpen, setIsQuickAddLabOpen] = useState(false);
    const [isDisclaimerOpen, setIsDisclaimerOpen] = useState(false);
    const [isLabModalOpen, setIsLabModalOpen] = useState(false);
    const [editingLab, setEditingLab] = useState<LabResult | null>(null);
    const [pendingImportText, setPendingImportText] = useState<string | null>(null);

    // --- Developer mode (unlocks the milk tea easter egg) ---
    const [devMode, setDevMode] = useState<boolean>(() =>
        localStorage.getItem('app-dev-mode') === 'true'
    );
    useEffect(() => {
        localStorage.setItem('app-dev-mode', String(devMode));
    }, [devMode]);

    const [theme, setTheme] = useState<AppTheme>(() => {
        const saved = localStorage.getItem('app-theme');
        return (saved as AppTheme) || 'system';
    });

    // --- Server sync: the server is the single source of truth ---------------
    // hrt.silky.moe sits behind Cloudflare Access, so these requests are already
    // authenticated at the edge — no in-app login. localStorage is a fast local
    // cache; the D1-backed /api/state is authoritative across devices.
    const hydratedRef = useRef(false);
    const lastSyncedSigRef = useRef<string | null>(null);
    const lastServerUpdateRef = useRef(0);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const saveInFlightRef = useRef(false);
    const saveAgainRef = useRef(false);
    const projectionSyncPendingRef = useRef(false);
    const syncNowRef = useRef<() => Promise<void>>(async () => {});

    const scheduleRetry = () => {
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
        retryTimerRef.current = setTimeout(() => syncNowRef.current(), 15000);
    };

    // Focus/online listeners call through this ref so they always see the
    // current data instead of values captured on the first render.
    syncNowRef.current = async () => {
        if (!hydratedRef.current) return;
        const sig = stateSignature();
        const rawStateDirty = sig !== lastSyncedSigRef.current;
        const projectionDirty = isPublicProjectionDirty();
        if (!rawStateDirty && !projectionDirty && !projectionSyncPendingRef.current) return;
        if (saveInFlightRef.current) {
            saveAgainRef.current = true;
            return;
        }

        // A projection-only refresh carries the entire canonical state blob, so
        // use compare-and-swap to ensure an idle device cannot overwrite newer
        // raw edits from another device merely to renew the public curve.
        const projectionOnly = !rawStateDirty;
        const baseUpdatedAt = projectionOnly ? lastServerUpdateRef.current : undefined;
        if (projectionOnly) projectionSyncPendingRef.current = true;
        saveInFlightRef.current = true;
        try {
            const payload = buildServerPayload();
            if (
                projectionOnly &&
                baseUpdatedAt === 0 &&
                !hasMeaningfulLocalState(payload)
            ) {
                // Preserve the first-run safeguard below: renewing an empty
                // public snapshot must not claim an empty D1 row before the
                // device holding the real, not-yet-uploaded history opens.
                projectionSyncPendingRef.current = false;
                return;
            }
            const result = await saveState(payload, baseUpdatedAt);
            lastSyncedSigRef.current = sig;
            lastServerUpdateRef.current = result.updated_at;
            projectionSyncPendingRef.current = false;
            if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
        } catch (error) {
            if (
                projectionOnly &&
                error instanceof StateConflictError &&
                error.current.data?.modes &&
                stateSignature() === sig
            ) {
                // No local edit happened while the request was in flight, so
                // safely adopt the newer server truth. If that row still needs
                // a projection, the follow-up sync regenerates it from the
                // newly hydrated inputs.
                hydrateFromServer(error.current.data);
                lastSyncedSigRef.current = stateSignature();
                lastServerUpdateRef.current = error.current.updated_at;
                projectionSyncPendingRef.current = false;
                if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
                if (isPublicProjectionDirty()) saveAgainRef.current = true;
            } else {
                // Keep a projection-only upload explicitly pending: building
                // the payload made its local cache clean even though D1 never
                // accepted it. Raw edits remain dirty via their signature.
                if (projectionOnly) projectionSyncPendingRef.current = true;
                scheduleRetry();
            }
        } finally {
            saveInFlightRef.current = false;
            if (saveAgainRef.current) {
                saveAgainRef.current = false;
                setTimeout(() => syncNowRef.current(), 0);
            }
        }
    };

    // Initial load: pull server state and adopt it, or seed the server from
    // whatever is stored locally on first run.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const { data, updated_at } = await loadState();
                if (cancelled) return;
                if (data && typeof data === 'object' && data.modes) {
                    hydrateFromServer(data);
                    // Older rows predate the safe precomputed public snapshot.
                    // Keep them dirty so the normal debounce writes one after
                    // hydration has rebuilt the calibrated browser simulation.
                    lastSyncedSigRef.current = stateSignature();
                    lastServerUpdateRef.current = updated_at;
                } else {
                    const payload = buildServerPayload();
                    if (hasMeaningfulLocalState(payload)) {
                        try {
                            // Only one device may claim an empty server. If two
                            // first loads race, the winner becomes authoritative.
                            const result = await saveState(payload, 0);
                            lastSyncedSigRef.current = stateSignature();
                            lastServerUpdateRef.current = result.updated_at;
                        } catch (error) {
                            if (error instanceof StateConflictError && error.current.data?.modes) {
                                hydrateFromServer(error.current.data);
                                lastSyncedSigRef.current = stateSignature();
                                lastServerUpdateRef.current = error.current.updated_at;
                            } else {
                                throw error;
                            }
                        }
                    } else {
                        // Do not let a fresh device create an empty authoritative
                        // row before the browser holding the real history opens.
                        lastSyncedSigRef.current = stateSignature();
                        lastServerUpdateRef.current = 0;
                    }
                }
            } catch {
                // Keep localStorage as the working cache and mark it dirty so it
                // will be retried after connectivity returns.
                lastSyncedSigRef.current = null;
            } finally {
                if (!cancelled) {
                    hydratedRef.current = true;
                    if (lastSyncedSigRef.current === null) scheduleRetry();
                }
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Debounced push to the server whenever the syncable data changes.
    useEffect(() => {
        if (!hydratedRef.current) return;
        const sig = stateSignature();
        if (sig === lastSyncedSigRef.current && !isPublicProjectionDirty()) return;
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => syncNowRef.current(), 1200);
        return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [events, labResults, doseTemplates, quickDoses, weight, pkParams, calibrationMethod, calibrationHistoryMode]);

    // Refresh from the server when the tab regains focus, so a change made on
    // another device shows up here — but only when there are no un-synced local
    // edits, so we never clobber pending changes.
    useEffect(() => {
        const refresh = async () => {
            if (!hydratedRef.current) return;
            if (stateSignature() !== lastSyncedSigRef.current || isPublicProjectionDirty()) {
                await syncNowRef.current();
                return;
            }
            try {
                const { data, updated_at } = await loadState();
                if (data && typeof data === 'object' && data.modes) {
                    if (updated_at === lastServerUpdateRef.current) return;
                    hydrateFromServer(data);
                    lastSyncedSigRef.current = stateSignature();
                    lastServerUpdateRef.current = updated_at;
                    if (isPublicProjectionDirty()) await syncNowRef.current();
                }
            } catch { /* ignore */ }
        };
        const onVis = () => { if (!document.hidden) refresh(); };
        const onOnline = () => syncNowRef.current();
        window.addEventListener('focus', refresh);
        window.addEventListener('online', onOnline);
        document.addEventListener('visibilitychange', onVis);
        return () => {
            window.removeEventListener('focus', refresh);
            window.removeEventListener('online', onOnline);
            document.removeEventListener('visibilitychange', onVis);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => () => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    }, []);

    // --- Theme Effect ---
    useEffect(() => {
        localStorage.setItem('app-theme', theme);
        const root = window.document.documentElement;

        const applyTheme = (isDark: boolean) => {
            root.classList.remove('light', 'dark');
            root.classList.add(isDark ? 'dark' : 'light');
        };

        // Mono renders as light with a grayscale filter (see html.mono in index.css)
        root.classList.toggle('mono', theme === 'mono');

        if (theme === 'system') {
            const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
            applyTheme(mediaQuery.matches);
            const handleChange = (e: MediaQueryListEvent) => applyTheme(e.matches);
            mediaQuery.addEventListener('change', handleChange);
            return () => mediaQuery.removeEventListener('change', handleChange);
        } else {
            applyTheme(theme === 'dark');
        }
    }, [theme]);

    const languageOptions = useMemo(() => ([
        { value: 'zh', label: '简体中文' },
        { value: 'zh-TW', label: '正體中文' },
        { value: 'yue', label: '廣東話' },
        { value: 'en', label: 'English' },
        { value: 'ja', label: '日本語' },
        { value: 'ko', label: '한국어' },
        { value: 'tr', label: 'Türkçe' },
    ]), []);

    // --- Modal Logic Wrappers ---
    useEffect(() => {
        const shouldLock = isExportModalOpen || isPasswordInputOpen || isWeightModalOpen || isFormOpen || isImportModalOpen || isDisclaimerOpen || isLabModalOpen;
        document.body.style.overflow = shouldLock ? 'hidden' : '';
        return () => { document.body.style.overflow = ''; };
    }, [isExportModalOpen, isPasswordInputOpen, isWeightModalOpen, isFormOpen, isImportModalOpen, isDisclaimerOpen, isLabModalOpen]);

    const importEventsFromJson = async (text: string): Promise<boolean> => {
        try {
            let parsed = JSON.parse(text);

            // Handle Encryption
            if (parsed.encrypted && parsed.iv && parsed.salt && parsed.data) {
                setPendingImportText(text);
                setIsPasswordInputOpen(true);
                return true;
            }

            // Handle Compression
            if (parsed.c && typeof parsed.c === 'string') {
                const decompressed = await decompressData(parsed.c);
                parsed = JSON.parse(decompressed);
            }

            return processImportedData(parsed);
        } catch (err) {
            console.error(err);
            showDialog('alert', t('drawer.import_error'));
            return false;
        }
    };

    const handlePasswordSubmit = async (password: string) => {
        if (!pendingImportText) return;
        const decrypted = await decryptData(pendingImportText, password);
        if (decrypted) {
            try {
                let parsed = JSON.parse(decrypted);
                if (parsed.c && typeof parsed.c === 'string') {
                    const decompressed = await decompressData(parsed.c);
                    parsed = JSON.parse(decompressed);
                }
                processImportedData(parsed);
                setIsPasswordInputOpen(false);
                setPendingImportText(null);
            } catch (e) {
                console.error(e);
                showDialog('alert', t('import.decrypt_error'));
            }
        } else {
            showDialog('alert', t('import.decrypt_error'));
        }
    };

    const handleEditEvent = (e: DoseEvent) => { setEditingEvent(e); setIsFormOpen(true); };
    const handleAddLabResult = () => { setEditingLab(null); setIsLabModalOpen(true); };
    const handleEditLabResult = (res: LabResult) => { setEditingLab(res); setIsLabModalOpen(true); };

    const handleQuickExport = () => {
        if (events.length === 0 && labResults.length === 0) {
            showDialog('alert', t('drawer.empty_export'));
            return;
        }
        const exportData = buildExportPayload();
        const json = JSON.stringify(exportData, null, 2);
        navigator.clipboard.writeText(json).then(() => {
            showDialog('alert', t('drawer.export_copied'));
        }).catch(err => {
            console.error('Failed to copy: ', err);
        });
    };

    const downloadFile = (data: string, filename: string) => {
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
    };

    const handleExportConfirm = async (encrypt: boolean, customPassword?: string): Promise<string | null> => {
        setIsExportModalOpen(false);
        const exportData = buildExportPayload();
        const json = JSON.stringify(exportData, null, 2);

        if (encrypt) {
            const { data, password } = await encryptData(json, customPassword);
            downloadFile(data, `hrt-dosages-encrypted-${new Date().toISOString().split('T')[0]}.json`);
            if (!customPassword) {
                return password;
            }
        } else {
            downloadFile(json, `hrt-dosages-${new Date().toISOString().split('T')[0]}.json`);
        }
        return null;
    };

    // Sub-views map to a primary tab for the mobile bottom nav highlight.
    const activeTab = ({
        'home': 'home',
        'history': 'history',
        'lab': 'lab',
        'lab-calibration': 'lab',
        'settings': 'settings',
        'settings-hrt-mode': 'settings',
        'settings-language': 'settings',
        'settings-appearance': 'settings',
        'settings-weight': 'settings',
        'settings-export': 'settings',
        'settings-import': 'settings',
        'settings-milk-tea': 'settings',
        'pk-params': 'settings',
    } as Record<string, string>)[currentView] ?? currentView;

    return (
        <div className="h-[100dvh] w-full bg-[var(--color-m3-surface)] dark:bg-[var(--color-m3-dark-surface)] flex flex-col md:flex-row font-sans text-[var(--color-m3-on-surface)] dark:text-[var(--color-m3-dark-on-surface)] select-none overflow-hidden">
            <Sidebar
                navItems={navItems}
                currentView={currentView}
                onViewChange={(v) => handleViewChange(v)}
            />
            <div className="flex-1 flex flex-col overflow-hidden w-full bg-[var(--color-m3-surface-dim)] dark:bg-[var(--color-m3-dark-surface)] relative">

                {/* Mobile site label — reflects the current deployment host */}
                <div className="md:hidden shrink-0 pt-[calc(0.5rem+env(safe-area-inset-top,0px))] pb-1 text-center text-[11px] font-medium tracking-wide text-muted select-none">
                    {window.location.hostname}
                </div>

                <div
                    ref={mainScrollRef}
                    key={currentView}
                    className={`flex-1 flex flex-col overflow-y-auto scrollbar-hide scroll-pb-nav ${transitionDirection === 'backward' ? 'view-enter-backward' : 'view-enter-forward'}`}
                >
                    {currentView === 'home' && (
                        <Home
                            t={t}
                            currentLevel={currentLevel}
                            currentCPA={currentCPA}
                            currentT={currentT}
                            currentStatus={currentStatus}
                            events={events}
                            weight={weight}
                            setIsWeightModalOpen={setIsWeightModalOpen}
                            simulation={simulation}
                            labResults={labResults}
                            onEditEvent={handleEditEvent}
                            calibrationFn={calibrationFn}
                            theme={theme}
                            onNavigateToHistory={() => handleViewChange('history')}
                            onNavigateToLab={() => handleViewChange('lab')}
                        />
                    )}

                    {currentView === 'history' && (
                        <History
                            t={t}
                            isQuickAddOpen={isQuickAddOpen}
                            setIsQuickAddOpen={setIsQuickAddOpen}
                            doseTemplates={doseTemplates}
                            onSaveEvent={e => {
                                if (events.find(p => p.id === e.id)) updateEvent(e);
                                else addEvent(e);
                            }}
                            onDeleteEvent={deleteEvent}
                            onAddEvents={addEvents}
                            onDeleteEvents={deleteEvents}
                            onSaveTemplate={addTemplate}
                            onDeleteTemplate={deleteTemplate}
                            quickDoses={quickDoses}
                            onAddQuickDose={addQuickDose}
                            onDeleteQuickDose={deleteQuickDose}
                            groupedEvents={groupedEvents}
                            onEditEvent={handleEditEvent}
                        />
                    )}

                    {currentView === 'lab' && (
                        <Lab
                            t={t}
                            isQuickAddLabOpen={isQuickAddLabOpen}
                            setIsQuickAddLabOpen={setIsQuickAddLabOpen}
                            labResults={labResults}
                            onSaveLabResult={r => {
                                if (labResults.find(prev => prev.id === r.id)) updateLabResult(r);
                                else addLabResult(r);
                            }}
                            onDeleteLabResult={deleteLabResult}
                            onEditLabResult={handleEditLabResult}
                            onClearLabResults={clearLabResults}
                            calibrationMethod={calibrationMethod}
                            calibration={calibration}
                            onOpenCalibrationSettings={() => handleViewChange('lab-calibration')}
                            currentTime={currentTime}
                            lang={lang}
                        />
                    )}

                    {currentView === 'lab-calibration' && (
                        <CalibrationSettings
                            method={calibrationMethod}
                            setMethod={setCalibrationMethod}
                            historyMode={calibrationHistoryMode}
                            setHistoryMode={setCalibrationHistoryMode}
                            calibration={calibration}
                            onBack={() => handleViewChange('lab')}
                        />
                    )}

                    {currentView === 'settings' && (
                        <Settings
                            t={t}
                            lang={lang}
                            setLang={setLang}
                            theme={theme}
                            setTheme={setTheme}
                            languageOptions={languageOptions}
                            onImportJson={importEventsFromJson}
                            labResults={labResults}
                            onExport={handleExportConfirm}
                            onQuickExport={handleQuickExport}
                            onClearAllEvents={clearAllEvents}
                            events={events}
                            showDialog={showDialog}
                            setIsDisclaimerOpen={setIsDisclaimerOpen}
                            appVersion={APP_VERSION}
                            weight={weight}
                            setIsWeightModalOpen={setIsWeightModalOpen}
                            pkParams={pkParams}
                            onNavigateToPKParams={() => handleViewChange('pk-params')}
                            onNavigateToHRTMode={() => handleViewChange('settings-hrt-mode')}
                            onNavigateToLanguage={() => handleViewChange('settings-language')}
                            onNavigateToAppearance={() => handleViewChange('settings-appearance')}
                            onNavigateToWeight={() => handleViewChange('settings-weight')}
                            onNavigateToExport={() => handleViewChange('settings-export')}
                            onNavigateToImport={() => handleViewChange('settings-import')}
                            devMode={devMode}
                            setDevMode={setDevMode}
                            onNavigateToMilkTea={() => handleViewChange('settings-milk-tea')}
                        />
                    )}

                    {currentView === 'settings-hrt-mode' && (
                        <HRTModeSettings onBack={() => handleViewChange('settings')} />
                    )}

                    {currentView === 'settings-language' && (
                        <LanguageSettings
                            lang={lang}
                            setLang={setLang}
                            languageOptions={languageOptions}
                            onBack={() => handleViewChange('settings')}
                        />
                    )}

                    {currentView === 'settings-appearance' && (
                        <AppearanceSettings theme={theme} setTheme={setTheme} onBack={() => handleViewChange('settings')} />
                    )}

                    {currentView === 'settings-weight' && (
                        <WeightSettings weight={weight} onSave={setWeight} onBack={() => handleViewChange('settings')} />
                    )}

                    {currentView === 'settings-export' && (
                        <ExportSettings
                            events={events}
                            labResults={labResults}
                            weight={weight}
                            onExport={handleExportConfirm}
                            onQuickExport={handleQuickExport}
                            onBack={() => handleViewChange('settings')}
                        />
                    )}

                    {currentView === 'settings-import' && (
                        <ImportSettings onImportJson={importEventsFromJson} onBack={() => handleViewChange('settings')} />
                    )}

                    {currentView === 'settings-milk-tea' && devMode && (
                        <MilkTeaEasterEgg onBack={() => handleViewChange('settings')} />
                    )}

                    {currentView === 'pk-params' && (
                        <PKParamsPage
                            pkParams={pkParams}
                            onSave={setPkParams}
                            onReset={clearPkParams}
                            onBack={() => handleViewChange('settings')}
                        />
                    )}
                </div>

                {/* Bottom Navigation — floating island */}
                <nav className="fixed left-4 right-4 bottom-[calc(0.75rem+env(safe-area-inset-bottom,0px))] z-40 md:hidden rounded-2xl bg-[var(--color-m3-surface-bright)] dark:bg-[var(--color-m3-dark-surface-container)] border border-[var(--color-m3-outline-variant)] dark:border-[var(--color-m3-dark-outline-variant)] shadow-[var(--shadow-m3-3)]">
                    <div className="flex items-stretch p-1.5 gap-1">
                        {navItems.map(({ id, icon: Icon, label }) => {
                            const isActive = activeTab === id;
                            return (
                                <button
                                    key={id}
                                    onClick={() => handleViewChange(id as ViewKey)}
                                    className={`flex-1 flex flex-col items-center justify-center gap-1 py-1.5 transition-colors duration-150 motion-reduce:transition-none ${isActive ? 'text-body' : 'text-muted'}`}
                                >
                                    <Icon size={20} strokeWidth={isActive ? 2 : 1.75} />
                                    <span className="text-[10px] font-medium">{label}</span>
                                </button>
                            );
                        })}
                    </div>
                </nav>
            </div>

            <ExportModal
                isOpen={isExportModalOpen}
                onClose={() => setIsExportModalOpen(false)}
                onExport={handleExportConfirm}
                events={events}
                labResults={labResults}
                weight={weight}
            />

            <PasswordInputModal
                isOpen={isPasswordInputOpen}
                onClose={() => setIsPasswordInputOpen(false)}
                onConfirm={handlePasswordSubmit}
            />

            <WeightEditorModal
                isOpen={isWeightModalOpen}
                onClose={() => setIsWeightModalOpen(false)}
                currentWeight={weight}
                onSave={setWeight}
            />

            <DoseFormModal
                isOpen={isFormOpen}
                onClose={() => setIsFormOpen(false)}
                eventToEdit={editingEvent}
                onSave={(e: DoseEvent) => {
                    if (events.find(p => p.id === e.id)) updateEvent(e);
                    else addEvent(e);
                }}
                onDelete={deleteEvent}
                templates={doseTemplates}
                onSaveTemplate={addTemplate}
                onDeleteTemplate={deleteTemplate}
                quickDoses={quickDoses}
                onAddQuickDose={addQuickDose}
                onDeleteQuickDose={deleteQuickDose}
                events={events}
            />

            <DisclaimerModal
                isOpen={isDisclaimerOpen}
                onClose={() => setIsDisclaimerOpen(false)}
            />

            <ImportModal
                isOpen={isImportModalOpen}
                onClose={() => setIsImportModalOpen(false)}
                onImportJson={importEventsFromJson}
            />

            <LabResultModal
                isOpen={isLabModalOpen}
                onClose={() => setIsLabModalOpen(false)}
                onSave={r => {
                    if (labResults.find(prev => prev.id === r.id)) updateLabResult(r);
                    else addLabResult(r);
                }}
                onDelete={deleteLabResult}
                resultToEdit={editingLab}
            />
        </div>
    );
};

// The query flag is a localhost-only preview convenience. Production view
// selection is host-based, matching the Worker API boundary.
const isPublicView = typeof window !== 'undefined' && (() => {
    const host = window.location.hostname;
    const localPreview = (host === 'localhost' || host === '127.0.0.1') &&
        new URLSearchParams(window.location.search).has('public');
    return host === PUBLIC_HOST || localPreview;
})();

const App = () => (
    isPublicView ? (
        <ErrorBoundary>
            <PublicDashboard />
        </ErrorBoundary>
    ) : (
        <LanguageProvider>
            <HRTModeProvider>
                <DialogProvider>
                    <ErrorBoundary>
                        <AppContent />
                    </ErrorBoundary>
                </DialogProvider>
            </HRTModeProvider>
        </LanguageProvider>
    )
);

export default App;
