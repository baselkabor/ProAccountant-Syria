/* ===== sync-core.js — مزامنة فورية لكل القوائم + طابور العمليات =====
   1) أي عملية حفظ ناجحة تحدّث كل الشاشات والقوائم المنسدلة والأعمدة فوراً.
   2) العمليات المتتالية السريعة (ضغطتان متتاليتان) تُنفَّذ بالترتيب بدل رفض الثانية.
   3) عند التنقل بين النوافذ تُعرض الشاشة ببيانات محدثة دائماً. */
(function () {
    const RENDERERS = {
        common: ['populateAccountDropdowns', 'populateCashboxesAndWarehouses', 'refreshInvoiceItemDropdowns', 'updateDashboardKPIs', 'updateSmartAlertsBadge', 'updateNextInvoiceNumber'],
        home: ['updateDashboardKPIs', 'renderSalesChart'],
        sales: ['renderRecentInvoices'], purchases: ['renderRecentInvoices'],
        items: ['renderItemsTable'], barcodes: ['renderBarcodeStudioList', 'renderItemsTable'],
        accounts: ['renderAccountsTable', 'renderDebtFollowupTable'],
        vouchers: ['populateVoucherReturnOptions', 'renderVouchersView'],
        returns: ['renderReturnsView'],
        reports: ['renderReportsView', 'renderAccountStatement'],
        eod: ['renderDetailedInvoicesReport', 'renderEndOfDayReport'],
        cashboxes: ['renderCashboxesAndExpensesView'],
        employees: ['renderEmployeesAndInstallmentsView'],
        profit: ['renderProfitAndReportsHub'],
        settings: ['updateDataSizeInfo']
    };
    const call = name => { const fn = window[name]; if (typeof fn === 'function') { try { fn(); } catch (e) { console.warn('[sync]', name, e); } } };
    const currentView = () => document.body.dataset.view || 'home';
    let syncing = false;

    /* تحديث شامل: الشاشة الحالية أولاً ثم الباقي، مع الحفاظ على ما يكتبه المستخدم */
    function syncAll() {
        if (syncing) return;
        syncing = true;
        try {
            const active = document.activeElement;
            const keep = active && active.id && /^(INPUT|TEXTAREA)$/.test(active.tagName) ? { id: active.id, v: active.value, s: active.selectionStart } : null;
            RENDERERS.common.forEach(call);
            const cur = currentView();
            (RENDERERS[cur] || []).forEach(call);
            Object.keys(RENDERERS).forEach(k => { if (k !== 'common' && k !== cur) RENDERERS[k].forEach(call); });
            if (keep) {
                const el = document.getElementById(keep.id);
                if (el && el.value !== keep.v) el.value = keep.v;
                if (el && document.activeElement !== el) { try { el.focus(); if (keep.s != null) el.setSelectionRange(keep.s, keep.s); } catch (e) {} }
            }
        } finally { syncing = false; }
    }
    let timer = 0;
    function scheduleSync() { clearTimeout(timer); timer = setTimeout(syncAll, 30); }
    window.paSyncAll = syncAll;
    window.paScheduleSync = scheduleSync;

    /* طابور العمليات */
    const orig = window.commitDatabaseMutation;
    let chain = Promise.resolve();
    let depth = 0;
    window.commitDatabaseMutation = function (mutator, options) {
        if (depth > 0) return orig(mutator, options); /* استدعاء داخلي متداخل: السلوك الأصلي */
        const wrapped = async () => { depth++; try { return await mutator(); } finally { depth--; } };
        const run = () => orig(wrapped, options);
        const p = chain.then(run, run);
        chain = p.catch(() => {});
        return p.then(res => { if (res !== null && res !== undefined) scheduleSync(); return res; });
    };

    /* تحديث الشاشة عند الدخول إليها */
    const origSwitch = window.switchTab;
    window.switchTab = function (tab) {
        const r = origSwitch.apply(this, arguments);
        if (r !== false) {
            const key = tab === 'purchases' ? 'purchases' : tab;
            RENDERERS.common.slice(0, 3).forEach(call);
            (RENDERERS[key] || []).forEach(call);
        }
        return r;
    };

    /* عند العودة للتطبيق أو تغيّر البيانات من نافذة أخرى على الحاسوب */
    document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleSync(); });
    window.addEventListener('pa-data-changed', scheduleSync);
})();
