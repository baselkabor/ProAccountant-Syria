/* ===== reports-pro.js — حركة الشركة والأرباح + تقارير دقيقة + كشف حساب مفصل =====
   يعتمد على db و PA_CORE ودوال الطباعة الموحدة في app.js (paDocHeader / triggerPrint). */
(function () {
    const esc = s => PA_CORE.escapeHtml(s == null ? '' : s);
    const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
    const money = v => (r2(v) < 0 ? '-$' : '$') + Math.abs(r2(v)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const qtyFmt = v => Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 3 });
    const pct = v => '<bdi dir="ltr">' + (Number.isFinite(v) ? (v * 100).toFixed(1) : '0.0') + '%</bdi>';
    const today = () => PA_CORE.getLocalDateString();
    const shiftDays = (d, n) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return PA_CORE.getLocalDateString(x); };
    const tsOf = rec => { const m = String(rec && rec.id || '').match(/(\d{10,})/); return m ? Number(m[1]) : 0; };
    const accName = id => { const a = db.accounts.find(x => x.id === id); return a ? a.name : '-'; };
    const payLabel = t => t === 'cash' ? 'نقدي' : (t === 'installment' ? 'تقسيط' : 'آجل');

    /* ================= الفترة الزمنية ================= */
    const period = { key: 'month', from: '', to: '' };
    function resolvePeriod() {
        const t = today();
        switch (period.key) {
            case 'today': return { from: t, to: t, label: 'اليوم ' + t };
            case 'week': return { from: shiftDays(t, -6), to: t, label: 'آخر 7 أيام' };
            case 'month': return { from: t.slice(0, 7) + '-01', to: t, label: 'الشهر الحالي ' + t.slice(0, 7) };
            case 'year': return { from: t.slice(0, 4) + '-01-01', to: t, label: 'السنة الحالية ' + t.slice(0, 4) };
            case 'custom': return { from: period.from || '', to: period.to || '', label: `من ${period.from || 'البداية'} إلى ${period.to || 'اليوم'}` };
            default: return { from: '', to: '', label: 'كل الفترات' };
        }
    }
    const inRange = (d, rg) => !!d && (!rg.from || d >= rg.from) && (!rg.to || d <= rg.to);

    /* ================= محرك الحسابات ================= */
    function lineNetUSD(inv, line) {
        const lines = inv.items || [];
        const sum = lines.reduce((t, l) => t + (Number(l.subOrig) || 0), 0);
        const share = sum > 0 ? (Number(line.subOrig) || 0) / sum : 1 / Math.max(1, lines.length);
        return (Number(inv.totalUSD) || 0) * share;
    }
    function lineCostUSD(line) {
        const item = db.items.find(i => i.id === line.itemId);
        return (Number(line.costUSD ?? (item ? item.cost : 0)) || 0) * (Number(line.qty) || 0);
    }
    function returnCostUSD(r) {
        const inv = db.invoices.find(i => i.id === r.invoiceId);
        const line = inv && (inv.items || []).find(l => l.itemId === r.itemId);
        const item = db.items.find(i => i.id === r.itemId);
        return (Number(r.costUSD ?? line?.costUSD ?? item?.cost ?? 0) || 0) * (Number(r.qty) || 0);
    }

    function computePnL(rg) {
        const o = { grossSales: 0, salesReturns: 0, cogs: 0, purchases: 0, purchaseReturns: 0, otherRevenue: 0, expenses: 0,
            salesCount: 0, purchasesCount: 0, cashSales: 0, creditSales: 0, installmentSales: 0, receipts: 0, payments: 0,
            expensesByTitle: {}, days: {}, items: {}, customers: {} };
        const day = d => (o.days[d] = o.days[d] || { sales: 0, cogs: 0, returns: 0, expenses: 0, revenue: 0, count: 0 });
        const itm = (id, name) => (o.items[id] = o.items[id] || { name, qty: 0, retQty: 0, revenue: 0, cost: 0 });
        const cus = id => (o.customers[id] = o.customers[id] || { revenue: 0, cost: 0, count: 0 });
        (db.invoices || []).forEach(inv => {
            if (!inRange(inv.date, rg)) return;
            const total = Number(inv.totalUSD) || 0;
            if (inv.type === 'sales') {
                o.grossSales += total; o.salesCount++;
                if (inv.paymentType === 'cash') o.cashSales += total; else if (inv.paymentType === 'installment') o.installmentSales += total; else o.creditSales += total;
                const d = day(inv.date); d.sales += total; d.count++;
                const c = cus(inv.accountId); c.revenue += total; c.count++;
                (inv.items || []).forEach(line => {
                    const cost = lineCostUSD(line); const net = lineNetUSD(inv, line);
                    o.cogs += cost; d.cogs += cost; c.cost += cost;
                    const it = itm(line.itemId || line.itemName, line.itemName); it.qty += Number(line.qty) || 0; it.revenue += net; it.cost += cost;
                });
            } else {
                o.purchases += total; o.purchasesCount++;
            }
        });
        (db.returns || []).forEach(r => {
            if (!inRange(r.date, rg)) return;
            const amt = Number(r.totalUSD) || 0;
            if (r.type === 'sales_return') {
                const cost = returnCostUSD(r);
                o.salesReturns += amt; o.cogs -= cost;
                const d = day(r.date); d.returns += amt; d.cogs -= cost;
                const inv = db.invoices.find(i => i.id === r.invoiceId);
                const c = cus(r.accountId || (inv && inv.accountId)); c.revenue -= amt; c.cost -= cost;
                const it = itm(r.itemId || r.itemName, r.itemName); it.retQty += Number(r.qty) || 0; it.revenue -= amt; it.cost -= cost;
            } else {
                o.purchaseReturns += amt;
            }
        });
        (db.expenses || []).forEach(e => {
            if (!inRange(e.date, rg)) return;
            const amt = Number(e.amountUSD) || 0;
            if (e.kind === 'revenue') { o.otherRevenue += amt; day(e.date).revenue += amt; }
            else { o.expenses += amt; day(e.date).expenses += amt; o.expensesByTitle[e.title || 'مصروف عام'] = (o.expensesByTitle[e.title || 'مصروف عام'] || 0) + amt; }
        });
        (db.vouchers || []).forEach(v => {
            if (!inRange(v.date, rg)) return;
            if (v.type === 'receipt') o.receipts += Number(v.amountUSD) || 0; else o.payments += Number(v.amountUSD) || 0;
        });
        o.netSales = o.grossSales - o.salesReturns;
        o.grossProfit = o.netSales - o.cogs;
        o.grossMargin = o.netSales > 0 ? o.grossProfit / o.netSales : 0;
        o.netProfit = o.grossProfit + o.otherRevenue - o.expenses;
        o.netMargin = o.netSales > 0 ? o.netProfit / o.netSales : 0;
        o.netPurchases = o.purchases - o.purchaseReturns;
        return o;
    }

    function snapshotBalances() {
        let receivables = 0, payables = 0, cash = 0, inventory = 0;
        db.accounts.forEach(a => {
            const b = calculateAccountBalanceUSD(a.id);
            if (b > 0) receivables += b; else payables += -b;
        });
        (db.cashboxes || []).forEach(c => { cash += calculateCashboxBalanceUSD(c.id); });
        db.items.forEach(i => { if (i.type === 'stock') inventory += Math.max(0, Number(i.qty) || 0) * (Number(i.cost) || 0); });
        return { receivables, payables, cash, inventory };
    }

    /* ================= واجهة حركة الشركة والأرباح ================= */
    const PERIODS = [['today', 'اليوم'], ['week', '7 أيام'], ['month', 'هذا الشهر'], ['year', 'هذه السنة'], ['all', 'الكل'], ['custom', 'مخصص']];
    function periodBar(prefix, onchange) {
        return `<div class="pa-period" data-prefix="${prefix}">
            <div class="pa-chips">${PERIODS.map(([k, l]) => `<button type="button" class="pa-chip ${period.key === k ? 'on' : ''}" onclick="paSetPeriod('${k}','${onchange}')">${l}</button>`).join('')}</div>
            <div class="pa-range ${period.key === 'custom' ? '' : 'hidden'}">
                <label>من <input type="date" class="amin-input" value="${esc(period.from)}" onchange="paSetRange('from',this.value,'${onchange}')"></label>
                <label>إلى <input type="date" class="amin-input" value="${esc(period.to)}" onchange="paSetRange('to',this.value,'${onchange}')"></label>
            </div></div>`;
    }
    window.paSetPeriod = (k, cb) => { period.key = k; if (k === 'custom' && !period.to) period.to = today(); (window[cb] || renderProfitAndReportsHub)(); };
    window.paSetRange = (which, v, cb) => { period[which] = v; period.key = 'custom'; (window[cb] || renderProfitAndReportsHub)(); };

    function kpi(title, value, tone, sub) {
        return `<div class="pa-kpi tone-${tone}"><div class="t">${title}</div><div class="v" dir="ltr">${value}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
    }

    window.renderProfitAndReportsHub = function () {
        ensureExtendedStores();
        const host = document.getElementById('profit-dashboard');
        if (!host) return;
        const rg = resolvePeriod();
        const p = computePnL(rg);
        const b = snapshotBalances();
        const days = Object.keys(p.days).sort().reverse();
        const topItems = Object.values(p.items).map(x => ({ ...x, profit: x.revenue - x.cost })).sort((a, c) => c.profit - a.profit).slice(0, 8);
        const maxDay = Math.max(1, ...days.map(d => p.days[d].sales));
        host.innerHTML = `
            <div class="pa-dash-head">
                <div><h2>📈 حركة الشركة والأرباح</h2><p>${esc(rg.label)} — ${p.salesCount} فاتورة مبيعات، ${p.purchasesCount} فاتورة مشتريات</p></div>
                <button type="button" class="pa-btn-primary" onclick="printProfitReport()">🖨️ تقرير الأرباح والخسائر</button>
            </div>
            ${periodBar('prof', 'renderProfitAndReportsHub')}
            <div class="pa-kpis">
                ${kpi('صافي المبيعات', money(p.netSales), 'green', `إجمالي: ${money(p.grossSales)} | مرتجع: ${money(p.salesReturns)}`)}
                ${kpi('مجمل الربح', money(p.grossProfit), p.grossProfit >= 0 ? 'green' : 'red', `هامش: ${pct(p.grossMargin)}`)}
                ${kpi('صافي الربح', money(p.netProfit), p.netProfit >= 0 ? 'blue' : 'red', `هامش صافي: ${pct(p.netMargin)}`)}
                ${kpi('المصروفات', money(p.expenses), 'red', `إيرادات أخرى: ${money(p.otherRevenue)}`)}
                ${kpi('صافي المشتريات', money(p.netPurchases), 'slate', `مرتجع مشتريات: ${money(p.purchaseReturns)}`)}
                ${kpi('النقد في الصناديق', money(b.cash), 'blue', 'الرصيد الحالي')}
                ${kpi('ذمم لنا (العملاء)', money(b.receivables), 'amber', `ذمم علينا: ${money(b.payables)}`)}
                ${kpi('قيمة المخزون بالتكلفة', money(b.inventory), 'slate', 'الرصيد الحالي')}
            </div>
            <div class="pa-dash-grid">
                <div class="pa-card">
                    <h3>⚖️ قائمة الدخل</h3>
                    <table class="pa-pnl">
                        <tr><td>إجمالي المبيعات</td><td dir="ltr">${money(p.grossSales)}</td></tr>
                        <tr><td>(−) مرتجعات المبيعات</td><td dir="ltr">${money(p.salesReturns)}</td></tr>
                        <tr class="sub"><td>صافي المبيعات</td><td dir="ltr">${money(p.netSales)}</td></tr>
                        <tr><td>(−) تكلفة البضاعة المباعة</td><td dir="ltr">${money(p.cogs)}</td></tr>
                        <tr class="sub"><td>مجمل الربح</td><td dir="ltr">${money(p.grossProfit)}</td></tr>
                        <tr><td>(+) إيرادات أخرى</td><td dir="ltr">${money(p.otherRevenue)}</td></tr>
                        <tr><td>(−) المصروفات</td><td dir="ltr">${money(p.expenses)}</td></tr>
                        <tr class="total ${p.netProfit >= 0 ? 'pos' : 'neg'}"><td>صافي الربح / الخسارة</td><td dir="ltr">${money(p.netProfit)}</td></tr>
                    </table>
                </div>
                <div class="pa-card">
                    <h3>💵 حركة النقد والتحصيل</h3>
                    <table class="pa-pnl">
                        <tr><td>مبيعات نقدية</td><td dir="ltr">${money(p.cashSales)}</td></tr>
                        <tr><td>مبيعات آجلة</td><td dir="ltr">${money(p.creditSales)}</td></tr>
                        <tr><td>مبيعات تقسيط</td><td dir="ltr">${money(p.installmentSales)}</td></tr>
                        <tr><td>سندات القبض</td><td dir="ltr">${money(p.receipts)}</td></tr>
                        <tr><td>سندات الدفع</td><td dir="ltr">${money(p.payments)}</td></tr>
                        <tr class="sub"><td>صافي النقد الداخل (نقدي + قبض − دفع − مصروف)</td><td dir="ltr">${money(p.cashSales + p.receipts - p.payments - p.expenses + p.otherRevenue)}</td></tr>
                    </table>
                </div>
            </div>
            <div class="pa-card">
                <h3>📅 الحركة اليومية</h3>
                <div class="overflow-x-auto"><table class="pa-table">
                    <thead><tr><th>التاريخ</th><th>فواتير</th><th>المبيعات</th><th>مرتجع</th><th>التكلفة</th><th>مصروف</th><th>صافي الربح</th><th></th></tr></thead>
                    <tbody>${days.map(d => { const x = p.days[d]; const np = x.sales - x.returns - x.cogs + x.revenue - x.expenses;
                        return `<tr><td dir="ltr">${d}</td><td>${x.count}</td><td dir="ltr">${money(x.sales)}</td><td dir="ltr">${money(x.returns)}</td><td dir="ltr">${money(x.cogs)}</td><td dir="ltr">${money(x.expenses)}</td><td dir="ltr" class="${np >= 0 ? 'pos' : 'neg'}">${money(np)}</td><td class="bar"><i style="width:${Math.round(x.sales / maxDay * 100)}%"></i></td></tr>`; }).join('') || '<tr><td colspan="8" class="empty">لا توجد حركات في هذه الفترة</td></tr>'}</tbody>
                </table></div>
            </div>
            <div class="pa-card">
                <h3>🏆 الأصناف الأكثر ربحاً</h3>
                <div class="overflow-x-auto"><table class="pa-table">
                    <thead><tr><th>الصنف</th><th>الكمية</th><th>الإيراد</th><th>التكلفة</th><th>الربح</th><th>الهامش</th></tr></thead>
                    <tbody>${topItems.map(x => `<tr><td>${esc(x.name)}</td><td dir="ltr">${qtyFmt(x.qty - x.retQty)}</td><td dir="ltr">${money(x.revenue)}</td><td dir="ltr">${money(x.cost)}</td><td dir="ltr" class="${x.profit >= 0 ? 'pos' : 'neg'}">${money(x.profit)}</td><td dir="ltr">${pct(x.revenue > 0 ? x.profit / x.revenue : 0)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">لا توجد مبيعات في هذه الفترة</td></tr>'}</tbody>
                </table></div>
            </div>`;
        openComprehensiveReport(window.currentCompReportKey || 'pnl');
    };

    window.printProfitReport = function () {
        const rg = resolvePeriod();
        const p = computePnL(rg);
        const b = snapshotBalances();
        const exp = Object.entries(p.expensesByTitle).sort((a, c) => c[1] - a[1]);
        const html = docWrap('تقرير الأرباح والخسائر', rg.label, `
            <div class="pa-rkpis">
                <div><span>صافي المبيعات</span><b dir="ltr">${money(p.netSales)}</b></div>
                <div><span>مجمل الربح</span><b dir="ltr">${money(p.grossProfit)}</b><small>${pct(p.grossMargin)}</small></div>
                <div><span>صافي الربح</span><b dir="ltr">${money(p.netProfit)}</b><small>${pct(p.netMargin)}</small></div>
                <div><span>النقد في الصناديق</span><b dir="ltr">${money(b.cash)}</b></div>
            </div>
            <table class="pa-invoice-table pa-rtable"><thead><tr><th>البند</th><th>المبلغ</th></tr></thead><tbody>
                <tr><td>إجمالي المبيعات (${p.salesCount} فاتورة)</td><td dir="ltr">${money(p.grossSales)}</td></tr>
                <tr><td>(−) مرتجعات المبيعات</td><td dir="ltr">${money(p.salesReturns)}</td></tr>
                <tr class="pa-rsub"><td>صافي المبيعات</td><td dir="ltr">${money(p.netSales)}</td></tr>
                <tr><td>(−) تكلفة البضاعة المباعة</td><td dir="ltr">${money(p.cogs)}</td></tr>
                <tr class="pa-rsub"><td>مجمل الربح</td><td dir="ltr">${money(p.grossProfit)}</td></tr>
                <tr><td>(+) إيرادات أخرى</td><td dir="ltr">${money(p.otherRevenue)}</td></tr>
                ${exp.map(([t, v]) => `<tr><td>(−) مصروف: ${esc(t)}</td><td dir="ltr">${money(v)}</td></tr>`).join('') || `<tr><td>(−) المصروفات</td><td dir="ltr">${money(0)}</td></tr>`}
                <tr class="pa-rtotal"><td>صافي الربح / الخسارة</td><td dir="ltr">${money(p.netProfit)}</td></tr>
            </tbody></table>
            <table class="pa-invoice-table pa-rtable"><thead><tr><th>مؤشرات أخرى</th><th>القيمة</th></tr></thead><tbody>
                <tr><td>صافي المشتريات (بعد المرتجع)</td><td dir="ltr">${money(p.netPurchases)}</td></tr>
                <tr><td>مبيعات نقدية / آجلة / تقسيط</td><td dir="ltr">${money(p.cashSales)} / ${money(p.creditSales)} / ${money(p.installmentSales)}</td></tr>
                <tr><td>سندات قبض / دفع</td><td dir="ltr">${money(p.receipts)} / ${money(p.payments)}</td></tr>
                <tr><td>ذمم لنا / ذمم علينا (حالياً)</td><td dir="ltr">${money(b.receivables)} / ${money(b.payables)}</td></tr>
                <tr><td>قيمة المخزون بالتكلفة (حالياً)</td><td dir="ltr">${money(b.inventory)}</td></tr>
            </tbody></table>`);
        triggerPrint(html, 'a4', { title: 'تقرير الأرباح والخسائر', fileName: `PnL_${Date.now()}.pdf`, kind: 'report' });
    };

    /* ================= التقارير الشاملة ================= */
    function docWrap(title, subtitle, body) {
        return `<article class="pa-invoice pa-rdoc ${paDocClasses()}" ${paAccentStyle()}>
            ${paDocHeader()}
            <div class="pa-invoice-banner is-sales"><span>${esc(title)}</span><span>${esc(subtitle)}</span></div>
            <div class="pa-rmeta">تاريخ الطباعة: <bdi dir="ltr">${today()}</bdi> — جميع المبالغ بالدولار الأمريكي، المعادل بالليرة حسب سعر الصرف ${Number(db.settings.exchangeRate || 0).toLocaleString('en-US')}</div>
            ${body}
            ${paDocFooter()}
        </article>`;
    }

    const REPORTS = {
        items_sales: 'مبيعات وأرباح الأصناف',
        item_move: 'حركة الأصناف والمخزون',
        customers_move: 'حركة العملاء',
        customer_profit: 'أرباح العملاء',
        suppliers_move: 'حركة الموردين',
        supplier_purchases: 'مشتريات الموردين',
        workers_move: 'الموظفون والرواتب',
        remaining_installments: 'الأقساط المتبقية',
        pnl: 'الأرباح والخسائر',
        all_expenses: 'المصروفات والإيرادات الأخرى'
    };

    function accountMovement(acc, rg) {
        const s = { opening: Number(acc.openingBalance) || 0, inv: 0, cashInv: 0, ret: 0, rcv: 0, pay: 0, count: 0, last: '' };
        const before = rg.from ? d => d < rg.from : () => false;
        const isSup = acc.type === 'supplier';
        db.invoices.filter(i => i.accountId === acc.id).forEach(i => {
            const sign = i.type === 'sales' ? 1 : -1; const credit = i.paymentType !== 'cash';
            if (before(i.date)) { if (credit) s.opening += sign * i.totalUSD; return; }
            if (!inRange(i.date, rg)) return;
            s.count++; s.last = i.date > s.last ? i.date : s.last;
            if (credit) s.inv += Number(i.totalUSD) || 0; else s.cashInv += Number(i.totalUSD) || 0;
        });
        db.vouchers.filter(v => v.accountId === acc.id).forEach(v => {
            const amt = Number(v.amountUSD) || 0;
            if (before(v.date)) { s.opening += v.type === 'receipt' ? -amt : amt; return; }
            if (!inRange(v.date, rg)) return;
            if (v.type === 'receipt') s.rcv += amt; else s.pay += amt;
        });
        (db.returns || []).filter(r => r.accountId === acc.id && !PA_CORE.isSettledReturn(r, db.invoices)).forEach(r => {
            const amt = Number(r.totalUSD) || 0; const sign = r.type === 'sales_return' ? -1 : 1;
            if (before(r.date)) { s.opening += sign * amt; return; }
            if (!inRange(r.date, rg)) return;
            s.ret += amt;
        });
        s.isSup = isSup;
        return s;
    }

    function buildReport(key) {
        const rg = resolvePeriod();
        const R = { title: REPORTS[key] || 'تقرير', cols: [], rows: [], foot: null, note: '' };
        if (key === 'items_sales') {
            const p = computePnL(rg);
            R.cols = ['الصنف', 'الكمية المباعة', 'المرتجع', 'صافي الكمية', 'الإيراد', 'التكلفة', 'الربح', 'الهامش'];
            let T = [0, 0, 0, 0, 0];
            Object.values(p.items).sort((a, c) => c.revenue - a.revenue).forEach(x => {
                const profit = x.revenue - x.cost;
                T = [T[0] + x.qty, T[1] + x.retQty, T[2] + x.revenue, T[3] + x.cost, T[4] + profit];
                R.rows.push([esc(x.name), qtyFmt(x.qty), qtyFmt(x.retQty), qtyFmt(x.qty - x.retQty), money(x.revenue), money(x.cost), money(profit), pct(x.revenue > 0 ? profit / x.revenue : 0)]);
            });
            R.foot = ['الإجمالي', qtyFmt(T[0]), qtyFmt(T[1]), qtyFmt(T[0] - T[1]), money(T[2]), money(T[3]), money(T[4]), pct(T[2] > 0 ? T[4] / T[2] : 0)];
        } else if (key === 'item_move') {
            R.cols = ['الصنف', 'شراء', 'مرتجع شراء', 'بيع', 'مرتجع بيع', 'الرصيد الحالي', 'التكلفة', 'قيمة المخزون'];
            let totalVal = 0;
            db.items.forEach(item => {
                const m = { b: 0, br: 0, s: 0, sr: 0 };
                db.invoices.forEach(i => { if (!inRange(i.date, rg)) return; (i.items || []).forEach(l => { if (l.itemId !== item.id) return; if (i.type === 'sales') m.s += Number(l.qty) || 0; else m.b += Number(l.qty) || 0; }); });
                (db.returns || []).forEach(r => { if (r.itemId !== item.id || !inRange(r.date, rg)) return; if (r.type === 'sales_return') m.sr += Number(r.qty) || 0; else m.br += Number(r.qty) || 0; });
                const stock = item.type === 'stock' ? Number(item.qty) || 0 : 0;
                const val = Math.max(0, stock) * (Number(item.cost) || 0); totalVal += val;
                R.rows.push([esc(item.name) + (item.type !== 'stock' ? ' <small>(خدمة)</small>' : ''), qtyFmt(m.b), qtyFmt(m.br), qtyFmt(m.s), qtyFmt(m.sr), item.type === 'stock' ? qtyFmt(stock) + (stock <= Number(item.minQty || 0) ? ' ⚠️' : '') : '—', money(item.cost), money(val)]);
            });
            R.foot = ['الإجمالي', '', '', '', '', '', '', money(totalVal)];
            R.note = '⚠️ = الرصيد عند حد التنبيه أو أقل.';
        } else if (key === 'customers_move' || key === 'suppliers_move') {
            const sup = key === 'suppliers_move';
            R.cols = sup ? ['المورد', 'رصيد أول المدة', 'مشتريات آجلة', 'مشتريات نقدية', 'مرتجع', 'دفعات', 'مقبوضات', 'الرصيد', 'آخر حركة']
                : ['العميل', 'رصيد أول المدة', 'مبيعات آجلة', 'مبيعات نقدية', 'مرتجع', 'مقبوضات', 'مدفوعات', 'الرصيد', 'آخر حركة'];
            const T = [0, 0, 0, 0, 0, 0, 0];
            db.accounts.filter(a => a.id !== 'acc_cash_client' && (sup ? a.type !== 'customer' : a.type !== 'supplier')).forEach(a => {
                const m = accountMovement(a, rg);
                const bal = calculateBalanceAt(a, rg.to);
                const vals = sup ? [m.opening, m.inv, m.cashInv, m.ret, m.pay, m.rcv, bal] : [m.opening, m.inv, m.cashInv, m.ret, m.rcv, m.pay, bal];
                vals.forEach((v, i) => { T[i] += v; });
                R.rows.push([esc(a.name), ...vals.map((v, i) => i === 0 || i === 6 ? balTxt(v) : money(v)), m.last || '-']);
            });
            R.foot = ['الإجمالي', balTxt(T[0]), money(T[1]), money(T[2]), money(T[3]), money(T[4]), money(T[5]), balTxt(T[6]), ''];
            R.note = 'الرصيد الموجب = ذمة على الحساب (لنا)، والسالب = له (علينا).';
        } else if (key === 'customer_profit') {
            const p = computePnL(rg);
            R.cols = ['العميل', 'عدد الفواتير', 'صافي المبيعات', 'التكلفة', 'الربح', 'الهامش'];
            const T = [0, 0, 0, 0];
            Object.entries(p.customers).sort((a, c) => (c[1].revenue - c[1].cost) - (a[1].revenue - a[1].cost)).forEach(([id, x]) => {
                const pr = x.revenue - x.cost; T[0] += x.count; T[1] += x.revenue; T[2] += x.cost; T[3] += pr;
                R.rows.push([esc(accName(id)), x.count, money(x.revenue), money(x.cost), money(pr), pct(x.revenue > 0 ? pr / x.revenue : 0)]);
            });
            R.foot = ['الإجمالي', T[0], money(T[1]), money(T[2]), money(T[3]), pct(T[1] > 0 ? T[3] / T[1] : 0)];
        } else if (key === 'supplier_purchases') {
            R.cols = ['المورد', 'عدد الفواتير', 'إجمالي المشتريات', 'مرتجع', 'صافي المشتريات', 'المدفوع', 'الرصيد الحالي'];
            const T = [0, 0, 0, 0, 0];
            db.accounts.filter(a => a.type !== 'customer' && a.id !== 'acc_cash_client').forEach(a => {
                const invs = db.invoices.filter(i => i.type === 'purchase' && i.accountId === a.id && inRange(i.date, rg));
                const tot = invs.reduce((t, i) => t + (Number(i.totalUSD) || 0), 0);
                const ret = (db.returns || []).filter(r => r.type === 'purchase_return' && r.accountId === a.id && inRange(r.date, rg)).reduce((t, r) => t + (Number(r.totalUSD) || 0), 0);
                const paid = db.vouchers.filter(v => v.type === 'payment' && v.accountId === a.id && inRange(v.date, rg)).reduce((t, v) => t + (Number(v.amountUSD) || 0), 0)
                    + invs.filter(i => i.paymentType === 'cash').reduce((t, i) => t + (Number(i.totalUSD) || 0), 0);
                T[0] += invs.length; T[1] += tot; T[2] += ret; T[3] += tot - ret; T[4] += paid;
                R.rows.push([esc(a.name), invs.length, money(tot), money(ret), money(tot - ret), money(paid), balTxt(calculateAccountBalanceUSD(a.id))]);
            });
            R.foot = ['الإجمالي', T[0], money(T[1]), money(T[2]), money(T[3]), money(T[4]), ''];
        } else if (key === 'workers_move') {
            R.cols = ['الموظف', 'الوظيفة', 'الراتب الشهري', 'رواتب مسجلة كمصروف في الفترة'];
            let T = 0, P = 0;
            (db.employees || []).forEach(e => {
                const paid = (db.expenses || []).filter(x => x.kind !== 'revenue' && inRange(x.date, rg) && String(x.title || '').includes(e.name)).reduce((t, x) => t + (Number(x.amountUSD) || 0), 0);
                T += Number(e.salary) || 0; P += paid;
                R.rows.push([esc(e.name), esc(e.role || '-'), money(e.salary), money(paid)]);
            });
            R.foot = ['الإجمالي', '', money(T), money(P)];
            R.note = 'تُحتسب الرواتب المدفوعة من المصروفات التي يحتوي عنوانها على اسم الموظف.';
        } else if (key === 'remaining_installments') {
            R.cols = ['العميل', 'الفاتورة', 'القسط', 'الاستحقاق', 'المبلغ', 'الحالة'];
            const t = today(); let T = 0, O = 0;
            (db.installments || []).filter(x => !x.paid && !x.cancelledByReturn && Number(x.amountUSD) > 0)
                .sort((a, c) => String(a.dueDate).localeCompare(String(c.dueDate))).forEach(x => {
                    const overdue = x.dueDate < t; T += Number(x.amountUSD) || 0; if (overdue) O += Number(x.amountUSD) || 0;
                    R.rows.push([esc(x.accountName || accName(x.accountId)), esc(x.invoiceNumber || '-'), `${x.installmentNo || '-'}/${x.totalInstallments || '-'}`, x.dueDate, money(x.amountUSD), overdue ? '<b class="neg">متأخر</b>' : 'قادم']);
                });
            R.foot = ['الإجمالي', '', '', '', money(T), 'متأخر: ' + money(O)];
        } else if (key === 'all_expenses') {
            R.cols = ['التاريخ', 'النوع', 'البيان', 'الصندوق', 'المبلغ'];
            let E = 0, V = 0;
            (db.expenses || []).filter(x => inRange(x.date, rg)).sort((a, c) => String(c.date).localeCompare(String(a.date))).forEach(x => {
                const cb = (db.cashboxes || []).find(c => c.id === x.cashboxId);
                if (x.kind === 'revenue') V += Number(x.amountUSD) || 0; else E += Number(x.amountUSD) || 0;
                R.rows.push([x.date, x.kind === 'revenue' ? 'إيراد' : 'مصروف', esc(x.title), esc(cb ? cb.name : '-'), money(x.amountUSD)]);
            });
            R.foot = ['', '', `مصروفات ${money(E)} — إيرادات ${money(V)}`, 'الصافي', money(V - E)];
        } else {
            const p = computePnL(rg);
            R.cols = ['البند', 'المبلغ'];
            R.rows = [['إجمالي المبيعات', money(p.grossSales)], ['(−) مرتجعات المبيعات', money(p.salesReturns)], ['صافي المبيعات', money(p.netSales)],
                ['(−) تكلفة البضاعة المباعة', money(p.cogs)], ['مجمل الربح', money(p.grossProfit) + ` (${pct(p.grossMargin)})`], ['(+) إيرادات أخرى', money(p.otherRevenue)], ['(−) المصروفات', money(p.expenses)]];
            R.foot = ['صافي الربح / الخسارة', money(p.netProfit) + ` (${pct(p.netMargin)})`];
        }
        R.period = rg.label;
        return R;
    }
    function balTxt(v) { const x = r2(v); return x === 0 ? '$0.00' : `${money(Math.abs(x))} ${x > 0 ? 'عليه' : 'له'}`; }
    function calculateBalanceAt(acc, to) {
        if (!to || to >= today()) return calculateAccountBalanceUSD(acc.id);
        const rows = statementEvents(acc.id).filter(e => e.date <= to);
        return rows.reduce((t, e) => t + e.debit - e.credit, 0);
    }

    window.openComprehensiveReport = function (key) {
        window.currentCompReportKey = key;
        try { currentCompReportKey = key; } catch (e) {}
        const titleEl = document.getElementById('comp-report-title');
        const bodyEl = document.getElementById('comp-report-body');
        if (!titleEl || !bodyEl) return;
        const R = buildReport(key);
        titleEl.textContent = `${R.title} — ${R.period}`;
        document.querySelectorAll('[data-report-key]').forEach(b => b.classList.toggle('on', b.getAttribute('data-report-key') === key));
        bodyEl.innerHTML = `<table class="pa-table"><thead><tr>${R.cols.map(c => `<th>${c}</th>`).join('')}</tr></thead>
            <tbody>${R.rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${R.cols.length}" class="empty">لا توجد بيانات في هذه الفترة</td></tr>`}</tbody>
            ${R.foot ? `<tfoot><tr>${R.foot.map(c => `<td>${c}</td>`).join('')}</tr></tfoot>` : ''}</table>${R.note ? `<p class="pa-note">${R.note}</p>` : ''}`;
    };

    window.printComprehensiveReport = function () {
        const key = window.currentCompReportKey || 'pnl';
        const R = buildReport(key);
        const many = R.cols.length >= 8;
        const body = `<table class="pa-invoice-table pa-rtable ${many ? 'pa-rdense' : ''}"><thead><tr>${R.cols.map(c => `<th>${c}</th>`).join('')}</tr></thead>
            <tbody>${R.rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${R.cols.length}">لا توجد بيانات في هذه الفترة</td></tr>`}</tbody>
            ${R.foot ? `<tfoot><tr class="pa-rtotal">${R.foot.map(c => `<td>${c}</td>`).join('')}</tr></tfoot>` : ''}</table>${R.note ? `<p class="pa-rmeta">${R.note}</p>` : ''}`;
        triggerPrint(docWrap(R.title, R.period, body), 'a4', { title: R.title, fileName: `Report_${key}_${Date.now()}.pdf`, kind: 'report' });
    };

    /* ================= كشف الحساب الدقيق والمفصل ================= */
    function statementEvents(accountId) {
        const acc = db.accounts.find(a => a.id === accountId);
        if (!acc) return [];
        const ev = [];
        db.invoices.filter(i => i.accountId === accountId).forEach(inv => {
            const sale = inv.type === 'sales'; const total = Number(inv.totalUSD) || 0; const cash = inv.paymentType === 'cash';
            ev.push({ date: inv.date, ts: tsOf(inv), ord: 1, ref: inv.number, kind: sale ? 'فاتورة مبيعات' : 'فاتورة مشتريات',
                desc: `${sale ? 'فاتورة مبيعات' : 'فاتورة مشتريات'} (${payLabel(inv.paymentType)})${inv.currency === 'SYP' ? ` — ${Number(inv.totalSYP || 0).toLocaleString('en-US')} ل.س` : ''}`,
                debit: sale ? total : (cash ? total : 0), credit: sale ? (cash ? total : 0) : total, inv });
        });
        db.vouchers.filter(v => v.accountId === accountId).forEach(v => {
            const amt = Number(v.amountUSD) || 0;
            const method = PA_CORE.isCashPayment(v) ? 'نقدي' : (v.payMethod === 'card_check' ? 'بطاقة/شيك' : 'تحويل بنكي');
            ev.push({ date: v.date, ts: tsOf(v), ord: 2, ref: v.number, kind: v.type === 'receipt' ? 'سند قبض' : 'سند دفع',
                desc: `${v.type === 'receipt' ? 'سند قبض' : 'سند دفع'} ${method}${v.currency === 'SYP' ? ` (${Number(v.origAmount || 0).toLocaleString('en-US')} ل.س)` : ''}${v.note ? ' — ' + v.note : ''}`,
                debit: v.type === 'payment' ? amt : 0, credit: v.type === 'receipt' ? amt : 0 });
        });
        (db.returns || []).filter(r => r.accountId === accountId && !PA_CORE.isSettledReturn(r, db.invoices)).forEach(r => {
            const amt = Number(r.totalUSD) || 0;
            ev.push({ date: r.date, ts: tsOf(r), ord: 3, ref: r.number, kind: r.type === 'sales_return' ? 'مرتجع مبيعات' : 'مرتجع مشتريات',
                desc: `${r.type === 'sales_return' ? 'مرتجع مبيعات' : 'مرتجع مشتريات'}: ${r.itemName} × ${qtyFmt(r.qty)} (فاتورة ${r.invoiceNumber || '-'})${r.note ? ' — ' + r.note : ''}`,
                debit: r.type === 'purchase_return' ? amt : 0, credit: r.type === 'sales_return' ? amt : 0 });
        });
        ev.sort((a, c) => String(a.date).localeCompare(String(c.date)) || (a.ts - c.ts) || (a.ord - c.ord));
        return ev;
    }

    function statementData(accountId) {
        const acc = db.accounts.find(a => a.id === accountId);
        if (!acc) return null;
        const from = document.getElementById('stmt-from')?.value || '';
        const to = document.getElementById('stmt-to')?.value || '';
        const detailed = !!document.getElementById('stmt-detailed')?.checked;
        let opening = Number(acc.openingBalance) || 0;
        const all = statementEvents(accountId);
        const rows = [];
        all.forEach(e => {
            if (from && e.date < from) { opening += e.debit - e.credit; return; }
            if (to && e.date > to) return;
            rows.push(e);
        });
        let run = opening, D = 0, C = 0;
        rows.forEach(e => { run = r2(run + e.debit - e.credit); e.running = run; D += e.debit; C += e.credit; });
        return { acc, from, to, detailed, opening: r2(opening), rows, debit: r2(D), credit: r2(C), closing: r2(run) };
    }

    function linesHtml(inv) {
        const cur = inv.currency === 'SYP' ? 'ل.س' : '$';
        return (inv.items || []).map(l => `${esc(l.itemName)} × ${qtyFmt(l.qty)} @ ${Number(l.priceOrig || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${cur}`).join('<br>')
            + (Number(inv.discount) > 0 ? `<br>خصم: ${Number(inv.discount).toLocaleString('en-US')} ${cur}` : '');
    }

    window.getAccountStatementRows = function (accountId) {
        const s = statementData(accountId);
        if (!s) return [];
        const out = [];
        if (s.opening !== 0 || s.from) out.push({ date: s.from || '', displayDate: s.from ? s.from : 'افتتاحي', ref: '-', desc: s.from ? 'رصيد سابق (أول المدة)' : 'رصيد افتتاحي', debit: s.opening > 0 ? s.opening : 0, credit: s.opening < 0 ? -s.opening : 0, running: s.opening });
        s.rows.forEach(e => out.push({ ...e, displayDate: e.date }));
        return out;
    };

    window.renderAccountStatement = function () {
        const sel = document.getElementById('statement-account-select');
        const tbody = document.getElementById('statement-table-body');
        if (!sel || !tbody) return;
        const s = statementData(sel.value);
        const sum = document.getElementById('stmt-summary');
        if (!s) { tbody.innerHTML = '<tr><td colspan="6" class="p-4 text-center text-slate-400">اختر حساباً</td></tr>'; if (sum) sum.innerHTML = ''; return; }
        const row = (d, ref, desc, dr, cr, run, extra) => `<tr class="hover:bg-slate-700/30"><td class="p-3 font-mono text-xs">${esc(d)}</td><td class="p-3 font-mono font-bold text-sky-300">${esc(ref)}</td><td class="p-3">${desc}${extra ? `<div class="text-[11px] text-slate-400 mt-1 leading-5">${extra}</div>` : ''}</td><td class="p-3 font-mono text-emerald-400">${dr > 0 ? money(dr) : '—'}</td><td class="p-3 font-mono text-rose-400">${cr > 0 ? money(cr) : '—'}</td><td class="p-3 font-mono font-bold">${balTxt(run)}</td></tr>`;
        let html = row(s.from || '—', '—', s.from ? 'رصيد أول المدة' : 'رصيد افتتاحي', s.opening > 0 ? s.opening : 0, s.opening < 0 ? -s.opening : 0, s.opening);
        html += s.rows.map(e => row(e.date, e.ref, esc(e.desc), e.debit, e.credit, e.running, s.detailed && e.inv ? linesHtml(e.inv) : '')).join('');
        if (!s.rows.length) html += '<tr><td colspan="6" class="p-4 text-center text-slate-400">لا توجد حركات في هذه الفترة</td></tr>';
        tbody.innerHTML = html;
        if (sum) sum.innerHTML = [
            ['رصيد أول المدة', balTxt(s.opening)], ['مجموع المدين', money(s.debit)], ['مجموع الدائن', money(s.credit)], ['الرصيد الختامي', balTxt(s.closing)]
        ].map(([t, v]) => `<div class="pa-kpi tone-slate"><div class="t">${t}</div><div class="v" dir="auto">${v}</div></div>`).join('');
    };

    window.printStatementA4 = function () {
        const sel = document.getElementById('statement-account-select');
        const s = sel && statementData(sel.value);
        if (!s) return showToast('اختر حساباً أولاً', 'error');
        const acc = s.acc;
        const rate = Number(db.settings.exchangeRate || 0);
        const rowsHtml = s.rows.map((e, i) => `<tr><td>${i + 1}</td><td dir="ltr">${esc(e.date)}</td><td>${esc(e.ref)}</td><td>${esc(e.desc)}${s.detailed && e.inv ? `<small class="pa-line-note">${linesHtml(e.inv)}</small>` : ''}</td><td dir="ltr">${e.debit > 0 ? money(e.debit) : '—'}</td><td dir="ltr">${e.credit > 0 ? money(e.credit) : '—'}</td><td>${balTxt(e.running)}</td></tr>`).join('');
        const periodTxt = s.from || s.to ? `من ${s.from || 'البداية'} إلى ${s.to || today()}` : 'كل الحركات';
        const html = `
            <article class="pa-invoice pa-statement ${paDocClasses()}" ${paAccentStyle()}>
                ${paDocHeader()}
                <div class="pa-invoice-banner is-sales"><span>كشف حساب ${s.detailed ? 'مفصل' : 'تفصيلي'}</span><span>${esc(acc.name)}</span></div>
                <div class="pa-invoice-meta">
                    <div>الحساب: <strong>${esc(acc.name)}</strong></div>
                    <div>النوع: ${acc.type === 'supplier' ? 'مورد' : (acc.type === 'both' ? 'زبون ومورد' : 'زبون')}</div>
                    <div>الهاتف: <bdi dir="ltr">${esc(acc.phone || '-')}</bdi>${acc.address ? ` — ${esc(acc.address)}` : ''}</div>
                    <div>الفترة: <strong>${esc(periodTxt)}</strong></div>
                </div>
                <div class="pa-rkpis">
                    <div><span>رصيد أول المدة</span><b>${balTxt(s.opening)}</b></div>
                    <div><span>مجموع المدين</span><b dir="ltr">${money(s.debit)}</b></div>
                    <div><span>مجموع الدائن</span><b dir="ltr">${money(s.credit)}</b></div>
                    <div><span>الرصيد الختامي</span><b>${balTxt(s.closing)}</b></div>
                </div>
                <table class="pa-invoice-table pa-stmt-table">
                    <thead><tr><th>#</th><th>التاريخ</th><th>المرجع</th><th>البيان</th><th>مدين</th><th>دائن</th><th>الرصيد</th></tr></thead>
                    <tbody>
                        <tr class="pa-rsub"><td></td><td dir="ltr">${esc(s.from || '')}</td><td>—</td><td>${s.from ? 'رصيد أول المدة' : 'رصيد افتتاحي'}</td><td dir="ltr">${s.opening > 0 ? money(s.opening) : '—'}</td><td dir="ltr">${s.opening < 0 ? money(-s.opening) : '—'}</td><td>${balTxt(s.opening)}</td></tr>
                        ${rowsHtml || '<tr><td colspan="7">لا توجد حركات في هذه الفترة</td></tr>'}
                    </tbody>
                    <tfoot><tr class="pa-rtotal"><td colspan="4">المجموع</td><td dir="ltr">${money(s.debit)}</td><td dir="ltr">${money(s.credit)}</td><td>${balTxt(s.closing)}</td></tr></tfoot>
                </table>
                <div class="pa-invoice-totals">
                    <div class="pa-invoice-net"><span>الرصيد الختامي ${s.closing > 0 ? '(ذمة على الحساب)' : (s.closing < 0 ? '(رصيد دائن للحساب)' : '(متوازن)')}</span><b dir="ltr">${money(Math.abs(s.closing))}</b></div>
                    <div class="pa-invoice-syp"><span>المعادل بالليرة (سعر ${rate.toLocaleString('en-US')})</span><b dir="auto">${Math.round(Math.abs(s.closing) * rate).toLocaleString('en-US')} ل.س</b></div>
                </div>
                <div class="pa-signatures"><div>توقيع ${acc.type === 'supplier' ? 'المورد' : 'العميل'} بالمطابقة</div><div>توقيع المحاسب</div></div>
                ${paDocFooter()}
            </article>`;
        const safe = String(acc.name).replace(/[^\p{L}\p{N}_-]+/gu, '-');
        triggerPrint(html, 'a4', { title: 'كشف حساب ' + acc.name, fileName: `Statement_${safe}_${Date.now()}.pdf`, kind: 'statement' });
    };
    window.exportStatementPDF = function () { window.printStatementA4(); };

    /* ================= تهيئة الواجهة ================= */
    function setupStatementControls() {
        const sel = document.getElementById('statement-account-select');
        if (!sel || document.getElementById('stmt-from')) return;
        const bar = document.createElement('div');
        bar.className = 'pa-stmt-controls';
        bar.innerHTML = `
            <label>من تاريخ <input type="date" id="stmt-from" class="amin-input" onchange="renderAccountStatement()"></label>
            <label>إلى تاريخ <input type="date" id="stmt-to" class="amin-input" onchange="renderAccountStatement()"></label>
            <label class="chk"><input type="checkbox" id="stmt-detailed" onchange="renderAccountStatement()"> كشف مفصل (بنود الفواتير)</label>
            <div class="quick"><button type="button" onclick="paStmtQuick('month')">هذا الشهر</button><button type="button" onclick="paStmtQuick('year')">هذه السنة</button><button type="button" onclick="paStmtQuick('all')">الكل</button></div>`;
        const header = sel.closest('.flex.flex-wrap.items-center.justify-between') || sel.parentElement;
        header.insertAdjacentElement('afterend', bar);
        const sum = document.createElement('div');
        sum.id = 'stmt-summary';
        sum.className = 'pa-kpis pa-kpis-4';
        bar.insertAdjacentElement('afterend', sum);
    }
    window.paStmtQuick = function (k) {
        const t = today();
        const f = document.getElementById('stmt-from'), to = document.getElementById('stmt-to');
        if (k === 'month') { f.value = t.slice(0, 7) + '-01'; to.value = t; }
        else if (k === 'year') { f.value = t.slice(0, 4) + '-01-01'; to.value = t; }
        else { f.value = ''; to.value = ''; }
        renderAccountStatement();
    };

    function setupProfitView() {
        const view = document.getElementById('view-profit');
        if (!view || document.getElementById('profit-dashboard')) return;
        const first = view.firstElementChild;
        const dash = document.createElement('div');
        dash.id = 'profit-dashboard';
        dash.className = 'pa-dashboard';
        view.insertBefore(dash, first);
        if (first && first.querySelector('#profit-metrics-grid')) first.remove();
        view.querySelectorAll('button[onclick^="openComprehensiveReport"]').forEach(b => {
            const m = b.getAttribute('onclick').match(/'([a-z_]+)'/);
            if (m) b.setAttribute('data-report-key', m[1]);
            b.classList.add('pa-report-btn');
        });
        const reportsCardTitle = Array.from(view.querySelectorAll('h2')).find(h => /تقارير شاملة/.test(h.textContent));
        if (reportsCardTitle) reportsCardTitle.textContent = '📊 التقارير الشاملة (حسب الفترة المختارة أعلاه)';
    }

    function boot() {
        setupProfitView();
        setupStatementControls();
        try { renderProfitAndReportsHub(); } catch (e) { console.error(e); }
        try { renderAccountStatement(); } catch (e) { console.error(e); }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
    else setTimeout(boot, 0);

    window.PA_REPORTS = { computePnL, snapshotBalances, statementData, buildReport, resolvePeriod, period };
})();
