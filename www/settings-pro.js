/* ===== settings-pro.js — واجهة إعدادات احترافية بأقسام واضحة (نمط إعدادات أندرويد) =====
   يعيد ترتيب عناصر الإعدادات الموجودة نفسها (بنفس المعرفات والوظائف) داخل أقسام قابلة للطي. */
(function () {
    const $ = id => document.getElementById(id);
    const up = (el, sel) => (el && el.closest(sel)) || null;
    let built = false;

    const SECTIONS = [
        { id: 'company', icon: '🏢', title: 'بيانات المنشأة', sub: 'الاسم، الهاتف، الشعار والرقم الضريبي' },
        { id: 'sales', icon: '🧾', title: 'الفواتير والبيع', sub: 'طريقة الدفع والعملة والطباعة التلقائية وما يظهر في الفاتورة' },
        { id: 'design', icon: '🎨', title: 'تصميم الطباعة', sub: 'قالب الفاتورة واللون والمعاينة' },
        { id: 'security', icon: '🔒', title: 'الأمان والقفل', sub: 'رمز PIN والفتح بالبصمة' },
        { id: 'backup', icon: '☁️', title: 'النسخ الاحتياطي و Google Drive', sub: 'نسخ مشفّرة، مزامنة واستعادة حسب التاريخ' },
        { id: 'look', icon: '🌐', title: 'اللغة والمظهر', sub: 'العربية / English والوضع الليلي أو النهاري' },
        { id: 'data', icon: '🗄️', title: 'إدارة البيانات', sub: 'حجم البيانات، الاستعادة السريعة، البيانات التجريبية والتصفير' },
        { id: 'about', icon: 'ℹ️', title: 'حول البرنامج', sub: 'الإصدار والمطوّر وجولة التعريف' }
    ];

    function section(s) {
        const el = document.createElement('div');
        el.className = 'st-sec';
        el.id = 'st-' + s.id;
        el.innerHTML = `<button type="button" class="st-row" aria-expanded="false">
                <span class="st-ic">${s.icon}</span>
                <span class="st-tx"><b>${s.title}</b><small>${s.sub}</small></span>
                <span class="st-chev">‹</span></button>
            <div class="st-body"></div>`;
        el.querySelector('.st-row').onclick = () => toggle(s.id);
        return el;
    }
    function toggle(id, force) {
        document.querySelectorAll('.st-sec').forEach(sec => {
            const open = sec.id === 'st-' + id ? (force !== undefined ? force : !sec.classList.contains('open')) : false;
            sec.classList.toggle('open', open);
            sec.querySelector('.st-row').setAttribute('aria-expanded', String(open));
        });
        const sec = $('st-' + id);
        if (sec && sec.classList.contains('open')) {
            if (id === 'backup' && typeof window.renderBackupCenter === 'function') window.renderBackupCenter();
            if (id === 'data' && typeof window.updateDataSizeInfo === 'function') window.updateDataSizeInfo();
            if (id === 'look') renderLook();
            setTimeout(() => sec.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
        }
        try { sessionStorage.setItem('pa_settings_open', sec && sec.classList.contains('open') ? id : ''); } catch (e) {}
    }
    window.paOpenSettingsSection = id => { if (typeof switchTab === 'function') switchTab('settings'); toggle(id, true); };

    const move = (target, el) => { if (el && target && !target.contains(el)) target.appendChild(el); };

    function renderLook() {
        const box = $('st-look-box');
        if (!box) return;
        const lang = typeof window.paLang === 'function' ? window.paLang() : 'ar';
        const day = document.body.classList.contains('day-mode');
        box.innerHTML = `
            <div class="st-opt"><div><b>لغة البرنامج</b><small>تغيير لغة الواجهة فوراً (الفواتير المطبوعة تبقى بالعربية)</small></div>
              <div class="st-seg" data-no-i18n><button type="button" class="${lang === 'ar' ? 'on' : ''}" onclick="setLang('ar');paRenderLook()">العربية</button><button type="button" class="${lang === 'en' ? 'on' : ''}" onclick="setLang('en');paRenderLook()">English</button></div></div>
            <div class="st-opt"><div><b>المظهر</b><small>الوضع الليلي مريح للعين، والنهاري أوضح تحت الشمس</small></div>
              <div class="st-seg"><button type="button" class="${!day ? 'on' : ''}" onclick="paSetTheme(false)">🌙 ليلي</button><button type="button" class="${day ? 'on' : ''}" onclick="paSetTheme(true)">☀️ نهاري</button></div></div>`;
    }
    window.paRenderLook = renderLook;
    window.paSetTheme = async day => {
        if (document.body.classList.contains('day-mode') !== day && typeof toggleThemeMode === 'function') await toggleThemeMode();
        renderLook();
    };

    function build() {
        if (built) return;
        const view = $('view-settings');
        const card = view && view.firstElementChild;
        if (!card || !$('set-company-name')) return;
        built = true;
        card.classList.add('st-card');

        /* رأس الصفحة: بطاقة المنشأة + زر الحفظ */
        const head = card.firstElementChild;
        if (head) head.classList.add('st-head-old');
        const hero = document.createElement('div');
        hero.className = 'st-hero';
        hero.innerHTML = `<div class="st-hero-logo" id="st-hero-logo"></div>
            <div class="st-hero-tx"><b id="st-hero-name"></b><small id="st-hero-sub"></small></div>`;
        card.insertBefore(hero, card.firstChild);

        const list = document.createElement('div');
        list.className = 'st-list';
        SECTIONS.forEach(s => list.appendChild(section(s)));
        hero.after(list);
        const body = id => $('st-' + id).querySelector('.st-body');

        /* 1) المنشأة */
        move(body('company'), up($('set-company-name'), '.grid'));
        move(body('company'), up($('settings-logo-preview'), '.flex.items-center.justify-between'));
        move(body('company'), $('set-tax-number') && $('set-tax-number').parentElement);
        /* 2) الفواتير والبيع */
        move(body('sales'), up($('set-default-payment'), '.grid'));
        move(body('sales'), up($('set-auto-print-invoice'), '.grid'));
        move(body('sales'), up($('set-inv-show-qr'), '.grid'));
        move(body('sales'), $('set-invoice-footer') && $('set-invoice-footer').parentElement);
        /* 3) التصميم */
        const tplWrap = $('set-invoice-template') && $('set-invoice-template').parentElement;
        const accentGrid = up($('set-invoice-accent'), '.grid');
        const note = accentGrid && accentGrid.nextElementSibling && accentGrid.nextElementSibling.tagName === 'P' ? accentGrid.nextElementSibling : null;
        move(body('design'), tplWrap);
        move(body('design'), accentGrid);
        move(body('design'), note);
        /* 4) الأمان */
        move(body('security'), up($('new-pin-input'), '.rounded-2xl'));
        move(body('security'), $('bio-settings-card'));
        /* 5) النسخ */
        move(body('backup'), $('backup-center'));
        move(body('backup'), $('gdrive-sync-container'));
        /* 6) اللغة والمظهر */
        const look = document.createElement('div'); look.id = 'st-look-box'; body('look').appendChild(look);
        /* 7) البيانات */
        move(body('data'), $('data-size-info') && $('data-size-info').parentElement);
        const dataH = Array.from(card.querySelectorAll('h3')).find(h => /إدارة البيانات|النسخ الاحتياطي المحلي/.test(h.textContent));
        if (dataH) { const blk = dataH.parentElement; dataH.remove(); move(body('data'), blk); }
        /* 8) حول */
        body('about').innerHTML = `<div class="st-about">
            <img src="app-icon-1024.png" alt="">
            <div><b>محاسب محترف سوريا</b><small dir="ltr">ProAccountant Syria — v${window.PA_APP_VERSION || '3.3'}</small>
            <small>تطوير: باسل محمد الخابور — <bdi dir="ltr">0952575089</bdi></small></div></div>
            <div class="st-about-actions"><button type="button" onclick="openTour && openTour()">❓ جولة تعريفية بالبرنامج</button>
            <a href="tel:0952575089">📞 الدعم الفني</a><a href="https://wa.me/963952575089">💬 واتساب</a></div>`;

        /* تنظيف العناوين والفواصل القديمة الفارغة */
        card.querySelectorAll(':scope > hr').forEach(h => h.remove());
        Array.from(card.children).forEach(ch => {
            if (ch === hero || ch === list || ch.classList.contains('st-head-old')) return;
            const h3 = ch.querySelector(':scope > h3');
            if (h3 && /الترويسة والفوترة/.test(h3.textContent)) h3.remove();
            if (!ch.textContent.trim() && !ch.querySelector('input,select,button')) ch.remove();
        });
        /* أي عناصر متبقية (احتياط) تذهب إلى قسم الفواتير */
        Array.from(card.children).forEach(ch => {
            if (ch === hero || ch === list || ch.classList.contains('st-head-old')) return;
            if (ch.querySelector('input,select,button')) move(body('sales'), ch); else ch.remove();
        });

        /* زر حفظ ثابت أسفل الشاشة */
        const save = document.createElement('div');
        save.className = 'st-savebar';
        save.innerHTML = `<button type="button" onclick="saveAllAdvancedSettings()">✔ حفظ الإعدادات</button>`;
        card.appendChild(save);
        if (head) head.remove();

        refreshHero();
        let last = '';
        try { last = sessionStorage.getItem('pa_settings_open') || ''; } catch (e) {}
        if (last) toggle(last, true);
    }

    function refreshHero() {
        if (!$('st-hero-name')) return;
        const st = (typeof db !== 'undefined' && db && db.settings) || {};
        $('st-hero-name').textContent = st.companyName || 'محاسب محترف سوريا';
        $('st-hero-sub').textContent = st.companySub || '';
        const logo = st.companyLogo ? PA_CORE.safeImageUrl(st.companyLogo) : '';
        $('st-hero-logo').innerHTML = logo ? `<img src="${PA_CORE.escapeHtml(logo)}" alt="">` : '<img src="app-icon-1024.png" alt="">';
    }
    window.paRefreshSettingsHero = refreshHero;

    function boot() { build(); refreshHero(); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0)); else setTimeout(boot, 0);
    const origSwitch = window.switchTab;
    window.switchTab = function (t) {
        const r = origSwitch.apply(this, arguments);
        if (t === 'settings') { build(); refreshHero(); if ($('bio-settings-card') && !$('bio-settings-card').closest('.st-body')) move($('st-security').querySelector('.st-body'), $('bio-settings-card')); }
        return r;
    };
    window.addEventListener('palang', () => { renderLook(); });
    const origSave = window.saveAllAdvancedSettings;
    if (typeof origSave === 'function') {
        window.saveAllAdvancedSettings = async function () { const r = await origSave.apply(this, arguments); refreshHero(); return r; };
    }
})();
