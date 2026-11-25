/* ===== فتح البرنامج ببصمة الجوال (اختياري) ===== */
(function () {
    const bridge = () => window.AndroidNative;
    const status = () => { try { return bridge() && typeof bridge().biometricStatus === 'function' ? bridge().biometricStatus() : 'unsupported'; } catch (e) { return 'unsupported'; } };
    const enabled = () => !!(db.settings && db.settings.biometricLock);
    const hasPin = () => !!(db.settings && db.settings.appPin && db.settings.appPin.length === 4);

    function unlock() {
        try { isAppUnlockedThisSession = true; } catch (e) {}
        try { pinFailedAttempts = 0; } catch (e) {}
        document.getElementById('pin-lock-screen')?.classList.add('hidden');
        showToast('تم فتح القفل بالبصمة ✔', 'success');
    }

    window.onBiometricResult = function (ok, msg) {
        setTimeout(() => { window.__paBioInFlight = false; }, 1500);
        if (ok) return unlock();
        const err = document.getElementById('pin-error-msg');
        if (err) err.textContent = msg ? ('لم يتم التحقق: ' + msg) : 'لم يتم التحقق من البصمة';
    };

    window.startBiometricUnlock = function () {
        const st = status();
        if (st !== 'available') {
            showToast(st === 'not_enrolled' ? 'لا توجد بصمة مسجلة في الهاتف. أضفها من إعدادات الهاتف.' : 'البصمة غير متاحة على هذا الجهاز', 'error');
            return;
        }
        window.__paBioInFlight = true;
        try { bridge().authenticateBiometric('فتح محاسب محترف سوريا', 'استخدم بصمتك أو قفل الشاشة'); }
        catch (e) { window.__paBioInFlight = false; showToast('تعذر تشغيل البصمة', 'error'); }
    };

    function decorateLockScreen() {
        const screen = document.getElementById('pin-lock-screen');
        if (!screen) return;
        let btn = document.getElementById('bio-unlock-btn');
        if (!btn) {
            btn = document.createElement('button');
            btn.type = 'button';
            btn.id = 'bio-unlock-btn';
            btn.className = 'pa-bio-btn';
            btn.innerHTML = '<span>☝️</span> فتح بالبصمة';
            btn.onclick = () => window.startBiometricUnlock();
            const err = document.getElementById('pin-error-msg');
            err && err.insertAdjacentElement('afterend', btn);
        }
        const bioOn = enabled() && status() === 'available';
        btn.style.display = bioOn ? '' : 'none';
        const pinOn = hasPin();
        const pad = screen.querySelector('.grid.grid-cols-3');
        const dots = document.getElementById('pin-dots-container');
        if (pad) pad.style.display = pinOn ? '' : 'none';
        if (dots) dots.style.display = pinOn ? '' : 'none';
        const sub = document.getElementById('pin-lock-subtitle');
        if (sub) sub.textContent = pinOn ? (bioOn ? 'استخدم البصمة أو أدخل رمز PIN' : 'أدخل رمز الحماية (PIN) لفتح البرنامج') : 'استخدم البصمة لفتح البرنامج';
        return bioOn;
    }

    const origShow = window.showPinLockScreen;
    window.showPinLockScreen = function () {
        origShow.apply(this, arguments);
        if (decorateLockScreen() && !window.__paBioInFlight) setTimeout(window.startBiometricUnlock, 350);
    };

    const origInit = window.initAppPinSecurity;
    window.initAppPinSecurity = function () {
        origInit.apply(this, arguments);
        let unlocked = true;
        try { unlocked = isAppUnlockedThisSession; } catch (e) {}
        if (enabled() && !hasPin() && !unlocked && status() === 'available') window.showPinLockScreen();
        renderSettingsCard();
    };

    function renderSettingsCard() {
        const anchor = document.getElementById('disable-pin-btn');
        if (!anchor) return;
        let card = document.getElementById('bio-settings-card');
        const pinCard = anchor.closest('.rounded-2xl');
        if (!card && pinCard) {
            card = document.createElement('div');
            card.id = 'bio-settings-card';
            card.className = 'pa-bio-card';
            pinCard.insertAdjacentElement('afterend', card);
        }
        if (!card) return;
        const st = status();
        const txt = st === 'available' ? 'متاحة على هذا الجهاز' : (st === 'not_enrolled' ? 'لا توجد بصمة مسجلة في الهاتف' : (st === 'unsupported' ? 'متاحة في تطبيق أندرويد فقط' : 'غير متاحة على هذا الجهاز'));
        card.innerHTML = `
            <div class="row">
                <div><h3>☝️ فتح البرنامج بالبصمة</h3><p>حماية اختيارية: يُطلب التحقق بالبصمة (أو قفل شاشة الهاتف) عند فتح البرنامج أو العودة إليه بعد أكثر من 45 ثانية. الحالة: <b>${txt}</b></p></div>
                <label class="pa-switch"><input type="checkbox" id="bio-toggle" ${enabled() ? 'checked' : ''} ${st === 'available' || enabled() ? '' : 'disabled'}><span></span></label>
            </div>`;
        card.querySelector('#bio-toggle').onchange = async e => {
            const on = e.target.checked;
            if (on && status() !== 'available') { e.target.checked = false; return showToast('البصمة غير متاحة على هذا الجهاز', 'error'); }
            const saved = await commitDatabaseMutation(() => { db.settings.biometricLock = on; return true; });
            if (!saved) { e.target.checked = !on; return; }
            try { isAppUnlockedThisSession = true; } catch (err) {}
            showToast(on ? 'تم تفعيل الفتح بالبصمة ✔' : 'تم إيقاف الفتح بالبصمة', 'success');
        };
    }

    function boot() { renderSettingsCard(); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
    window.addEventListener('androidnative-ready', () => { renderSettingsCard(); decorateLockScreen(); });
})();
