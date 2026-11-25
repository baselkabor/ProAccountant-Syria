/* ===== backup-pro.js — مركز النسخ الاحتياطي الاحترافي مع تشفير AES-256 =====
   • التشفير: AES-GCM 256-bit بمفتاح مشتق من كلمة سر النسخ (PBKDF2-SHA256، 250,000 تكرار) عبر WebCrypto المدمج.
   • كلمة سر النسخ تُحفظ على هذا الجهاز فقط (لا تُرفع داخل النسخة ولا إلى Google Drive).
   • نسخ Google Drive والملفات المصدّرة تُشفّر تلقائياً عند تفعيل التشفير.
   • الاستعادة تكتشف النسخة المشفّرة وتطلب كلمة السر عند الحاجة. */
(function () {
    const FORMAT = 'ProAccountant-Encrypted-Backup';
    const PASS_KEY = 'pa_backup_pass_v1';
    const HIST_KEY = 'pa_backup_history_v1';
    const ITER = 250000;
    const APP_VERSION = window.PA_APP_VERSION || '3.3.0';
    const enc = new TextEncoder(), dec = new TextDecoder();
    const ls = { get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }, del: k => { try { localStorage.removeItem(k); } catch (e) {} } };
    const esc = s => PA_CORE.escapeHtml(s == null ? '' : s);
    const b64 = buf => { const bytes = new Uint8Array(buf); let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
    const unb64 = str => Uint8Array.from(atob(str), c => c.charCodeAt(0));
    const cryptoOk = () => !!(window.crypto && crypto.subtle && window.TextEncoder);

    /* ---------------- التشفير ---------------- */
    async function deriveKey(password, salt, iter) {
        const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
        return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    }
    async function encryptData(obj, password) {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const key = await deriveKey(password, salt, ITER);
        const plain = enc.encode(JSON.stringify(obj));
        const digest = await crypto.subtle.digest('SHA-256', plain);
        const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
        return {
            format: FORMAT, version: 1, app: 'ProAccountant Syria', appVersion: APP_VERSION,
            createdAt: new Date().toISOString(),
            cipher: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iterations: ITER,
            salt: b64(salt), iv: b64(iv), sha256: b64(digest),
            summary: summaryOf(obj),
            data: b64(cipher)
        };
    }
    async function decryptEnvelope(env, password) {
        const key = await deriveKey(password, unb64(env.salt), Number(env.iterations) || ITER);
        let plain;
        try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv) }, key, unb64(env.data)); }
        catch (e) { throw new Error('كلمة السر غير صحيحة أو الملف معدّل'); }
        if (env.sha256) {
            const digest = b64(await crypto.subtle.digest('SHA-256', plain));
            if (digest !== env.sha256) throw new Error('فشل التحقق من سلامة النسخة');
        }
        return JSON.parse(dec.decode(plain));
    }
    const isEnvelope = o => !!(o && o.format === FORMAT && o.data && o.salt && o.iv);
    function summaryOf(d) {
        return { items: (d.items || []).length, accounts: (d.accounts || []).length, invoices: (d.invoices || []).length, vouchers: (d.vouchers || []).length, returns: (d.returns || []).length };
    }

    /* ---------------- الإعدادات المحلية ---------------- */
    const getPass = () => ls.get(PASS_KEY) || '';
    const encryptionOn = () => !!(db.settings && db.settings.backupEncrypt) && !!getPass() && cryptoOk();

    /* يُستخدم من مزامنة Drive في app.js */
    window.paPrepareBackupPayload = async function (data) {
        let out = null;
        if (encryptionOn()) {
            try { out = { text: JSON.stringify(await encryptData(data, getPass())), encrypted: true }; }
            catch (e) { console.error(e); }
        }
        if (!out) out = { text: JSON.stringify(data), encrypted: false };
        window.__paLastDrivePayload = { size: out.text.length, encrypted: out.encrypted };
        return out;
    };

    /* ---------------- سجل النسخ ---------------- */
    function history() { try { return JSON.parse(ls.get(HIST_KEY) || '[]'); } catch (e) { return []; } }
    function addHistory(entry) {
        const h = history();
        h.unshift({ at: new Date().toISOString(), ...entry });
        ls.set(HIST_KEY, JSON.stringify(h.slice(0, 20)));
        renderCenter();
    }
    const fmtDate = iso => { try { return new Date(iso).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }); } catch (e) { return iso; } };
    const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(2) + ' MB' : (n / 1024).toFixed(1) + ' KB';

    /* ---------------- نافذة كلمة السر ---------------- */
    function askPassword(title, hint) {
        return new Promise(resolve => {
            const m = document.createElement('div');
            m.className = 'pa-modal-backdrop';
            m.innerHTML = `<div class="pa-modal" role="dialog" aria-modal="true">
                <h3>🔐 ${esc(title)}</h3>${hint ? `<p>${esc(hint)}</p>` : ''}
                <input type="password" class="amin-input" id="pa-pass-input" autocomplete="current-password" placeholder="كلمة سر النسخ الاحتياطي">
                <div class="pa-modal-actions"><button type="button" class="ok">متابعة</button><button type="button" class="cancel">إلغاء</button></div></div>`;
            document.body.appendChild(m);
            const inp = m.querySelector('input');
            const done = v => { m.remove(); resolve(v); };
            m.querySelector('.ok').onclick = () => done(inp.value);
            m.querySelector('.cancel').onclick = () => done(null);
            inp.addEventListener('keydown', e => { if (e.key === 'Enter') done(inp.value); });
            setTimeout(() => inp.focus(), 50);
        });
    }

    /* ---------------- حفظ / مشاركة ملف ---------------- */
    function saveFile(fileName, text) {
        const bridge = window.AndroidNative;
        if (bridge && typeof bridge.shareBackupFile === 'function') {
            try { if (bridge.shareBackupFile(fileName, text) !== false) return true; } catch (e) {}
        }
        try {
            const blob = new Blob([text], { type: 'application/json' });
            const file = typeof File === 'function' ? new File([blob], fileName, { type: 'application/json' }) : null;
            if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
                navigator.share({ files: [file], title: fileName }).catch(() => {});
                return true;
            }
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = fileName;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 4000);
            return true;
        } catch (e) { return false; }
    }

    async function exportBackup(forcePlain) {
        const validated = PA_CORE.validateDatabaseBackup(db);
        if (!validated.ok) return showToast(`تعذر تصدير نسخة غير صالحة: ${validated.error}`, 'error');
        const now = new Date(); const stamp = PA_CORE.getLocalDateString(now) + '_' + String(now.getHours()).padStart(2, '0') + '-' + String(now.getMinutes()).padStart(2, '0');
        let text, encrypted = false;
        if (!forcePlain && encryptionOn()) {
            text = JSON.stringify(await encryptData(validated.data, getPass()));
            encrypted = true;
        } else {
            text = JSON.stringify(validated.data, null, 2);
        }
        const name = `ProAccountant_Backup_${stamp}${encrypted ? '_enc' : ''}.json`;
        if (!saveFile(name, text)) return showToast('تعذر حفظ ملف النسخة', 'error');
        addHistory({ kind: 'file', encrypted, size: text.length, name });
        showToast(encrypted ? 'تم تجهيز نسخة احتياطية مشفّرة 🔐' : 'تم تجهيز نسخة احتياطية (غير مشفّرة)', 'success');
    }
    window.exportBackupJSON = () => exportBackup(false);
    window.exportPlainBackup = () => exportBackup(true);

    /* ---------------- الاستعادة (تكتشف النسخ المشفّرة) ---------------- */
    const origApply = window.applyRestoredDatabase;
    window.applyRestoredDatabase = async function (imported) {
        if (isEnvelope(imported)) {
            if (!cryptoOk()) { showToast('هذا الجهاز لا يدعم فك التشفير', 'error'); return false; }
            const s = imported.summary || {};
            let pass = getPass();
            let data = null;
            if (pass) { try { data = await decryptEnvelope(imported, pass); } catch (e) { data = null; } }
            for (let attempt = 0; !data && attempt < 3; attempt++) {
                pass = await askPassword('نسخة احتياطية مشفّرة', `تاريخ النسخة: ${fmtDate(imported.createdAt)} — ${s.invoices ?? '?'} فاتورة، ${s.items ?? '?'} صنف، ${s.accounts ?? '?'} حساب. أدخل كلمة السر لفك التشفير.`);
                if (pass === null) return false;
                try { data = await decryptEnvelope(imported, pass); } catch (e) { showToast(e.message, 'error'); }
            }
            if (!data) return false;
            return origApply.call(this, data);
        }
        return origApply.apply(this, arguments);
    };
    window.onAndroidDriveRestoreSuccess = async function (jsonString) {
        try { await window.applyRestoredDatabase(typeof jsonString === 'string' ? JSON.parse(jsonString) : jsonString); }
        catch (e) { showToast('تعذر قراءة بيانات النسخة المستردة من درايف', 'error'); }
    };
    window.importBackupJSON = function (event) {
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async e => {
            try { await window.applyRestoredDatabase(JSON.parse(e.target.result)); }
            catch (err) { showToast('الملف ليس نسخة احتياطية صالحة', 'error'); }
        };
        reader.readAsText(file);
        event.target.value = '';
    };

    /* ---------------- الاستعادة المباشرة من Google Drive حسب التاريخ ---------------- */
    let drivePicker = null;
    function closeDrivePicker() { if (drivePicker) { drivePicker.remove(); drivePicker = null; } }
    function drivePickerShell(inner) {
        closeDrivePicker();
        drivePicker = document.createElement('div');
        drivePicker.className = 'pa-modal-backdrop';
        drivePicker.innerHTML = `<div class="pa-modal pa-drive-modal" role="dialog" aria-modal="true">
            <div class="pa-drive-head"><h3>☁️ نسخ Google Drive</h3><button type="button" class="pa-x" aria-label="إغلاق">✕</button></div>
            <p>${esc(db.settings.driveEmail || '')}</p><div class="pa-drive-body">${inner}</div></div>`;
        document.body.appendChild(drivePicker);
        drivePicker.querySelector('.pa-x').onclick = closeDrivePicker;
        drivePicker.addEventListener('click', e => { if (e.target === drivePicker) closeDrivePicker(); });
    }
    const fileDateLabel = f => {
        const m = String(f.name || '').match(/(\d{4})-(\d{2})(?:-(\d{2}))?/);
        const modified = f.modifiedTime ? new Date(f.modifiedTime) : null;
        const day = modified ? modified.toLocaleDateString('ar-SY', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : '';
        const time = modified ? modified.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
        return { title: m ? (m[3] ? `${m[1]}-${m[2]}-${m[3]}` : `شهر ${m[1]}-${m[2]}`) : (f.name || ''), sub: `${day}${time ? ' — آخر تحديث ' + time : ''}` };
    };
    window.onDriveBackupsList = function (json) {
        let files = [];
        try { files = JSON.parse(json) || []; } catch (e) {}
        files = files.filter(f => /\.json$/i.test(f.name || ''));
        if (!files.length) {
            drivePickerShell('<p class="bk-empty">لا توجد نسخ لهذا البرنامج على Google Drive بعد. اضغط «رفع إلى Google Drive الآن» لإنشاء أول نسخة.</p>');
            return;
        }
        drivePickerShell(`<div class="pa-drive-list">${files.map(f => {
            const d = fileDateLabel(f);
            const encFile = /_enc\.json$/i.test(f.name || '');
            return `<button type="button" class="pa-drive-item" data-id="${esc(f.id)}" data-name="${esc(f.name)}">
                <span class="ic">${encFile ? '🔐' : '📄'}</span>
                <span class="tx"><b dir="ltr">${esc(d.title)}</b><small>${esc(d.sub)}</small></span>
                <span class="sz" dir="ltr">${f.size ? fmtSize(Number(f.size)) : ''}</span><span class="go">استعادة ›</span></button>`;
        }).join('')}</div><p class="bk-note">اختر النسخة حسب التاريخ لتُستعاد مباشرة. تُحفظ نسخة أمان من بياناتك الحالية قبل الاستبدال.</p>`);
        drivePicker.querySelectorAll('.pa-drive-item').forEach(btn => {
            btn.onclick = () => {
                const name = btn.getAttribute('data-name');
                if (!window.confirm(`استعادة النسخة «${name}» من Google Drive؟ ستُستبدل البيانات الحالية.`)) return;
                drivePickerShell('<div class="pa-loading"><i></i>جاري تنزيل النسخة من Google Drive...</div>');
                window.__paDriveRestoring = true;
                try { window.AndroidNative.downloadDriveBackupFile(db.settings.driveEmail, btn.getAttribute('data-id')); }
                catch (e) { window.onDriveBackupsError('تعذر بدء التنزيل'); }
            };
        });
    };
    window.onDriveBackupsError = function (msg) {
        window.__paDriveRestoring = false;
        drivePickerShell(`<p class="bk-empty">⚠️ ${esc(msg || 'تعذر الاتصال بـ Google Drive')}</p><p class="bk-note">تأكد من الاتصال بالإنترنت ومن صلاحية حساب Google، ثم أعد المحاولة.</p>
            <div class="pa-modal-actions"><button type="button" class="ok" onclick="restoreFromDrive()">إعادة المحاولة</button><button type="button" class="cancel" onclick="openEmailChooser()">تغيير الحساب</button></div>`);
    };
    const origRestoreFromDrive = window.restoreFromDrive;
    window.restoreFromDrive = function () {
        const bridge = window.AndroidNative;
        if (!bridge || typeof bridge.listDriveBackupFiles !== 'function') return origRestoreFromDrive && origRestoreFromDrive.apply(this, arguments);
        if (!db.settings.driveEmail) { showToast('اختر حساب Google أولاً', 'info'); try { openEmailChooser(); } catch (e) {} return; }
        drivePickerShell('<div class="pa-loading"><i></i>جاري جلب قائمة النسخ من Google Drive...</div>');
        try { bridge.listDriveBackupFiles(db.settings.driveEmail); } catch (e) { window.onDriveBackupsError('تعذر الاتصال'); }
    };
    window.onAndroidDriveRestoreSuccess = async function (jsonString) {
        closeDrivePicker();
        window.__paDriveRestoring = false;
        try { await window.applyRestoredDatabase(typeof jsonString === 'string' ? JSON.parse(jsonString) : jsonString); }
        catch (e) { showToast('تعذر قراءة بيانات النسخة المستردة من درايف', 'error'); }
    };

    /* ---------------- نافذة تأكيد الخروج مع اقتراح النسخ ---------------- */
    let exitDialog = null;
    const exitNow = () => {
        const A = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.App;
        if (A && A.exitApp) A.exitApp();
        else if (window.AndroidNative && AndroidNative.exitApp) AndroidNative.exitApp();
        else window.close();
    };
    function backedUpToday() {
        const today = PA_CORE.getLocalDateString();
        const h = history()[0];
        return !!(h && PA_CORE.getLocalDateString(new Date(h.at)) === today);
    }
    window.paCloseExitDialog = function () { if (exitDialog) { exitDialog.remove(); exitDialog = null; return true; } return false; };
    window.paConfirmExit = function () {
        if (window.paCloseExitDialog()) return;
        const done = backedUpToday();
        const drive = !!db.settings.driveEmail && !!(window.AndroidNative && window.AndroidNative.uploadToDrive);
        exitDialog = document.createElement('div');
        exitDialog.className = 'pa-modal-backdrop';
        exitDialog.innerHTML = `<div class="pa-modal pa-exit-modal" role="dialog" aria-modal="true">
            <div class="pa-exit-ic">🚪</div>
            <h3>هل تريد الخروج من البرنامج؟</h3>
            <p class="${done ? 'ok' : 'warn'}">${done ? '✔ تم أخذ نسخة احتياطية اليوم.' : '⚠️ لم تأخذ نسخة احتياطية اليوم. ننصح بأخذ نسخة قبل الخروج لحماية بياناتك.'}</p>
            <div class="pa-exit-actions">
                ${done ? '' : `<button type="button" class="bk-primary" data-a="backup">${drive ? '☁️ نسخ إلى Google Drive ثم خروج' : '💾 أخذ نسخة احتياطية الآن'}</button>`}
                <button type="button" class="${done ? 'bk-primary' : 'bk-danger'}" data-a="exit">${done ? 'خروج' : 'خروج بدون نسخ'}</button>
                <button type="button" class="bk-secondary" data-a="cancel">البقاء في البرنامج</button>
            </div></div>`;
        document.body.appendChild(exitDialog);
        exitDialog.addEventListener('click', e => { if (e.target === exitDialog) window.paCloseExitDialog(); });
        exitDialog.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
            const a = b.getAttribute('data-a');
            if (a === 'cancel') return window.paCloseExitDialog();
            if (a === 'exit') { window.paCloseExitDialog(); return exitNow(); }
            if (drive) {
                b.disabled = true; b.textContent = '⏳ جاري الرفع إلى Google Drive...';
                window.__paExitAfterDrive = true;
                triggerDriveSyncNow(true);
            } else {
                window.paCloseExitDialog();
                await exportBackup(false);
            }
        });
    };
    const origDriveErr = window.onAndroidDriveSyncError;
    if (typeof origDriveErr === 'function') {
        window.onAndroidDriveSyncError = function (msg) {
            const r = origDriveErr.apply(this, arguments);
            if (window.__paExitAfterDrive) {
                window.__paExitAfterDrive = false;
                window.paCloseExitDialog();
                showToast('تعذر الرفع إلى Google Drive: ' + (msg || '') + ' — لم يتم الخروج.', 'error', 6000);
            }
            return r;
        };
    }

    /* ---------------- تسجيل نجاح مزامنة Drive ---------------- */
    const origDriveOk = window.onAndroidDriveSyncSuccess;
    if (typeof origDriveOk === 'function') {
        window.onAndroidDriveSyncSuccess = async function () {
            const r = await origDriveOk.apply(this, arguments);
            const lp = window.__paLastDrivePayload || {};
            addHistory({ kind: 'drive', encrypted: !!lp.encrypted, size: lp.size || 0, name: db.settings.driveEmail || 'Google Drive', auto: !window.__paManualDrive });
            window.__paManualDrive = false;
            if (window.__paExitAfterDrive) {
                window.__paExitAfterDrive = false;
                const box = exitDialog && exitDialog.querySelector('.pa-exit-modal p');
                if (box) { box.className = 'ok'; box.textContent = '✔ تم رفع النسخة إلى Google Drive. جاري الخروج...'; }
                setTimeout(() => { window.paCloseExitDialog(); exitNow(); }, 900);
            }
            return r;
        };
    }

    /* ---------------- واجهة مركز النسخ ---------------- */
    async function savePassword() {
        const p1 = document.getElementById('bk-pass1').value;
        const p2 = document.getElementById('bk-pass2').value;
        if (p1.length < 6) return showToast('كلمة السر يجب ألا تقل عن 6 أحرف', 'error');
        if (p1 !== p2) return showToast('كلمتا السر غير متطابقتين', 'error');
        if (!cryptoOk()) return showToast('هذا الجهاز لا يدعم التشفير', 'error');
        ls.set(PASS_KEY, p1);
        const saved = await commitDatabaseMutation(() => { db.settings.backupEncrypt = true; return true; }, { skipDriveSync: true });
        if (saved) showToast('تم حفظ كلمة سر النسخ وتفعيل التشفير 🔐 احتفظ بها في مكان آمن', 'success');
        renderCenter();
    }
    async function toggleEncrypt(on) {
        if (on && !getPass()) { showToast('عيّن كلمة سر النسخ أولاً', 'error'); renderCenter(); return; }
        await commitDatabaseMutation(() => { db.settings.backupEncrypt = on; return true; }, { skipDriveSync: true });
        renderCenter();
    }
    function forgetPassword() {
        if (!window.confirm('حذف كلمة سر النسخ من هذا الجهاز؟ لن تتمكن من فتح النسخ المشفّرة السابقة بدونها.')) return;
        ls.del(PASS_KEY);
        toggleEncrypt(false);
    }
    window.paBackup = { savePassword, toggleEncrypt, forgetPassword, exportBackup, encryptData, decryptEnvelope, isEnvelope, setDrive: p => setDrive(p), driveUp: m => driveUp(m) };

    /* ---------------- إعدادات Drive (تُحفظ مباشرة ثم تُزامن مع عناصر app.js المخفية) ---------------- */
    let activeTab = 'actions';
    async function setDrive(patch) {
        const saved = await commitDatabaseMutation(() => { Object.assign(db.settings, patch); return true; }, { skipDriveSync: true });
        try { initDriveSyncUI(); } catch (e) {}
        renderCenter();
        return saved;
    }
    function driveUp(manual) { window.__paManualDrive = !!manual; triggerDriveSyncNow(true); }
    window.paBackupTab = t => { activeTab = t; renderCenter(); };

    const sw = (on, action, dis) => `<label class="pa-switch"><input type="checkbox" ${on ? 'checked' : ''} ${dis ? 'disabled' : ''} onchange="${action}"><span></span></label>`;
    const row = (icon, title, sub, control, extra) => `<div class="bk-row"><span class="bk-ri">${icon}</span><span class="bk-rt"><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</span><span class="bk-rc">${control}</span>${extra ? `<div class="bk-rx">${extra}</div>` : ''}</div>`;

    function tabActions() {
        const h = history();
        const last = h[0];
        const days = last ? Math.floor((Date.now() - new Date(last.at).getTime()) / 86400000) : null;
        const drive = db.settings.driveEmail;
        return `
            <div class="bk-status ${last && days <= 1 ? 'ok' : 'warn'}">
                <span>${last ? (days === 0 ? '✔ آخر نسخة اليوم' : `⚠️ آخر نسخة منذ ${days} يوم`) : '⚠️ لا توجد نسخة احتياطية بعد'}</span>
                <small dir="ltr">${last ? fmtDate(last.at) : ''}</small>
            </div>
            <h4 class="bk-h">📤 أخذ نسخة احتياطية</h4>
            <div class="bk-grid2">
                <button type="button" class="bk-tile drive" onclick="paBackup.driveUp(true)"><span>☁️</span><b>إلى Google Drive</b><small>${drive ? esc(drive) : 'اختر الحساب أولاً'}</small></button>
                <button type="button" class="bk-tile local" onclick="paBackup.exportBackup(false)"><span>💾</span><b>على الجهاز</b><small>حفظ / مشاركة الملف</small></button>
            </div>
            <h4 class="bk-h">📥 استعادة نسخة</h4>
            <div class="bk-grid2">
                <button type="button" class="bk-tile" onclick="restoreFromDrive()"><span>☁️</span><b>من Google Drive</b><small>اختيار حسب التاريخ</small></button>
                <label class="bk-tile"><span>📂</span><b>من ملف على الجهاز</b><small>ملف .json</small><input type="file" accept=".json,application/json" class="hidden" onchange="importBackupJSON(event)"></label>
            </div>
            <button type="button" class="bk-mini" onclick="restoreLastGoodBackup()">♻️ التراجع إلى آخر حالة سليمة (قبل آخر تعديل)</button>`;
    }

    function tabSettings() {
        const st = db.settings;
        const hasPass = !!getPass();
        const on = encryptionOn();
        const daily = st.driveDailyFile !== false;
        return `
            <div class="bk-list">
                ${row('👤', 'حساب Google Drive', st.driveEmail ? esc(st.driveEmail) : 'لم يتم اختيار حساب', `<button type="button" class="bk-chip" onclick="openEmailChooser()">${st.driveEmail ? 'تغيير' : 'اختيار'}</button>`)}
                ${row('🔄', 'مزامنة فورية بعد كل حفظ', 'يرفع نسخة إلى Drive تلقائياً عند أي تعديل', sw(!!st.driveSyncEnabled, 'paBackup.setDrive({driveSyncEnabled:this.checked})', !st.driveEmail))}
                ${row('⏰', 'نسخ يومي تلقائي', 'يعمل عندما يكون البرنامج مفتوحاً في الوقت المحدد', `${sw(st.driveScheduledEnabled !== false, 'paBackup.setDrive({driveScheduledEnabled:this.checked})', !st.driveEmail)}`, `<label class="bk-inl">وقت النسخ <input type="time" class="bk-time" value="${esc(st.driveScheduledTime || '00:30')}" onchange="paBackup.setDrive({driveScheduledTime:this.value})" ${st.driveScheduledEnabled === false ? 'disabled' : ''}></label>`)}
                ${row('🗂️', 'طريقة حفظ الملفات على Drive', daily ? 'ملف مستقل لكل يوم (يمكن الاستعادة لأي تاريخ)' : 'ملف واحد لكل شهر يُحدَّث باستمرار', '', `<div class="st-seg"><button type="button" class="${daily ? 'on' : ''}" onclick="paBackup.setDrive({driveDailyFile:true})">يومي</button><button type="button" class="${!daily ? 'on' : ''}" onclick="paBackup.setDrive({driveDailyFile:false,driveMonthlyFile:true})">شهري</button></div>`)}
                ${row('🔔', 'إشعار عند نجاح المزامنة', '', sw(st.driveNotifications !== false, 'paBackup.setDrive({driveNotifications:this.checked})'))}
                ${row('🔐', 'تشفير النسخ (AES-256)', on ? 'مفعّل — النسخ لا تُفتح إلا بكلمة السر' : (hasPass ? 'متوقف' : 'عيّن كلمة سر لتفعيل التشفير'), sw(on, 'paBackup.toggleEncrypt(this.checked)', !hasPass))}
            </div>
            <details class="bk-pass-box" ${hasPass ? '' : 'open'}>
                <summary>🔑 ${hasPass ? 'تغيير كلمة سر النسخ' : 'تعيين كلمة سر النسخ'}</summary>
                <div class="bk-pass">
                    <input type="password" id="bk-pass1" class="amin-input" autocomplete="new-password" placeholder="كلمة السر (6 أحرف على الأقل)">
                    <input type="password" id="bk-pass2" class="amin-input" autocomplete="new-password" placeholder="تأكيد كلمة السر">
                    <button type="button" class="bk-primary" onclick="paBackup.savePassword()">${hasPass ? 'تحديث كلمة السر' : 'حفظ وتفعيل التشفير'}</button>
                </div>
                <p class="bk-warn">⚠️ كلمة السر محفوظة على هذا الجهاز فقط. إذا نسيتها لا يمكن فتح النسخ المشفّرة.</p>
                ${hasPass ? '<button type="button" class="bk-link" onclick="paBackup.forgetPassword()">حذف كلمة السر من هذا الجهاز</button>' : ''}
            </details>`;
    }

    function tabHistory() {
        const h = history();
        const drives = h.filter(x => x.kind === 'drive').length;
        const total = h.reduce((t, x) => t + (Number(x.size) || 0), 0);
        const items = h.map(x => {
            const d = new Date(x.at);
            const day = isNaN(d) ? '' : d.toLocaleDateString('ar-SY', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
            const time = isNaN(d) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
            return `<div class="bk-hitem">
                <span class="bk-hi ${x.kind === 'drive' ? 'drive' : 'local'}">${x.kind === 'drive' ? '☁️' : '💾'}</span>
                <span class="bk-ht"><b>${day}</b><small><bdi dir="ltr">${time}</bdi> — ${x.kind === 'drive' ? 'Google Drive' + (x.auto ? ' (تلقائي)' : '') : 'ملف على الجهاز'}</small></span>
                <span class="bk-hm"><b dir="ltr">${x.size ? fmtSize(x.size) : '—'}</b><small>${x.encrypted ? '🔐 مشفّرة' : 'غير مشفّرة'}</small></span>
            </div>`;
        }).join('');
        return `
            <div class="bk-sum">
                <div><b>${h.length}</b><small>نسخة مسجلة</small></div>
                <div><b>${drives}</b><small>على Drive</small></div>
                <div><b>${h.length - drives}</b><small>على الجهاز</small></div>
                <div><b dir="ltr">${total ? fmtSize(total) : '—'}</b><small>الحجم الكلي</small></div>
            </div>
            ${items ? `<div class="bk-hlist">${items}</div>` : '<p class="bk-empty">لم تُسجَّل أي نسخة على هذا الجهاز بعد.</p>'}
            <button type="button" class="bk-mini" onclick="restoreFromDrive()">☁️ عرض كل النسخ المحفوظة على Google Drive</button>`;
    }

    function renderCenter() {
        const host = document.getElementById('backup-center');
        if (!host || typeof db === 'undefined' || !db || !db.settings) return;
        const on = encryptionOn();
        const tabs = [['actions', '⚡', 'نسخ واستعادة'], ['settings', '⚙️', 'الإعدادات'], ['history', '🕘', 'السجل']];
        host.innerHTML = `
            <div class="bk-top">
                <div class="bk-top-tx"><b>🛡️ النسخ الاحتياطي</b><small>${db.settings.driveEmail ? '☁️ ' + esc(db.settings.driveEmail) : 'غير مرتبط بـ Google Drive'}</small></div>
                <span class="bk-badge ${on ? 'ok' : 'warn'}">${on ? '🔐 مشفّر' : '🔓 غير مشفّر'}</span>
            </div>
            <div class="bk-tabs" role="tablist">${tabs.map(([k, i, t]) => `<button type="button" role="tab" class="${activeTab === k ? 'on' : ''}" onclick="paBackupTab('${k}')"><span>${i}</span>${t}</button>`).join('')}</div>
            <div class="bk-pane">${activeTab === 'settings' ? tabSettings() : activeTab === 'history' ? tabHistory() : tabActions()}</div>`;
    }
    window.renderBackupCenter = renderCenter;

    function setup() {
        if (document.getElementById('backup-center')) return;
        const anchor = Array.from(document.querySelectorAll('#view-settings h3')).find(h => /النسخ الاحتياطي المحلي/.test(h.textContent));
        const block = anchor && anchor.parentElement;
        const host = document.createElement('div');
        host.id = 'backup-center';
        host.className = 'pa-backup-center';
        if (block) block.parentElement.insertBefore(host, block);
        else document.getElementById('view-settings')?.firstElementChild?.appendChild(host);
        if (anchor) anchor.textContent = 'إدارة البيانات';
    }

    function reminder() {
        const h = history();
        const last = h[0] ? new Date(h[0].at).getTime() : 0;
        const driveTs = db.settings && db.settings.driveLastSync ? 1 : 0;
        if ((db.invoices || []).length > 0 && !driveTs && Date.now() - last > 7 * 86400000) {
            setTimeout(() => showToast('💡 لم تأخذ نسخة احتياطية منذ أكثر من 7 أيام. افتح الإعدادات ← مركز النسخ الاحتياطي.', 'warning', 6000), 2500);
        }
    }

    const origAcc = window.onAndroidGoogleAccountSelected;
    if (typeof origAcc === 'function') window.onAndroidGoogleAccountSelected = async function () { const r = await origAcc.apply(this, arguments); renderCenter(); return r; };
    function boot() { setup(); renderCenter(); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
    const origInit = window.initializeAppUI;
    if (typeof origInit === 'function') {
        window.initializeAppUI = async function () { const r = await origInit.apply(this, arguments); boot(); reminder(); return r; };
    }
    const origSwitch = window.switchTab;
    window.switchTab = function (t) { const r = origSwitch.apply(this, arguments); if (t === 'settings') renderCenter(); return r; };
})();
