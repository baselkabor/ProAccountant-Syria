        const STORAGE_KEY = 'ProAccountant_Syria_Basel_DB_v1';
        const RESTORE_BACKUP_KEY = STORAGE_KEY + '_before_restore';
        const INVALID_DB_PREFIX = STORAGE_KEY + '_invalid_';

        let db = {
            settings: {
                companyName: 'محاسب محترف سوريا',
                companySub: 'بإدارة باسل محمد الخابور - 0952575089',
                exchangeRate: 15000,
                companyLogo: '',
                themeMode: 'night'
            },
            items: [],
            accounts: [],
            invoices: [],
            vouchers: [],
            returns: [],
            cashboxes: [],
            warehouses: [],
            expenses: [],
            employees: [],
            installments: [],
            auditLog: []
        };

        let currentInvoiceMode = 'sales';
        let resetConfirmFlag = false;
        let nativeSavePromise = Promise.resolve(true);
        let databaseSaveQueue = Promise.resolve(true);
        let databaseMutationInProgress = false;
        let databaseExists = false;
        let loadedFromNative = false;
        let appBootStarted = false;
        let appUIReady = false;
        let selectedReceiptPaper = 'a4';
        let activePrintDocument = null;
        let printPreviewObserver = null;
        let invoiceDraftRevision = 0;
        let printJobInFlight = false;
        let printJobTimer = null;
        let databaseReadBlocked = false;
        let driveSyncInFlight = false;
        let driveSyncQueued = false;
        let driveScheduledPendingDate = '';

        function isAndroidPlatform() {
            return /Android/i.test(navigator.userAgent)
                || !!(window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform() === 'android');
        }

        document.body.classList.toggle('pa-android', isAndroidPlatform());

        function getAndroidNativeBridge() {
            return window.AndroidNative && typeof window.AndroidNative.loadData === 'function'
                ? window.AndroidNative
                : null;
        }

        function waitForAndroidNativeBridge() {
            const current = getAndroidNativeBridge();
            if (current || !isAndroidPlatform()) return Promise.resolve(current);
            return new Promise(resolve => {
                let finished = false;
                const finish = () => {
                    if (finished) return;
                    finished = true;
                    clearInterval(timer);
                    clearTimeout(timeout);
                    window.removeEventListener('androidnative-ready', finish);
                    resolve(getAndroidNativeBridge());
                };
                const timer = setInterval(() => {
                    if (getAndroidNativeBridge()) finish();
                }, 50);
                const timeout = setTimeout(finish, isAndroidPlatform() ? 15000 : 2500);
                window.addEventListener('androidnative-ready', finish, { once: true });
            });
        }

        function getStoredDatabaseRaw() {
            const nativeBridge = getAndroidNativeBridge();
            if (nativeBridge) {
                const raw = nativeBridge.loadData();
                return raw === null ? localStorage.getItem(STORAGE_KEY) : raw;
            }
            return localStorage.getItem(STORAGE_KEY);
        }

        async function restoreStoredDatabaseRaw(raw) {
            const nativeBridge = getAndroidNativeBridge();
            const failures = [];
            try {
                if (raw === null || raw === '') localStorage.removeItem(STORAGE_KEY);
                else localStorage.setItem(STORAGE_KEY, raw);
            } catch (e) {
                failures.push('Local');
            }
            if (nativeBridge) {
                try {
                    const restored = raw === null || raw === ''
                        ? (typeof nativeBridge.clearData !== 'function' || nativeBridge.clearData())
                        : (typeof nativeBridge.saveData !== 'function' || nativeBridge.saveData(raw));
                    if (!restored) failures.push('Native');
                } catch (e) {
                    failures.push('Native');
                }
            }
            if (window.pywebview && window.pywebview.api && typeof window.pywebview.api.save_data === 'function') {
                try {
                    const result = window.pywebview.api.save_data(raw || '');
                    if (result && typeof result.then === 'function') await result;
                    else if (result === false) failures.push('Pywebview');
                } catch (e) {
                    failures.push('Pywebview');
                }
            }
            if (failures.length) throw new Error(`Rollback failed: ${failures.join(', ')}`);
            const storedRaw = getStoredDatabaseRaw();
            if (String(storedRaw || '') !== String(raw || '')) throw new Error('Rollback verification failed');
        }

        // دالة موحدة لتهيئة الواجهة بعد تحميل البيانات
        async function initializeAppUI() {
            if (!Array.isArray(db.returns)) db.returns = [];
            if (!Array.isArray(db.auditLog)) db.auditLog = [];
            if (typeof ensureExtendedStores === 'function') ensureExtendedStores();
            if (!databaseReadBlocked && !databaseExists) {
                seedInitialDefaults();
                databaseExists = true;
                await saveDatabase();
            }

            const today = PA_CORE.getLocalDateString();
            document.getElementById('inv-date').value = today;
            document.getElementById('voucher-date').value = today;

            const rateInput = document.getElementById('exchange-rate-input');
            rateInput.value = db.settings.exchangeRate || 15000;
            rateInput.oninput = function() {
                const val = Number(this.value);
                if (!Number.isFinite(val) || val <= 0) this.setAttribute('aria-invalid', 'true');
                else this.removeAttribute('aria-invalid');
            };
            rateInput.onchange = async function() {
                const val = Number(this.value);
                if (!Number.isFinite(val) || val <= 0) {
                    this.value = db.settings.exchangeRate;
                    this.removeAttribute('aria-invalid');
                    showToast('سعر الصرف يجب أن يكون رقماً أكبر من الصفر', 'error');
                    return;
                }
                const saved = await commitDatabaseMutation(() => {
                    db.settings.exchangeRate = val;
                    return true;
                });
                if (!saved) this.value = db.settings.exchangeRate;
                handleInvoiceCurrencyChange();
                renderItemsTable();
                if (typeof updateDashboardKPIs === 'function') updateDashboardKPIs();
            };
            rateInput.onblur = function() {
                if (this.getAttribute('aria-invalid') === 'true') {
                    this.value = db.settings.exchangeRate;
                    this.removeAttribute('aria-invalid');
                    showToast('سعر الصرف يجب أن يكون رقماً أكبر من الصفر', 'error');
                }
            };

            document.getElementById('set-company-name').value = db.settings.companyName;
            document.getElementById('set-company-sub').value = db.settings.companySub;

            applyThemeModeUI();
            switchTab('home');
            resetInvoiceForm();
            refreshAllViews();
            updateSmartAlertsBadge();
            initDriveSyncUI();
            window.addEventListener('palang', () => applyThemeModeUI());
            initAppPinSecurity();
            populateReturnsDropdowns();
            const retDateEl = document.getElementById('ret-date');
            if (retDateEl && !retDateEl.value) retDateEl.value = today;
            const eodDateEl = document.getElementById('eod-report-date');
            if (eodDateEl && !eodDateEl.value) eodDateEl.value = today;

            document.removeEventListener('keydown', handleGlobalShortcuts);
            document.addEventListener('keydown', handleGlobalShortcuts);
            appUIReady = true;
        }

        function preserveInvalidDatabase(raw) {
            if (!raw) return false;
            let preserved = false;
            try {
                localStorage.setItem(INVALID_DB_PREFIX + Date.now(), raw);
                preserved = true;
            } catch (e) {}
            const nativeBridge = getAndroidNativeBridge();
            if (nativeBridge && typeof nativeBridge.preserveInvalidData === 'function') {
                try {
                    if (nativeBridge.preserveInvalidData(raw) !== false) preserved = true;
                } catch (e) {}
            }
            return preserved;
        }

        async function loadDatabase() {
            let sourceData = '';
            let nativeBridge = null;
            try {
                nativeBridge = await waitForAndroidNativeBridge();
                if (nativeBridge) {
                    const diskData = nativeBridge.loadData();
                    if (diskData === null) throw new Error('تعذر قراءة ملف قاعدة البيانات');
                    if (diskData) {
                        sourceData = diskData;
                        databaseExists = true;
                        const parsed = JSON.parse(diskData);
                        const validated = PA_CORE.validateDatabaseBackup(parsed);
                        if (!validated.ok) throw new Error(validated.error);
                        db = validated.data;
                        loadedFromNative = true;
                        return;
                    }
                }
                if (window.pywebview && window.pywebview.api) {
                    const diskData = await window.pywebview.api.load_data();
                    if (diskData) {
                        sourceData = diskData;
                        databaseExists = true;
                        const parsed = JSON.parse(diskData);
                        const validated = PA_CORE.validateDatabaseBackup(parsed);
                        if (!validated.ok) throw new Error(validated.error);
                        db = validated.data;
                        return;
                    }
                }
                const raw = localStorage.getItem(STORAGE_KEY);
                if (raw) {
                    sourceData = raw;
                    databaseExists = true;
                    const parsed = JSON.parse(raw);
                    const validated = PA_CORE.validateDatabaseBackup(parsed);
                    if (!validated.ok) throw new Error(validated.error);
                    db = validated.data;
                    if (nativeBridge && !nativeBridge.saveData(raw)) {
                        showToast('تم تحميل البيانات القديمة، لكن تعذر نقلها إلى تخزين أندرويد.', 'error');
                    }
                }
            } catch (e) {
                if (!sourceData && nativeBridge) {
                    databaseReadBlocked = true;
                    showToast('تعذر قراءة تخزين أندرويد؛ تم إيقاف الحفظ لتجنب فقدان البيانات.', 'error');
                    return;
                }
                const preserved = preserveInvalidDatabase(sourceData);
                databaseReadBlocked = true;
                databaseExists = false;
                showToast(preserved
                    ? 'تعذر قراءة قاعدة البيانات؛ حُفظت النسخة الأصلية وأُوقف الحفظ. استرجع نسخة سليمة من الإعدادات.'
                    : 'تعذر قراءة قاعدة البيانات وحفظ نسخة منها. أُوقف الحفظ لتجنب فقدان البيانات؛ أعد تشغيل التطبيق.', 'error');
            }
        }

        async function saveDatabase(options = {}) {
            if (databaseReadBlocked && !options.allowRecovery) {
                showToast('الحفظ متوقف؛ استرجع نسخة سليمة أو أعد تشغيل التطبيق بعد إصلاح التخزين.', 'error');
                return false;
            }
            const validated = PA_CORE.validateDatabaseBackup(db);
            if (!validated.ok) {
                showToast(`تعذر الحفظ: ${validated.error}`, 'error');
                return false;
            }
            const jsonString = JSON.stringify(validated.data, null, 2);
            const operation = databaseSaveQueue.catch(() => true).then(async () => {
                const previousRaw = localStorage.getItem(STORAGE_KEY);
                let localSaved = false;
                try {
                    try {
                        localStorage.setItem(STORAGE_KEY, jsonString);
                        localSaved = true;
                    } catch (e) {}

                    const nativeBridge = getAndroidNativeBridge();
                    if (nativeBridge) {
                        if (!nativeBridge.saveData(jsonString)) throw new Error('Native save failed');
                    } else if (window.pywebview && window.pywebview.api && typeof window.pywebview.api.save_data === 'function') {
                        const result = await window.pywebview.api.save_data(jsonString);
                        if (result === false) throw new Error('Native save failed');
                    } else if (!localSaved) {
                        throw new Error('Local storage save failed');
                    }

                    if (!options.skipDriveSync && db.settings.driveSyncEnabled && db.settings.driveEmail && navigator.onLine) {
                        triggerDriveSyncNow(false);
                    }
                    updateSmartAlertsBadge();
                    return true;
                } catch (e) {
                    if (localSaved) {
                        try {
                            if (previousRaw === null) localStorage.removeItem(STORAGE_KEY);
                            else localStorage.setItem(STORAGE_KEY, previousRaw);
                        } catch (rollbackError) {}
                    }
                    showToast('تعذر حفظ البيانات؛ لم تُرحّل العملية.', 'error');
                    return false;
                }
            });
            nativeSavePromise = operation;
            databaseSaveQueue = operation.catch(() => false);
            return operation;
        }

        async function commitDatabaseMutation(mutator, options = {}) {
            if (databaseMutationInProgress) {
                showToast('يرجى انتظار اكتمال العملية السابقة', 'warning');
                return null;
            }
            const lockScreen = document.getElementById('pin-lock-screen');
            if (lockScreen && !lockScreen.classList.contains('hidden')) {
                showToast('افتح قفل التطبيق أولاً', 'error');
                return null;
            }
            const previousDb = JSON.parse(JSON.stringify(db));
            let previousRaw = null;
            try {
                previousRaw = getStoredDatabaseRaw();
            } catch (e) {
                showToast('تعذر قراءة النسخة السابقة؛ أُوقفت العملية لحماية البيانات.', 'error');
                return null;
            }
            databaseMutationInProgress = true;
            try {
                const result = await mutator();
                if (result === null || result === undefined) return result;
                const validated = PA_CORE.validateDatabaseBackup(db);
                if (!validated.ok) throw new Error(validated.error);
                db = validated.data;
                if (!await saveDatabase(options)) throw new Error('Database save failed');
                if (previousRaw && !databaseReadBlocked) { try { localStorage.setItem(STORAGE_KEY + '_last_good', previousRaw); } catch (e) {} }
                try { updateDataSizeInfo(); } catch (e) {}
                if (options.allowRecovery) {
                    databaseReadBlocked = false;
                    databaseExists = true;
                }
                return result;
            } catch (e) {
                db = previousDb;
                let rollbackFailed = false;
                try {
                    await restoreStoredDatabaseRaw(previousRaw);
                } catch (rollbackError) {
                    rollbackFailed = true;
                    databaseReadBlocked = true;
                }
                refreshAllViews();
                if (typeof renderAllExtendedViews === 'function') renderAllExtendedViews();
                showToast(rollbackFailed
                    ? 'فشلت العملية وتعذر تأكيد استرجاع البيانات السابقة؛ أُوقف الحفظ حمايةً للبيانات.'
                    : `فشلت العملية ولم تُحفظ: ${e.message || 'خطأ غير معروف'}`, 'error');
                return null;
            } finally {
                databaseMutationInProgress = false;
            }
        }

        function openDriveSyncPanel() {
            switchTab('settings');
            if (typeof switchSettingsSubtab === 'function') switchSettingsSubtab('security');
            const el = document.getElementById('gdrive-sync-container');
            if (el) el.scrollIntoView({ behavior: 'smooth' });
        }

        function initDriveSyncUI() {
            const s = db.settings;
            const emailDisplay = document.getElementById('connected-drive-email-display');
            const topLabel = document.getElementById('top-drive-btn-label');

            if (s.driveEmail) {
                if (emailDisplay) emailDisplay.textContent = s.driveEmail;
                if (topLabel) topLabel.textContent = s.driveEmail.split('@')[0];
            }

            if (document.getElementById('drive-sync-enabled')) {
                document.getElementById('drive-sync-enabled').checked = !!s.driveSyncEnabled;
                document.getElementById('drive-monthly-file').checked = s.driveMonthlyFile !== false;
                document.getElementById('drive-daily-file').checked = s.driveDailyFile !== false;
                document.getElementById('drive-sync-notifications').checked = s.driveNotifications !== false;
                document.getElementById('drive-scheduled-enabled').checked = s.driveScheduledEnabled !== false;
                if (s.driveScheduledTime) document.getElementById('drive-scheduled-time').value = s.driveScheduledTime;
                if (s.driveLastSync) {
                    document.getElementById('drive-last-sync-time').textContent = s.driveLastSync;
                    document.getElementById('drive-sync-status-badge').textContent = '[تمت بنجاح]';
                }
                if (s.driveLastDaily) {
                    document.getElementById('drive-last-daily-time').textContent = s.driveLastDaily;
                }
            }
        }

        async function saveDrivePreferences() {
            const preferences = {
                driveSyncEnabled: document.getElementById('drive-sync-enabled').checked,
                driveMonthlyFile: document.getElementById('drive-monthly-file').checked,
                driveDailyFile: document.getElementById('drive-daily-file').checked,
                driveNotifications: document.getElementById('drive-sync-notifications').checked,
                driveScheduledEnabled: document.getElementById('drive-scheduled-enabled').checked,
                driveScheduledTime: document.getElementById('drive-scheduled-time').value
            };
            const saved = await commitDatabaseMutation(() => {
                Object.assign(db.settings, preferences);
                return true;
            });
            if (saved && db.settings.driveSyncEnabled && db.settings.driveEmail) triggerDriveSyncNow(true);
        }

        // استدعاء نافذة اختيار الإيميل عند الضغط على زر القلم
        function openEmailChooser() {
            if (window.AndroidNative && window.AndroidNative.pickGoogleAccount) {
                window.AndroidNative.pickGoogleAccount();
            } else {
                document.getElementById('fallback-email-input').value = db.settings.driveEmail || '';
                document.getElementById('email-picker-fallback-modal').classList.remove('hidden');
                document.getElementById('fallback-email-input').focus();
            }
        }

        function confirmFallbackEmail() {
            const email = document.getElementById('fallback-email-input').value.trim();
            if (!email || !email.includes('@')) {
                showToast('يرجى إدخال بريد إلكتروني صحيح', 'error');
                return;
            }
            document.getElementById('email-picker-fallback-modal').classList.add('hidden');
            onAndroidGoogleAccountSelected(email);
        }

        // دالة يستدعيها الأندرويد تلقائياً بعد اختيار الإيميل من القائمة
        async function onAndroidGoogleAccountSelected(email) {
            const safeEmail = String(email || '').trim();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safeEmail)) {
                showToast('البريد الإلكتروني غير صالح', 'error');
                return;
            }
            const saved = await commitDatabaseMutation(() => {
                db.settings.driveEmail = safeEmail;
                db.settings.driveSyncEnabled = true;
                return true;
            });
            if (!saved) return;
            document.getElementById('drive-sync-enabled').checked = true;
            initDriveSyncUI();
            showToast('تم ربط الحساب: ' + safeEmail, 'success');
            triggerDriveSyncNow(true);
        }

        function getFormattedTimestamp() {
            const now = new Date();
            const d = String(now.getDate()).padStart(2, '0');
            const m = String(now.getMonth() + 1).padStart(2, '0');
            const y = now.getFullYear();
            const hh = String(now.getHours()).padStart(2, '0');
            const mm = String(now.getMinutes()).padStart(2, '0');
            const ss = String(now.getSeconds()).padStart(2, '0');
            return `${d}-${m}-${y}-${hh}:${mm}:${ss}`;
        }

        function triggerDriveSyncNow(manual = false) {
            const email = db.settings.driveEmail;
            if (!email) {
                if (manual) openEmailChooser();
                return;
            }
            if (driveSyncInFlight) {
                driveSyncQueued = true;
                return;
            }

            const now = new Date();
            const y = now.getFullYear();
            const m = String(now.getMonth() + 1).padStart(2, '0');
            const d = String(now.getDate()).padStart(2, '0');

            // تحديد اسم الملف حسب خيار المستخدم (شهري / يومي / موحد)
            let fileName = 'ProAccountant_Syria_Backup.json';
            if (db.settings.driveDailyFile !== false) {
                fileName = `ProAccountant_Syria_${y}-${m}-${d}.json`;
            } else if (db.settings.driveMonthlyFile) {
                fileName = `ProAccountant_Syria_${y}-${m}.json`;
            }

            const statusBadge = document.getElementById('drive-sync-status-badge');
            if (statusBadge) {
                statusBadge.textContent = '[جاري المزامنة...]';
                statusBadge.className = 'text-amber-600 font-extrabold';
            }

            const validated = PA_CORE.validateDatabaseBackup(db);
            if (!validated.ok) {
                if (manual) showToast(`تعذرت المزامنة: ${validated.error}`, 'error');
                return;
            }
            driveSyncInFlight = true;
            (async () => {
            let payload;
            try {
                const prepared = typeof window.paPrepareBackupPayload === 'function'
                    ? await window.paPrepareBackupPayload(validated.data)
                    : { text: JSON.stringify(validated.data, null, 2), encrypted: false };
                payload = prepared.text;
                if (prepared.encrypted) fileName = fileName.replace(/\.json$/, '_enc.json');
            } catch (e) {
                onAndroidDriveSyncError('تعذر تجهيز النسخة');
                return;
            }
            if (window.AndroidNative && window.AndroidNative.uploadToDrive) {
                try {
                    if (window.AndroidNative.uploadToDrive(email, fileName, payload) === false) {
                        onAndroidDriveSyncError('تعذر بدء المزامنة');
                    }
                } catch (e) {
                    onAndroidDriveSyncError('تعذر بدء المزامنة');
                }
            } else if (window.pywebview && window.pywebview.api && typeof window.pywebview.api.upload_to_drive === 'function') {
                Promise.resolve(window.pywebview.api.upload_to_drive(email, fileName, payload))
                    .then(result => result === false ? onAndroidDriveSyncError('تعذر الاتصال بخدمة Drive') : onAndroidDriveSyncSuccess())
                    .catch(() => onAndroidDriveSyncError('تعذر الاتصال بخدمة Drive'));
            } else {
                onAndroidDriveSyncError('مزامنة Google Drive متاحة في تطبيق أندرويد فقط');
            }
            })();
        }

        async function onAndroidDriveSyncSuccess() {
            const ts = getFormattedTimestamp();
            const saved = await commitDatabaseMutation(() => {
                db.settings.driveLastSync = ts;
                db.settings.driveLastDaily = ts;
                return true;
            }, { skipDriveSync: true });
            driveSyncInFlight = false;
            if (driveSyncQueued) {
                driveSyncQueued = false;
                triggerDriveSyncNow(false);
            }
            if (!saved) return;
            if (driveScheduledPendingDate) {
                localStorage.setItem('LastAutoBackupDate', driveScheduledPendingDate);
                driveScheduledPendingDate = '';
            }

            const statusBadge = document.getElementById('drive-sync-status-badge');
            if (statusBadge) {
                statusBadge.textContent = '[تمت بنجاح]';
                statusBadge.className = 'text-emerald-600 font-extrabold';
            }
            if (document.getElementById('drive-last-sync-time')) {
                document.getElementById('drive-last-sync-time').textContent = ts;
            }
            if (document.getElementById('drive-last-daily-time')) {
                document.getElementById('drive-last-daily-time').textContent = ts;
            }
            if (db.settings.driveNotifications !== false) {
                showToast('تمت مزامنة البيانات على جوجل درايف بنجاح ✔', 'success');
            }
        }

        function onAndroidDriveSyncError(errMsg) {
            driveSyncInFlight = false;
            driveScheduledPendingDate = '';
            if (driveSyncQueued) {
                driveSyncQueued = false;
                triggerDriveSyncNow(false);
            }
            const statusBadge = document.getElementById('drive-sync-status-badge');
            if (statusBadge) {
                statusBadge.textContent = '[تعذرت المزامنة]';
                statusBadge.className = 'text-rose-600 font-extrabold';
            }
            if (db.settings.driveNotifications !== false) {
                showToast('تنبيه المزامنة: ' + errMsg, 'error');
            }
        }

        // فحص مؤقت الحفظ التلقائي اليومي كل دقيقة
        setInterval(() => {
            if (!db.settings.driveScheduledEnabled || !db.settings.driveEmail) return;
            const now = new Date();
            const currentHHMM = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
            const targetTime = db.settings.driveScheduledTime || '00:30';
            const todayKey = PA_CORE.getLocalDateString(now);

            if (currentHHMM === targetTime && localStorage.getItem('LastAutoBackupDate') !== todayKey) {
                driveScheduledPendingDate = todayKey;
                triggerDriveSyncNow(false);
            }
        }, 30000);

        async function bootApplication() {
            if (appBootStarted) return;
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', bootApplication, { once: true });
                return;
            }
            appBootStarted = true;
            await loadDatabase();
            await initializeAppUI();
        }

        window.addEventListener('pywebviewready', function() {
            bootApplication();
        });

        window.addEventListener('androidnative-ready', async function() {
            if (window.pywebview) return;
            if (!appBootStarted) return bootApplication();
            if (loadedFromNative || (appUIReady && databaseMutationInProgress)) return;
            await loadDatabase();
            if (appUIReady) {
                isAppUnlockedThisSession = false;
                await initializeAppUI();
                showToast('تمت مزامنة البيانات مع تخزين أندرويد', 'info');
            }
        });

        window.onload = async function() {
            if (!window.pywebview) await bootApplication();
        };

        function seedInitialDefaults() {
            db.accounts = [
                { id: 'acc_cash_client', name: 'زبون نقدي عام', type: 'customer', phone: '-', address: '-', openingBalance: 0 },
                { id: 'acc_1', name: 'أحمد المحمد', type: 'customer', phone: '0933112233', address: 'دمشق', openingBalance: 50 },
                { id: 'acc_2', name: 'شركة التقنية الحديثة', type: 'supplier', phone: '0944556677', address: 'حلب', openingBalance: -200 }
            ];
            db.items = [
                { id: 'itm_1', code: 'RTR-01', name: 'راوتر TP-Link ثنائي الهوائي', category: 'شبكات', type: 'stock', cost: 18, price: 25, qty: 12, minQty: 3 },
                { id: 'itm_2', code: 'CBL-100', name: 'كبل شبكة Cat6 (متر)', category: 'كابلات', type: 'stock', cost: 0.3, price: 0.5, qty: 300, minQty: 50 },
                { id: 'itm_3', code: 'SUB-4M', name: 'اشتراك إنترنت شهري 4 ميغا', category: 'خدمات', type: 'service', cost: 5, price: 10, qty: 0, minQty: 0 }
            ];
            if (!Array.isArray(db.returns)) db.returns = [];
            if (typeof ensureExtendedStores === 'function') ensureExtendedStores();
        }

        function switchTab(tabName) {
            const invoiceTab = tabName === 'sales' || tabName === 'purchases';
            if (invoiceTab) {
                const nextMode = tabName === 'sales' ? 'sales' : 'purchase';
                const hasDraft = Array.from(document.querySelectorAll('#invoice-items-body tr')).some(row => row.querySelector('.row-item-select')?.value)
                    || Number(document.getElementById('inv-discount')?.value || 0) !== 0
                    || !!document.getElementById('inv-notes')?.value.trim();
                if (currentInvoiceMode !== nextMode && hasDraft
                    && !window.confirm('سيتم مسح بنود الفاتورة الحالية عند التحويل بين المبيعات والمشتريات. هل تريد المتابعة؟')) return false;
                if (currentInvoiceMode !== nextMode) {
                    currentInvoiceMode = nextMode;
                    resetInvoiceForm();
                }
            }

            document.querySelectorAll('.amin-btn').forEach(btn => btn.classList.remove('active'));
            const activeBtn = document.getElementById('tab-' + tabName);
            if (activeBtn) activeBtn.classList.add('active');

            ['view-home', 'view-invoice', 'view-returns', 'view-vouchers', 'view-items', 'view-barcodes', 'view-accounts', 'view-reports', 'view-eod', 'view-cashboxes', 'view-employees', 'view-profit', 'view-settings'].forEach(id => {
                document.getElementById(id).classList.add('hidden');
            });

            if (invoiceTab) {
                document.getElementById('view-invoice').classList.remove('hidden');
                setupInvoiceModeUI();
            } else {
                document.getElementById('view-' + tabName).classList.remove('hidden');
                if (tabName === 'reports') renderReportsView();
                if (tabName === 'vouchers') renderVouchersView();
                if (tabName === 'returns') renderReturnsView();
                if (tabName === 'eod') { renderDetailedInvoicesReport(); renderEndOfDayReport(); }
                if (tabName === 'cashboxes') renderCashboxesAndExpensesView();
                if (tabName === 'employees') renderEmployeesAndInstallmentsView();
                if (tabName === 'profit') renderProfitAndReportsHub();
            }
            return true;
        }

        function handleGlobalShortcuts(e) {
            if (e.key === 'F2') {
                e.preventDefault();
                if (!document.getElementById('view-invoice').classList.contains('hidden')) saveInvoice();
            } else if (e.key === 'F4') {
                e.preventDefault();
                if (!document.getElementById('view-invoice').classList.contains('hidden')) saveAndPrintInvoice('a4');
            } else if (e.key === 'Escape') {
                if (!document.getElementById('quick-account-modal').classList.contains('hidden')) {
                    closeQuickAccountModal();
                } else if (!document.getElementById('smart-alerts-modal').classList.contains('hidden')) {
                    document.getElementById('smart-alerts-modal').classList.add('hidden');
                } else if (!document.getElementById('view-invoice').classList.contains('hidden')) {
                    resetInvoiceForm();
                    showToast('تم تصفير حقول الفاتورة لفاتورة جديدة', 'info');
                }
            }
        }

        function setupInvoiceModeUI() {
            const banner = document.getElementById('invoice-header-banner');
            const badge = document.getElementById('invoice-type-badge');
            const accLabel = document.getElementById('inv-account-label');

            if (currentInvoiceMode === 'sales') {
                banner.className = 'bg-emerald-950/60 border-b border-emerald-500/30 px-4 py-3 flex flex-wrap items-center justify-between gap-3';
                badge.className = 'bg-emerald-500 text-slate-950 font-black px-3 py-1 rounded-lg text-sm';
                badge.textContent = 'فاتورة مبيعات';
                accLabel.textContent = 'الزبون / العميل';
            } else {
                banner.className = 'bg-sky-950/60 border-b border-sky-500/30 px-4 py-3 flex flex-wrap items-center justify-between gap-3';
                badge.className = 'bg-sky-400 text-slate-950 font-black px-3 py-1 rounded-lg text-sm';
                badge.textContent = 'فاتورة مشتريات (إدخال مستودع)';
                accLabel.textContent = 'المورد / الشركة';
            }

            updateNextInvoiceNumber();
            populateAccountDropdowns();
        }

        function updateNextInvoiceNumber() {
            const sameType = db.invoices.filter(i => i.type === currentInvoiceMode);
            const nextNum = PA_CORE.nextDocumentNumber(sameType, '#', currentInvoiceMode === 'sales' ? 1001 : 2001);
            document.getElementById('inv-number').textContent = nextNum;
        }

        function resetInvoiceForm() {
            invoiceDraftRevision += 1;
            updateNextInvoiceNumber();
            const defPay = (db.settings && db.settings.defaultPaymentType) || 'cash';
            const defCur = (db.settings && db.settings.defaultCurrency) || 'USD';
            document.getElementById('inv-date').value = PA_CORE.getLocalDateString();
            document.getElementById('voucher-date').value = PA_CORE.getLocalDateString();
            document.getElementById('inv-payment-type').value = defPay;
            const curEl = document.getElementById('inv-currency');
            if (curEl) curEl.value = defCur;
            document.getElementById('inv-discount').value = 0;
            document.getElementById('inv-notes').value = '';
            document.getElementById('smart-input-box').value = '';
            const downEl = document.getElementById('inst-down-payment');
            if (downEl) downEl.value = 0;
            const recEl = document.getElementById('inv-receipt-no');
            if (recEl) recEl.value = '';
            
            const tbody = document.getElementById('invoice-items-body');
            tbody.innerHTML = '';
            addInvoiceRow(false);
            recalculateInvoice();
            if (typeof recalculateInstallmentPlan === 'function') recalculateInstallmentPlan();
        }

        function addInvoiceRow(focusNew = true) {
            const tbody = document.getElementById('invoice-items-body');
            const rowIndex = tbody.children.length + 1;
            const tr = document.createElement('tr');
            tr.className = 'hover:bg-slate-700/30 transition';

            let itemsOptions = `<option value="">-- اختر مادة أو خدمة --</option>`;
            db.items.forEach(itm => {
                itemsOptions += `<option value="${PA_CORE.escapeHtml(itm.id)}">${PA_CORE.escapeHtml(itm.name)}</option>`;
            });

            tr.innerHTML = `
                <td class="invoice-row-number"><span class="invoice-field-label">البند</span><span class="row-index">${rowIndex}</span></td>
                <td class="invoice-row-item">
                    <select class="amin-input w-full font-bold row-item-select" aria-label="الصنف"
                        onchange="onRowItemSelect(this)" onkeydown="handleRowKey(event, this, 'qty')">
                        ${itemsOptions}
                    </select>
                </td>
                <td class="invoice-row-stock"><span class="invoice-field-label">المتوفر</span><span class="row-stock">-</span></td>
                <td class="invoice-row-qty">
                    <label class="invoice-field-label">الكمية</label>
                    <input type="number" value="1" min="0.001" step="0.001" inputmode="decimal" aria-label="الكمية"
                        class="amin-input w-full text-center font-bold row-qty"
                        oninput="recalculateInvoice()" onkeydown="handleRowKey(event, this, 'price')">
                </td>
                <td class="invoice-row-price">
                    <label class="invoice-field-label row-price-label">السعر</label>
                    <input type="number" value="0" min="0" step="any" inputmode="decimal" aria-label="السعر الإفرادي"
                        class="amin-input w-full text-center font-bold row-price"
                        oninput="recalculateInvoice()" onkeydown="handleRowKey(event, this, 'note')">
                </td>
                <td class="invoice-row-total"><span class="invoice-field-label">المجموع</span><strong class="row-subtotal">0.00</strong></td>
                <td class="invoice-row-note">
                    <input type="text" placeholder="ملاحظة على البند (اختياري)" aria-label="ملاحظة البند"
                        class="amin-input w-full row-note" onkeydown="handleRowKey(event, this, 'nextRow')">
                </td>
                <td class="invoice-row-delete">
                    <button type="button" onclick="removeInvoiceRow(this)" aria-label="حذف البند">✕</button>
                </td>
            `;

            tbody.appendChild(tr);
            if (focusNew) tr.querySelector('.row-item-select').focus();
            return tr;
        }

        function handleRowKey(e, el, nextTarget) {
            if (e.key === 'Enter') {
                e.preventDefault();
                const tr = el.closest('tr');
                if (nextTarget === 'qty') tr.querySelector('.row-qty').focus();
                else if (nextTarget === 'price') tr.querySelector('.row-price').focus();
                else if (nextTarget === 'note') tr.querySelector('.row-note').focus();
                else if (nextTarget === 'nextRow') {
                    const nextTr = tr.nextElementSibling;
                    if (nextTr) nextTr.querySelector('.row-item-select').focus();
                    else addInvoiceRow(true);
                }
            }
        }

        function onRowItemSelect(selectEl) {
            const tr = selectEl.closest('tr');
            const item = db.items.find(i => i.id === selectEl.value);
            const stockCell = tr.querySelector('.row-stock');
            const priceInput = tr.querySelector('.row-price');
            const currency = document.getElementById('inv-currency').value;
            const rate = db.settings.exchangeRate || 15000;

            if (!item) {
                stockCell.textContent = '-';
                priceInput.value = 0;
                recalculateInvoice();
                return;
            }

            if (item.type === 'service') {
                stockCell.innerHTML = `<span class="text-purple-400">خدمة</span>`;
            } else {
                const colorClass = Number(item.qty || 0) <= Number(item.minQty || 0) ? 'text-rose-400 font-bold' : 'text-emerald-400';
                stockCell.innerHTML = `<span class="${colorClass}">${Number(item.qty || 0)}</span>`;
            }

            const baseUSD = currentInvoiceMode === 'sales' ? item.price : item.cost;
            priceInput.value = currency === 'USD' ? baseUSD : Math.round(baseUSD * rate);
            tr.dataset.priceUSD = String(baseUSD);
            recalculateInvoice();
        }

        function removeInvoiceRow(btn) {
            const tbody = document.getElementById('invoice-items-body');
            if (tbody.children.length > 1) {
                btn.closest('tr').remove();
                Array.from(tbody.children).forEach((row, idx) => {
                    row.querySelector('.row-index').textContent = idx + 1;
                });
                recalculateInvoice();
            }
        }

        function handleInvoiceCurrencyChange() {
            const currencySelect = document.getElementById('inv-currency');
            const currency = currencySelect.value;
            const previousCurrency = currencySelect.dataset.currency || currency;
            const rate = Number(db.settings.exchangeRate) || 15000;
            const discountInput = document.getElementById('inv-discount');
            const discount = Number(discountInput.value) || 0;
            if (currency !== previousCurrency) {
                discountInput.value = currency === 'USD' ? discount / rate : Math.round(discount * rate);
            }
            document.querySelectorAll('#invoice-items-body tr').forEach(tr => {
                const itemId = tr.querySelector('.row-item-select').value;
                const priceInput = tr.querySelector('.row-price');
                const storedUSD = Number(tr.dataset.priceUSD);
                if (!itemId || !Number.isFinite(storedUSD)) return;
                priceInput.value = currency === 'USD' ? storedUSD : Math.round(storedUSD * rate);
            });
            recalculateInvoice();
        }

        function recalculateInvoice() {
            const currencySelect = document.getElementById('inv-currency');
            const currency = currencySelect.value;
            currencySelect.dataset.currency = currency;
            const symbol = currency === 'USD' ? '$' : 'ل.س';
            document.getElementById('inv-discount-label').textContent = `الخصم (${symbol})`;
            const rate = db.settings.exchangeRate || 15000;
            let subtotalOrig = 0;

            document.querySelectorAll('#invoice-items-body tr').forEach(tr => {
                const itemId = tr.querySelector('.row-item-select').value;
                const qty = parseFloat(tr.querySelector('.row-qty').value) || 0;
                const price = parseFloat(tr.querySelector('.row-price').value) || 0;
                const rowSub = qty * price;
                if (itemId) tr.dataset.priceUSD = String(currency === 'USD' ? price : price / rate);
                tr.querySelector('.row-price-label').textContent = `السعر (${symbol})`;
                tr.querySelector('.row-subtotal').textContent = currency === 'USD' ? '$' + rowSub.toFixed(2) : Math.round(rowSub).toLocaleString('en-US') + ' ل.س';
                if (itemId) subtotalOrig += rowSub;
            });

            const discount = parseFloat(document.getElementById('inv-discount').value) || 0;
            const netOrig = Math.max(0, subtotalOrig - discount);

            let totalUSD = currency === 'USD' ? netOrig : (netOrig / rate);
            let totalSYP = currency === 'SYP' ? netOrig : (netOrig * rate);

            document.getElementById('inv-total-usd').textContent = '$' + totalUSD.toFixed(2);
            document.getElementById('inv-total-syp').textContent = Math.round(totalSYP).toLocaleString() + ' ل.س';
        }

        function handlePaymentTypeChange() {
            const pType = document.getElementById('inv-payment-type').value;
            const accSelect = document.getElementById('inv-account-select');
            if (pType === 'credit' && accSelect.value === 'acc_cash_client') {
                const firstNamed = db.accounts.find(a => a.id !== 'acc_cash_client');
                if (firstNamed) accSelect.value = firstNamed.id;
                showToast('تم التحويل إلى آجل: يرجى التأكد من اسم العميل', 'info');
            }
        }

        function parseSmartCommand() {
            const input = document.getElementById('smart-input-box').value.trim();
            if (!input) return;

            if (input.includes('شراء') || input.includes('مشتريات') || input.includes('توريد')) {
                if (switchTab('purchases') === false) return;
            } else if (input.includes('بيع') || input.includes('مبيع')) {
                if (switchTab('sales') === false) return;
            }

            if (input.includes('آجل') || input.includes('اجل') || input.includes('دين') || input.includes('ذمم')) {
                document.getElementById('inv-payment-type').value = 'credit';
            } else if (input.includes('نقد') || input.includes('كاش')) {
                document.getElementById('inv-payment-type').value = 'cash';
            }

            let extractedPrice = null;
            const priceMatch = input.match(/(?:بسعر|سعر)\s*(\d+(?:\.\d+)?)/);
            if (priceMatch) extractedPrice = parseFloat(priceMatch[1]);

            let extractedQty = 1;
            const cleanForQty = input.replace(/(?:بسعر|سعر)\s*\d+(?:\.\d+)?/, '');
            const qtyMatch = cleanForQty.match(/(\d+(?:\.\d+)?)/);
            if (qtyMatch) extractedQty = parseFloat(qtyMatch[1]);

            let matchedAccount = null;
            for (const acc of db.accounts) {
                if (acc.id === 'acc_cash_client') continue;
                const firstWord = acc.name.split(' ')[0];
                if (input.includes(acc.name) || (firstWord.length >= 3 && input.includes(firstWord))) {
                    matchedAccount = acc;
                    break;
                }
            }
            if (matchedAccount) document.getElementById('inv-account-select').value = matchedAccount.id;

            let matchedItem = null;
            for (const itm of db.items) {
                const words = itm.name.split(' ').filter(w => w.length >= 3);
                if (input.includes(itm.name) || words.some(w => input.includes(w))) {
                    matchedItem = itm;
                    break;
                }
            }

            if (matchedItem) {
                let targetRow = Array.from(document.querySelectorAll('#invoice-items-body tr')).find(tr => !tr.querySelector('.row-item-select').value);
                if (!targetRow) targetRow = addInvoiceRow(false);

                const sel = targetRow.querySelector('.row-item-select');
                sel.value = matchedItem.id;
                onRowItemSelect(sel);

                targetRow.querySelector('.row-qty').value = extractedQty;
                if (extractedPrice !== null) targetRow.querySelector('.row-price').value = extractedPrice;
                recalculateInvoice();
                document.getElementById('smart-input-box').value = '';
                showToast(`تمت تعبئة: ${extractedQty} × ${matchedItem.name} بنجاح ⚡`, 'success');
            } else {
                showToast('لم يتم التعرف على اسم المادة في الجملة، تأكد من وجودها في بطاقة المواد', 'error');
            }
        }

        function saveInvoice() {
            const paymentType = document.getElementById('inv-payment-type').value;
            const accountId = document.getElementById('inv-account-select').value;
            const date = document.getElementById('inv-date').value;
            const currency = document.getElementById('inv-currency').value;
            const rate = Number(db.settings.exchangeRate);
            const discount = Number(document.getElementById('inv-discount').value);
            const notes = document.getElementById('inv-notes').value.trim();

            if (!Number.isFinite(rate) || rate <= 0) {
                showToast('سعر الصرف غير صالح. يرجى تصحيحه من الإعدادات.', 'error');
                return null;
            }
            if (!Number.isFinite(discount) || discount < 0) {
                showToast('يرجى إدخال حسم صحيح أكبر من أو يساوي الصفر', 'error');
                return null;
            }
            if (!accountId || !db.accounts.some(account => account.id === accountId)) {
                showToast('يرجى اختيار حساب العميل أو المورد للفاتورة', 'error');
                return null;
            }
            const account = db.accounts.find(entry => entry.id === accountId);
            const expectedType = currentInvoiceMode === 'sales' ? 'customer' : 'supplier';
            if (account.type && account.type !== expectedType && account.type !== 'both') {
                showToast(currentInvoiceMode === 'sales' ? 'فاتورة المبيعات تتطلب حساب عميل' : 'فاتورة المشتريات تتطلب حساب مورد', 'error');
                return null;
            }
            if (!date || !PA_CORE.shiftDateByInterval(date, 'monthly', 0)) {
                showToast('يرجى إدخال تاريخ صحيح للفاتورة', 'error');
                return null;
            }
            if (paymentType === 'credit' && accountId === 'acc_cash_client') {
                showToast('لا يمكن حفظ فاتورة آجلة على (زبون نقدي عام)! يرجى اختيار اسم العميل.', 'error');
                return null;
            }

            let lines = [];
            let subtotalOrig = 0;

            for (const tr of document.querySelectorAll('#invoice-items-body tr')) {
                const itemId = tr.querySelector('.row-item-select').value;
                const qty = Number(tr.querySelector('.row-qty').value);
                const priceOrig = Number(tr.querySelector('.row-price').value);
                const rowNote = tr.querySelector('.row-note').value.trim();

                if (itemId && (!PA_CORE.isValidQuantity(qty) || !Number.isFinite(priceOrig) || priceOrig < 0)) {
                    showToast('يرجى إدخال كمية موجبة بثلاث خانات عشرية كحد أقصى وسعر صحيح', 'error');
                    return null;
                }

                if (itemId && qty > 0) {
                    const itemObj = db.items.find(i => i.id === itemId);
                    if (!itemObj) {
                        showToast('إحدى المواد المختارة لم تعد موجودة', 'error');
                        return null;
                    }
                    const subOrig = qty * priceOrig;
                    subtotalOrig += subOrig;
                    lines.push({
                        itemId,
                        itemName: itemObj ? itemObj.name : 'مادة',
                        qty,
                        priceOrig,
                        priceUSD: currency === 'USD' ? priceOrig : (priceOrig / rate),
                        costUSD: currentInvoiceMode === 'purchase' ? (currency === 'USD' ? priceOrig : priceOrig / rate) : (Number(itemObj.cost) || 0),
                        subOrig,
                        note: rowNote
                    });
                }
            }

            if (lines.length === 0) {
                showToast('يرجى إدخال مادة واحدة على الأقل في الفاتورة!', 'error');
                return null;
            }
            lines = PA_CORE.mergeInvoiceLines(lines);

            const insufficient = PA_CORE.findInsufficientStock(lines, db.items, currentInvoiceMode);
            if (insufficient) {
                showToast(`الرصيد المتوفر من «${insufficient.itemName}» هو ${insufficient.available} فقط، والكمية المطلوبة ${insufficient.requested}.`, 'error');
                return null;
            }

            if (discount > subtotalOrig + 1e-9) {
                showToast('الحسم لا يمكن أن يتجاوز إجمالي بنود الفاتورة', 'error');
                return null;
            }
            const netOrig = Math.max(0, subtotalOrig - discount);
            const totalUSD = currency === 'USD' ? netOrig : (netOrig / rate);
            const totalSYP = currency === 'SYP' ? netOrig : (netOrig * rate);
            if (![subtotalOrig, netOrig, totalUSD, totalSYP].every(Number.isFinite)) {
                showToast('قيم الفاتورة كبيرة أو غير صالحة', 'error');
                return null;
            }

            if (currentInvoiceMode === 'purchase') {
                const discountUSD = currency === 'USD' ? discount : discount / rate;
                const allocations = PA_CORE.distributeMoneyProportionally(discountUSD, lines.map(line => line.subOrig));
                lines.forEach((line, index) => {
                    line.discountUSD = allocations[index];
                    line.costUSD = Math.max(0, line.priceUSD - allocations[index] / line.qty);
                });
            }

            lines.forEach(line => {
                const itemObj = db.items.find(i => i.id === line.itemId);
                if (itemObj && itemObj.type === 'stock') {
                    if (currentInvoiceMode === 'sales') {
                        itemObj.qty = Number((itemObj.qty - line.qty).toFixed(6));
                    } else {
                        itemObj.qty = Number((itemObj.qty + line.qty).toFixed(6));
                        itemObj.cost = line.costUSD;
                    }
                }
            });

            const invNumber = document.getElementById('inv-number').textContent;
            const invoiceRecord = {
                id: 'inv_' + Date.now(),
                number: invNumber,
                type: currentInvoiceMode,
                paymentType,
                accountId,
                date,
                currency,
                rate,
                items: lines,
                discount,
                totalUSD: parseFloat(totalUSD.toFixed(2)),
                totalSYP: Math.round(totalSYP),
                notes
            };

            db.invoices.unshift(invoiceRecord);
            return invoiceRecord;
        }

        async function saveAndPrintInvoice(format) {
            const saved = await saveInvoice(true);
            if (saved) printInvoiceById(saved.id, format);
        }

        async function saveVoucher() {
            const type = document.getElementById('voucher-type').value;
            const accountId = document.getElementById('voucher-account').value;
            const returnId = document.getElementById('voucher-return')?.value || '';
            const payMethod = document.getElementById('voucher-pay-method')?.value || 'cash_pay';
            const cashboxId = payMethod === 'cash_pay' ? document.getElementById('voucher-cashbox')?.value : '';
            const origAmount = Number(document.getElementById('voucher-amount').value);
            const currency = document.getElementById('voucher-currency').value;
            const date = document.getElementById('voucher-date').value;
            const note = document.getElementById('voucher-note').value.trim();
            const rate = Number(db.settings.exchangeRate);

            if (!accountId || accountId === 'acc_cash_client') {
                showToast('يرجى اختيار اسم العميل أو المورد للسند', 'error');
                return;
            }
            const account = db.accounts.find(entry => entry.id === accountId);
            const selectedReturn = returnId ? db.returns.find(entry => entry.id === returnId) : null;
            const normalDirectionInvalid = (type === 'receipt' && account?.type === 'supplier')
                || (type === 'payment' && account?.type === 'customer');
            if (normalDirectionInvalid && !selectedReturn) {
                showToast(type === 'receipt' ? 'سند القبض يجب أن يكون من حساب عميل أو حساب مشترك' : 'سند الدفع يجب أن يكون إلى حساب مورد أو حساب مشترك', 'error');
                return;
            }
            if (selectedReturn && (selectedReturn.accountId !== accountId || type !== PA_CORE.refundVoucherTypeForReturn(selectedReturn))) {
                showToast('نوع السند أو الحساب لا يطابق المرتجع المحدد', 'error');
                return;
            }
            if (payMethod === 'cash_pay' && (!cashboxId || !db.cashboxes.some(c => c.id === cashboxId))) {
                showToast('يرجى اختيار صندوق صالح للسند النقدي', 'error');
                return;
            }
            if (!date || !PA_CORE.shiftDateByInterval(date, 'monthly', 0)) {
                showToast('يرجى إدخال تاريخ صحيح للسند', 'error');
                return;
            }
            if (!Number.isFinite(origAmount) || origAmount <= 0) {
                showToast('يرجى إدخال مبلغ صحيح أكبر من الصفر', 'error');
                return;
            }
            if (!Number.isFinite(rate) || rate <= 0) {
                showToast('سعر الصرف غير صالح. يرجى تصحيحه من الإعدادات.', 'error');
                return;
            }

            const amountUSD = PA_CORE.roundMoney(currency === 'USD' ? origAmount : (origAmount / rate));
            if (amountUSD <= 0) {
                showToast('مبلغ السند بعد التحويل أصغر من أصغر وحدة نقدية', 'error');
                return;
            }
            const prefix = type === 'receipt' ? 'RCV-' : 'PAY-';
            const voucherNum = PA_CORE.nextDocumentNumber(db.vouchers.filter(entry => entry.type === type), prefix, 101);

            const voucher = await commitDatabaseMutation(() => {
                if (returnId) {
                    const returnRecord = db.returns.find(entry => entry.id === returnId);
                    if (!returnRecord || returnRecord.accountId !== accountId || type !== PA_CORE.refundVoucherTypeForReturn(returnRecord)) {
                        throw new Error('بيانات تسوية المرتجع تغيرت؛ يرجى إعادة اختيارها');
                    }
                    if (PA_CORE.isSettledReturn(returnRecord, db.invoices)) {
                        throw new Error('هذا المرتجع مسترد نقداً ولا يقبل تسوية بسند آخر');
                    }
                    const remainingReturnUSD = Math.max(0, Number(returnRecord.totalUSD) - PA_CORE.calculateReturnRefundedUSD(returnId, db.vouchers));
                    const balance = calculateAccountBalanceUSD(accountId);
                    const availableCreditUSD = type === 'payment' ? Math.max(0, -balance) : Math.max(0, balance);
                    const allowedUSD = Math.min(remainingReturnUSD, availableCreditUSD);
                    if (amountUSD > allowedUSD + 0.01) {
                        throw new Error(`أقصى مبلغ قابل للتسوية الآن هو $${allowedUSD.toFixed(2)}`);
                    }
                }
                const record = {
                    id: 'vch_' + Date.now(),
                    number: voucherNum,
                    type,
                    accountId,
                    cashboxId: cashboxId || undefined,
                    payMethod,
                    amountUSD,
                    origAmount,
                    currency,
                    rate,
                    date,
                    note,
                    ...(returnId ? { returnId, source: 'return_refund' } : {})
                };
                db.vouchers.unshift(record);
                return record;
            });
            if (!voucher) return;
            document.getElementById('voucher-amount').value = '';
            document.getElementById('voucher-note').value = '';
            refreshAllViews();
            showToast(`تم حفظ ${type === 'receipt' ? 'سند القبض' : 'سند الدفع'} رقم ${voucherNum}`, 'success');
        }

        function populateVoucherReturnOptions() {
            const select = document.getElementById('voucher-return');
            if (!select) return;
            const type = document.getElementById('voucher-type')?.value;
            const accountId = document.getElementById('voucher-account')?.value;
            const returnType = type === 'payment' ? 'sales_return' : 'purchase_return';
            const balance = calculateAccountBalanceUSD(accountId);
            const creditUSD = type === 'payment' ? Math.max(0, -balance) : Math.max(0, balance);
            const previous = select.value;
            const options = (db.returns || []).filter(record => {
                if (record.accountId !== accountId || record.type !== returnType || creditUSD <= 0) return false;
                if (PA_CORE.isSettledReturn(record, db.invoices)) return false;
                return PA_CORE.calculateReturnRefundedUSD(record.id, db.vouchers) < Number(record.totalUSD) - 0.009;
            }).map(record => {
                const remaining = Math.max(0, Number(record.totalUSD) - PA_CORE.calculateReturnRefundedUSD(record.id, db.vouchers));
                const allowed = Math.min(remaining, creditUSD);
                return `<option value="${PA_CORE.escapeHtml(record.id)}">${PA_CORE.escapeHtml(record.number)} - متاح $${allowed.toFixed(2)}</option>`;
            });
            select.innerHTML = '<option value="">بدون ربط بمرتجع</option>' + options.join('');
            if (options.some(option => option.includes(`value="${PA_CORE.escapeHtml(previous)}"`))) select.value = previous;
        }

        function renderVouchersView() {
            populateVoucherReturnOptions();
            const tbody = document.getElementById('vouchers-table-body');
            tbody.innerHTML = '';
            db.vouchers.forEach(v => {
                const acc = db.accounts.find(a => a.id === v.accountId);
                const cashbox = db.cashboxes.find(c => c.id === v.cashboxId);
                const badge = v.type === 'receipt'
                    ? `<span class="bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded text-xs font-bold">سند قبض</span>`
                    : `<span class="bg-rose-500/20 text-rose-300 px-2 py-0.5 rounded text-xs font-bold">سند دفع</span>`;
                tbody.innerHTML += `
                    <tr class="hover:bg-slate-700/30">
                        <td class="p-3 font-mono font-bold text-amber-400">${PA_CORE.escapeHtml(v.number)}</td>
                        <td class="p-3">${badge}</td>
                        <td class="p-3 text-slate-300">${PA_CORE.escapeHtml(v.date)}</td>
                        <td class="p-3 font-bold">${PA_CORE.escapeHtml(acc ? acc.name : 'محذوف')}</td>
                        <td class="p-3">${PA_CORE.escapeHtml(cashbox ? cashbox.name : '-')}</td>
                        <td class="p-3 font-mono font-bold text-emerald-400">$${Number(v.amountUSD || 0).toFixed(2)}</td>
                        <td class="p-3 text-slate-400 text-xs">${PA_CORE.escapeHtml(v.note || '-')}</td>
                        <td class="p-3 text-center">
                            <button onclick="printVoucherById('${PA_CORE.escapeHtml(v.id)}')" class="bg-slate-700 hover:bg-amber-500 hover:text-slate-950 px-2.5 py-1 rounded text-xs font-bold transition">🖨️ طباعة</button>
                        </td>
                    </tr>
                `;
            });
        }

        function toggleStockFields() {
            const type = document.getElementById('item-type').value;
            document.getElementById('stock-fields-wrapper').style.display = type === 'stock' ? 'grid' : 'none';
        }

        async function saveItemCard() {
            const editId = document.getElementById('item-edit-id').value;
            const name = document.getElementById('item-name').value.trim();
            const type = document.getElementById('item-type').value;
            const code = document.getElementById('item-code').value.trim();
            const cost = Number(document.getElementById('item-cost').value);
            const price = Number(document.getElementById('item-price').value);
            const qty = Number(document.getElementById('item-qty').value);
            const minQty = Number(document.getElementById('item-min-qty').value);

            if (!name) {
                showToast('يرجى إدخال اسم المادة أو الخدمة', 'error');
                return;
            }
            if (![cost, price, qty, minQty].every(Number.isFinite) || cost < 0 || price < 0 || qty < 0 || minQty < 0) {
                showToast('يرجى إدخال قيم رقمية صحيحة وغير سالبة للصنف', 'error');
                return;
            }

            if (code && db.items.some(item => item.id !== editId && item.code === code)) {
                showToast('رمز الباركود مستخدم لمادة أخرى', 'error');
                return;
            }
            const saved = await commitDatabaseMutation(() => {
                if (editId) {
                    const idx = db.items.findIndex(i => i.id === editId);
                    if (idx === -1) return null;
                    db.items[idx] = { ...db.items[idx], name, type, code, cost, price, qty, minQty };
                } else {
                    db.items.push({ id: 'itm_' + Date.now(), name, type, code, cost, price, qty, minQty });
                }
                return true;
            });
            if (!saved) return;
            clearItemForm();
            refreshAllViews();
            showToast(editId ? 'تم تعديل بطاقة المادة بنجاح' : 'تمت إضافة المادة الجديدة بنجاح', 'success');
        }

        function editItemCard(id) {
            const itm = db.items.find(i => i.id === id);
            if (!itm) return;
            document.getElementById('item-edit-id').value = itm.id;
            document.getElementById('item-name').value = itm.name;
            document.getElementById('item-type').value = itm.type;
            document.getElementById('item-code').value = itm.code || '';
            document.getElementById('item-cost').value = itm.cost;
            document.getElementById('item-price').value = itm.price;
            document.getElementById('item-qty').value = itm.qty;
            document.getElementById('item-min-qty').value = itm.minQty;
            toggleStockFields();
        }

        function clearItemForm() {
            document.getElementById('item-edit-id').value = '';
            document.getElementById('item-name').value = '';
            document.getElementById('item-code').value = '';
            document.getElementById('item-cost').value = 0;
            document.getElementById('item-price').value = 0;
            document.getElementById('item-qty').value = 0;
            document.getElementById('item-min-qty').value = 3;
            document.getElementById('item-type').value = 'stock';
            toggleStockFields();
        }

        function renderItemsTable() {
            const search = (document.getElementById('item-search')?.value || '').toLowerCase();
            const tbody = document.getElementById('items-table-body');
            const rate = db.settings.exchangeRate || 15000;
            tbody.innerHTML = '';

            db.items.filter(i => i.name.toLowerCase().includes(search)).forEach(itm => {
                const typeLabel = itm.type === 'stock'
                    ? `<span class="bg-sky-500/20 text-sky-300 px-2 py-0.5 rounded text-xs">مادة مخزنية</span>`
                    : `<span class="bg-purple-500/20 text-purple-300 px-2 py-0.5 rounded text-xs">خدمة / اشتراك</span>`;
                
                let stockBadge = '-';
                if (itm.type === 'stock') {
                    const isLow = Number(itm.qty || 0) <= Number(itm.minQty || 0);
                    stockBadge = `<span class="font-mono font-bold ${isLow ? 'text-rose-400' : 'text-emerald-400'}">${Number(itm.qty || 0)}</span>`;
                }

                tbody.innerHTML += `
                    <tr class="hover:bg-slate-700/30">
                        <td class="p-3 font-bold">${PA_CORE.escapeHtml(itm.name)}</td>
                        <td class="p-3">${typeLabel}</td>
                        <td class="p-3 font-mono text-slate-400">$${Number(itm.cost || 0).toFixed(2)}</td>
                        <td class="p-3 font-mono font-bold text-emerald-400">$${Number(itm.price || 0).toFixed(2)}</td>
                        <td class="p-3 font-mono text-amber-400">${Math.round(Number(itm.price || 0) * Number(rate || 0)).toLocaleString()} ل.س</td>
                        <td class="p-3">${stockBadge}</td>
                        <td class="p-3 text-center">
                            <button onclick="editItemCard('${PA_CORE.escapeHtml(itm.id)}')" class="bg-slate-700 hover:bg-amber-500 hover:text-slate-950 px-2.5 py-1 rounded text-xs font-bold transition">تعديل</button>
                        </td>
                    </tr>
                `;
            });
        }

        function calculateCashboxBalanceUSD(cashboxId) {
            return PA_CORE.calculateCashboxBalance(cashboxId, db);
        }

        function calculateAccountBalanceUSD(accountId) {
            return PA_CORE.calculateAccountBalanceUSD(db, accountId);
        }

        async function saveAccountCard() {
            const editId = document.getElementById('acc-edit-id').value;
            const name = document.getElementById('acc-name').value.trim();
            const type = document.getElementById('acc-type').value;
            const phone = document.getElementById('acc-phone').value.trim();
            const address = document.getElementById('acc-address').value.trim();
            const openingBalance = Number(document.getElementById('acc-opening').value);

            if (!name) {
                showToast('يرجى إدخال اسم الزبون أو المورد', 'error');
                return;
            }
            if (!Number.isFinite(openingBalance)) {
                showToast('يرجى إدخال رصيد افتتاحي رقمي صحيح', 'error');
                return;
            }

            const saved = await commitDatabaseMutation(() => {
                if (editId) {
                    const idx = db.accounts.findIndex(a => a.id === editId);
                    if (idx === -1) return null;
                    db.accounts[idx] = { ...db.accounts[idx], name, type, phone, address, openingBalance };
                } else {
                    db.accounts.push({ id: 'acc_' + Date.now(), name, type, phone, address, openingBalance });
                }
                return true;
            });
            if (!saved) return;
            clearAccountForm();
            refreshAllViews();
            showToast(editId ? 'تم تحديث بطاقة الحساب' : 'تمت إضافة الحساب الجديد بنجاح', 'success');
        }

        function editAccountCard(id) {
            const acc = db.accounts.find(a => a.id === id);
            if (!acc) return;
            document.getElementById('acc-edit-id').value = acc.id;
            document.getElementById('acc-name').value = acc.name;
            document.getElementById('acc-type').value = acc.type;
            document.getElementById('acc-phone').value = acc.phone || '';
            document.getElementById('acc-address').value = acc.address || '';
            document.getElementById('acc-opening').value = acc.openingBalance || 0;
        }

        function clearAccountForm() {
            document.getElementById('acc-edit-id').value = '';
            document.getElementById('acc-name').value = '';
            document.getElementById('acc-phone').value = '';
            document.getElementById('acc-address').value = '';
            document.getElementById('acc-opening').value = 0;
        }

        function renderAccountsTable() {
            const search = (document.getElementById('acc-search')?.value || '').toLowerCase();
            const tbody = document.getElementById('accounts-table-body');
            tbody.innerHTML = '';

            db.accounts.filter(a => a.name.toLowerCase().includes(search) || (a.phone && a.phone.includes(search))).forEach(acc => {
                const bal = calculateAccountBalanceUSD(acc.id);
                const typeMap = { customer: 'زبون', supplier: 'مورد', both: 'زبون ومورد' };
                let statusHtml = `<span class="text-slate-400">متوازن</span>`;
                if (bal > 0) statusHtml = `<span class="text-amber-400 font-bold">لنا عليه (مدين)</span>`;
                else if (bal < 0) statusHtml = `<span class="text-rose-400 font-bold">له علينا (دائن)</span>`;

                tbody.innerHTML += `
                    <tr class="hover:bg-slate-700/30">
                        <td class="p-3 font-bold">${PA_CORE.escapeHtml(acc.name)}</td>
                        <td class="p-3 text-xs text-slate-300">${typeMap[acc.type] || 'حساب'}</td>
                        <td class="p-3 font-mono text-xs">${PA_CORE.escapeHtml(acc.phone || '-')}</td>
                        <td class="p-3 font-mono font-bold ${bal > 0 ? 'text-amber-400' : (bal < 0 ? 'text-rose-400' : 'text-slate-300')}">$${Number(Math.abs(bal)).toFixed(2)}</td>
                        <td class="p-3 text-xs">${statusHtml}</td>
                        <td class="p-3 text-center flex justify-center gap-1">
                            <button onclick="viewAccountStatementDirect('${PA_CORE.escapeHtml(acc.id)}')" class="bg-sky-600/30 hover:bg-sky-600 text-sky-200 hover:text-white px-2 py-1 rounded text-xs font-bold transition">كشف حساب</button>
                            ${acc.id !== 'acc_cash_client' ? `<button onclick="editAccountCard('${PA_CORE.escapeHtml(acc.id)}')" class="bg-slate-700 hover:bg-amber-500 hover:text-slate-950 px-2 py-1 rounded text-xs font-bold transition">تعديل</button>` : ''}
                        </td>
                    </tr>
                `;
            });
        }

        function openQuickAccountModal() {
            document.getElementById('quick-acc-name').value = '';
            document.getElementById('quick-acc-phone').value = '';
            document.getElementById('quick-acc-type').value = currentInvoiceMode === 'sales' ? 'customer' : 'supplier';
            document.getElementById('quick-account-modal').classList.remove('hidden');
            document.getElementById('quick-acc-name').focus();
        }
        function closeQuickAccountModal() {
            document.getElementById('quick-account-modal').classList.add('hidden');
        }
        async function saveQuickAccount() {
            const name = document.getElementById('quick-acc-name').value.trim();
            if (!name) return;
            const newAcc = {
                id: 'acc_' + Date.now(),
                name,
                type: document.getElementById('quick-acc-type').value,
                phone: document.getElementById('quick-acc-phone').value.trim(),
                address: '',
                openingBalance: 0
            };
            const saved = await commitDatabaseMutation(() => {
                db.accounts.push(newAcc);
                return newAcc;
            });
            if (!saved) return;
            populateAccountDropdowns();
            document.getElementById('inv-account-select').value = newAcc.id;
            closeQuickAccountModal();
            showToast(`تمت إضافة "${name}" واختياره`, 'success');
        }

        function viewAccountStatementDirect(accountId) {
            switchTab('reports');
            document.getElementById('statement-account-select').value = accountId;
            renderAccountStatement();
        }

        function renderReportsView() {
            const profit = PA_CORE.calculateProfit(db);
            const totalSales = profit.sales;
            const totalPurchases = profit.purchases;
            const estimatedCostOfGoodsSold = profit.costOfSales;

            let receivables = 0;
            let payables = 0;
            db.accounts.forEach(acc => {
                if (acc.id === 'acc_cash_client') return;
                const bal = calculateAccountBalanceUSD(acc.id);
                if (bal > 0) receivables += bal;
                else if (bal < 0) payables += Math.abs(bal);
            });

            const netProfit = totalSales - estimatedCostOfGoodsSold;

            document.getElementById('rep-total-sales').textContent = '$' + totalSales.toFixed(2);
            document.getElementById('rep-total-purchases').textContent = '$' + totalPurchases.toFixed(2);
            document.getElementById('rep-receivables').textContent = '$' + receivables.toFixed(2);
            document.getElementById('rep-payables').textContent = '$' + payables.toFixed(2);
            document.getElementById('rep-net-profit').textContent = '$' + netProfit.toFixed(2);

            const invBody = document.getElementById('inventory-report-body');
            invBody.innerHTML = '';
            let totalStockCostVal = 0;

            db.items.filter(i => i.type === 'stock').forEach(itm => {
                const rowVal = Number(itm.qty || 0) * Number(itm.cost || 0);
                totalStockCostVal += rowVal;
                const status = Number(itm.qty || 0) <= Number(itm.minQty || 0)
                    ? `<span class="bg-rose-500/20 text-rose-300 px-2 py-0.5 rounded text-xs font-bold">⚠️ قارب على النفاد</span>`
                    : `<span class="bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded text-xs">متوفر</span>`;

                invBody.innerHTML += `
                    <tr class="hover:bg-slate-700/30">
                        <td class="p-3 font-bold">${PA_CORE.escapeHtml(itm.name)}</td>
                        <td class="p-3 font-mono font-bold">${Number(itm.qty || 0)}</td>
                        <td class="p-3 font-mono">$${Number(itm.cost || 0).toFixed(2)}</td>
                        <td class="p-3 font-mono text-amber-400 font-bold">$${Number(rowVal).toFixed(2)}</td>
                        <td class="p-3 font-mono text-emerald-400">$${Number(itm.price || 0).toFixed(2)}</td>
                        <td class="p-3">${status}</td>
                    </tr>
                `;
            });
            document.getElementById('inventory-total-value').textContent = `قيمة المخزون بالتكلفة: $${totalStockCostVal.toFixed(2)}`;

            renderAccountStatement();
        }

        function getAccountStatementRows(accountId) {
            const acc = db.accounts.find(a => a.id === accountId);
            if (!acc) return [];

            const events = [];
            if (acc.openingBalance !== 0) {
                events.push({
                    date: '0000-00-00',
                    displayDate: 'افتتاحي',
                    ref: '-',
                    desc: 'رصيد افتتاحي سابق',
                    debit: acc.openingBalance > 0 ? acc.openingBalance : 0,
                    credit: acc.openingBalance < 0 ? Math.abs(acc.openingBalance) : 0
                });
            }

            db.invoices.filter(i => i.accountId === accountId).forEach(inv => {
                if (inv.type === 'sales') {
                    events.push({
                        date: inv.date,
                        displayDate: inv.date,
                        ref: inv.number,
                        desc: `فاتورة مبيعات (${inv.paymentType === 'cash' ? 'نقدي' : (inv.paymentType === 'installment' ? 'تقسيط' : 'آجل')})`,
                        debit: inv.totalUSD,
                        credit: inv.paymentType === 'cash' ? inv.totalUSD : 0
                    });
                } else {
                    events.push({
                        date: inv.date,
                        displayDate: inv.date,
                        ref: inv.number,
                        desc: `فاتورة مشتريات (${inv.paymentType === 'cash' ? 'نقدي' : (inv.paymentType === 'installment' ? 'تقسيط' : 'آجل')})`,
                        debit: inv.paymentType === 'cash' ? inv.totalUSD : 0,
                        credit: inv.totalUSD
                    });
                }
            });

            db.vouchers.filter(v => v.accountId === accountId).forEach(v => {
                const method = PA_CORE.isCashPayment(v) ? 'نقدي' : (v.payMethod === 'card_check' ? 'بطاقة/شيكة' : 'تحويل بنكي');
                events.push({
                    date: v.date,
                    displayDate: v.date,
                    ref: v.number,
                    desc: `${v.type === 'receipt' ? 'سند قبض' : 'سند دفع'} ${method} ${v.note ? '- ' + v.note : ''}`,
                    debit: v.type === 'payment' ? v.amountUSD : 0,
                    credit: v.type === 'receipt' ? v.amountUSD : 0
                });
            });

            (db.returns || []).filter(r => r.accountId === accountId && !PA_CORE.isSettledReturn(r, db.invoices)).forEach(r => {
                const amt = Number(r.totalUSD) || 0;
                events.push({
                    date: r.date,
                    displayDate: r.date,
                    ref: r.number,
                    desc: `${r.type === 'sales_return' ? 'مرتجع مبيعات' : 'مرتجع مشتريات'}: ${r.itemName} (${r.qty}) ${r.note ? '- ' + r.note : ''}`,
                    debit: r.type === 'purchase_return' ? amt : 0,
                    credit: r.type === 'sales_return' ? amt : 0
                });
            });

            events.sort((a, b) => a.date.localeCompare(b.date));

            let running = 0;
            return events.map(ev => {
                running = parseFloat((running + ev.debit - ev.credit).toFixed(2));
                return { ...ev, running };
            });
        }

        function renderAccountStatement() {
            const accountId = document.getElementById('statement-account-select').value;
            const tbody = document.getElementById('statement-table-body');
            tbody.innerHTML = '';

            const rows = getAccountStatementRows(accountId);
            if (rows.length === 0) {
                tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-slate-400">لا توجد حركات مسجلة لهذا الحساب بعد</td></tr>`;
                return;
            }

            rows.forEach(r => {
                tbody.innerHTML += `
                    <tr class="hover:bg-slate-700/30">
                        <td class="p-3 font-mono text-xs">${PA_CORE.escapeHtml(r.displayDate)}</td>
                        <td class="p-3 font-mono font-bold text-amber-400">${PA_CORE.escapeHtml(r.ref)}</td>
                        <td class="p-3">${PA_CORE.escapeHtml(r.desc)}</td>
                        <td class="p-3 font-mono text-emerald-400">${r.debit > 0 ? '$' + Number(r.debit).toFixed(2) : '-'}</td>
                        <td class="p-3 font-mono text-rose-400">${r.credit > 0 ? '$' + Number(r.credit).toFixed(2) : '-'}</td>
                        <td class="p-3 font-mono font-bold ${r.running >= 0 ? 'text-amber-300' : 'text-rose-400'}">
                            $${Number(Math.abs(r.running)).toFixed(2)} ${r.running > 0 ? '(عليه)' : (r.running < 0 ? '(له)' : '')}
                        </td>
                    </tr>
                `;
            });
        }


        function refreshInvoiceItemDropdowns() {
            const selects = document.querySelectorAll('#invoice-items-body .row-item-select');
            if (!selects.length) return;
            const optsHtml = `<option value="">-- اختر مادة أو خدمة --</option>` +
                (db.items || []).map(itm => `<option value="${PA_CORE.escapeHtml(itm.id)}">${PA_CORE.escapeHtml(itm.name)}</option>`).join('');
            selects.forEach(sel => {
                const prevVal = sel.value;
                sel.innerHTML = optsHtml;
                if (prevVal && (db.items || []).some(i => i.id === prevVal)) {
                    sel.value = prevVal;
                }
            });
        }

        function refreshAllViews() {
            populateAccountDropdowns();
            populateCashboxesAndWarehouses();
            refreshInvoiceItemDropdowns();
            renderItemsTable();
            renderAccountsTable();
            renderRecentInvoices();
            renderVouchersView();
            try { renderReturnsView(); } catch (e) {}
            try { renderAccountStatement(); } catch (e) {}
        }

        function populateAccountDropdowns() {
            const invSel = document.getElementById('inv-account-select');
            const vchSel = document.getElementById('voucher-account');
            const stSel = document.getElementById('statement-account-select');

            const prevInv = invSel.value;
            const prevVch = vchSel.value;
            const prevSt = stSel.value;

            invSel.innerHTML = '';
            vchSel.innerHTML = '';
            stSel.innerHTML = '';

            db.accounts.forEach(acc => {
                const opt1 = `<option value="${PA_CORE.escapeHtml(acc.id)}">${PA_CORE.escapeHtml(acc.name)}</option>`;
                invSel.innerHTML += opt1;
                if (acc.id !== 'acc_cash_client') {
                    vchSel.innerHTML += opt1;
                    stSel.innerHTML += opt1;
                }
            });

            if (prevInv && db.accounts.some(a => a.id === prevInv)) invSel.value = prevInv;
            if (prevVch && db.accounts.some(a => a.id === prevVch)) vchSel.value = prevVch;
            if (prevSt && db.accounts.some(a => a.id === prevSt)) stSel.value = prevSt;
        }

        function renderRecentInvoices() {
            const tbody = document.getElementById('recent-invoices-list');
            if (!tbody) return;
            const q = (document.getElementById('recent-inv-filter')?.value || '').trim().toLowerCase();
            tbody.innerHTML = '';
            const list = (db.invoices || []).filter(inv => {
                if (!q) return true;
                const acc = db.accounts.find(a => a.id === inv.accountId);
                return (inv.number || '').toLowerCase().includes(q) ||
                       (acc && (acc.name || '').toLowerCase().includes(q));
            }).slice(0, 15);

            if (list.length === 0) {
                tbody.innerHTML = `<tr><td colspan="8" class="p-4 text-center text-slate-400">لا توجد فواتير مرحلة مطابقة</td></tr>`;
                return;
            }

            list.forEach(inv => {
                const acc = db.accounts.find(a => a.id === inv.accountId);
                const typeBadge = inv.type === 'sales'
                    ? `<span class="bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2 py-0.5 rounded-full text-[11px] font-extrabold">مبيعات</span>`
                    : `<span class="bg-sky-500/20 text-sky-300 border border-sky-500/30 px-2 py-0.5 rounded-full text-[11px] font-extrabold">مشتريات</span>`;
                const payText = inv.paymentType === 'cash' ? 'نقدي' : (inv.paymentType === 'installment' ? 'تقسيط' : 'آجل');
                tbody.innerHTML += `
                    <tr class="hover:bg-slate-700/30">
                        <td data-label="الرقم" class="py-2 font-mono font-bold text-amber-400">${PA_CORE.escapeHtml(inv.number)}</td>
                        <td data-label="النوع" class="py-2">${typeBadge}</td>
                        <td data-label="التاريخ" class="py-2 font-mono text-slate-300">${PA_CORE.escapeHtml(inv.date)}</td>
                        <td data-label="العميل / المورد" class="py-2 font-bold text-slate-100">${PA_CORE.escapeHtml(acc ? acc.name : '-')}</td>
                        <td data-label="الدفع" class="py-2 text-slate-300">${payText}</td>
                        <td data-label="الصافي ($)" class="py-2 font-mono font-bold text-emerald-400" dir="ltr">$${Number(inv.totalUSD || 0).toFixed(2)}</td>
                        <td data-label="المعادل" class="py-2 font-mono text-amber-300">${Number(inv.totalSYP || 0).toLocaleString()} ل.س</td>
                        <td data-label="إجراءات" class="py-2 text-center">
                            <div class="flex justify-center gap-1">
                                <button type="button" onclick="printInvoiceById('${PA_CORE.escapeHtml(inv.id)}', 'thermal')" class="bg-sky-700/80 hover:bg-sky-600 text-white px-2 py-1 rounded text-[11px] font-bold">كاشير</button>
                                <button type="button" onclick="printInvoiceById('${PA_CORE.escapeHtml(inv.id)}', 'a4')" class="bg-indigo-700/80 hover:bg-indigo-600 text-white px-2 py-1 rounded text-[11px] font-bold">A4</button>
                                <button type="button" onclick="duplicateInvoiceById('${PA_CORE.escapeHtml(inv.id)}')" class="bg-slate-700 hover:bg-amber-500 hover:text-slate-950 px-2 py-1 rounded text-[11px] font-bold" title="تكرار الفاتورة">تكرار</button>
                                <button type="button" onclick="deleteInvoiceById('${PA_CORE.escapeHtml(inv.id)}')" class="bg-rose-800/80 hover:bg-rose-600 text-white px-2 py-1 rounded text-[11px] font-bold" title="حذف الفاتورة">حذف</button>
                            </div>
                        </td>
                    </tr>
                `;
            });
        }
        let currentAlertFilter = 'all';

        function ensureDismissedAlertsStore() {
            if (!db.settings) db.settings = {};
            if (!Array.isArray(db.settings.dismissedAlerts)) {
                db.settings.dismissedAlerts = [];
            }
            return db.settings.dismissedAlerts;
        }

        function buildRawSmartAlerts() {
            const rate = db.settings.exchangeRate || 15000;
            const raw = [];

            db.items.filter(i => i.type === 'stock' && i.qty <= i.minQty).forEach(itm => {
                const signature = `stock:${itm.id}`;
                raw.push({
                    id: signature,
                    category: 'stock',
                    badge: 'مخزون',
                    accountId: null,
                    title: `تنبيه مخزون: ${itm.name}`,
                    detail: `الرصيد الحالي (${Number(itm.qty || 0)}) وصل للحد الأدنى (${Number(itm.minQty || 0)}).`
                });
            });

            db.accounts.filter(a => a.id !== 'acc_cash_client').forEach(acc => {
                const bal = calculateAccountBalanceUSD(acc.id);
                const absUSD = Math.abs(bal);
                const sypVal = Math.round(absUSD * rate).toLocaleString();

                if (bal > 0 && (acc.type === 'customer' || acc.type === 'both' || !acc.type)) {
                    const signature = `debt_on_acc:${acc.id}:${bal.toFixed(2)}`;
                    raw.push({
                        id: signature,
                        category: 'owed_to_us',
                        badge: 'عليه دين لنا',
                        accountId: acc.id,
                        title: `دين مستحق على: ${acc.name}`,
                        detail: `عليه دين بقيمة $${absUSD.toFixed(2)} (المعادل: ${sypVal} ل.س).`
                    });
                } else if (bal < 0 && (acc.type === 'supplier' || acc.type === 'both' || !acc.type)) {
                    const signature = `debt_by_us:${acc.id}:${absUSD.toFixed(2)}`;
                    raw.push({
                        id: signature,
                        category: 'owed_by_us',
                        badge: 'نريد منه / له علينا',
                        accountId: acc.id,
                        title: `التزام / دين لصالح: ${acc.name}`,
                        detail: `له علينا رصيد بقيمة $${absUSD.toFixed(2)} (المعادل: ${sypVal} ل.س).`
                    });
                }
            });

            return raw;
        }

        function getSmartAlerts(includeDismissed = false) {
            const dismissed = ensureDismissedAlertsStore();
            const allAlerts = buildRawSmartAlerts();
            if (includeDismissed) return allAlerts;
            return allAlerts.filter(a => !dismissed.includes(a.id));
        }

        async function markAlertAsRead(alertId) {
            if (ensureDismissedAlertsStore().includes(alertId)) return;
            const saved = await commitDatabaseMutation(() => {
                db.settings.dismissedAlerts.push(alertId);
                return true;
            });
            if (!saved) return;
            renderSmartAlertsList();
            showToast('تم تأشير الإشعار كمقروء وإخفاء التذكير', 'info');
        }

        async function markAllAlertsAsRead() {
            const visible = getSmartAlerts(false);
            if (visible.length === 0) return;
            const saved = await commitDatabaseMutation(() => {
                const dismissed = ensureDismissedAlertsStore();
                visible.forEach(alert => {
                    if (!dismissed.includes(alert.id)) dismissed.push(alert.id);
                });
                return true;
            });
            if (!saved) return;
            renderSmartAlertsList();
            showToast('تم إخفاء جميع التذكيرات الحالية', 'success');
        }

        async function restoreDismissedAlerts() {
            const saved = await commitDatabaseMutation(() => {
                db.settings.dismissedAlerts = [];
                return true;
            });
            if (!saved) return;
            renderSmartAlertsList();
            showToast('تمت إعادة إظهار جميع التنبيهات القائمة', 'info');
        }

        function setAlertFilter(filterName) {
            currentAlertFilter = filterName;
            ['all', 'owed_to_us', 'owed_by_us', 'stock'].forEach(key => {
                const btn = document.getElementById('alert-filter-' + key);
                if (!btn) return;
                if (key === filterName) {
                    btn.className = 'px-2.5 py-1 rounded-lg font-bold bg-amber-500 text-slate-950 transition';
                } else if (key === 'owed_to_us') {
                    btn.className = 'px-2.5 py-1 rounded-lg font-bold bg-slate-800 text-amber-300 border border-amber-500/30 transition';
                } else if (key === 'owed_by_us') {
                    btn.className = 'px-2.5 py-1 rounded-lg font-bold bg-slate-800 text-rose-300 border border-rose-500/30 transition';
                } else if (key === 'stock') {
                    btn.className = 'px-2.5 py-1 rounded-lg font-bold bg-slate-800 text-sky-300 border border-sky-500/30 transition';
                } else {
                    btn.className = 'px-2.5 py-1 rounded-lg font-bold bg-slate-800 text-slate-200 border border-slate-700 transition';
                }
            });
            renderSmartAlertsList();
        }

        function openAccountFromAlert(accountId) {
            if (!accountId) return;
            document.getElementById('smart-alerts-modal').classList.add('hidden');
            viewAccountStatementDirect(accountId);
        }

        function updateSmartAlertsBadge() {
            const alerts = getSmartAlerts(false);
            const badge = document.getElementById('alert-badge');
            if (!badge) return;
            if (alerts.length > 0) {
                badge.textContent = alerts.length;
                badge.classList.remove('hidden');
            } else {
                badge.classList.add('hidden');
            }
        }

        function renderSmartAlertsList() {
            const list = document.getElementById('smart-alerts-list');
            if (!list) return;

            let alerts = getSmartAlerts(false);
            if (currentAlertFilter !== 'all') {
                alerts = alerts.filter(a => a.category === currentAlertFilter);
            }

            if (alerts.length === 0) {
                list.innerHTML = `<div class="text-center text-emerald-400 py-6 font-bold bg-slate-900/60 rounded-xl border border-emerald-500/20">✔ لا توجد إشعارات غير مقروءة في هذا القسم.</div>`;
                return;
            }

            list.innerHTML = alerts.map(a => {
                const styleMap = {
                    owed_to_us: 'bg-amber-950/45 border-amber-500/40 text-amber-100',
                    owed_by_us: 'bg-rose-950/45 border-rose-500/40 text-rose-100',
                    stock: 'bg-sky-950/45 border-sky-500/40 text-sky-100'
                };
                const badgeMap = {
                    owed_to_us: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
                    owed_by_us: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
                    stock: 'bg-sky-500/20 text-sky-300 border-sky-500/40'
                };

                const statementBtn = a.accountId
                    ? `<button type="button" data-account-id="${PA_CORE.escapeHtml(a.accountId)}" class="bg-slate-900/90 hover:bg-slate-700 text-sky-300 border border-sky-500/30 text-xs font-bold px-2.5 py-1.5 rounded-lg transition">كشف الحساب</button>`
                    : '';

                return `
                    <div class="p-3.5 rounded-xl border ${styleMap[a.category] || styleMap.owed_to_us} flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition">
                        <div class="space-y-1 cursor-pointer flex-grow" data-alert-id="${PA_CORE.escapeHtml(a.id)}">
                            <div class="flex items-center gap-2 flex-wrap">
                                <span class="text-[11px] px-2 py-0.5 rounded-full border font-extrabold ${badgeMap[a.category] || badgeMap.owed_to_us}">${PA_CORE.escapeHtml(a.badge)}</span>
                                <span class="font-extrabold text-sm">${PA_CORE.escapeHtml(a.title)}</span>
                            </div>
                            <div class="text-xs opacity-90">${PA_CORE.escapeHtml(a.detail)}</div>
                        </div>
                        <div class="flex items-center gap-1.5 shrink-0">
                            ${statementBtn}
                            <button type="button" data-alert-id="${PA_CORE.escapeHtml(a.id)}" class="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-extrabold px-3 py-1.5 rounded-lg transition shadow-sm">
                                قرأت / إخفاء
                            </button>
                        </div>
                    </div>
                `;
            }).join('');
            list.querySelectorAll('[data-alert-id]').forEach(el => {
                el.addEventListener('click', () => markAlertAsRead(el.getAttribute('data-alert-id')));
            });
            list.querySelectorAll('[data-account-id]').forEach(el => {
                el.addEventListener('click', () => openAccountFromAlert(el.getAttribute('data-account-id')));
            });
        }

        function showSmartAlerts() {
            currentAlertFilter = 'all';
            setAlertFilter('all');
            document.getElementById('smart-alerts-modal').classList.remove('hidden');
        }

        function applyThemeModeUI(mode) {
            let storedMode = 'night';
            try { storedMode = localStorage.getItem('pa_theme_mode') || 'night'; } catch (e) {}
            const resolvedMode = mode || (db.settings && db.settings.themeMode) || storedMode;
            const isDay = resolvedMode === 'day';
            document.documentElement.dataset.theme = isDay ? 'light' : 'dark';
            document.body.classList.toggle('day-mode', isDay);
            const button = document.getElementById('theme-toggle-btn');
            if (button) {
                const nextLabel = isDay ? 'وضع ليلي' : 'وضع نهاري';
                button.title = window.t ? window.t(nextLabel) : nextLabel;
                button.setAttribute('aria-label', window.t ? window.t('تبديل بين الوضع الليلي والوضع النهاري') : 'تبديل بين الوضع الليلي والوضع النهاري');
                button.setAttribute('aria-pressed', isDay ? 'true' : 'false');
                button.dataset.mode = isDay ? 'day' : 'night';
            }
        }

        async function toggleThemeMode() {
            const currentMode = document.documentElement.dataset.theme === 'light' ? 'day' : 'night';
            const nextMode = currentMode === 'day' ? 'night' : 'day';
            applyThemeModeUI(nextMode);
            try { localStorage.setItem('pa_theme_mode', nextMode); } catch (e) {}
            const saved = await commitDatabaseMutation(() => {
                db.settings.themeMode = nextMode;
                return true;
            });
            if (!saved) {
                try { localStorage.setItem('pa_theme_mode', currentMode); } catch (e) {}
                applyThemeModeUI(currentMode);
                return;
            }
            renderSalesChart();
        }

        function populateReturnsDropdowns() {
            const accSel = document.getElementById('ret-account');
            const itmSel = document.getElementById('ret-item');
            const invSel = document.getElementById('ret-invoice');
            if (!accSel || !itmSel || !invSel) return;
            const invoiceType = document.getElementById('ret-type').value === 'sales_return' ? 'sales' : 'purchase';
            const returnedQty = (inv, line) => (db.returns || []).filter(r => r.invoiceId === inv.id && r.itemId === line.itemId).reduce((t, r) => t + Number(r.qty || 0), 0);
            const invoices = db.invoices.filter(inv => inv.type === invoiceType
                && (inv.items || []).some(line => Number(line.qty) - returnedQty(inv, line) > 1e-9));
            const previousInvoice = invSel.value;
            invSel.innerHTML = '<option value="">-- اختر الفاتورة --</option>' + invoices.map(inv => {
                const acc = db.accounts.find(a => a.id === inv.accountId);
                return `<option value="${PA_CORE.escapeHtml(inv.id)}">${PA_CORE.escapeHtml(inv.number)} — ${PA_CORE.escapeHtml(acc ? acc.name : '-')} — ${PA_CORE.escapeHtml(inv.date)} — $${Number(inv.totalUSD || 0).toFixed(2)}</option>`;
            }).join('');
            if (invoices.some(inv => inv.id === previousInvoice)) invSel.value = previousInvoice;
            onReturnInvoiceChange();
        }

        function onReturnInvoiceChange() {
            const invoice = db.invoices.find(inv => inv.id === document.getElementById('ret-invoice')?.value);
            const accountSel = document.getElementById('ret-account');
            const itemSel = document.getElementById('ret-item');
            if (!invoice || !accountSel || !itemSel) {
                if (itemSel) itemSel.innerHTML = '<option value="">-- اختر الفاتورة أولاً --</option>';
                return;
            }
            accountSel.value = invoice.accountId;
            if (invoice.cashboxId) document.getElementById('ret-cashbox').value = invoice.cashboxId;
            itemSel.innerHTML = invoice.items.map(line => {
                const done = (db.returns || []).filter(r => r.invoiceId === invoice.id && r.itemId === line.itemId).reduce((t, r) => t + Number(r.qty || 0), 0);
                const left = Math.max(0, Number(line.qty) - done);
                return `<option value="${PA_CORE.escapeHtml(line.itemId)}"${left <= 0 ? ' disabled' : ''}>${PA_CORE.escapeHtml(line.itemName)} (متاح للإرجاع: ${left})</option>`;
            }).join('');
            const firstOpen = Array.from(itemSel.options).find(o => !o.disabled);
            if (firstOpen) itemSel.value = firstOpen.value;
            onReturnItemChange();
        }

        function onReturnItemChange() {
            const invoice = db.invoices.find(inv => inv.id === document.getElementById('ret-invoice')?.value);
            const line = invoice?.items.find(entry => entry.itemId === document.getElementById('ret-item')?.value);
            const priceInp = document.getElementById('ret-price-usd');
            const qtyInp = document.getElementById('ret-qty');
            if (!line || !priceInp || !qtyInp) return;
            const returnedQty = (db.returns || []).filter(record => record.invoiceId === invoice.id && record.itemId === line.itemId)
                .reduce((sum, record) => sum + Number(record.qty || 0), 0);
            const remainingQty = Math.max(0, Number(line.qty) - returnedQty);
            const returnedTotal = (db.returns || []).filter(record => record.invoiceId === invoice.id)
                .reduce((sum, record) => sum + Number(record.totalUSD || 0), 0);
            const remainingNet = Math.max(0, Number(invoice.totalUSD) - returnedTotal);
            const netUnitUSD = Math.min(PA_CORE.calculateReturnAmount(invoice, line, 1), remainingNet);
            priceInp.value = Number(netUnitUSD.toFixed(6));
            priceInp.readOnly = true;
            qtyInp.max = remainingQty;
            qtyInp.title = `الكمية القابلة للمرتجع: ${remainingQty}`;
        }

        async function saveReturnRecord() {
            const type = document.getElementById('ret-type').value;
            const invoice = db.invoices.find(inv => inv.id === document.getElementById('ret-invoice')?.value);
            const itemId = document.getElementById('ret-item').value;
            const qty = Number(document.getElementById('ret-qty').value);
            const date = document.getElementById('ret-date').value || PA_CORE.getLocalDateString();
            const note = document.getElementById('ret-note').value.trim();
            if (!invoice || invoice.type !== (type === 'sales_return' ? 'sales' : 'purchase')) {
                showToast('يرجى اختيار الفاتورة الأصلية المناسبة', 'error');
                return;
            }
            const line = invoice.items.find(entry => entry.itemId === itemId);
            const itemObj = db.items.find(item => item.id === itemId);
            if (!line || !itemObj || !PA_CORE.isValidQuantity(qty)) {
                showToast('يرجى اختيار مادة وكمية صحيحة بثلاث خانات عشرية كحد أقصى', 'error');
                return;
            }
            const alreadyReturned = (db.returns || []).filter(record => record.invoiceId === invoice.id && record.itemId === itemId)
                .reduce((sum, record) => sum + Number(record.qty || 0), 0);
            if (alreadyReturned + qty > Number(line.qty) + 1e-9) {
                showToast(`الكمية القابلة للمرتجع هي ${Math.max(0, Number(line.qty) - alreadyReturned)} فقط`, 'error');
                return;
            }
            if (type === 'purchase_return' && itemObj.type === 'stock' && qty > Number(itemObj.qty || 0)) {
                showToast('كمية مرتجع المشتريات أكبر من الرصيد المتوفر', 'error');
                return;
            }
            const cashSettled = PA_CORE.isCashInvoice(invoice);
            const nonCashSettled = invoice.paymentType === 'cash' && !cashSettled;
            const selectedCashboxId = document.getElementById('ret-cashbox')?.value || '';
            const cashboxId = cashSettled ? selectedCashboxId : '';
            if (cashSettled && (!cashboxId || !db.cashboxes.some(cashbox => cashbox.id === cashboxId))) {
                showToast('يرجى اختيار صندوق صالح لرد المرتجع النقدي', 'error');
                return;
            }
            const rate = Number(invoice.rate) || Number(db.settings.exchangeRate);
            const returnedTotal = (db.returns || []).filter(record => record.invoiceId === invoice.id)
                .reduce((sum, record) => sum + Number(record.totalUSD || 0), 0);
            const remainingNet = Math.max(0, Number(invoice.totalUSD) - returnedTotal);
            const totalUSD = PA_CORE.roundMoney(Math.min(
                PA_CORE.calculateReturnAmount(invoice, line, qty),
                remainingNet
            ));
            const priceUSD = totalUSD / qty;
            const totalSYP = Math.round(totalUSD * rate);
            const retNum = PA_CORE.nextDocumentNumber(db.returns, 'RET-', 101);

            const saved = await commitDatabaseMutation(() => {
                if (itemObj.type === 'stock') {
                    itemObj.qty = Number((itemObj.qty + (type === 'sales_return' ? qty : -qty)).toFixed(6));
                }
                const record = {
                    id: 'ret_' + Date.now(), number: retNum, type,
                    invoiceId: invoice.id, invoiceNumber: invoice.number,
                    accountId: invoice.accountId, cashboxId: cashboxId || undefined,
                    payMethod: cashSettled ? 'cash_pay' : (invoice.payMethod || 'bank_transfer'), cashSettled,
                    itemId, itemName: itemObj.name, qty, priceUSD,
                    costUSD: Number(line.costUSD ?? itemObj.cost) || 0,
                    totalUSD, totalSYP, rate, date, note
                };
                db.returns.unshift(record);
                if (nonCashSettled && totalUSD > 0) {
                    const voucherType = PA_CORE.refundVoucherTypeForReturn(record);
                    const prefix = voucherType === 'receipt' ? 'RCV-' : 'PAY-';
                    const refundVoucher = {
                        id: 'vch_ret_' + Date.now(),
                        number: PA_CORE.nextDocumentNumber(db.vouchers.filter(entry => entry.type === voucherType), prefix, 101),
                        type: voucherType, accountId: invoice.accountId, payMethod: invoice.payMethod,
                        returnId: record.id, source: 'return_refund', amountUSD: totalUSD,
                        origAmount: totalUSD, currency: 'USD', rate, date,
                        note: `رد تلقائي لمرتجع ${record.number} بطريقة الدفع الأصلية`
                    };
                    db.vouchers.unshift(refundVoucher);
                    record.refundVoucherId = refundVoucher.id;
                }
                PA_CORE.applyReturnToInstallments(db, record);
                return record;
            });
            if (!saved) return;
            refreshAllViews();
            renderAllExtendedViews();
            renderReturnsView();
            document.getElementById('ret-note').value = '';
            document.getElementById('ret-qty').value = 1;
            showToast(`تم حفظ وترحيل المرتجع ${retNum}${saved.refundVoucherId ? ' وتسجيل الرد بطريقة الدفع الأصلية' : ''}`, 'success');
        }

        function renderReturnsView() {
            if (!Array.isArray(db.returns)) db.returns = [];
            populateReturnsDropdowns();
            const tbody = document.getElementById('returns-table-body');
            if (!tbody) return;
            tbody.innerHTML = '';

            if (db.returns.length === 0) {
                tbody.innerHTML = `<tr><td colspan="10" class="p-4 text-center text-slate-400">لا توجد مرتجعات مسجلة بعد</td></tr>`;
                return;
            }

            db.returns.forEach(r => {
                const acc = db.accounts.find(a => a.id === r.accountId);
                const cashbox = db.cashboxes.find(c => c.id === r.cashboxId);
                const badge = r.type === 'sales_return'
                    ? `<span class="bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded text-xs font-bold">مرتجع مبيعات</span>`
                    : `<span class="bg-sky-500/20 text-sky-300 px-2 py-0.5 rounded text-xs font-bold">مرتجع مشتريات</span>`;
                const refundedUSD = PA_CORE.calculateReturnRefundedUSD(r.id, db.vouchers);
                const settlementBadge = PA_CORE.isSettledReturn(r, db.invoices)
                    ? '<span class="text-emerald-300 font-bold">مسترد نقداً</span>'
                    : (refundedUSD >= Number(r.totalUSD) - 0.009
                        ? '<span class="text-emerald-300 font-bold">تمت التسوية</span>'
                        : (refundedUSD > 0
                            ? `<span class="text-amber-300 font-bold">تسوية جزئية $${refundedUSD.toFixed(2)}</span>`
                            : '<span class="text-slate-300">على الحساب</span>'));
                tbody.innerHTML += `
                    <tr class="hover:bg-slate-700/30">
                        <td class="p-3 font-mono font-bold text-orange-400">${PA_CORE.escapeHtml(r.number)}</td>
                        <td class="p-3">${badge}</td>
                        <td class="p-3 font-mono text-xs text-slate-300">${PA_CORE.escapeHtml(r.date)}</td>
                        <td class="p-3 font-bold">${PA_CORE.escapeHtml(acc ? acc.name : '-')}</td>
                        <td class="p-3">${PA_CORE.escapeHtml(cashbox ? cashbox.name : '-')}</td>
                        <td class="p-3 text-xs">${settlementBadge}</td>
                        <td class="p-3">${PA_CORE.escapeHtml(r.itemName)}</td>
                        <td class="p-3 font-mono font-bold">${Number(r.qty || 0)}</td>
                        <td class="p-3 font-mono font-bold text-emerald-400">$${Number(r.totalUSD || 0).toFixed(2)}</td>
                        <td class="p-3 text-center">
                            <div class="flex gap-1.5 justify-center"><button onclick="printReturnById('${PA_CORE.escapeHtml(r.id)}','a4')" class="bg-slate-700 hover:bg-amber-500 hover:text-slate-950 px-2.5 py-1 rounded text-xs font-bold transition">🖨️ A4</button><button onclick="printReturnById('${PA_CORE.escapeHtml(r.id)}','thermal')" class="bg-slate-700 hover:bg-amber-500 hover:text-slate-950 px-2.5 py-1 rounded text-xs font-bold transition">🧾 كاشير</button></div>
                        </td>
                    </tr>
                `;
            });
        }

        function printReturnById(retId, format = 'a4') {
            if (!Array.isArray(db.returns)) return;
            const r = db.returns.find(x => x.id === retId);
            if (!r) return;
            const acc = db.accounts.find(a => a.id === r.accountId);
            const inv = db.invoices.find(i => i.id === r.invoiceId);
            const cashbox = (db.cashboxes || []).find(c => c.id === r.cashboxId);
            const isSale = r.type === 'sales_return';
            const title = isSale ? 'إشعار مرتجع مبيعات' : 'إشعار مرتجع مشتريات';
            const refundedUSD = PA_CORE.calculateReturnRefundedUSD(r.id, db.vouchers);
            const settlement = PA_CORE.isSettledReturn(r, db.invoices)
                ? `مسترد نقداً${cashbox ? ' من ' + cashbox.name : ''}`
                : (refundedUSD >= Number(r.totalUSD) - 0.009 ? 'تمت التسوية بسند' : (refundedUSD > 0 ? `تسوية جزئية $${refundedUSD.toFixed(2)}` : 'مخصوم من رصيد الحساب'));
            const money = v => '$' + Number(v || 0).toFixed(2);
            const html = `
                <article class="pa-invoice pa-return ${paDocClasses()} ${isSale ? 'is-sales' : 'is-purchase'}" ${paAccentStyle()}>
                    ${paDocHeader()}
                    <div class="pa-invoice-banner ${isSale ? 'is-sales' : 'is-purchase'}"><span>${title}</span><span>رقم: ${PA_CORE.escapeHtml(r.number)}</span></div>
                    <div class="pa-invoice-meta">
                        <div>${isSale ? 'العميل' : 'المورد'}: <strong>${PA_CORE.escapeHtml(acc ? acc.name : '-')}</strong></div>
                        <div>التاريخ: <bdi dir="ltr">${PA_CORE.escapeHtml(r.date)}</bdi></div>
                        <div>الفاتورة الأصلية: <strong>${PA_CORE.escapeHtml(r.invoiceNumber || (inv ? inv.number : '-'))}</strong>${inv ? ` بتاريخ <bdi dir="ltr">${PA_CORE.escapeHtml(inv.date)}</bdi>` : ''}</div>
                        <div>حالة التسوية: <strong>${PA_CORE.escapeHtml(settlement)}</strong></div>
                    </div>
                    <table class="pa-invoice-table">
                        <thead><tr><th>#</th><th>المادة</th><th>الكمية</th><th>سعر الوحدة ($)</th><th>الإجمالي ($)</th></tr></thead>
                        <tbody><tr><td>1</td><td>${PA_CORE.escapeHtml(r.itemName)}</td><td dir="ltr">${Number(r.qty || 0).toLocaleString('en-US', { maximumFractionDigits: 3 })}</td><td dir="ltr">${Number(r.priceUSD || 0).toFixed(2)}</td><td dir="ltr">${Number(r.totalUSD || 0).toFixed(2)}</td></tr></tbody>
                    </table>
                    <div class="pa-receipt-items"><div class="pa-receipt-item"><strong>1. ${PA_CORE.escapeHtml(r.itemName)}</strong><div class="pa-receipt-amounts"><span dir="ltr">${Number(r.qty || 0)} × ${Number(r.priceUSD || 0).toFixed(2)}</span><b dir="ltr">${money(r.totalUSD)}</b></div></div></div>
                    <div class="pa-invoice-totals">
                        <div class="pa-invoice-net"><span>قيمة المرتجع</span><b dir="ltr">${money(r.totalUSD)}</b></div>
                        <div class="pa-invoice-syp"><span>المعادل بالليرة</span><b dir="auto">${Number(r.totalSYP || 0).toLocaleString('en-US')} ل.س</b></div>
                    </div>
                    ${r.note ? `<div class="pa-invoice-notes"><strong>البيان:</strong> ${PA_CORE.escapeHtml(r.note)}</div>` : ''}
                    <div class="pa-signatures"><div>توقيع ${isSale ? 'العميل' : 'المورد'}</div><div>توقيع المحاسب</div></div>
                    ${paDocFooter()}
                </article>
            `;
            triggerPrint(html, format, { title, fileName: `Return_${String(r.number || r.id).replace(/[^\p{L}\p{N}_-]+/gu, '-')}.pdf`, kind: 'return' });
        }

        function renderDetailedInvoicesReport() {
            const tbody = document.getElementById('detailed-invoices-body');
            if (!tbody) return;
            const filterType = document.getElementById('inv-detail-filter-type')?.value || 'all';
            const search = (document.getElementById('inv-detail-search')?.value || '').trim().toLowerCase();

            const filtered = db.invoices.filter(inv => {
                if (filterType !== 'all' && inv.type !== filterType) return false;
                if (!search) return true;
                const acc = db.accounts.find(a => a.id === inv.accountId);
                const accName = (acc ? acc.name : '').toLowerCase();
                const invNum = (inv.number || '').toLowerCase();
                const itemsText = (inv.items || []).map(i => i.itemName).join(' ').toLowerCase();
                return invNum.includes(search) || accName.includes(search) || itemsText.includes(search);
            });

            if (filtered.length === 0) {
                tbody.innerHTML = `<tr><td colspan="9" class="p-4 text-center text-slate-400">لا توجد فواتير مطابقة للبحث</td></tr>`;
                return;
            }

            tbody.innerHTML = filtered.map(inv => {
                const acc = db.accounts.find(a => a.id === inv.accountId);
                const typeBadge = inv.type === 'sales'
                    ? `<span class="bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded text-xs font-bold">مبيعات</span>`
                    : `<span class="bg-sky-500/20 text-sky-300 px-2 py-0.5 rounded text-xs font-bold">مشتريات</span>`;
                const itemsSummary = PA_CORE.escapeHtml((inv.items || []).map(it => `${it.itemName} (${Number(it.qty || 0)} × ${Number(it.priceOrig || 0)})`).join('، '));

                return `
                    <tr class="hover:bg-slate-700/30">
                        <td class="p-3 font-mono font-bold text-amber-400">${PA_CORE.escapeHtml(inv.number)}</td>
                        <td class="p-3">${typeBadge}</td>
                        <td class="p-3 font-mono text-xs text-slate-300">${PA_CORE.escapeHtml(inv.date)}</td>
                        <td class="p-3 font-bold">${PA_CORE.escapeHtml(acc ? acc.name : '-')}</td>
                        <td class="p-3 text-xs">${inv.paymentType === 'cash' ? 'نقدي' : 'آجل'}</td>
                        <td class="p-3 text-xs text-slate-300 max-w-xs truncate" title="${itemsSummary}">${itemsSummary || '-'}</td>
                        <td class="p-3 font-mono font-bold text-emerald-400">$${Number(inv.totalUSD || 0).toFixed(2)}</td>
                        <td class="p-3 font-mono text-amber-300">${Number(inv.totalSYP || 0).toLocaleString()} ل.س</td>
                        <td class="p-3 text-center">
                            <div class="flex justify-center gap-1">
                                <button onclick="printInvoiceById('${PA_CORE.escapeHtml(inv.id)}', 'thermal')" class="bg-slate-700 hover:bg-sky-600 px-2 py-1 rounded text-xs font-bold">كاشير</button>
                                <button onclick="printInvoiceById('${PA_CORE.escapeHtml(inv.id)}', 'a4')" class="bg-slate-700 hover:bg-indigo-600 px-2 py-1 rounded text-xs font-bold">A4</button>
                            </div>
                        </td>
                    </tr>
                `;
            }).join('');
        }

        function computeEndOfDayMetrics(targetDate) {
            return PA_CORE.calculateEndOfDayMetrics(db, targetDate);
        }

        function renderEndOfDayReport() {
            const dateInput = document.getElementById('eod-report-date');
            const cardsContainer = document.getElementById('eod-summary-cards');
            if (!dateInput || !cardsContainer) return;

            if (!dateInput.value) {
                dateInput.value = PA_CORE.getLocalDateString();
            }
            const m = computeEndOfDayMetrics(dateInput.value);

            cardsContainer.innerHTML = `
                <div class="bg-slate-900/90 border border-emerald-500/30 rounded-xl p-3.5">
                    <div class="text-xs text-slate-400 font-bold">مبيعات اليوم (${m.dayInvoicesCount} فاتورة)</div>
                    <div class="text-lg font-black text-emerald-400 font-mono mt-1">$${m.totalSalesUSD.toFixed(2)}</div>
                    <div class="text-[11px] text-slate-400 mt-1">نقدي: $${m.salesCashUSD.toFixed(2)} | آجل: $${m.salesCreditUSD.toFixed(2)} | بطاقة/تحويل: $${m.salesOtherPaidUSD.toFixed(2)}</div>
                </div>
                <div class="bg-slate-900/90 border border-sky-500/30 rounded-xl p-3.5">
                    <div class="text-xs text-slate-400 font-bold">مشتريات اليوم</div>
                    <div class="text-lg font-black text-sky-400 font-mono mt-1">$${m.purchasesUSD.toFixed(2)}</div>
                    <div class="text-[11px] text-slate-400 mt-1">نقدي: $${m.purchasesCashUSD.toFixed(2)} | المعادل: ${Math.round(m.purchasesUSD * m.rate).toLocaleString()} ل.س</div>
                </div>
                <div class="bg-slate-900/90 border border-amber-500/30 rounded-xl p-3.5">
                    <div class="text-xs text-slate-400 font-bold">السندات والمرتجعات لليوم</div>
                    <div class="text-xs font-bold text-amber-300 mt-1.5">قبض: $${m.receiptsUSD.toFixed(2)} (نقدي: $${m.cashReceiptsUSD.toFixed(2)}) | دفع: $${m.paymentsUSD.toFixed(2)} (نقدي: $${m.cashPaymentsUSD.toFixed(2)})</div>
                    <div class="text-xs font-bold text-orange-300 mt-1">مرتجع مبيع: $${m.salesReturnsUSD.toFixed(2)} (نقدي: $${m.cashSalesReturnsUSD.toFixed(2)}) | شراء: $${m.purchaseReturnsUSD.toFixed(2)} (نقدي: $${m.cashPurchaseReturnsUSD.toFixed(2)})</div>
                    <div class="text-xs font-bold text-rose-300 mt-1">مصروفات: $${m.expensesUSD.toFixed(2)} | إيرادات: $${m.revenuesUSD.toFixed(2)}</div>
                </div>
                <div class="bg-gradient-to-br from-amber-950/70 to-slate-900 border border-amber-500/50 rounded-xl p-3.5">
                    <div class="text-xs text-amber-300 font-bold">صافي حركة الكاش لليوم</div>
                    <div class="text-lg font-black text-emerald-400 font-mono mt-1">$${m.netCashUSD.toFixed(2)}</div>
                    <div class="text-xs font-bold text-amber-400 mt-1">${m.netCashSYP.toLocaleString()} ل.س</div>
                </div>
            `;
        }

        function printEndOfDayReportA4() {
            const dateInput = document.getElementById('eod-report-date');
            const m = computeEndOfDayMetrics(dateInput ? dateInput.value : PA_CORE.getLocalDateString());

            const html = `
                <div dir="rtl" style="font-family: 'TajawalLocal', 'Segoe UI', Tahoma, Arial, sans-serif; color: #0F172A; background: #ffffff; padding: 10px;">
                    <div style="text-align: center; border-bottom: 2px solid #0F172A; padding-bottom: 10px; margin-bottom: 14px;">
                        <h2 style="margin: 0; font-size: 24px; font-weight: 900; color: #0F172A;">${PA_CORE.escapeHtml(db.settings.companyName)}</h2>
                        <p style="margin: 4px 0 0; font-size: 13.5px; color: #334155; font-weight: 600;">${PA_CORE.escapeHtml(db.settings.companySub)}</p>
                    </div>
                    <div style="text-align: center; background: #F1F5F9; border: 1px solid #CBD5E1; padding: 8px; margin-bottom: 14px; font-size: 16px; font-weight: 900;">
                        تقرير شامل بنهاية اليوم - تاريخ: <span dir="ltr">${PA_CORE.escapeHtml(m.day)}</span>
                    </div>
                    <table style="width: 100%; border-collapse: collapse; margin-bottom: 14px; font-size: 13.5px;">
                        <tbody>
                            <tr style="border-bottom: 1px solid #CBD5E1;"><td style="padding:8px; font-weight:700;">إجمالي مبيعات اليوم</td><td style="padding:8px; text-align:left; font-weight:800;" dir="ltr">$${m.totalSalesUSD.toFixed(2)} (نقدي: $${m.salesCashUSD.toFixed(2)} / آجل: $${m.salesCreditUSD.toFixed(2)} / بطاقة أو تحويل: $${m.salesOtherPaidUSD.toFixed(2)})</td></tr>
                            <tr style="border-bottom: 1px solid #CBD5E1;"><td style="padding:8px; font-weight:700;">إجمالي مشتريات اليوم</td><td style="padding:8px; text-align:left; font-weight:800;" dir="ltr">$${m.purchasesUSD.toFixed(2)} (نقدي: $${m.purchasesCashUSD.toFixed(2)})</td></tr>
                            <tr style="border-bottom: 1px solid #CBD5E1;"><td style="padding:8px; font-weight:700;">سندات القبض / سندات الدفع</td><td style="padding:8px; text-align:left; font-weight:800;" dir="ltr">قبض: $${m.receiptsUSD.toFixed(2)} (نقدي: $${m.cashReceiptsUSD.toFixed(2)}) | دفع: $${m.paymentsUSD.toFixed(2)} (نقدي: $${m.cashPaymentsUSD.toFixed(2)})</td></tr>
                            <tr style="border-bottom: 1px solid #CBD5E1;"><td style="padding:8px; font-weight:700;">مرتجعات اليوم (مبيعات / مشتريات)</td><td style="padding:8px; text-align:left; font-weight:800;" dir="ltr">مبيعات: $${m.salesReturnsUSD.toFixed(2)} (نقدي: $${m.cashSalesReturnsUSD.toFixed(2)}) | مشتريات: $${m.purchaseReturnsUSD.toFixed(2)} (نقدي: $${m.cashPurchaseReturnsUSD.toFixed(2)})</td></tr>
                            <tr style="border-bottom: 1px solid #CBD5E1;"><td style="padding:8px; font-weight:700;">المصروفات والإيرادات</td><td style="padding:8px; text-align:left; font-weight:800;" dir="ltr">مصروفات: $${m.expensesUSD.toFixed(2)} | إيرادات: $${m.revenuesUSD.toFixed(2)}</td></tr>
                        </tbody>
                    </table>
                    <div style="border-top: 2px solid #0F172A; border-bottom: 2px solid #0F172A; padding: 12px; text-align: center; background-color: #F8FAFC; font-size: 17px; font-weight: 900;">
                        صافي حركة الكاش لليوم: <span dir="ltr">$${m.netCashUSD.toFixed(2)}</span> (${m.netCashSYP.toLocaleString()} ل.س)
                    </div>
                    <div style="text-align: center; margin-top: 14px; border-top: 1px dashed #94a3b8; padding-top: 6px; font-size: 9.5px; line-height: 1.5; color: #475569;">
                        <div>شكراً لاختياركم نظام المحاسبة - محاسب محترف سوريا | باسل محمد الخابور - 0952575089</div>
                        <div dir="ltr" style="font-family: sans-serif;">Thank you for choosing our accounting system - ProAccountant Syria | Dev: Basel Al-Kabor | +963 952 575 089</div>
                    </div>
                </div>
            `;
            triggerPrint(html, 'a4');
        }

        function extractPrintText(html) {
            try {
                const parsed = new DOMParser().parseFromString(html, 'text/html');
                parsed.querySelectorAll('style, script').forEach(element => element.remove());
                return (parsed.body?.innerText || parsed.body?.textContent || '').trim();
            } catch (e) {
                return '';
            }
        }

        function sendNativeHtml(action, fileName, html, fallbackText, paper, jobName) {
            const bridge = window.AndroidNative;
            const canChunk = bridge && typeof bridge.beginHtmlTransfer === 'function'
                && typeof bridge.appendHtmlTransfer === 'function' && typeof bridge.finishHtmlTransfer === 'function';
            if (canChunk && html.length > 200000) {
                let session = '';
                try {
                    const beginTransfer = typeof bridge.beginHtmlTransferWithFallback === 'function'
                        ? bridge.beginHtmlTransferWithFallback
                        : bridge.beginHtmlTransfer;
                    session = beginTransfer.call(bridge, action, fileName, jobName, paper, fallbackText);
                    if (!session) return false;
                    const chunks = PA_PRINT.chunkHtml(html, 32000);
                    for (const chunk of chunks) {
                        if (!bridge.appendHtmlTransfer(session, chunk)) {
                            if (typeof bridge.abortHtmlTransfer === 'function') bridge.abortHtmlTransfer(session);
                            return false;
                        }
                    }
                    return bridge.finishHtmlTransfer(session) !== false;
                } catch (e) {
                    if (session && typeof bridge.abortHtmlTransfer === 'function') {
                        try { bridge.abortHtmlTransfer(session); } catch (_) {}
                    }
                    return false;
                }
            }
            try {
                if (action === 'print' && typeof bridge?.printHtml === 'function') {
                    bridge.printHtml(html, jobName, paper);
                    return true;
                }
                if (action === 'pdf' && typeof bridge?.requestStorageAndSharePdfWithPaper === 'function') {
                    bridge.requestStorageAndSharePdfWithPaper(fileName, html, fallbackText, paper);
                    return true;
                }
                if (action === 'pdf' && typeof bridge?.requestStorageAndSharePdf === 'function') {
                    bridge.requestStorageAndSharePdf(fileName, html, fallbackText);
                    return true;
                }
                if (action === 'whatsapp' && typeof bridge?.sharePdfToWhatsApp === 'function') {
                    bridge.sharePdfToWhatsApp(fileName, html, fallbackText);
                    return true;
                }
            } catch (e) {}
            return false;
        }

        function setPrintActionsBusy(busy) {
            document.querySelectorAll('#android-print-modal .pa-print-actions button').forEach(button => {
                button.disabled = busy;
                button.setAttribute('aria-busy', String(busy));
            });
        }

        function beginPrintJob(duration = 45000) {
            if (printJobInFlight) return false;
            printJobInFlight = true;
            setPrintActionsBusy(true);
            clearTimeout(printJobTimer);
            printJobTimer = setTimeout(() => {
                printJobInFlight = false;
                setPrintActionsBusy(false);
            }, duration);
            return true;
        }

        function triggerPrint(htmlContent, mode = 'a4', metadata = {}) {
            const paper = PA_PRINT.normalizePaper(mode);
            const title = metadata.title || 'مستند محاسب محترف';
            const html = PA_PRINT.buildDocument(htmlContent, paper.id, title, metadata.kind || 'document');
            activePrintDocument = {
                html,
                text: extractPrintText(html) || title,
                paper: paper.id,
                title,
                fileName: metadata.fileName || `Invoice_${Date.now()}.pdf`,
                kind: metadata.kind || 'document'
            };
            selectedReceiptPaper = paper.id;

            if (isAndroidPlatform()) {
                const modal = document.getElementById('android-print-modal') || document.createElement('div');
                modal.id = 'android-print-modal';
                modal.className = 'pa-print-modal';
                modal.innerHTML = `
                    <div class="pa-print-toolbar">
                        <div><strong>معاينة الطباعة</strong><span>${PA_CORE.escapeHtml(title)}</span></div>
                        <button type="button" class="pa-print-close" onclick="closeAndroidPrintModal()" aria-label="إغلاق">✕</button>
                    </div>
                    <div class="pa-print-stage pa-paper-${paper.id}">
                        <div class="pa-print-sheet"><iframe id="android-print-frame" title="معاينة مستند الطباعة"></iframe></div>
                    </div>
                    <div class="pa-print-actions">
                        <button type="button" class="pa-print-secondary" onclick="tryAndroidSystemPrint()">طباعة</button>
                        <button type="button" class="pa-print-primary" onclick="shareReceiptText()">مشاركة PDF</button>
                    </div>
                `;
                if (!modal.isConnected) document.body.appendChild(modal);
                printPreviewObserver?.disconnect();
                const frame = document.getElementById('android-print-frame');
                const stage = modal.querySelector('.pa-print-stage');
                const sheet = modal.querySelector('.pa-print-sheet');
                const fitPreview = () => {
                    const width = frame.offsetWidth;
                    const scale = Math.min(1, Math.max(1, stage.clientWidth - 8) / width);
                    const height = Math.max(1123, frame.contentDocument?.documentElement.scrollHeight || 0);
                    frame.style.height = `${height}px`;
                    frame.style.transform = `scale(${scale})`;
                    sheet.style.width = `${width * scale}px`;
                    sheet.style.height = `${height * scale}px`;
                };
                frame.onload = fitPreview;
                printPreviewObserver = new ResizeObserver(fitPreview);
                printPreviewObserver.observe(stage);
                frame.srcdoc = html;
                setPrintActionsBusy(printJobInFlight);
                return;
            }

            PA_PRINT.printDocument(activePrintDocument.html);
        }

        /* PDF مطابق للمعاينة: يُرسم في الواجهة نفسها ثم يُسلَّم لأندرويد كملف جاهز */
        async function sendRasterPdf(action, snapshot) {
            const bridge = window.AndroidNative;
            const method = action === 'print' ? 'printPdfBase64' : 'sharePdfBase64';
            if (!bridge || typeof bridge[method] !== 'function' || !window.PA_PDF) return false;
            try {
                showToast(action === 'print' ? 'جاري تجهيز المستند للطباعة...' : 'جاري تجهيز ملف PDF...', 'info', 2000);
                const pdf = await PA_PDF.fromHtml(snapshot.html, snapshot.paper);
                const ok = action === 'print'
                    ? bridge.printPdfBase64(snapshot.title || 'ProAccountant', pdf.base64, snapshot.paper)
                    : bridge.sharePdfBase64(snapshot.fileName, pdf.base64);
                return ok !== false;
            } catch (e) {
                console.error(e);
                return false;
            }
        }

        function endPrintJob() {
            printJobInFlight = false;
            clearTimeout(printJobTimer);
            setPrintActionsBusy(false);
        }

        async function shareReceiptText() {
            if (!activePrintDocument) return;
            const snapshot = { ...activePrintDocument };
            if (!beginPrintJob()) return;
            if (isAndroidPlatform() && await sendRasterPdf('pdf', snapshot)) {
                endPrintJob();
                return;
            }
            if (!isAndroidPlatform() && window.PA_PDF) {
                try {
                    const pdf = await PA_PDF.fromHtml(snapshot.html, snapshot.paper);
                    const blob = new Blob([pdf.bytes], { type: 'application/pdf' });
                    const file = typeof File === 'function' ? new File([blob], snapshot.fileName, { type: 'application/pdf' }) : null;
                    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
                        await navigator.share({ files: [file], title: snapshot.title });
                    } else {
                        const a = document.createElement('a');
                        a.href = URL.createObjectURL(blob); a.download = snapshot.fileName;
                        document.body.appendChild(a); a.click(); a.remove();
                        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
                    }
                    endPrintJob();
                    return;
                } catch (e) {}
            }
            if (isAndroidPlatform() && sendNativeHtml('pdf', snapshot.fileName, snapshot.html, snapshot.text, snapshot.paper, snapshot.title)) {
                showToast('جاري تجهيز ملف PDF ومشاركته', 'info');
                return;
            }
            printJobInFlight = false;
            clearTimeout(printJobTimer);
            setPrintActionsBusy(false);
            showToast('تعذر تجهيز PDF، سيتم استخدام مشاركة النص', 'error');
            try {
                if (navigator.share) {
                    await navigator.share({ title: snapshot.title, text: snapshot.text });
                } else if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(snapshot.text);
                    showToast('تم نسخ نص المستند إلى الحافظة', 'success');
                } else {
                    showToast('تعذر فتح نافذة المشاركة على هذا الجهاز', 'error');
                }
            } catch (e) {}
        }

        function hidePrintAreaCompletely() {
            const printArea = document.getElementById('print-area');
            if (printArea) {
                printArea.removeAttribute('style');
                printArea.innerHTML = '';
            }
            document.body.classList.remove('print-a4', 'print-thermal');
        }

        function closeAndroidPrintModal() {
            printPreviewObserver?.disconnect();
            printPreviewObserver = null;
            const modal = document.getElementById('android-print-modal');
            if (modal) modal.remove();
            activePrintDocument = null;
            hidePrintAreaCompletely();
        }

        window.addEventListener('afterprint', () => {
            setTimeout(hidePrintAreaCompletely, 300);
        });

        window.onAndroidPdfError = function(message) {
            printJobInFlight = false;
            clearTimeout(printJobTimer);
            setPrintActionsBusy(false);
            showToast(message || 'تعذر إكمال ملف PDF', 'error');
        };
        window.onAndroidNativeError = window.onAndroidPdfError;

        function restoreFromDrive() {
            if (window.AndroidNative && typeof window.AndroidNative.openGoogleDriveForRestore === 'function') {
                showToast('اختر النسخة المطلوبة في Google Drive ونزّلها، ثم اضغط "استرجاع" لاختيار الملف من الجهاز', 'info');
                window.AndroidNative.openGoogleDriveForRestore();
            } else if (window.pywebview && window.pywebview.api && typeof window.pywebview.api.open_google_drive === 'function') {
                showToast('جاري فتح Google Drive في المتصفح... نزّل النسخة ثم اضغط "استرجاع" لاختيارها', 'info');
                window.pywebview.api.open_google_drive();
            } else {
                window.open('https://drive.google.com', '_blank');
                const inp = document.getElementById('import-json-input');
                if (inp) inp.click();
            }
        }

        async function onAndroidDriveRestoreSuccess(jsonString) {
            try {
                const imported = typeof jsonString === 'string' ? JSON.parse(jsonString) : jsonString;
                await applyRestoredDatabase(imported);
            } catch (e) {
                showToast('تعذر قراءة بيانات النسخة المستردة من درايف', 'error');
            }
        }

        async function tryAndroidSystemPrint() {
            if (!activePrintDocument || !beginPrintJob(30000)) return;
            const { html, title, paper } = activePrintDocument;
            if (isAndroidPlatform() && await sendRasterPdf('print', { ...activePrintDocument })) {
                endPrintJob();
                return;
            }
            if (isAndroidPlatform()) {
                if (!sendNativeHtml('print', `${title}_${Date.now()}.pdf`, html, activePrintDocument.text, paper, title)) {
                    printJobInFlight = false;
                    clearTimeout(printJobTimer);
                    setPrintActionsBusy(false);
                    showToast('تعذر بدء الطباعة؛ أعد المحاولة أو شارك PDF', 'error');
                }
                return;
            }
            PA_PRINT.printDocument(html).finally(() => {
                printJobInFlight = false;
                clearTimeout(printJobTimer);
                setPrintActionsBusy(false);
            });
        }

        function generateQRDataURL(text, size = 92) {
            try {
                if (typeof window.QRCode === 'function') {
                    const tmp = document.createElement('div');
                    const qr = new window.QRCode(tmp, { text: text, width: size, height: size });
                    if (qr && qr._canvas) return qr._canvas.toDataURL('image/png');
                    const c = tmp.querySelector('canvas');
                    if (c) return c.toDataURL('image/png');
                }
            } catch (e) {}
            return '';
        }

        /* ترويسة/تذييل موحّدة لكل المستندات المطبوعة (نفس قالب ولون الفاتورة) */
        function paDocClasses() {
            const t = (db.settings && db.settings.invoiceTemplate) || 'modern';
            return 'tpl-' + String(t).replace(/[^a-z]/g, '');
        }
        function paAccentStyle() {
            const c = (db.settings && db.settings.invoiceAccent) || '';
            return /^#[0-9a-f]{6}$/i.test(c) ? `style="--pa-acc:${c}"` : '';
        }
        function paDocHeader() {
            const st = db.settings || {};
            const logo = st.invShowLogo !== false ? PA_CORE.safeImageUrl(st.companyLogo) : '';
            const tax = String(st.taxNumber || '').trim();
            return `<header class="pa-invoice-header"><div class="pa-company">${logo ? `<img class="pa-company-logo" src="${PA_CORE.escapeHtml(logo)}" alt="">` : ''}<div><h1 class="pa-company-name">${PA_CORE.escapeHtml(st.companyName || '')}</h1><p class="pa-company-sub">${PA_CORE.escapeHtml(st.companySub || '')}</p>${tax ? `<p class="pa-company-sub">الرقم الضريبي / السجل: <span dir="ltr">${PA_CORE.escapeHtml(tax)}</span></p>` : ''}</div></div></header>`;
        }
        function paDocFooter() {
            const st = db.settings || {};
            return `<footer class="pa-document-footer"><div>${PA_CORE.escapeHtml(st.companyName || '')} | ${PA_CORE.escapeHtml(st.companySub || '')}</div><div dir="ltr">ProAccountant Syria | Dev: Basel Al-Kabor | +963 952 575 089</div></footer>`;
        }

        function printInvoiceById(invId, format = 'a4', opts = {}) {
            const inv = opts.invoice || db.invoices.find(i => i.id === invId);
            if (!inv) return;
            const settings = Object.assign({}, db.settings || {}, opts.settings || {});
            const tpl = settings.invoiceTemplate || 'modern';
            const showQr = settings.invShowQr !== false;
            const showLogo = settings.invShowLogo !== false;
            const showBalance = settings.invShowBalance !== false;
            const taxNumber = String(settings.taxNumber || '').trim();
            const customFooter = String(settings.invoiceFooter || '').trim();

            const acc = opts.account || db.accounts.find(a => a.id === inv.accountId);
            const title = inv.type === 'sales' ? 'فاتورة مبيعات' : 'فاتورة مشتريات';
            const methodLabel = inv.payMethod === 'card_check' ? 'بطاقة / شيك' : (inv.payMethod === 'bank_transfer' ? 'تحويل بنكي' : 'نقدي');
            const payLabel = inv.paymentType === 'cash' ? methodLabel : (inv.paymentType === 'installment' ? 'تقسيط' : 'آجل');
            const currencyLabel = inv.currency === 'SYP' ? 'ل.س' : '$';
            const formatAmount = value => Number(value || 0).toLocaleString('en-US', {
                minimumFractionDigits: inv.currency === 'USD' ? 2 : 0, maximumFractionDigits: 6
            });
            const qrPayload = `${settings.companyName || ''} | ${title} ${inv.number} | ${inv.date} | ${acc ? acc.name : '-'} | $${Number(inv.totalUSD || 0).toFixed(2)}`;
            const qrDataUrl = showQr ? PA_CORE.safeImageUrl(generateQRDataURL(qrPayload, format === 'thermal' ? 74 : 94)) : '';
            const logoUrl = showLogo ? PA_CORE.safeImageUrl(settings.companyLogo) : '';
            const accBalanceUSD = (showBalance && !opts.invoice && acc && acc.id !== 'acc_cash_client' && typeof calculateAccountBalanceUSD === 'function')
                ? calculateAccountBalanceUSD(acc.id)
                : null;
            const balanceHtml = accBalanceUSD !== null
                ? `<div>الرصيد الحالي: <strong dir="ltr">$${Math.abs(accBalanceUSD).toFixed(2)}</strong> (${accBalanceUSD > 0 ? 'عليه' : (accBalanceUSD < 0 ? 'له' : 'متوازن')})</div>`
                : '';

            const rowsHtml = inv.items.map((item, idx) => `
                <tr>
                    <td>${idx + 1}</td>
                    <td>${PA_CORE.escapeHtml(item.itemName)}${item.note ? `<small class="pa-line-note">${PA_CORE.escapeHtml(item.note)}</small>` : ''}</td>
                    <td dir="ltr">${Number(item.qty || 0).toLocaleString('en-US', { maximumFractionDigits: 3 })}</td>
                    <td dir="ltr">${formatAmount(item.priceOrig)}</td>
                    <td dir="ltr">${formatAmount(item.subOrig)}</td>
                </tr>
            `).join('');
            const receiptRows = inv.items.map((item, idx) => `
                <div class="pa-receipt-item">
                    <strong>${idx + 1}. ${PA_CORE.escapeHtml(item.itemName)}</strong>
                    ${item.note ? `<small class="pa-line-note">${PA_CORE.escapeHtml(item.note)}</small>` : ''}
                    <div class="pa-receipt-amounts"><span dir="ltr">${Number(item.qty || 0).toLocaleString('en-US', { maximumFractionDigits: 3 })} × ${formatAmount(item.priceOrig)}</span><b dir="ltr">${formatAmount(item.subOrig)} ${currencyLabel}</b></div>
                </div>
            `).join('');
            const html = `
                <article class="pa-invoice tpl-${PA_CORE.escapeHtml(tpl)} ${inv.type === 'sales' ? 'is-sales' : 'is-purchase'}"${/^#[0-9a-f]{6}$/i.test(settings.invoiceAccent || '') ? ` style="--pa-acc:${settings.invoiceAccent}"` : ''}>
                    <header class="pa-invoice-header">
                        <div class="pa-company">
                            ${logoUrl ? `<img class="pa-company-logo" src="${PA_CORE.escapeHtml(logoUrl)}" alt="">` : ''}
                            <div>
                                <h1 class="pa-company-name">${PA_CORE.escapeHtml(settings.companyName || '')}</h1>
                                <p class="pa-company-sub">${PA_CORE.escapeHtml(settings.companySub || '')}</p>
                                ${taxNumber ? `<p class="pa-company-sub" style="font-size:10.5px;">الرقم الضريبي / السجل: <span dir="ltr">${PA_CORE.escapeHtml(taxNumber)}</span></p>` : ''}
                            </div>
                        </div>
                        ${qrDataUrl ? `<img class="pa-qr" src="${PA_CORE.escapeHtml(qrDataUrl)}" alt="QR">` : ''}
                    </header>
                    <div class="pa-invoice-banner ${inv.type === 'sales' ? 'is-sales' : ''}">
                        <span>${title} (${payLabel})</span>
                        <span>رقم: ${PA_CORE.escapeHtml(inv.number)}</span>
                    </div>
                    <div class="pa-invoice-meta">
                        <div>العميل/المورد: <strong>${PA_CORE.escapeHtml(acc ? acc.name : '-')}</strong></div>
                        <div>التاريخ: ${PA_CORE.escapeHtml(inv.date)}</div>
                        <div>العملة: ${PA_CORE.escapeHtml(inv.currency)} | سعر الصرف: ${Number(inv.rate || settings.exchangeRate || 0).toLocaleString('en-US')}</div>
                        ${balanceHtml}
                        ${inv.receiptNo ? `<div>مرجع التسديد: ${PA_CORE.escapeHtml(inv.receiptNo)}</div>` : ''}
                    </div>
                    <table class="pa-invoice-table">
                        <thead><tr><th>#</th><th>المادة</th><th>الكمية</th><th>السعر (${currencyLabel})</th><th>المجموع (${currencyLabel})</th></tr></thead>
                        <tbody>${rowsHtml}</tbody>
                    </table>
                    <div class="pa-receipt-items">${receiptRows}</div>
                    <div class="pa-invoice-totals">
                        <div class="pa-invoice-discount"><span>إجمالي البنود</span><b dir="auto">${formatAmount(inv.items.reduce((sum, item) => sum + Number(item.subOrig || 0), 0))} ${currencyLabel}</b></div>
                        ${inv.discount > 0 ? `<div class="pa-invoice-discount"><span>الخصم</span><b dir="auto">- ${formatAmount(inv.discount)} ${currencyLabel}</b></div>` : ''}
                        <div class="pa-invoice-net"><span>الصافي المستحق</span><b dir="auto">${inv.currency === 'SYP' ? Number(inv.totalSYP || 0).toLocaleString('en-US') + ' ل.س' : '$' + Number(inv.totalUSD || 0).toFixed(2)}</b></div>
                        <div class="pa-invoice-syp"><span>${inv.currency === 'SYP' ? 'المعادل بالدولار' : 'المعادل بالليرة'}</span><b dir="auto">${inv.currency === 'SYP' ? '$' + Number(inv.totalUSD || 0).toFixed(2) : Number(inv.totalSYP || 0).toLocaleString('en-US') + ' ل.س'}</b></div>
                    </div>
                    ${inv.notes ? `<div class="pa-invoice-notes"><strong>ملاحظات:</strong> ${PA_CORE.escapeHtml(inv.notes)}</div>` : ''}
                    <footer class="pa-document-footer">
                        ${customFooter ? `<div style="font-weight:700;margin-bottom:2px;">${PA_CORE.escapeHtml(customFooter)}</div>` : ''}
                        <div>شكراً لتعاملكم معنا — ${PA_CORE.escapeHtml(settings.companyName || '')} | ${PA_CORE.escapeHtml(settings.companySub || '')}</div>
                        <div dir="ltr">ProAccountant Syria | Dev: Basel Al-Kabor | +963 952 575 089</div>
                    </footer>
                </article>
            `;
            const safeNumber = String(inv.number || inv.id).replace(/[^\p{L}\p{N}_-]+/gu, '-');
            triggerPrint(html, format, { title, fileName: `Invoice_${safeNumber}.pdf`, kind: 'invoice' });
        }

        /* معاينة تصميم الفاتورة بالإعدادات الحالية (قبل الحفظ) ببيانات تجريبية */
        function previewInvoiceDesign(paper = 'a4') {
            const get = (id, d) => document.getElementById(id)?.value || d;
            const chk = id => !!document.getElementById(id)?.checked;
            const rate = Number(db.settings.exchangeRate) || 15000;
            const sample = {
                id: 'preview', type: 'sales', number: '1001', paymentType: 'credit', date: PA_CORE.getLocalDateString(),
                currency: 'USD', rate, discount: 5,
                items: [
                    { itemName: 'قميص رجالي قطني', qty: 2, priceOrig: 12.5, subOrig: 25, note: 'لون أزرق' },
                    { itemName: 'بنطال جينز كلاسيك مقاس 32', qty: 1, priceOrig: 30, subOrig: 30 },
                    { itemName: 'حذاء رياضي', qty: 3, priceOrig: 18, subOrig: 54 }
                ],
                totalUSD: 104, totalSYP: Math.round(104 * rate), notes: 'فاتورة تجريبية لمعاينة التصميم'
            };
            printInvoiceById('preview', paper, {
                invoice: sample, account: { id: 'x', name: 'عميل تجريبي' },
                settings: {
                    invoiceTemplate: get('set-invoice-template', 'modern'),
                    invoiceAccent: get('set-invoice-accent', ''),
                    taxNumber: get('set-tax-number', ''), invoiceFooter: get('set-invoice-footer', ''),
                    invShowQr: chk('set-inv-show-qr'), invShowLogo: chk('set-inv-show-logo'), invShowBalance: false
                }
            });
        }

        /* ===== تكرار وحذف الفاتورة ===== */
        function duplicateInvoiceById(invId) {
            const inv = db.invoices.find(i => i.id === invId);
            if (!inv) return;
            if (!switchTab(inv.type === 'sales' ? 'sales' : 'purchases') && currentInvoiceMode !== (inv.type === 'sales' ? 'sales' : 'purchase')) return;
            resetInvoiceForm();
            const accSel = document.getElementById('inv-account-select');
            if (accSel && db.accounts.some(a => a.id === inv.accountId)) accSel.value = inv.accountId;
            const curEl = document.getElementById('inv-currency');
            if (curEl) { curEl.value = inv.currency; if (typeof handleInvoiceCurrencyChange === 'function') handleInvoiceCurrencyChange(); }
            const tbody = document.getElementById('invoice-items-body');
            tbody.innerHTML = '';
            inv.items.forEach(line => {
                addInvoiceRow(false);
                const tr = tbody.lastElementChild;
                const sel = tr.querySelector('.row-item-select');
                if (sel && db.items.some(i => i.id === line.itemId)) {
                    sel.value = line.itemId;
                    onRowItemSelect(sel);
                } else if (sel) { return; }
                const q = tr.querySelector('.row-qty'); if (q) q.value = line.qty;
                const n = tr.querySelector('.row-note'); if (n) n.value = line.note || '';
            });
            if (!tbody.children.length) addInvoiceRow(false);
            recalculateInvoice();
            showToast('تم نسخ بنود الفاتورة؛ راجعها ثم اضغط إتمام', 'success');
        }

        async function deleteInvoiceById(invId) {
            const inv = db.invoices.find(i => i.id === invId);
            if (!inv) return;
            if ((db.returns || []).some(r => r.invoiceId === inv.id)) {
                showToast('لا يمكن حذف فاتورة لديها مرتجعات. احذف المرتجعات أولاً.', 'error');
                return;
            }
            if (!window.confirm(`حذف الفاتورة ${inv.number}؟ سيتم عكس أثرها على المخزون والأرصدة.`)) return;
            const done = await commitDatabaseMutation(() => {
                const sign = inv.type === 'sales' ? 1 : -1;
                if (sign < 0) {
                    const short = inv.items.find(l => { const it = db.items.find(i => i.id === l.itemId); return it && it.type === 'stock' && it.qty < l.qty; });
                    if (short) throw new Error(`لا يمكن عكس الشراء: رصيد «${short.itemName}» أقل من الكمية المشتراة`);
                }
                inv.items.forEach(l => {
                    const it = db.items.find(i => i.id === l.itemId);
                    if (it && it.type === 'stock') it.qty = Number((it.qty + sign * Number(l.qty)).toFixed(6));
                });
                db.vouchers = db.vouchers.filter(v => v.invoiceId !== inv.id);
                db.installments = (db.installments || []).filter(x => x.invoiceId !== inv.id);
                db.invoices = db.invoices.filter(i => i.id !== inv.id);
                return true;
            });
            if (done) {
                refreshAllViews();
                if (typeof renderAllExtendedViews === 'function') renderAllExtendedViews();
                resetInvoiceForm();
                showToast('تم حذف الفاتورة وعكس أثرها', 'success');
            }
        }

        /* ===== حجم البيانات + استعادة آخر نسخة سليمة ===== */
        const LAST_GOOD_KEY = STORAGE_KEY + '_last_good';
        function updateDataSizeInfo() {
            const el = document.getElementById('data-size-info');
            if (!el) return;
            let bytes = 0;
            try { bytes = new Blob([JSON.stringify(db)]).size; } catch (e) {}
            const imgs = db.items.filter(i => i.image).length;
            el.textContent = `حجم البيانات: ${(bytes / 1024).toFixed(bytes > 1048576 ? 0 : 1)} KB — ${db.items.length} صنف (${imgs} بصورة) — ${db.invoices.length} فاتورة`;
            el.classList.toggle('text-rose-400', bytes > 3 * 1048576);
        }
        async function restoreLastGoodBackup() {
            let raw = null;
            try { raw = localStorage.getItem(LAST_GOOD_KEY) || localStorage.getItem(RESTORE_BACKUP_KEY); } catch (e) {}
            if (!raw) { showToast('لا توجد نسخة سليمة محفوظة بعد', 'warning'); return; }
            try { await applyRestoredDatabase(JSON.parse(raw)); }
            catch (e) { showToast('النسخة المحفوظة غير صالحة', 'error'); }
        }
        function printVoucherById(vId) {
            const v = db.vouchers.find(x => x.id === vId);
            if (!v) return;
            const acc = db.accounts.find(a => a.id === v.accountId);
            const title = v.type === 'receipt' ? 'سند قبض' : 'سند دفع';
            const method = v.payMethod === 'bank_transfer' ? 'تحويل بنكي' : (v.payMethod === 'card_check' ? 'بطاقة / شيك' : 'نقدي');
            const orig = Number(v.origAmount || 0);
            const html = `
                <article class="pa-invoice pa-voucher ${paDocClasses()} ${v.type === 'receipt' ? 'is-sales' : 'is-purchase'}" ${paAccentStyle()}>
                    ${paDocHeader()}
                    <div class="pa-invoice-banner ${v.type === 'receipt' ? 'is-sales' : 'is-purchase'}"><span>${title}</span><span>رقم: ${PA_CORE.escapeHtml(v.number)}</span></div>
                    <div class="pa-invoice-meta">
                        <div>${v.type === 'receipt' ? 'استلمنا من السيد/ة' : 'دفعنا إلى السيد/ة'}: <strong>${PA_CORE.escapeHtml(acc ? acc.name : '-')}</strong></div>
                        <div>التاريخ: <bdi dir="ltr">${PA_CORE.escapeHtml(v.date)}</bdi></div>
                        <div>طريقة الدفع: ${method}</div>
                        <div>العملة: ${PA_CORE.escapeHtml(v.currency || 'USD')}${v.currency === 'SYP' ? ` | سعر الصرف: ${Number(v.rate || db.settings.exchangeRate || 0).toLocaleString('en-US')}` : ''}</div>
                    </div>
                    <div class="pa-invoice-totals">
                        <div class="pa-invoice-net"><span>المبلغ</span><b dir="ltr">$${Number(v.amountUSD || 0).toFixed(2)}</b></div>
                        ${v.currency === 'SYP' ? `<div class="pa-invoice-syp"><span>المبلغ الأصلي</span><b dir="auto">${orig.toLocaleString('en-US')} ل.س</b></div>` : ''}
                    </div>
                    <div class="pa-invoice-notes"><strong>وذلك عن:</strong> ${PA_CORE.escapeHtml(v.note || 'دفعة على الحساب')}</div>
                    <div class="pa-signatures"><div>توقيع المستلم</div><div>توقيع المحاسب</div></div>
                    ${paDocFooter()}
                </article>
            `;
            triggerPrint(html, 'a4', { title, fileName: `Voucher_${String(v.number || v.id).replace(/[^\p{L}\p{N}_-]+/gu, '-')}.pdf`, kind: 'voucher' });
        }

        function printStatementA4() {
            const accountId = document.getElementById('statement-account-select').value;
            const acc = db.accounts.find(a => a.id === accountId);
            if (!acc) return;
            const rows = getAccountStatementRows(accountId);
            const finalBal = calculateAccountBalanceUSD(accountId);

            const totalDebit = rows.reduce((t, r) => t + Number(r.debit || 0), 0);
            const totalCredit = rows.reduce((t, r) => t + Number(r.credit || 0), 0);
            const money = v => '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            const rowsHtml = rows.map((r, i) => `
                <tr>
                    <td>${i + 1}</td>
                    <td dir="ltr">${PA_CORE.escapeHtml(r.displayDate)}</td>
                    <td>${PA_CORE.escapeHtml(r.ref)}</td>
                    <td>${PA_CORE.escapeHtml(r.desc)}</td>
                    <td dir="ltr">${r.debit > 0 ? money(r.debit) : '—'}</td>
                    <td dir="ltr">${r.credit > 0 ? money(r.credit) : '—'}</td>
                    <td><b dir="ltr">${money(Math.abs(r.running))}</b> <small>${r.running > 0 ? 'عليه' : (r.running < 0 ? 'له' : '')}</small></td>
                </tr>
            `).join('') || '<tr><td colspan="7">لا توجد حركات على هذا الحساب</td></tr>';
            const html = `
                <article class="pa-invoice pa-statement ${paDocClasses()}" ${paAccentStyle()}>
                    ${paDocHeader()}
                    <div class="pa-invoice-banner is-sales"><span>كشف حساب تفصيلي</span><span>${PA_CORE.escapeHtml(acc.name)}</span></div>
                    <div class="pa-invoice-meta">
                        <div>الحساب: <strong>${PA_CORE.escapeHtml(acc.name)}</strong></div>
                        <div>النوع: ${acc.type === 'supplier' ? 'مورد' : (acc.type === 'both' ? 'زبون ومورد' : 'زبون')}</div>
                        <div>الهاتف: <bdi dir="ltr">${PA_CORE.escapeHtml(acc.phone || '-')}</bdi></div>
                        <div>تاريخ الطباعة: <bdi dir="ltr">${PA_CORE.getLocalDateString()}</bdi></div>
                    </div>
                    <table class="pa-invoice-table pa-stmt-table">
                        <thead><tr><th>#</th><th>التاريخ</th><th>المرجع</th><th>البيان</th><th>مدين</th><th>دائن</th><th>الرصيد</th></tr></thead>
                        <tbody>${rowsHtml}</tbody>
                    </table>
                    <div class="pa-invoice-totals">
                        <div class="pa-invoice-discount"><span>مجموع المدين</span><b dir="ltr">${money(totalDebit)}</b></div>
                        <div class="pa-invoice-discount"><span>مجموع الدائن</span><b dir="ltr">${money(totalCredit)}</b></div>
                        <div class="pa-invoice-net"><span>الرصيد النهائي ${finalBal > 0 ? '(ذمة على الحساب)' : (finalBal < 0 ? '(رصيد دائن للحساب)' : '(متوازن)')}</span><b dir="ltr">${money(Math.abs(finalBal))}</b></div>
                        <div class="pa-invoice-syp"><span>المعادل بالليرة</span><b dir="auto">${Math.round(Math.abs(finalBal) * Number(db.settings.exchangeRate || 0)).toLocaleString('en-US')} ل.س</b></div>
                    </div>
                    ${paDocFooter()}
                </article>
            `;
            triggerPrint(html, 'a4', { title: 'كشف حساب', fileName: `Statement_${Date.now()}.pdf`, kind: 'statement' });
        }

        function exportBackupJSON() {
            const validated = PA_CORE.validateDatabaseBackup(db);
            if (!validated.ok) {
                showToast(`تعذر تصدير نسخة غير صالحة: ${validated.error}`, 'error');
                return;
            }
            const dataStr = JSON.stringify(validated.data, null, 2);
            const blob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const dateTag = PA_CORE.getLocalDateString();
            a.href = url;
            a.download = `ProAccountant_Syria_Backup_${dateTag}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showToast('تم تحميل ملف النسخة الاحتياطية بنجاح.', 'success');
        }

        async function applyRestoredDatabase(imported) {
            const validated = PA_CORE.validateDatabaseBackup(imported);
            if (!validated.ok) {
                showToast(validated.error, 'error');
                return false;
            }
            if (!window.confirm('سيتم استبدال البيانات الحالية بالكامل. هل تريد المتابكة؟')) return false;

            let rollbackRaw = JSON.stringify(db);
            try { rollbackRaw = getStoredDatabaseRaw() || rollbackRaw; } catch (e) {}
            try {
                localStorage.setItem(RESTORE_BACKUP_KEY, rollbackRaw);
            } catch (err) {
                showToast('تعذر إنشاء نسخة أمان قبل الاستعادة', 'error');
                return false;
            }

            const restored = await commitDatabaseMutation(() => {
                db = validated.data;
                ensureExtendedStores();
                return true;
            }, { allowRecovery: true });
            if (!restored) return false;
            isAppUnlockedThisSession = false;
            initAppPinSecurity();

            document.getElementById('exchange-rate-input').value = db.settings.exchangeRate;
            document.getElementById('set-company-name').value = db.settings.companyName;
            document.getElementById('set-company-sub').value = db.settings.companySub;
            refreshAllViews();
            renderAllExtendedViews();
            resetInvoiceForm();
            showToast('تم استرجاع البيانات بنجاح وحفظ نسخة أمان للبيانات السابقة ✔', 'success');
            return true;
        }

        function importBackupJSON(event) {
            const file = event.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async function(e) {
                try {
                    const imported = JSON.parse(e.target.result);
                    await applyRestoredDatabase(imported);
                } catch (err) {
                    showToast('خطأ في قراءة ملف JSON', 'error');
                }
            };
            reader.readAsText(file);
            event.target.value = '';
        }

        async function saveCompanySettings() {
            const companyName = document.getElementById('set-company-name').value.trim() || 'محاسب محترف سوريا';
            const companySub = document.getElementById('set-company-sub').value.trim() || 'بإدارة باسل محمد الخابور - 0952575089';
            const saved = await commitDatabaseMutation(() => {
                db.settings.companyName = companyName;
                db.settings.companySub = companySub;
                return true;
            });
            if (saved) showToast('تم حفظ إعدادات الترويسة', 'success');
        }

        async function loadDemoData() {
            if (!window.confirm('سيتم استبدال البيانات الحالية بمجموعة تجريبية متكاملة. هل تريد المتابعة؟')) return;
            const saved = await commitDatabaseMutation(() => {
                const settings = { ...db.settings };
                db = { settings, items: [], accounts: [], invoices: [], vouchers: [], returns: [], cashboxes: [], warehouses: [], expenses: [], employees: [], installments: [], auditLog: [] };
                seedInitialDefaults();
                const today = PA_CORE.getLocalDateString();
                db.invoices = [{
                    id: 'inv_demo_1', number: '#1001', type: 'sales', paymentType: 'credit',
                    accountId: 'acc_1', date: today, currency: 'USD', rate: settings.exchangeRate,
                    items: [{ itemId: 'itm_1', itemName: 'راوتر TP-Link ثنائي الهوائي', qty: 2, priceOrig: 25, priceUSD: 25, subOrig: 50, note: '' }],
                    discount: 0, totalUSD: 50, totalSYP: 50 * settings.exchangeRate, notes: 'فاتورة تجريبية'
                }];
                db.vouchers = [{
                    id: 'vch_demo_1', number: 'RCV-101', type: 'receipt', accountId: 'acc_1',
                    amountUSD: 20, origAmount: 20, currency: 'USD', rate: settings.exchangeRate,
                    date: today, note: 'دفعة أولى تجريبية'
                }];
                db.items.find(item => item.id === 'itm_1').qty = 10;
                return true;
            }, { allowRecovery: true });
            if (!saved) return;
            isAppUnlockedThisSession = false;
            initAppPinSecurity();
            refreshAllViews();
            resetInvoiceForm();
            showToast('تم تحميل البيانات التجريبية بنجاح', 'success');
        }

        async function confirmResetAllData() {
            if (!resetConfirmFlag) {
                resetConfirmFlag = true;
                showToast('اضغط على زر التصفير مرة أخرى خلال 5 ثوانٍ لتأكيد مسح جميع البيانات!', 'error');
                setTimeout(() => { resetConfirmFlag = false; }, 5000);
                return;
            }
            resetConfirmFlag = false;
            const saved = await commitDatabaseMutation(() => {
                const settings = { ...db.settings };
                db = { settings, items: [], accounts: [], invoices: [], vouchers: [], returns: [], cashboxes: [], warehouses: [], expenses: [], employees: [], installments: [], auditLog: [] };
                seedInitialDefaults();
                return true;
            }, { allowRecovery: true });
            if (!saved) return;
            isAppUnlockedThisSession = false;
            initAppPinSecurity();
            refreshAllViews();
            resetInvoiceForm();
            showToast('تم تصفير جميع البيانات وإعادة الضبط', 'info');
        }

        function playToastTone(type) {
            if (db.settings && db.settings.soundEffects === false) return;
            try {
                const ctx = new (window.AudioContext || window.webkitAudioContext)();
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.value = type === 'success' ? 880 : (type === 'error' ? 280 : 620);
                gain.gain.value = 0.04;
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start();
                setTimeout(() => { osc.stop(); ctx.close(); }, 90);
            } catch (e) {}
        }

        function showToast(message, type = 'info', duration = 3500) {
            const container = document.getElementById('toast-container');
            if (!container) return;
            const toast = document.createElement('div');
            const colors = {
                success: 'bg-emerald-600 border-emerald-400 text-white',
                error: 'bg-rose-600 border-rose-400 text-white',
                warning: 'bg-amber-600 border-amber-300 text-white',
                info: 'bg-slate-800 border-sky-400 text-sky-200'
            };
            const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
            toast.className = `pointer-events-auto border px-4 py-3 rounded-xl shadow-2xl text-sm font-bold transition-all duration-300 flex items-center justify-between gap-3 ${colors[type] || colors.info}`;
            toast.innerHTML = `<span>${icons[type] || 'ℹ️'} ${PA_CORE.escapeHtml(message)}</span><button type="button" onclick="this.parentElement.remove()" style="background:transparent;border:none;color:inherit;font-weight:900;font-size:15px;cursor:pointer;padding:0 4px;">✕</button>`;
            while (container.children.length >= 2) container.firstElementChild.remove();
            toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
            container.appendChild(toast);
            if (type === 'success' || type === 'error') playToastTone(type);

            setTimeout(() => {
                if (!toast.parentElement) return;
                toast.style.opacity = '0';
                toast.style.transform = 'translateY(10px)';
                setTimeout(() => toast.remove(), 300);
            }, duration);
        }

        // ==================== منطق قراءة الباركود (قارئ USB + كاميرا) ====================
        let barcodeStream = null;
        let barcodeScanInterval = null;
        let barcodeTargetMode = 'invoice';

        function playBeepSound() {
            try {
                const ctx = new (window.AudioContext || window.webkitAudioContext)();
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.value = 1000;
                gain.gain.value = 0.1;
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start();
                setTimeout(() => { osc.stop(); ctx.close(); }, 100);
            } catch (e) {}
        }

        function handleBarcodeScanned(rawCode) {
            const code = (rawCode || '').trim();
            if (!code) return;

            playBeepSound();
            try { if (navigator.vibrate) navigator.vibrate(60); } catch (e) {}

            if (barcodeTargetMode === 'itemCard') {
                document.getElementById('item-code').value = code;
                showToast(`تم التقاط الباركود: ${code} ✔`, 'success');
                barcodeTargetMode = 'invoice';
                return;
            }

            const matchedItem = db.items.find(i => i.code && i.code.trim().toLowerCase() === code.toLowerCase());
            if (!matchedItem) {
                showToast(`لا توجد مادة مسجلة بهذا الباركود: ${code}`, 'error');
                return;
            }

            const rows = Array.from(document.querySelectorAll('#invoice-items-body tr'));
            const existingRow = rows.find(tr => tr.querySelector('.row-item-select').value === matchedItem.id);

            if (existingRow) {
                const qtyInput = existingRow.querySelector('.row-qty');
                qtyInput.value = (parseFloat(qtyInput.value) || 0) + 1;
                recalculateInvoice();
                showToast(`+1 ${matchedItem.name} (${currentInvoiceMode === 'sales' ? 'مبيع' : 'شراء'})`, 'success');
                return;
            }

            let targetRow = rows.find(tr => !tr.querySelector('.row-item-select').value);
            if (!targetRow) targetRow = addInvoiceRow(false);

            const sel = targetRow.querySelector('.row-item-select');
            sel.value = matchedItem.id;
            onRowItemSelect(sel);
            targetRow.querySelector('.row-qty').value = 1;
            recalculateInvoice();
            showToast(`تمت إضافة: ${matchedItem.name} ✔`, 'success');
        }

        async function openCameraBarcodeScanner(mode = 'invoice') {
            barcodeTargetMode = mode;
            if (window.AndroidNative && typeof window.AndroidNative.requestCameraPermission === 'function') {
                const granted = window.AndroidNative.requestCameraPermission(mode);
                if (!granted) {
                    showToast('يرجى السماح بصلاحية الكاميرا من النافذة المنبثقة...', 'info');
                    return;
                }
            }
            startCameraStreamDirectly(mode);
        }

        function onAndroidCameraPermissionDenied() {
            showToast('تم رفض إذن الكاميرا. جاري فتح إعدادات التطبيق لتفعيلها...', 'error');
            if (window.AndroidNative && typeof window.AndroidNative.openAppSettings === 'function') {
                setTimeout(() => window.AndroidNative.openAppSettings(), 1200);
            }
        }

        async function startCameraStreamDirectly(mode = 'invoice') {
            barcodeTargetMode = mode;
            const modal = document.getElementById('barcode-camera-modal');
            const video = document.getElementById('barcode-video-preview');
            const status = document.getElementById('barcode-camera-status');

            modal.classList.remove('hidden');
            status.textContent = 'جاري تشغيل الكاميرا...';

            try {
                barcodeStream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: { ideal: 'environment' } },
                    audio: false
                });
                video.srcObject = barcodeStream;
                await video.play();

                if ('BarcodeDetector' in window) {
                    const detector = new BarcodeDetector({
                        formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'qr_code', 'upc_a', 'upc_e']
                    });
                    status.textContent = 'وجّه الكاميرا نحو الباركود ليتم التقاطه تلقائياً...';

                    barcodeScanInterval = setInterval(async () => {
                        if (video.readyState === video.HAVE_ENOUGH_DATA) {
                            try {
                                const barcodes = await detector.detect(video);
                                if (barcodes.length > 0 && barcodes[0].rawValue) {
                                    const detectedCode = barcodes[0].rawValue;
                                    closeCameraBarcodeScanner();
                                    handleBarcodeScanned(detectedCode);
                                }
                            } catch (err) {}
                        }
                    }, 300);
                } else {
                    status.innerHTML = '';
                    status.append('الفحص التلقائي غير مدعوم على هذا الجهاز — اكتب رقم الباركود يدوياً أو استخدم قارئ USB/Bluetooth: ');
                    const man = document.createElement('input');
                    man.type = 'text'; man.inputMode = 'numeric'; man.className = 'amin-input rounded-xl px-3 py-2 text-sm font-mono w-full mt-2'; man.placeholder = 'رقم الباركود';
                    man.addEventListener('keydown', ev => { if (ev.key === 'Enter' && man.value.trim()) { const v = man.value; closeCameraBarcodeScanner(); handleBarcodeScanned(v); } });
                    status.appendChild(man);
                }
            } catch (err) {
                status.textContent = 'تعذر الوصول إلى الكاميرا. تأكد من تفعيل إذن الكاميرا من إعدادات الهاتف.';
            }
        }

        function closeCameraBarcodeScanner() {
            if (barcodeScanInterval) {
                clearInterval(barcodeScanInterval);
                barcodeScanInterval = null;
            }
            if (barcodeStream) {
                barcodeStream.getTracks().forEach(track => track.stop());
                barcodeStream = null;
            }
            document.getElementById('barcode-camera-modal').classList.add('hidden');
        }

        // ==================== نظام الحماية برمز PIN ====================
        let currentPinBuffer = '';
        let isAppUnlockedThisSession = false;
        let pinFailedAttempts = 0;
        let pinLockoutUntil = 0;

        function initAppPinSecurity() {
            const hasPin = !!(db.settings && db.settings.appPin && db.settings.appPin.length === 4);
            const statusBadge = document.getElementById('pin-status-badge');
            const disableBtn = document.getElementById('disable-pin-btn');
            const headerLockBtn = document.getElementById('header-lock-btn');

            if (hasPin) {
                if (statusBadge) {
                    statusBadge.textContent = 'مفعّل ✔';
                    statusBadge.className = 'text-xs font-bold px-2.5 py-1 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40';
                }
                if (disableBtn) disableBtn.classList.remove('hidden');
                if (headerLockBtn) headerLockBtn.classList.remove('hidden');

                if (!isAppUnlockedThisSession) {
                    showPinLockScreen();
                }
            } else {
                if (statusBadge) {
                    statusBadge.textContent = 'غير مفعّل';
                    statusBadge.className = 'text-xs font-bold px-2.5 py-1 rounded-full bg-slate-800 text-slate-400 border border-slate-700';
                }
                if (disableBtn) disableBtn.classList.add('hidden');
                if (headerLockBtn) headerLockBtn.classList.add('hidden');
                document.getElementById('pin-lock-screen').classList.add('hidden');
            }
        }

        function showPinLockScreen() {
            currentPinBuffer = '';
            updatePinDotsUI();
            document.getElementById('pin-error-msg').textContent = '';
            document.getElementById('pin-lock-screen').classList.remove('hidden');
        }

        function lockAppNow() {
            if (!db.settings || !(db.settings.appPin || db.settings.biometricLock)) return;
            isAppUnlockedThisSession = false;
            showPinLockScreen();
        }

        function enterPinDigit(digit) {
            const now = Date.now();
            if (pinLockoutUntil > now) {
                const sec = Math.ceil((pinLockoutUntil - now) / 1000);
                document.getElementById('pin-error-msg').textContent = `محاولات كثيرة! انتظر ${sec} ثانية`;
                return;
            }
            if (currentPinBuffer.length >= 4) return;
            currentPinBuffer += digit;
            updatePinDotsUI();

            if (currentPinBuffer.length === 4) {
                setTimeout(() => {
                    if (currentPinBuffer === db.settings.appPin) {
                        pinFailedAttempts = 0;
                        isAppUnlockedThisSession = true;
                        document.getElementById('pin-lock-screen').classList.add('hidden');
                        currentPinBuffer = '';
                        updatePinDotsUI();
                        showToast('تم فتح القفل بنجاح ✔', 'success');
                    } else {
                        pinFailedAttempts++;
                        if (pinFailedAttempts >= 5) {
                            pinLockoutUntil = Date.now() + 30000;
                            pinFailedAttempts = 0;
                            document.getElementById('pin-error-msg').textContent = 'تم القفل مؤقتاً 30 ثانية بعد 5 محاولات خاطئة';
                        } else {
                            document.getElementById('pin-error-msg').textContent = `رمز PIN غير صحيح! (${pinFailedAttempts}/5)`;
                        }
                        currentPinBuffer = '';
                        updatePinDotsUI();
                    }
                }, 120);
            }
        }

        function backspacePinDigit() {
            currentPinBuffer = currentPinBuffer.slice(0, -1);
            updatePinDotsUI();
        }

        function clearPinInput() {
            currentPinBuffer = '';
            document.getElementById('pin-error-msg').textContent = '';
            updatePinDotsUI();
        }

        function updatePinDotsUI() {
            const dots = document.querySelectorAll('#pin-dots-container .pin-dot');
            dots.forEach((dot, idx) => {
                if (idx < currentPinBuffer.length) {
                    dot.classList.remove('bg-transparent');
                    dot.classList.add('bg-amber-400', 'scale-110');
                } else {
                    dot.classList.add('bg-transparent');
                    dot.classList.remove('bg-amber-400', 'scale-110');
                }
            });
        }

        async function saveAppPinSetting() {
            const pin = document.getElementById('new-pin-input').value.trim();
            const confirmation = document.getElementById('confirm-pin-input').value.trim();
            if (!/^\d{4}$/.test(pin)) return showToast('يجب أن يتكون رمز PIN من 4 أرقام فقط', 'error');
            if (pin !== confirmation) return showToast('الرمزان غير متطابقين', 'error');
            const saved = await commitDatabaseMutation(() => {
                db.settings.appPin = pin;
                return true;
            });
            if (!saved) return;
            isAppUnlockedThisSession = true;
            document.getElementById('new-pin-input').value = '';
            document.getElementById('confirm-pin-input').value = '';
            initAppPinSecurity();
            showToast('تم تفعيل قفل الحماية برمز PIN', 'success');
        }

        async function disableAppPinSetting() {
            const saved = await commitDatabaseMutation(() => {
                delete db.settings.appPin;
                return true;
            });
            if (!saved) return;
            isAppUnlockedThisSession = false;
            initAppPinSecurity();
            showToast('تم إلغاء قفل الحماية برمز PIN', 'info');
        }

        document.addEventListener('keydown', function(e) {
            const lockScreen = document.getElementById('pin-lock-screen');
            if (lockScreen && !lockScreen.classList.contains('hidden')) {
                e.stopImmediatePropagation();
                if (/^[0-9]$/.test(e.key)) {
                    e.preventDefault();
                    enterPinDigit(e.key);
                } else if (e.key === 'Backspace') {
                    e.preventDefault();
                    backspacePinDigit();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    clearPinInput();
                }
            }
        });

        /* القفل التلقائي: بعد غياب أكثر من 45 ثانية فقط (لا يقفل عند مشاركة PDF أو فتح الكاميرا لثوانٍ) */
        let appHiddenAt = 0;
        document.addEventListener('visibilitychange', () => {
            const protectedApp = db.settings && (db.settings.appPin || db.settings.biometricLock);
            if (document.hidden) { appHiddenAt = Date.now(); return; }
            if (!protectedApp || window.__paBioInFlight || !appHiddenAt) return;
            const away = Date.now() - appHiddenAt;
            appHiddenAt = 0;
            if (away > 45000) lockAppNow();
        });

        let installmentFrequency = 'monthly';
        let profitPeriodFilter = 'all';
        let currentCompReportKey = 'pnl';
        let selectedPrintPaper = 'a4';

        function ensureExtendedStores() {
            if (!Array.isArray(db.cashboxes) || db.cashboxes.length === 0) {
                db.cashboxes = [
                    { id: 'cb_main', name: 'الصندوق الرئيسي', openingBalance: 0 },
                    { id: 'cb_shop', name: 'صندوق المحل', openingBalance: 0 }
                ];
            }
            if (!Array.isArray(db.warehouses) || db.warehouses.length === 0) {
                db.warehouses = ['المستودع الرئيسي', 'مخزن الفرع'];
            }
            if (!Array.isArray(db.expenses)) db.expenses = [];
            if (!Array.isArray(db.employees)) db.employees = [];
            if (!Array.isArray(db.installments)) db.installments = [];

            const defaultCashboxId = db.cashboxes[0].id;
            for (const collection of [db.invoices, db.vouchers, db.returns, db.expenses]) {
                for (const record of collection) {
                    if (!record.cashboxId) record.cashboxId = defaultCashboxId;
                }
            }
        }

        function setInstallmentFreq(freq) {
            installmentFrequency = freq;
            const mBtn = document.getElementById('inst-freq-monthly');
            const wBtn = document.getElementById('inst-freq-weekly');
            const lbl = document.getElementById('inst-count-label');
            if (freq === 'monthly') {
                if (mBtn) mBtn.className = 'px-3 py-1 rounded-lg font-bold bg-sky-600 text-white';
                if (wBtn) wBtn.className = 'px-3 py-1 rounded-lg font-bold bg-slate-700 text-slate-200';
                if (lbl) lbl.textContent = 'عدد الأشهر';
            } else {
                if (wBtn) wBtn.className = 'px-3 py-1 rounded-lg font-bold bg-sky-600 text-white';
                if (mBtn) mBtn.className = 'px-3 py-1 rounded-lg font-bold bg-slate-700 text-slate-200';
                if (lbl) lbl.textContent = 'عدد الأسابيع';
            }
            recalculateInstallmentPlan();
        }

        function recalculateInstallmentPlan() {
            const pTypeEl = document.getElementById('inv-payment-type');
            const panel = document.getElementById('installment-panel');
            if (!pTypeEl || !panel) return;
            const isInst = pTypeEl.value === 'installment';
            panel.classList.toggle('hidden', !isInst);
            if (!isInst) return;

            const totalTxt = (document.getElementById('inv-total-usd')?.textContent || '$0').replace(/[^0-9.-]/g, '');
            const totalUSD = parseFloat(totalTxt) || 0;
            const downUSD = parseFloat(document.getElementById('inst-down-payment')?.value) || 0;
            const count = Math.min(120, Math.max(1, parseInt(document.getElementById('inst-count')?.value, 10) || 1));
            const remUSD = Math.max(0, totalUSD - downUSD);

            const remEl = document.getElementById('inst-remaining');
            const perTotEl = document.getElementById('inst-per-total');
            const perRemEl = document.getElementById('inst-per-rem');
            if (remEl) remEl.value = remUSD.toFixed(2);
            if (perTotEl) perTotEl.value = (totalUSD / count).toFixed(2);
            if (perRemEl) perRemEl.value = (remUSD / count).toFixed(2);
        }

        const origHandlePaymentChange = handlePaymentTypeChange;
        handlePaymentTypeChange = function() {
            const pType = document.getElementById('inv-payment-type').value;
            const accSelect = document.getElementById('inv-account-select');
            if ((pType === 'credit' || pType === 'installment') && accSelect.value === 'acc_cash_client') {
                const firstNamed = db.accounts.find(a => a.id !== 'acc_cash_client');
                if (firstNamed) accSelect.value = firstNamed.id;
                showToast('تم التحويل إلى آجل/تقسيط: يرجى التأكد من اسم العميل', 'info');
            }
            recalculateInstallmentPlan();
        };

        const origRecalc = recalculateInvoice;
        recalculateInvoice = function() {
            origRecalc();
            recalculateInstallmentPlan();
        };

        function invoiceDraftState() {
            return JSON.stringify([currentInvoiceMode, invoiceDraftRevision, installmentFrequency,
                Array.from(document.querySelectorAll('#view-invoice input, #view-invoice select, #view-invoice textarea'))
                    .map(field => [field.id || field.className, field.value])]);
        }

        const origSaveInvoice = saveInvoice;
        saveInvoice = async function() {
            ensureExtendedStores();
            const submittedDraft = invoiceDraftState();
            const pType = document.getElementById('inv-payment-type').value;
            const accountId = document.getElementById('inv-account-select').value;
            if ((pType === 'credit' || pType === 'installment') && accountId === 'acc_cash_client') {
                showToast('لا يمكن حفظ فاتورة آجلة أو تقسيط على (زبون نقدي عام)!', 'error');
                return null;
            }

            let downUSD = pType === 'installment' ? Number(document.getElementById('inst-down-payment')?.value) : 0;
            const installmentCount = pType === 'installment' ? Number(document.getElementById('inst-count')?.value) : 1;
            const count = pType === 'installment' ? installmentCount : 1;
            const firstDate = document.getElementById('inst-first-date')?.value || document.getElementById('inv-date').value;
            const payMethod = document.getElementById('inv-pay-method')?.value || 'cash_pay';
            const receiptNo = document.getElementById('inv-receipt-no')?.value || '';
            const requiresCashbox = (pType === 'cash' || downUSD > 0) && payMethod === 'cash_pay';
            const cashboxId = requiresCashbox ? document.getElementById('inv-cashbox-select')?.value : '';

            if (requiresCashbox && (!cashboxId || !db.cashboxes.some(c => c.id === cashboxId))) {
                showToast('يرجى اختيار صندوق صالح للفاتورة النقدية', 'error');
                return null;
            }

            if (pType === 'installment') {
                const totalUSD = parseFloat((document.getElementById('inv-total-usd')?.textContent || '0').replace(/[^0-9.-]/g, '')) || 0;
                if (!Number.isFinite(downUSD) || downUSD < 0 || downUSD > totalUSD) {
                    showToast('الدفعة الأولى يجب ألا تتجاوز إجمالي الفاتورة', 'error');
                    return null;
                }
                downUSD = PA_CORE.roundMoney(downUSD);
                if (!Number.isInteger(count) || count < 1 || count > 120) {
                    showToast('عدد الأقساط يجب أن يكون رقماً صحيحاً بين 1 و120', 'error');
                    return null;
                }
                if (!firstDate || !PA_CORE.shiftDateByInterval(firstDate, installmentFrequency, 0)) {
                    showToast('يرجى إدخال تاريخ صحيح لأول قسط', 'error');
                    return null;
                }
            }

            const saved = await commitDatabaseMutation(() => {
                const invoice = origSaveInvoice();
                if (!invoice) return null;
                invoice.cashboxId = cashboxId || undefined;
                invoice.payMethod = payMethod;
                invoice.receiptNo = receiptNo;
                invoice.downPaymentUSD = pType === 'installment' ? downUSD : 0;

                if (pType === 'installment') {
                    const remainingUSD = Math.max(0, invoice.totalUSD - downUSD);
                    const amounts = remainingUSD > 0 ? PA_CORE.splitMoneyEvenly(remainingUSD, count) : [];
                    const account = db.accounts.find(entry => entry.id === accountId);
                    amounts.forEach((amount, index) => {
                        db.installments.push({
                            id: 'inst_' + Date.now() + '_' + (index + 1),
                            invoiceId: invoice.id, invoiceNumber: invoice.number,
                            accountId, accountName: account ? account.name : '-',
                            installmentNo: index + 1, totalInstallments: amounts.length,
                            frequency: installmentFrequency,
                            dueDate: PA_CORE.shiftDateByInterval(firstDate, installmentFrequency, index),
                            amountUSD: amount, originalAmountUSD: amount, paid: false
                        });
                    });
                    if (downUSD > 0) {
                        const voucherType = PA_CORE.voucherTypeForInvoice(invoice);
                        const prefix = voucherType === 'receipt' ? 'RCV-' : 'PAY-';
                        db.vouchers.unshift({
                            id: 'vch_dn_' + Date.now(),
                            number: PA_CORE.nextDocumentNumber(db.vouchers.filter(entry => entry.type === voucherType), prefix, 101),
                            type: voucherType, accountId, cashboxId: cashboxId || undefined, payMethod,
                            invoiceId: invoice.id, source: 'installment_down', amountUSD: downUSD,
                            origAmount: downUSD, currency: 'USD', rate: invoice.rate, date: invoice.date,
                            note: `دفعة أولى لفاتورة تقسيط ${invoice.number}`
                        });
                    }
                }
                return invoice;
            });
            if (!saved) return null;
            const resetSubmittedDraft = invoiceDraftState() === submittedDraft;
            refreshAllViews();
            renderAllExtendedViews();
            if (resetSubmittedDraft) resetInvoiceForm();
            else updateNextInvoiceNumber();
            showToast(`تم حفظ وترحيل الفاتورة ${saved.number} تلقائياً`, 'success');
            return saved;
        };

        function populateCashboxesAndWarehouses() {
            ensureExtendedStores();
            const options = db.cashboxes.map(c => `<option value="${PA_CORE.escapeHtml(c.id)}">${PA_CORE.escapeHtml(c.name)}</option>`).join('');
            for (const id of ['inv-cashbox-select', 'voucher-cashbox', 'ret-cashbox', 'exp-cashbox']) {
                const select = document.getElementById(id);
                if (!select) continue;
                const prev = select.value;
                select.innerHTML = options;
                if (prev && db.cashboxes.some(c => c.id === prev)) select.value = prev;
            }

            const whSel = document.getElementById('inv-warehouse-select');
            if (whSel) {
                const prevW = whSel.value;
                whSel.innerHTML = `<option value="كل المخازن">كل المخازن</option>` + db.warehouses.map(w => `<option value="${PA_CORE.escapeHtml(w)}">${PA_CORE.escapeHtml(w)}</option>`).join('');
                if (prevW) whSel.value = prevW;
            }
        }

        async function addCashboxItem() {
            ensureExtendedStores();
            const name = (document.getElementById('new-cashbox-name')?.value || '').trim();
            const balance = Number(document.getElementById('new-cashbox-bal')?.value);
            if (!name) return showToast('أدخل اسم الصندوق', 'error');
            if (!Number.isFinite(balance)) return showToast('أدخل رصيداً افتتاحياً رقمياً صحيحاً', 'error');
            if (db.cashboxes.some(cashbox => cashbox.name === name)) return showToast('اسم الصندوق موجود مسبقاً', 'error');
            const saved = await commitDatabaseMutation(() => {
                db.cashboxes.push({ id: 'cb_' + Date.now(), name, openingBalance: balance });
                return true;
            });
            if (!saved) return;
            document.getElementById('new-cashbox-name').value = '';
            document.getElementById('new-cashbox-bal').value = 0;
            renderCashboxesAndExpensesView();
            showToast('تمت إضافة الصندوق', 'success');
        }

        async function addWarehouseItem() {
            ensureExtendedStores();
            const name = (document.getElementById('new-warehouse-name')?.value || '').trim();
            if (!name) return showToast('أدخل اسم المخزن أو التصنيف', 'error');
            if (db.warehouses.includes(name)) return showToast('اسم المخزن موجود مسبقاً', 'error');
            const saved = await commitDatabaseMutation(() => {
                db.warehouses.push(name);
                return true;
            });
            if (!saved) return;
            document.getElementById('new-warehouse-name').value = '';
            renderCashboxesAndExpensesView();
            showToast('تمت إضافة المخزن', 'success');
        }

        async function saveExpenseOrRevenue() {
            ensureExtendedStores();
            const kind = document.getElementById('exp-kind')?.value || 'expense';
            const cashboxId = document.getElementById('exp-cashbox')?.value;
            const amountUSD = Number(document.getElementById('exp-amount')?.value);
            const date = document.getElementById('exp-date')?.value || PA_CORE.getLocalDateString();
            const title = (document.getElementById('exp-title')?.value || '').trim();
            if (!cashboxId || !db.cashboxes.some(cashbox => cashbox.id === cashboxId)) return showToast('يرجى اختيار صندوق صالح', 'error');
            if (!Number.isFinite(amountUSD) || amountUSD <= 0) return showToast('أدخل مبلغاً صحيحاً', 'error');
            if (kind === 'expense') {
                const available = calculateCashboxBalanceUSD(cashboxId);
                if (amountUSD > available + 1e-9 && !window.confirm(`رصيد الصندوق الحالي $${Number(available).toFixed(2)} أقل من المصروف. هل تريد المتابعة وجعل الرصيد سالباً؟`)) return;
            }
            const saved = await commitDatabaseMutation(() => {
                db.expenses.unshift({ id: 'exp_' + Date.now(), kind, cashboxId, amountUSD, date, title: title || (kind === 'expense' ? 'مصروف عام' : 'إيراد عام') });
                return true;
            });
            if (!saved) return;
            document.getElementById('exp-amount').value = '';
            document.getElementById('exp-title').value = '';
            renderCashboxesAndExpensesView();
            showToast('تم حفظ الحركة', 'success');
        }

        function renderCashboxesAndExpensesView() {
            ensureExtendedStores();
            populateCashboxesAndWarehouses();
            const cbList = document.getElementById('cashboxes-list');
            if (cbList) {
                cbList.innerHTML = db.cashboxes.map(c => {
                    const balance = calculateCashboxBalanceUSD(c.id);
                    return `
                        <div class="flex items-center justify-between bg-slate-900/70 px-3 py-2 rounded-xl border border-slate-700 text-xs">
                            <span class="font-bold text-sky-300">${PA_CORE.escapeHtml(c.name)}</span>
                            <span class="font-mono font-bold ${balance < 0 ? 'text-rose-400' : 'text-emerald-400'}">$${balance.toFixed(2)}</span>
                        </div>
                    `;
                }).join('');
            }
            const whList = document.getElementById('warehouses-list');
            if (whList) {
                whList.innerHTML = db.warehouses.map(w => `<span class="bg-slate-900 text-amber-300 border border-amber-500/30 px-2.5 py-1 rounded-lg text-xs font-bold">${PA_CORE.escapeHtml(w)}</span>`).join('');
            }
            const expBody = document.getElementById('expenses-table-body');
            if (expBody) {
                expBody.innerHTML = db.expenses.length === 0
                    ? `<tr><td colspan="5" class="p-3 text-center text-slate-400">لا توجد حركات مسجلة</td></tr>`
                    : db.expenses.map(e => {
                        const cashbox = db.cashboxes.find(c => c.id === e.cashboxId);
                        return `
                            <tr>
                                <td class="p-2.5 font-mono">${PA_CORE.escapeHtml(e.date)}</td>
                                <td class="p-2.5 font-bold ${e.kind === 'expense' ? 'text-rose-400' : 'text-emerald-400'}">${e.kind === 'expense' ? 'مصروف' : 'إيراد'}</td>
                                <td class="p-2.5">${PA_CORE.escapeHtml(cashbox ? cashbox.name : '-')}</td>
                                <td class="p-2.5">${PA_CORE.escapeHtml(e.title)}</td>
                                <td class="p-2.5 font-mono font-bold">$${Number(e.amountUSD).toFixed(2)}</td>
                            </tr>
                        `;
                    }).join('');
            }
        }

        async function addEmployeeRecord() {
            ensureExtendedStores();
            const editId = (document.getElementById('emp-edit-id')?.value || '').trim();
            const name = (document.getElementById('emp-name')?.value || '').trim();
            const role = (document.getElementById('emp-role')?.value || '').trim();
            const salary = Number(document.getElementById('emp-salary')?.value);
            if (!name) return showToast('أدخل اسم الموظف', 'error');
            if (!Number.isFinite(salary) || salary < 0) return showToast('أدخل راتباً رقمياً صحيحاً وغير سالب', 'error');
            const saved = await commitDatabaseMutation(() => {
                if (editId) {
                    const index = db.employees.findIndex(employee => employee.id === editId);
                    if (index === -1) throw new Error('الموظف غير موجود');
                    db.employees[index] = { ...db.employees[index], name, role: role || 'موظف', salary };
                } else {
                    db.employees.push({ id: 'emp_' + Date.now(), name, role: role || 'موظف', salary });
                }
                return true;
            });
            if (!saved) return;
            clearEmployeeForm();
            renderEmployeesAndInstallmentsView();
            showToast(editId ? 'تم تعديل بيانات الموظف' : 'تمت إضافة الموظف', 'success');
        }

        function editEmployeeRecord(empId) {
            ensureExtendedStores();
            const emp = db.employees.find(e => e.id === empId);
            if (!emp) return;
            if (document.getElementById('emp-edit-id')) document.getElementById('emp-edit-id').value = emp.id;
            if (document.getElementById('emp-name')) document.getElementById('emp-name').value = emp.name || '';
            if (document.getElementById('emp-role')) document.getElementById('emp-role').value = emp.role || '';
            if (document.getElementById('emp-salary')) document.getElementById('emp-salary').value = emp.salary || 0;
            const saveBtn = document.getElementById('emp-save-btn');
            if (saveBtn) saveBtn.textContent = '✔ حفظ التعديل';
            const cancelBtn = document.getElementById('emp-cancel-btn');
            if (cancelBtn) cancelBtn.classList.remove('hidden');
            document.getElementById('emp-name')?.focus();
        }

        function clearEmployeeForm() {
            if (document.getElementById('emp-edit-id')) document.getElementById('emp-edit-id').value = '';
            if (document.getElementById('emp-name')) document.getElementById('emp-name').value = '';
            if (document.getElementById('emp-role')) document.getElementById('emp-role').value = '';
            if (document.getElementById('emp-salary')) document.getElementById('emp-salary').value = '';
            const saveBtn = document.getElementById('emp-save-btn');
            if (saveBtn) saveBtn.textContent = '+ إضافة موظف';
            const cancelBtn = document.getElementById('emp-cancel-btn');
            if (cancelBtn) cancelBtn.classList.add('hidden');
        }

        async function deleteEmployeeRecord(empId) {
            ensureExtendedStores();
            if (!window.confirm('هل تريد حذف هذا الموظف؟')) return;
            const saved = await commitDatabaseMutation(() => {
                const index = db.employees.findIndex(employee => employee.id === empId);
                if (index === -1) return null;
                db.employees.splice(index, 1);
                return true;
            });
            if (!saved) return;
            if (document.getElementById('emp-edit-id')?.value === empId) clearEmployeeForm();
            renderEmployeesAndInstallmentsView();
            showToast('تم حذف الموظف', 'info');
        }

        async function toggleInstallmentPaid(instId) {
            ensureExtendedStores();
            const result = await commitDatabaseMutation(() => {
                const selected = db.installments.find(entry => entry.id === instId);
                if (!selected || selected.cancelledByReturn) return null;
                const invoice = db.invoices.find(entry => entry.id === selected.invoiceId);
                if (!invoice) throw new Error('الفاتورة المرتبطة بالقسط غير موجودة');
                const returnedUSD = (db.returns || [])
                    .filter(entry => entry.invoiceId === invoice.id)
                    .reduce((sum, entry) => sum + Number(entry.totalUSD || 0), 0);
                PA_CORE.applyReturnToInstallments(db, {
                    invoiceId: invoice.id,
                    type: invoice.type === 'sales' ? 'sales_return' : 'purchase_return',
                    totalUSD: returnedUSD
                });
                const installment = db.installments.find(entry => entry.id === instId);
                const voucherId = 'vch_' + installment.id;
                if (installment.paid) {
                    installment.paid = false;
                    db.vouchers = db.vouchers.filter(entry => entry.id !== voucherId);
                    PA_CORE.applyReturnToInstallments(db, { invoiceId: invoice.id, totalUSD: returnedUSD });
                    return 'unpaid';
                }
                const amountUSD = Number(installment.amountUSD);
                if (!Number.isFinite(amountUSD) || amountUSD <= 0) throw new Error('قيمة القسط غير صالحة');
                const paidUSD = db.vouchers
                    .filter(entry => entry.invoiceId === invoice.id)
                    .reduce((sum, entry) => sum + Number(entry.amountUSD || 0), 0);
                if (paidUSD + amountUSD > Number(invoice.totalUSD) - returnedUSD + 0.01) {
                    throw new Error('لا يمكن تسديد مبلغ يتجاوز صافي الفاتورة');
                }
                const payMethod = PA_CORE.isCashPayment(invoice) ? 'cash_pay' : (invoice.payMethod || 'bank_transfer');
                const voucherType = PA_CORE.voucherTypeForInvoice(invoice);
                const prefix = voucherType === 'receipt' ? 'RCV-' : 'PAY-';
                installment.paid = true;
                db.vouchers.unshift({
                    id: voucherId,
                    number: PA_CORE.nextDocumentNumber(db.vouchers.filter(entry => entry.type === voucherType), prefix, 101),
                    type: voucherType, accountId: installment.accountId,
                    cashboxId: payMethod === 'cash_pay' ? (invoice.cashboxId || db.cashboxes[0]?.id) : undefined,
                    payMethod, invoiceId: invoice.id, source: 'installment',
                    amountUSD, origAmount: amountUSD,
                    currency: 'USD', rate: invoice.rate || db.settings.exchangeRate || 15000,
                    date: PA_CORE.getLocalDateString(),
                    note: `تسديد قسط رقم ${installment.installmentNo}/${installment.totalInstallments} - فاتورة ${invoice.number}`
                });
                return 'paid';
            });
            if (!result) return;
            refreshAllViews();
            renderEmployeesAndInstallmentsView();
            showToast(result === 'paid' ? 'تم تسديد القسط وترحيل السند' : 'تم إلغاء تسديد القسط وإعادة المبلغ للذمم', 'info');
        }

        function renderDebtFollowupTable() {
            const tbody = document.getElementById('debt-followup-body');
            if (!tbody) return;
            const q = (document.getElementById('debt-followup-search')?.value || '').trim().toLowerCase();
            const debtors = db.accounts
                .filter(account => account.id !== 'acc_cash_client'
                    && (account.type === 'customer' || account.type === 'both'))
                .map(account => ({ acc: account, bal: calculateAccountBalanceUSD(account.id) }))
                .filter(entry => entry.bal > 0
                    && (!q || entry.acc.name.toLowerCase().includes(q) || (entry.acc.phone || '').includes(q)));

            if (debtors.length === 0) {
                tbody.innerHTML = `<tr><td colspan="4" class="p-4 text-center text-slate-400">لا توجد ديون مستحقة مطابقة</td></tr>`;
                return;
            }

            tbody.innerHTML = debtors.map(d => {
                const phone = (d.acc.phone || '').replace(/[^0-9+]/g, '');
                const msg = encodeURIComponent(`مرحباً ${d.acc.name}، نذكركم بوجود رصيد مستحق بقيمة $${d.bal.toFixed(2)} - ${db.settings.companyName}`);
                const waUrl = phone ? `https://wa.me/${phone.replace(/^0/, '963')}?text=${msg}` : '#';
                const telUrl = phone ? `tel:${phone}` : '#';
                const smsUrl = phone ? `sms:${phone}?body=${msg}` : '#';
                return `
                    <tr>
                        <td class="p-3 font-bold">${PA_CORE.escapeHtml(d.acc.name)}</td>
                        <td class="p-3 font-mono" dir="ltr">${PA_CORE.escapeHtml(d.acc.phone || '-')}</td>
                        <td class="p-3 font-mono font-bold text-amber-400">$${Number(d.bal || 0).toFixed(2)}</td>
                        <td class="p-3 text-center">
                            <div class="flex justify-center gap-1.5">
                                <a href="${PA_CORE.escapeHtml(waUrl)}" target="_blank" rel="noopener noreferrer" class="bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-1 rounded-lg font-bold">واتساب</a>
                                <a href="${PA_CORE.escapeHtml(telUrl)}" class="bg-sky-600 hover:bg-sky-500 text-white px-2.5 py-1 rounded-lg font-bold">اتصال</a>
                                <a href="${PA_CORE.escapeHtml(smsUrl)}" class="bg-amber-500 hover:bg-amber-400 text-slate-950 px-2.5 py-1 rounded-lg font-bold">SMS</a>
                            </div>
                        </td>
                    </tr>
                `;
            }).join('');
        }

        function renderEmployeesAndInstallmentsView() {
            ensureExtendedStores();
            const empBody = document.getElementById('employees-table-body');
            if (empBody) {
                empBody.innerHTML = db.employees.length === 0
                    ? `<tr><td colspan="4" class="p-3 text-center text-slate-400">لا يوجد موظفون مسجلون</td></tr>`
                    : db.employees.map(e => `
                        <tr class="hover:bg-slate-700/30">
                            <td class="p-2.5 font-bold">${PA_CORE.escapeHtml(e.name)}</td>
                            <td class="p-2.5 text-slate-300">${PA_CORE.escapeHtml(e.role)}</td>
                            <td class="p-2.5 font-mono font-bold text-emerald-400">$${Number(e.salary || 0).toFixed(2)}</td>
                            <td class="p-2.5 text-center">
                                <div class="flex justify-center gap-1">
                                    <button type="button" data-employee-action="edit" data-employee-id="${PA_CORE.escapeHtml(e.id)}" class="bg-slate-700 hover:bg-amber-500 hover:text-slate-950 px-2 py-1 rounded text-[11px] font-bold transition">تعديل</button>
                                    <button type="button" data-employee-action="delete" data-employee-id="${PA_CORE.escapeHtml(e.id)}" class="bg-rose-700/80 hover:bg-rose-600 text-white px-2 py-1 rounded text-[11px] font-bold transition">حذف</button>
                                </div>
                            </td>
                        </tr>
                    `).join('');
                empBody.querySelectorAll('[data-employee-action]').forEach(btn => {
                    btn.addEventListener('click', () => {
                        const employeeId = btn.getAttribute('data-employee-id');
                        if (btn.getAttribute('data-employee-action') === 'edit') editEmployeeRecord(employeeId);
                        else deleteEmployeeRecord(employeeId);
                    });
                });
            }
            const instBody = document.getElementById('installments-table-body');
            if (instBody) {
                instBody.innerHTML = db.installments.length === 0
                    ? `<tr><td colspan="6" class="p-3 text-center text-slate-400">لا توجد أقساط مجدولة</td></tr>`
                    : db.installments.map(i => `
                        <tr>
                            <td class="p-2.5 font-bold">${PA_CORE.escapeHtml(i.accountName)}</td>
                            <td class="p-2.5 font-mono text-amber-400">${PA_CORE.escapeHtml(i.invoiceNumber)}</td>
                            <td class="p-2.5 font-mono">${Number(i.installmentNo || 0)}/${Number(i.totalInstallments || 0)}</td>
                            <td class="p-2.5 font-mono">${PA_CORE.escapeHtml(i.dueDate)}</td>
                            <td class="p-2.5 font-mono font-bold text-sky-300">$${Number(i.amountUSD || 0).toFixed(2)}</td>
                            <td class="p-2.5">${i.cancelledByReturn ? '<span class="text-slate-400 text-[11px]">أُلغي بالمرتجع</span>' : `<button type="button" data-installment-id="${PA_CORE.escapeHtml(i.id)}" class="px-2 py-0.5 rounded text-[11px] font-bold ${i.paid ? 'bg-emerald-600 text-white' : 'bg-amber-500/20 text-amber-300'}">${i.paid ? 'مدفوع' : 'مستحق'}</button>`}</td>
                        </tr>
                    `).join('');
                instBody.querySelectorAll('[data-installment-id]').forEach(btn => {
                    btn.addEventListener('click', () => toggleInstallmentPaid(btn.getAttribute('data-installment-id')));
                });
            }
            renderDebtFollowupTable();
        }

        function setProfitPeriod(period) {
            profitPeriodFilter = period;
            ['all', 'daily', 'monthly'].forEach(k => {
                const btn = document.getElementById('prof-p-' + k);
                if (btn) btn.className = `px-3 py-1.5 rounded-lg font-bold ${k === period ? 'bg-sky-600 text-white' : 'bg-slate-900 text-slate-300'}`;
            });
            renderProfitAndReportsHub();
        }

        function matchesProfitPeriod(dateStr) {
            if (!dateStr) return true;
            const now = new Date();
            const today = PA_CORE.getLocalDateString(now);
            const ym = today.slice(0, 7);
            if (profitPeriodFilter === 'daily') return dateStr === today;
            if (profitPeriodFilter === 'monthly') return dateStr.startsWith(ym);
            if (profitPeriodFilter === 'custom') {
                const c = document.getElementById('prof-custom-date')?.value;
                return !c || dateStr === c;
            }
            return true;
        }

        function renderProfitAndReportsHub() {
            ensureExtendedStores();
            const grid = document.getElementById('profit-metrics-grid');
            if (!grid) return;

            const profit = PA_CORE.calculateProfit(db, date => matchesProfitPeriod(date));
            const salesUSD = profit.sales;
            const costOfSalesUSD = profit.costOfSales;
            const purchasesUSD = profit.purchases;
            let extraRevUSD = 0, expensesUSD = 0;

            (db.expenses || []).filter(e => matchesProfitPeriod(e.date)).forEach(e => {
                if (e.kind === 'revenue') extraRevUSD += Number(e.amountUSD) || 0;
                else expensesUSD += Number(e.amountUSD) || 0;
            });

            let supplierDebtsUSD = 0;
            db.accounts.forEach(account => {
                const balance = calculateAccountBalanceUSD(account.id);
                if (balance < 0 && (account.type === 'supplier' || account.type === 'both')) {
                    supplierDebtsUSD += Math.abs(balance);
                }
            });

            const netProfitUSD = (salesUSD - costOfSalesUSD) + extraRevUSD - expensesUSD;

            const cards = [
                ['إجمالي المبيعات', salesUSD, 'text-emerald-400'],
                ['تكلفة المبيعات', costOfSalesUSD, 'text-amber-300'],
                ['إجمالي المشتريات', purchasesUSD, 'text-sky-400'],
                ['إجمالي الإيرادات', extraRevUSD, 'text-emerald-300'],
                ['إجمالي المصروفات', expensesUSD, 'text-rose-400'],
                ['صافي الأرباح', netProfitUSD, netProfitUSD >= 0 ? 'text-emerald-400' : 'text-rose-400'],
                ['الديون علينا (للموردين)', supplierDebtsUSD, 'text-orange-400']
            ];

            grid.innerHTML = cards.map(([title, val, cls]) => `
                <div class="bg-slate-900/90 border border-slate-700 rounded-xl p-3.5">
                    <div class="text-xs text-slate-400 font-bold">${title}</div>
                    <div class="text-lg font-black font-mono mt-1 ${cls}">$${Number(val).toFixed(2)}</div>
                </div>
            `).join('');

            openComprehensiveReport(currentCompReportKey);
        }

        function setPrintPaperSize(mode) {
            selectedPrintPaper = mode;
            ['58mm', 'thermal', 'a4'].forEach(m => {
                const btn = document.getElementById('paper-btn-' + m);
                if (!btn) return;
                btn.className = (m === mode)
                    ? 'px-3 py-1.5 rounded-lg font-bold bg-amber-500 text-slate-950 font-extrabold'
                    : 'px-3 py-1.5 rounded-lg font-bold bg-slate-800 text-slate-200 border border-slate-600';
            });
            showToast(`تم اختيار حجم الطباعة: ${mode === 'thermal' ? '80 مم' : mode}`, 'info');
        }

        function openComprehensiveReport(key) {
            currentCompReportKey = key;
            const titleEl = document.getElementById('comp-report-title');
            const bodyEl = document.getElementById('comp-report-body');
            if (!titleEl || !bodyEl) return;

            const titles = {
                items_sales: 'مبيعات الأصناف',
                customers_move: 'تقرير بحركة العملاء',
                suppliers_move: 'تقرير بحركة الموردين',
                item_move: 'تقرير بحركة الصنف',
                customer_profit: 'تقرير بأرباح العميل',
                supplier_purchases: 'تقرير بمشتريات المورد',
                workers_move: 'تقرير بحركة العمال',
                remaining_installments: 'تقرير بالأقساط المتبقية',
                pnl: 'تقرير بالأرباح والخسائر',
                all_expenses: 'تقرير بكافة المصروفات'
            };
            titleEl.textContent = titles[key] || 'تقرير شامل';

            let rows = [];
            if (key === 'items_sales' || key === 'item_move') {
                const map = Object.create(null);
                (db.invoices || []).forEach(invoice => {
                    const subtotalUSD = (invoice.items || []).reduce((sum, line) => {
                        const unitUSD = Number(line.priceUSD ?? (Number(line.priceOrig || 0) / Number(invoice.rate || 1)));
                        return sum + Number(line.qty || 0) * unitUSD;
                    }, 0);
                    const discountUSD = invoice.currency === 'SYP'
                        ? Number(invoice.discount || 0) / Number(invoice.rate || 1)
                        : Number(invoice.discount || 0);
                    const discountRatio = subtotalUSD > 0 ? Math.min(1, discountUSD / subtotalUSD) : 0;
                    (invoice.items || []).forEach(line => {
                        const name = line.itemName || 'غير محدد';
                        if (!map[name]) map[name] = { sold: 0, purchased: 0, revenue: 0 };
                        const qty = Number(line.qty) || 0;
                        const unitUSD = Number(line.priceUSD ?? (Number(line.priceOrig || 0) / Number(invoice.rate || 1)));
                        if (invoice.type === 'sales') {
                            map[name].sold += qty;
                            map[name].revenue += qty * unitUSD * (1 - discountRatio);
                        } else {
                            map[name].purchased += qty;
                        }
                    });
                });
                (db.returns || []).forEach(record => {
                    if (record.type !== 'sales_return') return;
                    const name = record.itemName || 'غير محدد';
                    if (!map[name]) map[name] = { sold: 0, purchased: 0, revenue: 0 };
                    map[name].sold -= Number(record.qty) || 0;
                    map[name].revenue -= Number(record.totalUSD) || 0;
                });
                rows = Object.entries(map).map(([name, value]) => `<tr><td class="p-2 font-bold">${PA_CORE.escapeHtml(name)}</td><td class="p-2 font-mono">${Number(value.sold.toFixed(3))}</td><td class="p-2 font-mono">${Number(value.purchased.toFixed(3))}</td><td class="p-2 font-mono text-emerald-400">$${Number(value.revenue.toFixed(2))}</td></tr>`);
                bodyEl.innerHTML = `<table class="w-full text-right"><thead><tr class="bg-slate-800 text-slate-400"><th class="p-2">الصنف</th><th class="p-2">صافي المبيع</th><th class="p-2">المشتريات</th><th class="p-2">صافي الإيراد ($)</th></tr></thead><tbody class="divide-y divide-slate-800">${rows.join('') || '<tr><td colspan="4" class="p-3 text-center text-slate-400">لا توجد بيانات</td></tr>'}</tbody></table>`;
            } else if (key === 'customers_move' || key === 'customer_profit' || key === 'suppliers_move' || key === 'supplier_purchases') {
                const isSup = key.startsWith('supplier');
                const list = db.accounts.filter(a => a.id !== 'acc_cash_client' && (isSup ? a.type !== 'customer' : a.type !== 'supplier'));
                rows = list.map(a => `<tr><td class="p-2 font-bold">${PA_CORE.escapeHtml(a.name)}</td><td class="p-2 font-mono">${PA_CORE.escapeHtml(a.phone || '-')}</td><td class="p-2 font-mono text-amber-300">$${Number(calculateAccountBalanceUSD(a.id) || 0).toFixed(2)}</td></tr>`);
                bodyEl.innerHTML = `<table class="w-full text-right"><thead><tr class="bg-slate-800 text-slate-400"><th class="p-2">الاسم</th><th class="p-2">الهاتف</th><th class="p-2">الرصيد ($)</th></tr></thead><tbody class="divide-y divide-slate-800">${rows.join('') || '<tr><td colspan="3" class="p-3 text-center text-slate-400">لا توجد بيانات</td></tr>'}</tbody></table>`;
            } else if (key === 'workers_move') {
                rows = (db.employees || []).map(e => `<tr><td class="p-2 font-bold">${PA_CORE.escapeHtml(e.name)}</td><td class="p-2">${PA_CORE.escapeHtml(e.role)}</td><td class="p-2 font-mono text-emerald-400">$${Number(e.salary || 0).toFixed(2)}</td></tr>`);
                bodyEl.innerHTML = `<table class="w-full text-right"><thead><tr class="bg-slate-800 text-slate-400"><th class="p-2">الموظف</th><th class="p-2">الوظيفة</th><th class="p-2">الراتب ($)</th></tr></thead><tbody class="divide-y divide-slate-800">${rows.join('') || '<tr><td colspan="3" class="p-3 text-center text-slate-400">لا يوجد عمال مسجلون</td></tr>'}</tbody></table>`;
            } else if (key === 'remaining_installments') {
                const rem = (db.installments || []).filter(entry => !entry.paid && !entry.cancelledByReturn && Number(entry.amountUSD) > 0);
                rows = rem.map(x => `<tr><td class="p-2 font-bold">${PA_CORE.escapeHtml(x.accountName)}</td><td class="p-2 font-mono">${PA_CORE.escapeHtml(x.dueDate)}</td><td class="p-2 font-mono text-amber-300">$${Number(x.amountUSD || 0).toFixed(2)}</td></tr>`);
                bodyEl.innerHTML = `<table class="w-full text-right"><thead><tr class="bg-slate-800 text-slate-400"><th class="p-2">العميل</th><th class="p-2">الاستحقاق</th><th class="p-2">المتبقي ($)</th></tr></thead><tbody class="divide-y divide-slate-800">${rows.join('') || '<tr><td colspan="3" class="p-3 text-center text-slate-400">لا توجد أقساط متبقية</td></tr>'}</tbody></table>`;
            } else if (key === 'all_expenses') {
                rows = (db.expenses || []).map(x => `<tr><td class="p-2 font-mono">${PA_CORE.escapeHtml(x.date)}</td><td class="p-2 font-bold">${PA_CORE.escapeHtml(x.title)}</td><td class="p-2 font-mono text-rose-400">$${Number(x.amountUSD || 0).toFixed(2)}</td></tr>`);
                bodyEl.innerHTML = `<table class="w-full text-right"><thead><tr class="bg-slate-800 text-slate-400"><th class="p-2">التاريخ</th><th class="p-2">البيان</th><th class="p-2">المبلغ ($)</th></tr></thead><tbody class="divide-y divide-slate-800">${rows.join('') || '<tr><td colspan="3" class="p-3 text-center text-slate-400">لا توجد مصروفات</td></tr>'}</tbody></table>`;
            } else {
                const metricCards = Array.from(document.querySelectorAll('#profit-metrics-grid > div')).map(d => `<div class="p-2 border-b border-slate-700 flex justify-between">${d.innerHTML}</div>`);
                bodyEl.innerHTML = `<div class="space-y-1">${metricCards.join('')}</div>`;
            }
        }

        function printComprehensiveReport() {
            const title = document.getElementById('comp-report-title')?.textContent || 'تقرير شامل';
            const bodyHtml = document.getElementById('comp-report-body')?.innerHTML || '';
            const html = `<section class="pa-report" dir="rtl"><h2>${PA_CORE.escapeHtml(db.settings.companyName)} - ${PA_CORE.escapeHtml(title)}</h2>${bodyHtml}</section>`;
            triggerPrint(html, selectedPrintPaper);
        }

        function renderAllExtendedViews() {
            populateCashboxesAndWarehouses();
            renderCashboxesAndExpensesView();
            renderEmployeesAndInstallmentsView();
            renderProfitAndReportsHub();
        }

        const origInitAppUI = initializeAppUI;
        initializeAppUI = async function() {
            await origInitAppUI();
            const today = PA_CORE.getLocalDateString();
            const expD = document.getElementById('exp-date');
            if (expD && !expD.value) expD.value = today;
            const instD = document.getElementById('inst-first-date');
            if (instD && !instD.value) instD.value = today;
            renderAllExtendedViews();
        };

    


        // ==================== 1. دوال طباعة الباركود أوفلاين ====================
        function generateBarcodeSVG(code, width = 2, height = 46) {
            const safeCode = String(code || '000000').trim() || '000000';
            const safeWidth = Math.max(1, Number(width) || 2);
            const safeHeight = Math.max(1, Number(height) || 46);
            if (typeof window.JsBarcode === 'function') {
                const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                window.JsBarcode(svg, safeCode, { width: safeWidth, height: safeHeight, displayValue: false, margin: 10 });
                return svg.outerHTML;
            }
            if (typeof window.generateCode128SVG === 'function') {
                return window.generateCode128SVG(safeCode, safeHeight);
            }
            return '';
        }

        function printItemBarcode(itemId, copies = 1) {
            const itm = db.items.find(i => i.id === itemId);
            if (!itm) return showToast('الصنف غير موجود', 'error');
            if (!(itm.code || '').trim()) return showToast('ولّد رمز باركود للصنف أولاً من استوديو الباركود', 'error');
            const count = Math.min(500, Math.max(1, parseInt(copies, 10) || 1));
            const codeVal = itm.code.trim();
            const svgHtml = generateBarcodeSVG(codeVal, 2, 42);
            const rate = db.settings.exchangeRate || 15000;

            const priceText = `$${Number(itm.price || 0).toFixed(2)} | ${Math.round(Number(itm.price || 0) * Number(rate || 0)).toLocaleString()} ل.س`;
            const label = PA_PRINT.labelMarkup({ name: itm.name }, svgHtml, {
                companyName: db.settings.companyName,
                code: codeVal,
                priceText
            });
            const labels = Array.from({ length: count }, () => label);
            triggerPrint(PA_PRINT.buildLabelSheet(labels, '50x30'), 'thermal', {
                title: 'ملصق باركود',
                fileName: `Label_${codeVal}_${Date.now()}.pdf`,
                kind: 'labels'
            });
        }

        function printAllBarcodes() {
            const stockItems = db.items.filter(item => (item.code || '').trim());
            if (stockItems.length === 0) {
                return showToast('لا توجد أصناف لها رمز باركود؛ ولّد الرموز أولاً', 'error');
            }
            if (stockItems.length < db.items.length) showToast('سيتم استبعاد الأصناف التي لا تملك رمز باركود', 'info');
            const rate = db.settings.exchangeRate || 15000;
            const labels = stockItems.map(itm => {
                const codeVal = itm.code.trim();
                const svgHtml = generateBarcodeSVG(codeVal, 1.8, 30);
                const priceText = `$${Number(itm.price || 0).toFixed(2)} (${Math.round(Number(itm.price || 0) * Number(rate || 0)).toLocaleString()} ل.س)`;
                return PA_PRINT.labelMarkup({ name: itm.name }, svgHtml, {
                    companyName: db.settings.companyName,
                    code: codeVal,
                    priceText
                });
            });
            triggerPrint(PA_PRINT.buildLabelSheet(labels, 'a4_grid'), 'a4', {
                title: 'ملصقات باركود الأصناف',
                fileName: `Labels_All_${Date.now()}.pdf`,
                kind: 'labels'
            });
        }

        function promptPrintItemBarcode(itemId) {
            const itm = db.items.find(i => i.id === itemId);
            if (!itm) return;
            const modal = document.getElementById('barcode-copies-modal');
            if (modal) {
                document.getElementById('bc-prompt-item-id').value = itemId;
                document.getElementById('bc-prompt-item-name').textContent = itm.name;
                document.getElementById('bc-prompt-copies-input').value = 6;
                modal.classList.remove('hidden');
                document.getElementById('bc-prompt-copies-input').focus();
            } else {
                const val = prompt(`أدخل عدد ملصقات الباركود المطلوبة للصنف (${itm.name}):`, '6');
                const n = parseInt(val, 10);
                if (n > 0) printItemBarcode(itemId, n);
            }
        }

        function confirmPromptPrintItemBarcode() {
            const itemId = document.getElementById('bc-prompt-item-id')?.value;
            const copies = parseInt(document.getElementById('bc-prompt-copies-input')?.value, 10) || 1;
            document.getElementById('barcode-copies-modal')?.classList.add('hidden');
            if (itemId) printItemBarcode(itemId, copies);
        }

        // ==================== 2. بطاقات KPI في الصفحة الرئيسية ====================
        function updateDashboardKPIs() {
            const today = PA_CORE.getLocalDateString();
            let todaySales = 0;
            let todayCount = 0;
            (db.invoices || []).forEach(inv => {
                if (inv.type === 'sales' && inv.date === today) {
                    todaySales += Number(inv.totalUSD) || 0;
                    todayCount++;
                }
            });

            let receivables = 0, recCount = 0;
            let payables = 0, payCount = 0;
            (db.accounts || []).forEach(acc => {
                if (acc.id === 'acc_cash_client') return;
                const bal = calculateAccountBalanceUSD(acc.id);
                if (bal > 0) { receivables += bal; recCount++; }
                else if (bal < 0) { payables += Math.abs(bal); payCount++; }
            });

            let stockValue = 0;
            const stockItems = (db.items || []).filter(i => i.type === 'stock');
            stockItems.forEach(i => { stockValue += (Number(i.qty) || 0) * (Number(i.cost) || 0); });

            const setTxt = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
            setTxt('kpi-today-sales', '$' + todaySales.toFixed(2));
            setTxt('kpi-today-count', `${todayCount} فاتورة اليوم`);
            setTxt('kpi-receivables', '$' + receivables.toFixed(2));
            setTxt('kpi-receivables-count', `${recCount} حساب مدين`);
            setTxt('kpi-payables', '$' + payables.toFixed(2));
            setTxt('kpi-payables-count', `${payCount} حساب دائن`);
            setTxt('kpi-stock-value', '$' + stockValue.toFixed(2));
            setTxt('kpi-stock-count', `${db.items.length} صنف (${stockItems.length} مخزني)`);
        }

        // ==================== 3. رسم بياني لمبيعات آخر 7 أيام ====================
        let salesChartInstance = null;
        function renderSalesChart() {
            const canvas = document.getElementById('sales-chart');
            if (!canvas || typeof window.Chart !== 'function') return;

            const labels = [];
            const totals = [];
            const now = new Date();
            for (let d = 6; d >= 0; d--) {
                const dt = new Date(now);
                dt.setDate(now.getDate() - d);
                const iso = PA_CORE.getLocalDateString(dt);
                labels.push(iso.slice(5)); // MM-DD
                const daySum = (db.invoices || [])
                    .filter(inv => inv.type === 'sales' && inv.date === iso)
                    .reduce((acc, inv) => acc + (Number(inv.totalUSD) || 0), 0);
                totals.push(parseFloat(daySum.toFixed(2)));
            }

            if (salesChartInstance && typeof salesChartInstance.destroy === 'function') {
                salesChartInstance.destroy();
            }
            salesChartInstance = new window.Chart(canvas, {
                type: 'bar',
                data: {
                    labels,
                    datasets: [{ label: 'مبيعات ($)', data: totals }]
                }
            });
        }

        // ==================== 4. البحث الشامل (Global Search Ctrl+K) ====================
        function openGlobalSearch() {
            const modal = document.getElementById('global-search-modal');
            const inp = document.getElementById('global-search-input');
            if (!modal || !inp) return;
            modal.classList.remove('hidden');
            inp.value = '';
            runGlobalSearch('');
            setTimeout(() => inp.focus(), 60);
        }

        function closeGlobalSearch() {
            document.getElementById('global-search-modal')?.classList.add('hidden');
        }

        function runGlobalSearch(query) {
            const box = document.getElementById('global-search-results');
            if (!box) return;
            const q = String(query || '').trim().toLowerCase();
            if (!q) {
                box.innerHTML = `<div class="text-center text-slate-400 py-6 text-xs">اكتب اسم زبون، مورد، مادة، باركود، رقم فاتورة، أو سند للبحث الفوري...</div>`;
                return;
            }

            const results = [];
            // العملاء والموردون
            (db.accounts || []).filter(a => a.id !== 'acc_cash_client' && ((a.name || '').toLowerCase().includes(q) || (a.phone || '').includes(q))).slice(0, 6).forEach(acc => {
                const bal = calculateAccountBalanceUSD(acc.id);
                results.push({
                    badge: 'حساب',
                    color: 'text-amber-300',
                    title: acc.name,
                    sub: `هاتف: ${acc.phone || '-'} | الرصيد: $${Number(bal || 0).toFixed(2)}`,
                    action: 'account',
                    id: acc.id
                });
            });

            // الأصناف والمخزون
            (db.items || []).filter(i => (i.name || '').toLowerCase().includes(q) || (i.code || '').toLowerCase().includes(q)).slice(0, 6).forEach(itm => {
                results.push({
                    badge: 'صنف',
                    color: 'text-sky-300',
                    title: itm.name,
                    sub: `باركود: ${itm.code || '-'} | السعر: $${Number(itm.price || 0).toFixed(2)} | المتوفر: ${Number(itm.qty || 0)}`,
                    action: 'item',
                    id: itm.id
                });
            });

            // الفواتير
            (db.invoices || []).filter(inv => {
                const acc = db.accounts.find(a => a.id === inv.accountId);
                return (inv.number || '').toLowerCase().includes(q) || (acc && acc.name.toLowerCase().includes(q));
            }).slice(0, 6).forEach(inv => {
                const acc = db.accounts.find(a => a.id === inv.accountId);
                results.push({
                    badge: inv.type === 'sales' ? 'مبيعات' : 'مشتريات',
                    color: 'text-emerald-300',
                    title: `فاتورة ${inv.number} — ${acc ? acc.name : '-'}`,
                    sub: `التاريخ: ${inv.date} | الإجمالي: $${Number(inv.totalUSD || 0).toFixed(2)}`,
                    action: 'invoice',
                    id: inv.id
                });
            });

            // السندات
            (db.vouchers || []).filter(v => {
                const acc = db.accounts.find(a => a.id === v.accountId);
                return (v.number || '').toLowerCase().includes(q) || (v.note || '').toLowerCase().includes(q) || (acc && acc.name.toLowerCase().includes(q));
            }).slice(0, 5).forEach(v => {
                const acc = db.accounts.find(a => a.id === v.accountId);
                results.push({
                    badge: v.type === 'receipt' ? 'سند قبض' : 'سند دفع',
                    color: 'text-purple-300',
                    title: `${v.number} — ${acc ? acc.name : '-'}`,
                    sub: `التاريخ: ${v.date} | المبلغ: $${Number(v.amountUSD || 0).toFixed(2)}`,
                    action: 'voucher',
                    id: v.id
                });
            });

            if (results.length === 0) {
                box.innerHTML = `<div class="text-center text-rose-400 py-6 text-xs font-bold">لا توجد نتائج مطابقة لعبارة "${PA_CORE.escapeHtml(query)}"</div>`;
                return;
            }

            box.innerHTML = results.map(r => `
                <button type="button" data-search-action="${PA_CORE.escapeHtml(r.action)}" data-search-id="${PA_CORE.escapeHtml(r.id)}" class="w-full text-right bg-slate-900/90 hover:bg-slate-700 border border-slate-700 rounded-xl p-3 flex items-center justify-between gap-2 transition">
                    <div>
                        <div class="font-bold text-sm text-slate-100">${PA_CORE.escapeHtml(r.title)}</div>
                        <div class="text-[11px] text-slate-400 mt-0.5">${PA_CORE.escapeHtml(r.sub)}</div>
                    </div>
                    <span class="text-[11px] font-extrabold px-2.5 py-1 rounded-full bg-slate-800 border border-slate-600 ${r.color} shrink-0">${PA_CORE.escapeHtml(r.badge)}</span>
                </button>
            `).join('');
            box.querySelectorAll('[data-search-action]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const action = btn.getAttribute('data-search-action');
                    const id = btn.getAttribute('data-search-id');
                    closeGlobalSearch();
                    if (action === 'account') viewAccountStatementDirect(id);
                    else if (action === 'item') { switchTab('items'); editItemCard(id); }
                    else if (action === 'invoice') printInvoiceById(id, 'a4');
                    else if (action === 'voucher') printVoucherById(id);
                });
            });
        }

        document.addEventListener('keydown', function(e) {
            if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
                e.preventDefault();
                openGlobalSearch();
            } else if (e.key === 'Escape') {
                const gs = document.getElementById('global-search-modal');
                if (gs && !gs.classList.contains('hidden')) closeGlobalSearch();
            }
        });

        // ==================== 5. تصدير PDF احترافي أوفلاين ====================
        function exportElementToPDF(elementId, fileName = 'Report.pdf') {
            const el = document.getElementById(elementId);
            if (!el) return showToast('تعذر العثور على المحتوى لتصديره', 'error');
            showToast('جاري تجهيز ملف PDF...', 'info');
            if (typeof window.html2pdf === 'function') {
                window.html2pdf().from(el).set({ filename: fileName, margin: 8 }).save();
            } else {
                triggerPrint(el.innerHTML, 'a4');
            }
        }

        function exportStatementPDF() {
            const accountId = document.getElementById('statement-account-select')?.value;
            const acc = db.accounts.find(a => a.id === accountId);
            if (!acc) return;
            const rows = getAccountStatementRows(accountId);
            const finalBal = calculateAccountBalanceUSD(accountId);
            const tmp = document.createElement('div');
            tmp.id = '_tmp_pdf_stmt';
            tmp.innerHTML = `
                <div dir="rtl" style="font-family:'TajawalLocal',sans-serif;">
                    <h2 style="text-align:center;margin:0;">${PA_CORE.escapeHtml(db.settings.companyName)}</h2>
                    <p style="text-align:center;margin:2px 0 12px 0;">كشف حساب: ${PA_CORE.escapeHtml(acc.name)}</p>
                    <table style="width:100%;border-collapse:collapse;font-size:12px;">
                        <thead><tr style="background:#e2e8f0;"><th style="padding:6px;border:1px solid #cbd5e1;">التاريخ</th><th style="padding:6px;border:1px solid #cbd5e1;">المرجع</th><th style="padding:6px;border:1px solid #cbd5e1;">البيان</th><th style="padding:6px;border:1px solid #cbd5e1;">مدين</th><th style="padding:6px;border:1px solid #cbd5e1;">دائن</th><th style="padding:6px;border:1px solid #cbd5e1;">الرصيد</th></tr></thead>
                        <tbody>${rows.map(r => `<tr><td style="padding:5px;border:1px solid #cbd5e1;">${PA_CORE.escapeHtml(r.displayDate)}</td><td style="padding:5px;border:1px solid #cbd5e1;">${PA_CORE.escapeHtml(r.ref)}</td><td style="padding:5px;border:1px solid #cbd5e1;">${PA_CORE.escapeHtml(r.desc)}</td><td style="padding:5px;border:1px solid #cbd5e1;">${r.debit > 0 ? '$' + Number(r.debit).toFixed(2) : '-'}</td><td style="padding:5px;border:1px solid #cbd5e1;">${r.credit > 0 ? '$' + Number(r.credit).toFixed(2) : '-'}</td><td style="padding:5px;border:1px solid #cbd5e1;font-weight:bold;">$${Number(Math.abs(r.running)).toFixed(2)} ${r.running >= 0 ? 'عليه' : 'له'}</td></tr>`).join('')}</tbody>
                    </table>
                    <h3 style="text-align:left;margin-top:12px;">الرصيد النهائي: $${Math.abs(finalBal).toFixed(2)} (${finalBal >= 0 ? 'عليه' : 'له'})</h3>
                </div>
            `;
            document.body.appendChild(tmp);
            exportElementToPDF('_tmp_pdf_stmt', `Statement_${acc.name}_${Date.now()}.pdf`);
            setTimeout(() => tmp.remove(), 1000);
        }

        // ==================== 6. رفع شعار الشركة في الإعدادات ====================
        function handleCompanyLogoUpload(event) {
            const file = event.target.files && event.target.files[0];
            if (!file) return;
            if (!/^image\/(?:png|jpeg|webp)$/.test(file.type) || file.size > 5 * 1024 * 1024) {
                showToast('اختر صورة PNG أو JPG أو WebP بحجم أقصى 5MB', 'error');
                return;
            }
            const reader = new FileReader();
            reader.onload = function(e) {
                const img = new Image();
                img.onload = async function() {
                    const canvas = document.createElement('canvas');
                    canvas.width = 140; canvas.height = 140;
                    const ctx = canvas.getContext('2d');
                    const sc = Math.min(140 / img.width, 140 / img.height);
                    const dw = img.width * sc, dh = img.height * sc;
                    ctx.drawImage(img, (140 - dw) / 2, (140 - dh) / 2, dw, dh);
                    const logo = canvas.toDataURL('image/png');
                    const saved = await commitDatabaseMutation(() => {
                        db.settings.companyLogo = logo;
                        return true;
                    });
                    if (!saved) return;
                    const prev = document.getElementById('settings-logo-preview');
                    if (prev) prev.innerHTML = `<img src="${PA_CORE.escapeHtml(logo)}" style="width:48px;height:48px;border-radius:10px;object-fit:cover;">`;
                    showToast('تم حفظ شعار الشركة للفواتير', 'success');
                };
                img.onerror = () => showToast('تعذر قراءة الصورة', 'error');
                img.src = PA_CORE.safeImageUrl(e.target.result);
            };
            reader.readAsDataURL(file);
            event.target.value = '';
        }

        // ربط التحديثات التلقائية مع refreshAllViews و toggleThemeMode
        const _origRefreshAllViews = refreshAllViews;
        refreshAllViews = function() {
            const r = _origRefreshAllViews.apply(this, arguments);
            updateDashboardKPIs();
            renderSalesChart();
            return r;
        };

        const _origToggleThemeMode = toggleThemeMode;
        toggleThemeMode = async function() {
            const r = await _origToggleThemeMode.apply(this, arguments);
            renderSalesChart();
            return r;
        };
