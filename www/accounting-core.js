(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.PA_CORE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const HTML_ENTITIES = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    };

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => HTML_ENTITIES[char]);
    }

    function safeImageUrl(value) {
        const url = String(value || '').trim();
        if (!url) return '';
        if (/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i.test(url)) return url;
        if (/^(?:https?:\/\/|\/|\.\/|assets\/)/i.test(url)) return url;
        return '';
    }

    function getLocalDateString(date = new Date()) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    function roundMoney(value) {
        const numericValue = Number(value);
        return Number.isFinite(numericValue) ? parseFloat(numericValue.toFixed(2)) : 0;
    }

    function splitMoneyEvenly(total, count) {
        const safeTotal = Math.max(0, roundMoney(total));
        const safeCount = Math.max(1, Math.floor(Number(count) || 1));
        const totalCents = Math.round(safeTotal * 100);
        const baseCents = Math.floor(totalCents / safeCount);
        const remainderCents = totalCents % safeCount;
        return Array.from({ length: safeCount }, (_, index) =>
            (baseCents + (index < remainderCents ? 1 : 0)) / 100
        );
    }

    function distributeMoneyProportionally(total, weights) {
        const safeTotal = Math.max(0, roundMoney(total));
        const safeWeights = weights.map(weight => Math.max(0, Number(weight) || 0));
        const totalWeight = safeWeights.reduce((sum, weight) => sum + weight, 0);
        if (totalWeight <= 0) return safeWeights.map(() => 0);
        const rawCents = safeWeights.map(weight => safeTotal * 100 * weight / totalWeight);
        const cents = rawCents.map(value => Math.floor(value));
        let remainder = Math.round(safeTotal * 100) - cents.reduce((sum, value) => sum + value, 0);
        const order = rawCents.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
            .sort((a, b) => b.fraction - a.fraction);
        for (let index = 0; index < remainder; index += 1) cents[order[index % order.length].index] += 1;
        return cents.map(value => value / 100);
    }

    function findInsufficientStock(lines, items, invoiceType) {
        if (invoiceType !== 'sales') return null;
        const requested = new Map();
        for (const line of lines || []) {
            const qty = Number(line.qty);
            if (!line.itemId || !Number.isFinite(qty) || qty <= 0) continue;
            requested.set(line.itemId, (requested.get(line.itemId) || 0) + qty);
        }

        for (const [itemId, qty] of requested) {
            const item = (items || []).find(entry => entry.id === itemId);
            if (!item || item.type !== 'stock') continue;
            const available = Number(item.qty);
            if (!Number.isFinite(available)) continue;
            if (qty > available + 1e-9) {
                return {
                    itemId,
                    itemName: item.name,
                    requested: qty,
                    available
                };
            }
        }
        return null;
    }

    function isValidQuantity(value) {
        const qty = Number(value);
        return Number.isFinite(qty) && qty > 0 && Math.abs(qty * 1000 - Math.round(qty * 1000)) < 1e-7;
    }

    function nextDocumentNumber(records, prefix, startingNumber) {
        const escapedPrefix = String(prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`^${escapedPrefix}?(\\d+)$`);
        let maximum = Number(startingNumber) - 1;
        for (const record of records || []) {
            const match = pattern.exec(String(record?.number || '').trim());
            if (match) maximum = Math.max(maximum, Number(match[1]));
        }
        return prefix + (maximum + 1);
    }

    function isCashPayment(record) {
        return !!record && (!record.payMethod || record.payMethod === 'cash_pay');
    }

    function isSettledReturn(record, invoices) {
        if (!record || record.cashSettled === false) return false;
        if (!record.invoiceId) return true;
        const invoice = (invoices || []).find(entry => entry.id === record.invoiceId);
        return !!invoice && invoice.paymentType === 'cash' && isCashPayment(invoice) && isCashPayment(record);
    }

    function refundVoucherTypeForReturn(record) {
        return record?.type === 'sales_return' ? 'payment' : 'receipt';
    }

    function calculateReturnRefundedUSD(returnId, vouchers) {
        return roundMoney((vouchers || [])
            .filter(entry => entry.returnId === returnId)
            .reduce((sum, entry) => sum + Number(entry.amountUSD || 0), 0));
    }

    function calculateAccountBalanceUSD(data, accountId) {
        const account = (data.accounts || []).find(entry => entry.id === accountId);
        if (!account) return 0;
        let balance = Number(account.openingBalance) || 0;

        for (const invoice of data.invoices || []) {
            if (invoice.accountId !== accountId || (invoice.paymentType !== 'credit' && invoice.paymentType !== 'installment')) continue;
            balance += invoice.type === 'sales' ? Number(invoice.totalUSD) || 0 : -(Number(invoice.totalUSD) || 0);
        }
        for (const voucher of data.vouchers || []) {
            if (voucher.accountId !== accountId) continue;
            const amount = Number(voucher.amountUSD) || 0;
            balance += voucher.type === 'receipt' ? -amount : amount;
        }
        for (const record of data.returns || []) {
            if (record.accountId !== accountId || record.legacyAppliedToOpening || isSettledReturn(record, data.invoices || [])) continue;
            const amount = Number(record.totalUSD) || 0;
            balance += record.type === 'sales_return' ? -amount : amount;
        }
        return roundMoney(balance);
    }

    function calculateReturnAmount(invoice, line, qty) {
        if (!invoice || !line || !isValidQuantity(qty)) return 0;
        const originalQty = Number(line.qty);
        if (qty > originalQty + 1e-9) return 0;
        const subtotalOrig = (invoice.items || []).reduce((sum, entry) => sum + Number(entry.subOrig || 0), 0);
        const discountRatio = subtotalOrig > 0 ? Math.min(1, Number(invoice.discount || 0) / subtotalOrig) : 0;
        const unitUSD = Number(line.priceUSD ?? (Number(line.priceOrig || 0) / Number(invoice.rate || 1)));
        const amount = qty * unitUSD * (1 - discountRatio);
        return Number.isFinite(amount) ? amount : 0;
    }

    function mergeInvoiceLines(lines) {
        const merged = [];
        for (const line of lines || []) {
            const qty = Number(line.qty);
            const existing = merged.find(entry => entry.itemId === line.itemId);
            if (!existing) {
                merged.push({ ...line, qty });
                continue;
            }
            const previousQty = Number(existing.qty);
            const totalQty = Number((previousQty + qty).toFixed(3));
            for (const field of ['priceOrig', 'priceUSD', 'costUSD', 'discountUSD']) {
                if (existing[field] !== undefined || line[field] !== undefined) {
                    existing[field] = (Number(existing[field] || 0) * previousQty
                        + Number(line[field] || 0) * qty) / totalQty;
                }
            }
            existing.qty = totalQty;
            existing.subOrig = Number((Number(existing.subOrig || 0) + Number(line.subOrig || 0)).toFixed(6));
            const notes = [existing.note, line.note].map(note => String(note || '').trim()).filter(Boolean);
            existing.note = Array.from(new Set(notes)).join(' | ');
        }
        return merged;
    }

    function applyReturnToInstallments(data, returnRecord) {
        if (!returnRecord || !returnRecord.invoiceId) return;
        const returnedUSD = roundMoney((data.returns || [])
            .filter(entry => entry.invoiceId === returnRecord.invoiceId)
            .reduce((sum, entry) => sum + Number(entry.totalUSD || 0), 0));
        const schedule = (data.installments || [])
            .filter(entry => entry.invoiceId === returnRecord.invoiceId)
            .sort((a, b) => Number(a.installmentNo) - Number(b.installmentNo));
        let consumedCredits = 0;
        let unpaidOriginal = 0;
        for (const installment of schedule) {
            const original = Number(installment.originalAmountUSD ?? installment.amountUSD ?? 0);
            installment.originalAmountUSD ??= original;
            if (installment.paid) {
                const voucher = (data.vouchers || []).find(entry => entry.id === `vch_${installment.id}`);
                const actualPaid = roundMoney(voucher?.amountUSD ?? installment.amountUSD ?? 0);
                installment.amountUSD = actualPaid;
                installment.cancelledByReturn = false;
                consumedCredits += Math.max(0, original - actualPaid);
            } else {
                unpaidOriginal += original;
            }
        }
        // Paid discounted installments have already used part of the invoice's return credit.
        let remaining = Math.min(Math.max(0, roundMoney(returnedUSD - consumedCredits)), unpaidOriginal);
        for (const installment of schedule) {
            if (installment.paid) continue;
            const original = Number(installment.originalAmountUSD);
            const reduction = Math.min(original, remaining);
            installment.amountUSD = roundMoney(Math.max(0, original - reduction));
            installment.cancelledByReturn = installment.amountUSD <= 0;
            remaining = roundMoney(remaining - reduction);
        }
    }

    function calculateProfit(data, datePredicate = () => true) {
        let sales = 0;
        let costOfSales = 0;
        let purchases = 0;
        for (const invoice of data.invoices || []) {
            if (!datePredicate(invoice.date)) continue;
            if (invoice.type === 'sales') {
                sales += Number(invoice.totalUSD) || 0;
                for (const line of invoice.items || []) {
                    const item = (data.items || []).find(entry => entry.id === line.itemId);
                    const unitCost = Number(line.costUSD ?? item?.cost ?? 0);
                    costOfSales += unitCost * (Number(line.qty) || 0);
                }
            } else {
                purchases += Number(invoice.totalUSD) || 0;
            }
        }
        for (const record of data.returns || []) {
            if (!datePredicate(record.date) || record.type !== 'sales_return') continue;
            sales -= Number(record.totalUSD) || 0;
            const invoice = (data.invoices || []).find(entry => entry.id === record.invoiceId);
            const line = invoice?.items?.find(entry => entry.itemId === record.itemId);
            const item = (data.items || []).find(entry => entry.id === record.itemId);
            const unitCost = Number(record.costUSD ?? line?.costUSD ?? item?.cost ?? 0);
            costOfSales -= unitCost * (Number(record.qty) || 0);
        }
        return { sales: roundMoney(sales), costOfSales: roundMoney(costOfSales), purchases: roundMoney(purchases) };
    }

    function calculateCashboxBalance(cashboxId, data) {
        const cashbox = (data.cashboxes || []).find(entry => entry.id === cashboxId);
        if (!cashbox) return 0;
        let balance = Number(cashbox.openingBalance) || 0;

        for (const invoice of data.invoices || []) {
            if (invoice.cashboxId !== cashboxId || !isCashInvoice(invoice)) continue;
            const amount = Number(invoice.totalUSD) || 0;
            balance += invoice.type === 'sales' ? amount : -amount;
        }

        for (const voucher of data.vouchers || []) {
            if (voucher.cashboxId !== cashboxId || !isCashPayment(voucher)) continue;
            const amount = Number(voucher.amountUSD) || 0;
            balance += voucher.type === 'receipt' ? amount : -amount;
        }

        for (const record of data.returns || []) {
            if (record.cashboxId !== cashboxId || !isSettledReturn(record, data.invoices)) continue;
            const amount = Number(record.totalUSD) || 0;
            balance += record.type === 'sales_return' ? -amount : amount;
        }

        for (const record of data.expenses || []) {
            if (record.cashboxId !== cashboxId) continue;
            const amount = Number(record.amountUSD) || 0;
            balance += record.kind === 'revenue' ? amount : -amount;
        }

        return roundMoney(balance);
    }

    function calculateEndOfDayMetrics(data, targetDate) {
        const day = targetDate || getLocalDateString();
        const rate = Number(data.settings?.exchangeRate) || 15000;
        let salesCashUSD = 0;
        let salesCreditUSD = 0;
        let salesOtherPaidUSD = 0;
        let purchasesUSD = 0;
        let purchasesCashUSD = 0;
        let dayInvoicesCount = 0;

        for (const invoice of data.invoices || []) {
            if (invoice.date !== day) continue;
            dayInvoicesCount++;
            const amount = Number(invoice.totalUSD) || 0;
            if (invoice.type === 'sales') {
                if (isCashInvoice(invoice)) salesCashUSD += amount;
                else if (invoice.paymentType === 'cash') salesOtherPaidUSD += amount;
                else salesCreditUSD += amount;
            } else {
                purchasesUSD += amount;
                if (isCashInvoice(invoice)) purchasesCashUSD += amount;
            }
        }

        let receiptsUSD = 0;
        let paymentsUSD = 0;
        let cashReceiptsUSD = 0;
        let cashPaymentsUSD = 0;
        for (const voucher of data.vouchers || []) {
            if (voucher.date !== day) continue;
            const amount = Number(voucher.amountUSD) || 0;
            if (voucher.type === 'receipt') receiptsUSD += amount;
            else paymentsUSD += amount;
            if (!isCashPayment(voucher)) continue;
            if (voucher.type === 'receipt') cashReceiptsUSD += amount;
            else cashPaymentsUSD += amount;
        }

        let salesReturnsUSD = 0;
        let purchaseReturnsUSD = 0;
        let cashSalesReturnsUSD = 0;
        let cashPurchaseReturnsUSD = 0;
        for (const record of data.returns || []) {
            if (record.date !== day) continue;
            const amount = Number(record.totalUSD) || 0;
            if (record.type === 'sales_return') salesReturnsUSD += amount;
            else purchaseReturnsUSD += amount;
            if (!isSettledReturn(record, data.invoices || [])) continue;
            if (record.type === 'sales_return') cashSalesReturnsUSD += amount;
            else cashPurchaseReturnsUSD += amount;
        }

        let expensesUSD = 0;
        let revenuesUSD = 0;
        for (const record of data.expenses || []) {
            if (record.date !== day) continue;
            const amount = Number(record.amountUSD) || 0;
            if (record.kind === 'revenue') revenuesUSD += amount;
            else expensesUSD += amount;
        }

        const netCashUSD = roundMoney(
            salesCashUSD + cashPurchaseReturnsUSD + cashReceiptsUSD + revenuesUSD
            - purchasesCashUSD - cashSalesReturnsUSD - cashPaymentsUSD - expensesUSD
        );
        return {
            day,
            rate,
            dayInvoicesCount,
            totalSalesUSD: roundMoney(salesCashUSD + salesCreditUSD + salesOtherPaidUSD),
            salesCashUSD: roundMoney(salesCashUSD),
            salesCreditUSD: roundMoney(salesCreditUSD),
            salesOtherPaidUSD: roundMoney(salesOtherPaidUSD),
            purchasesUSD: roundMoney(purchasesUSD),
            purchasesCashUSD: roundMoney(purchasesCashUSD),
            receiptsUSD: roundMoney(receiptsUSD),
            paymentsUSD: roundMoney(paymentsUSD),
            cashReceiptsUSD: roundMoney(cashReceiptsUSD),
            cashPaymentsUSD: roundMoney(cashPaymentsUSD),
            salesReturnsUSD: roundMoney(salesReturnsUSD),
            purchaseReturnsUSD: roundMoney(purchaseReturnsUSD),
            cashSalesReturnsUSD: roundMoney(cashSalesReturnsUSD),
            cashPurchaseReturnsUSD: roundMoney(cashPurchaseReturnsUSD),
            expensesUSD: roundMoney(expensesUSD),
            revenuesUSD: roundMoney(revenuesUSD),
            netCashUSD,
            netCashSYP: Math.round(netCashUSD * rate)
        };
    }

    function voucherTypeForInvoice(invoice) {
        return invoice && invoice.type === 'purchase' ? 'payment' : 'receipt';
    }

    function isCashInvoice(invoice) {
        return !!invoice && invoice.paymentType === 'cash' && (!invoice.payMethod || invoice.payMethod === 'cash_pay');
    }

    function shiftDateByInterval(dateValue, frequency, offset) {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateValue || ''));
        if (!match) return '';
        const year = Number(match[1]);
        const month = Number(match[2]);
        const day = Number(match[3]);
        const source = new Date(year, month - 1, day);
        if (source.getFullYear() !== year || source.getMonth() !== month - 1 || source.getDate() !== day) return '';

        let shifted;
        if (frequency === 'weekly') {
            shifted = new Date(year, month - 1, day + (Number(offset) || 0) * 7);
        } else {
            const monthOffset = Number(offset) || 0;
            const targetYear = year + Math.floor((month - 1 + monthOffset) / 12);
            const targetMonth = (month - 1 + monthOffset) % 12;
            const lastDay = new Date(targetYear, targetMonth + 1, 0).getDate();
            shifted = new Date(targetYear, targetMonth, Math.min(day, lastDay));
        }
        return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}-${String(shifted.getDate()).padStart(2, '0')}`;
    }

    function isRecord(value) {
        return !!value && typeof value === 'object' && !Array.isArray(value);
    }

    function isNumeric(value) {
        return (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value));
    }

    function validateDatabaseBackup(value) {
        if (!isRecord(value)) return { ok: false, error: 'بنية النسخة الاحتياطية غير صالحة.' };
        if (!isRecord(value.settings)) return { ok: false, error: 'إعدادات النسخة الاحتياطية غير صالحة.' };
        for (const key of ['companyName', 'companySub', 'companyLogo']) {
            if (value.settings[key] !== undefined && typeof value.settings[key] !== 'string') {
                return { ok: false, error: `إعداد غير صالح: ${key}` };
            }
        }

        for (const key of ['items', 'accounts', 'invoices', 'vouchers']) {
            if (!Array.isArray(value[key])) return { ok: false, error: `النسخة الاحتياطية تفتقد القائمة: ${key}` };
        }

        const rules = [
            ['items', record => typeof record.id === 'string' && typeof record.name === 'string'
                && (record.type === undefined || record.type === 'stock' || record.type === 'service')
                && (record.type !== 'stock' || isNumeric(record.qty))],
            ['accounts', record => typeof record.id === 'string' && typeof record.name === 'string'
                && (record.type === undefined || record.type === 'customer' || record.type === 'supplier' || record.type === 'both')],
            ['invoices', record => typeof record.id === 'string'
                && (record.type === 'sales' || record.type === 'purchase')
                && (record.paymentType === 'cash' || record.paymentType === 'credit' || record.paymentType === 'installment')
                && (record.payMethod === undefined || record.payMethod === 'cash_pay' || record.payMethod === 'card_check' || record.payMethod === 'bank_transfer')
                && (record.currency === undefined || record.currency === 'USD' || record.currency === 'SYP')
                && typeof record.accountId === 'string' && isNumeric(record.totalUSD)
                && Array.isArray(record.items) && record.items.length > 0
                && record.items.every(line => isRecord(line) && typeof line.itemId === 'string' && isNumeric(line.qty) && Number(line.qty) > 0)],
            ['vouchers', record => typeof record.id === 'string' && (record.type === 'receipt' || record.type === 'payment')
                && typeof record.accountId === 'string' && isNumeric(record.amountUSD)
                && (record.returnId === undefined || typeof record.returnId === 'string')],
            ['returns', record => typeof record.id === 'string' && (record.type === 'sales_return' || record.type === 'purchase_return')
                && typeof record.accountId === 'string' && isNumeric(record.totalUSD) && isNumeric(record.qty) && Number(record.qty) > 0],
            ['cashboxes', record => typeof record.id === 'string' && typeof record.name === 'string'],
            ['expenses', record => typeof record.id === 'string' && (record.kind === 'expense' || record.kind === 'revenue') && isNumeric(record.amountUSD)],
            ['employees', record => typeof record.id === 'string' && typeof record.name === 'string'],
            ['installments', record => typeof record.id === 'string' && typeof record.invoiceId === 'string'
                && typeof record.accountId === 'string' && isNumeric(record.amountUSD) && Number(record.amountUSD) >= 0]
        ];

        const numericFields = [
            ['items', 'qty', true],
            ['items', 'cost'],
            ['items', 'price'],
            ['items', 'minQty'],
            ['accounts', 'openingBalance', true],
            ['invoices', 'totalUSD'],
            ['invoices', 'totalSYP'],
            ['invoices', 'rate'],
            ['invoices', 'discount'],
            ['invoices', 'downPaymentUSD'],
            ['vouchers', 'amountUSD'],
            ['vouchers', 'origAmount'],
            ['vouchers', 'rate'],
            ['returns', 'totalUSD'],
            ['returns', 'totalSYP'],
            ['returns', 'priceUSD'],
            ['returns', 'qty'],
            ['returns', 'rate'],
            ['cashboxes', 'openingBalance', true],
            ['expenses', 'amountUSD'],
            ['employees', 'salary'],
            ['installments', 'amountUSD'],
            ['installments', 'originalAmountUSD']
        ];

        const seenIds = new Set();
        for (const [key, rule] of rules) {
            const records = value[key];
            if (records === undefined) continue;
            if (!Array.isArray(records)) return { ok: false, error: `القائمة غير صالحة: ${key}` };
            for (const record of records) {
                if (!isRecord(record) || !rule(record)) return { ok: false, error: `توجد سجلات غير صالحة في: ${key}` };
                if (!/^[A-Za-z0-9_-]+$/.test(record.id)) return { ok: false, error: `توجد معرّفات غير صالحة في: ${key}` };
                if (seenIds.has(record.id)) return { ok: false, error: `توجد معرّفات مكررة في: ${key}` };
                seenIds.add(record.id);
            }
        }

        const accountIds = new Set(value.accounts.map(record => record.id));
        const itemIds = new Set(value.items.map(record => record.id));
        const barcodeCodes = new Set();
        for (const item of value.items) {
            const code = String(item.code || '').trim();
            if (code && barcodeCodes.has(code)) return { ok: false, error: `باركود مكرر للصنف: ${item.id}` };
            if (code) barcodeCodes.add(code);
        }
        const cashboxIds = new Set((value.cashboxes || []).map(record => record.id));
        const invoiceIds = new Set(value.invoices.map(record => record.id));
        const accountsById = new Map(value.accounts.map(record => [record.id, record]));
        const invoicesById = new Map(value.invoices.map(record => [record.id, record]));
        const returnsById = new Map((value.returns || []).map(record => [record.id, record]));
        const requireReference = (id, ids, label) => ids.has(id) ? null : `مرجع غير صالح في: ${label}`;
        for (const [key, records] of [
            ['invoices', value.invoices],
            ['vouchers', value.vouchers],
            ['returns', value.returns || []],
            ['installments', value.installments || []]
        ]) {
            for (const record of records) {
                const accountError = requireReference(record.accountId, accountIds, key);
                if (accountError) return { ok: false, error: accountError };
                if (record.cashboxId !== undefined && record.cashboxId !== null && record.cashboxId !== '') {
                    const cashboxError = requireReference(record.cashboxId, cashboxIds, key);
                    if (cashboxError) return { ok: false, error: cashboxError };
                }
                if (record.invoiceId !== undefined && record.invoiceId !== null && record.invoiceId !== '') {
                    const invoiceError = requireReference(record.invoiceId, invoiceIds, key);
                    if (invoiceError) return { ok: false, error: invoiceError };
                    const invoice = invoicesById.get(record.invoiceId);
                    if (invoice && invoice.accountId !== record.accountId) {
                        return { ok: false, error: `حساب الحركة لا يطابق الفاتورة في: ${key}` };
                    }
                    if (invoice && key === 'vouchers' && record.type !== voucherTypeForInvoice(invoice)) {
                        return { ok: false, error: `نوع السند لا يطابق الفاتورة: ${record.id}` };
                    }
                    if (invoice && key === 'returns' && record.type !== (invoice.type === 'sales' ? 'sales_return' : 'purchase_return')) {
                        return { ok: false, error: `نوع المرتجع لا يطابق الفاتورة: ${record.id}` };
                    }
                    if (invoice && key === 'installments' && invoice.paymentType !== 'installment') {
                        return { ok: false, error: `قسط مرتبط بفاتورة غير تقسيطية: ${record.id}` };
                    }
                }
            }
        }
        const refundTotalsByAccount = new Map();
        for (const voucher of value.vouchers) {
            if (voucher.returnId === undefined || voucher.returnId === null || voucher.returnId === '') continue;
            const returnRecord = returnsById.get(voucher.returnId);
            if (!returnRecord) return { ok: false, error: `مرتجع غير صالح في السند: ${voucher.id}` };
            if (returnRecord.accountId !== voucher.accountId) {
                return { ok: false, error: `حساب تسوية المرتجع لا يطابق السند: ${voucher.id}` };
            }
            if (voucher.type !== refundVoucherTypeForReturn(returnRecord)) {
                return { ok: false, error: `نوع سند التسوية لا يطابق المرتجع: ${voucher.id}` };
            }
            if (isSettledReturn(returnRecord, value.invoices)) {
                return { ok: false, error: `لا يمكن تسوية مرتجع نقدي مسترد بسند آخر: ${voucher.id}` };
            }
            const totals = refundTotalsByAccount.get(voucher.accountId) || { receipt: 0, payment: 0 };
            totals[voucher.type] += Number(voucher.amountUSD) || 0;
            refundTotalsByAccount.set(voucher.accountId, totals);
        }
        for (const returnRecord of value.returns || []) {
            const refundedUSD = calculateReturnRefundedUSD(returnRecord.id, value.vouchers);
            if (refundedUSD > Number(returnRecord.totalUSD) + 0.02) {
                return { ok: false, error: `تسوية المرتجع تتجاوز قيمته: ${returnRecord.id}` };
            }
        }
        const balanceBeforeRefunds = {
            ...value,
            vouchers: value.vouchers.filter(voucher => !voucher.returnId)
        };
        for (const account of value.accounts) {
            const totals = refundTotalsByAccount.get(account.id);
            if (!totals) continue;
            const balance = calculateAccountBalanceUSD(balanceBeforeRefunds, account.id);
            if (totals.payment > Math.max(0, -balance) + 0.02) {
                return { ok: false, error: `سند التسوية يتجاوز رصيد الحساب الدائن: ${account.id}` };
            }
            if (totals.receipt > Math.max(0, balance) + 0.02) {
                return { ok: false, error: `سند التسوية يتجاوز رصيد الحساب الدائن: ${account.id}` };
            }
        }
        for (const invoice of value.invoices) {
            for (const line of invoice.items) {
                if (!itemIds.has(line.itemId)) return { ok: false, error: `صنف غير موجود في الفاتورة: ${invoice.id}` };
            }
            const account = accountsById.get(invoice.accountId);
            const expectedType = invoice.type === 'sales' ? 'customer' : 'supplier';
            if (account && account.type && account.type !== expectedType && account.type !== 'both') {
                return { ok: false, error: `نوع الحساب غير مناسب للفاتورة: ${invoice.id}` };
            }
        }
        for (const record of value.returns || []) {
            if (!itemIds.has(record.itemId)) return { ok: false, error: `صنف غير موجود في المرتجع: ${record.id}` };
            if (record.invoiceId) {
                const invoice = invoicesById.get(record.invoiceId);
                const line = invoice?.items?.find(entry => entry.itemId === record.itemId);
                if (!line) return { ok: false, error: `بند المرتجع غير موجود في الفاتورة: ${record.id}` };
                const alreadyReturned = (value.returns || [])
                    .filter(entry => entry.id !== record.id && entry.invoiceId === record.invoiceId && entry.itemId === record.itemId)
                    .reduce((sum, entry) => sum + Number(entry.qty || 0), 0);
                if (alreadyReturned + Number(record.qty) > Number(line.qty) + 1e-9) {
                    return { ok: false, error: `كمية المرتجع تتجاوز الكمية الأصلية: ${record.id}` };
                }
                const returnedTotal = (value.returns || [])
                    .filter(entry => entry.invoiceId === invoice.id)
                    .reduce((sum, entry) => sum + Number(entry.totalUSD || 0), 0);
                if (returnedTotal > Number(invoice.totalUSD) + 0.02) {
                    return { ok: false, error: `إجمالي المرتجعات يتجاوز الفاتورة: ${invoice.id}` };
                }
            }
        }
        for (const record of value.expenses || []) {
            if (record.cashboxId !== undefined && record.cashboxId !== null && record.cashboxId !== ''
                && !cashboxIds.has(record.cashboxId)) {
                return { ok: false, error: 'مرجع صندوق غير صالح في: expenses' };
            }
        }
        if (value.warehouses !== undefined && (!Array.isArray(value.warehouses) || !value.warehouses.every(entry => typeof entry === 'string'))) {
            return { ok: false, error: 'قائمة المخازن غير صالحة.' };
        }

        for (const [key, field, allowNegative] of numericFields) {
            for (const record of value[key] || []) {
                if (record[field] === undefined) continue;
                const numericValue = Number(record[field]);
                if (!isNumeric(record[field]) || (!allowNegative && numericValue < 0)) {
                    return { ok: false, error: `قيمة مالية غير صالحة في: ${key}` };
                }
            }
        }

        const backupRate = Number(value.settings.exchangeRate);
        if (!isNumeric(value.settings.exchangeRate) || backupRate <= 0) {
            return { ok: false, error: 'سعر الصرف في النسخة الاحتياطية غير صالح.' };
        }
        for (const invoice of value.invoices || []) {
            if (invoice.rate !== undefined && (!isNumeric(invoice.rate) || Number(invoice.rate) <= 0)) {
                return { ok: false, error: 'سعر صرف إحدى الفواتير غير صالح.' };
            }
            const invoiceRate = Number(invoice.rate ?? backupRate);
            let calculatedSubtotalUSD = 0;
            for (const line of invoice.items) {
                for (const field of ['priceOrig', 'priceUSD', 'subOrig', 'costUSD', 'discountUSD']) {
                    if (line[field] !== undefined && (!Number.isFinite(Number(line[field])) || Number(line[field]) < 0)) {
                        return { ok: false, error: `قيمة غير صالحة في بنود الفاتورة: ${invoice.id}` };
                    }
                }
                const unitUSD = Number(line.priceUSD ?? (Number(line.priceOrig || 0) / invoiceRate));
                calculatedSubtotalUSD += Number(line.qty) * unitUSD;
            }
            const discountUSD = invoice.currency === 'SYP' ? Number(invoice.discount || 0) / invoiceRate : Number(invoice.discount || 0);
            const calculatedTotalUSD = Math.max(0, calculatedSubtotalUSD - discountUSD);
            if (Math.abs(calculatedTotalUSD - Number(invoice.totalUSD)) > 0.02) {
                return { ok: false, error: `إجمالي الفاتورة لا يطابق بنودها: ${invoice.id}` };
            }
            if (invoice.paymentType === 'installment' && invoice.downPaymentUSD !== undefined) {
                const schedule = (value.installments || []).filter(entry => entry.invoiceId === invoice.id);
                const hasOriginalAmounts = schedule.every(entry => entry.originalAmountUSD !== undefined);
                const scheduled = schedule.reduce((sum, entry) => sum + Number(
                    hasOriginalAmounts ? entry.originalAmountUSD : entry.amountUSD
                ), 0);
                if (hasOriginalAmounts && schedule.some(entry => Number(entry.amountUSD) > Number(entry.originalAmountUSD) + 0.001)) {
                    return { ok: false, error: `قيمة قسط معدلة تتجاوز قيمته الأصلية: ${invoice.id}` };
                }
                if (hasOriginalAmounts
                    && Math.abs(scheduled + Number(invoice.downPaymentUSD) - Number(invoice.totalUSD)) > 0.02) {
                    return { ok: false, error: `جدول الأقساط لا يطابق الفاتورة: ${invoice.id}` };
                }
                if (!hasOriginalAmounts
                    && scheduled + Number(invoice.downPaymentUSD) > Number(invoice.totalUSD) + 0.02) {
                    return { ok: false, error: `جدول الأقساط الحالي يتجاوز الفاتورة: ${invoice.id}` };
                }
            }
        }

        for (const [key, records] of [['vouchers', value.vouchers], ['returns', value.returns || []]]) {
            if (records.some(record => record.rate !== undefined && (!isNumeric(record.rate) || Number(record.rate) <= 0))) {
                return { ok: false, error: `سعر صرف غير صالح في: ${key}` };
            }
        }

        const exchangeRate = Number(value.settings.exchangeRate);
        if (!isNumeric(value.settings.exchangeRate) || exchangeRate <= 0) {
            return { ok: false, error: 'سعر الصرف في النسخة الاحتياطية غير صالح.' };
        }
        if (value.settings.appPin !== undefined && !/^\d{4}$/.test(String(value.settings.appPin))) {
            return { ok: false, error: 'رمز الحماية في النسخة الاحتياطية غير صالح.' };
        }

        const numericKeys = {};
        for (const [key, field] of numericFields) {
            if (!numericKeys[key]) numericKeys[key] = new Set();
            numericKeys[key].add(field);
        }
        const legacyInstallmentOriginals = new Map();
        for (const invoice of value.invoices) {
            if (invoice.paymentType !== 'installment') continue;
            const schedule = (value.installments || []).filter(entry => entry.invoiceId === invoice.id);
            if (!schedule.some(entry => entry.originalAmountUSD === undefined)) continue;
            const paidTotal = schedule.filter(entry => entry.paid)
                .reduce((sum, entry) => sum + Number(entry.amountUSD || 0), 0);
            const unpaid = schedule.filter(entry => !entry.paid);
            const unpaidCurrent = unpaid.reduce((sum, entry) => sum + Number(entry.amountUSD || 0), 0);
            const unpaidOriginalTotal = Math.max(unpaidCurrent,
                Number(invoice.totalUSD || 0) - Number(invoice.downPaymentUSD || 0) - paidTotal);
            const originals = distributeMoneyProportionally(unpaidOriginalTotal, unpaid.map(entry => entry.amountUSD));
            unpaid.forEach((entry, index) => legacyInstallmentOriginals.set(entry.id, originals[index]));
            schedule.filter(entry => entry.paid).forEach(entry => legacyInstallmentOriginals.set(entry.id, Number(entry.amountUSD || 0)));
        }

        const normalizeCollection = key => (value[key] || []).map(record => {
            const normalized = { ...record };
            if (normalized.cashboxId === '' || normalized.cashboxId === null) delete normalized.cashboxId;
            if (normalized.invoiceId === '' || normalized.invoiceId === null) delete normalized.invoiceId;
            if (normalized.returnId === '' || normalized.returnId === null) delete normalized.returnId;
            for (const field of numericKeys[key] || []) {
                if (normalized[field] !== undefined) normalized[field] = Number(normalized[field]);
            }
            if (key === 'items') {
                normalized.type = normalized.type || 'stock';
                normalized.qty = Number(normalized.qty ?? 0);
                normalized.cost = Number(normalized.cost ?? 0);
                normalized.price = Number(normalized.price ?? 0);
                normalized.minQty = Number(normalized.minQty ?? 0);
            } else if (key === 'accounts') {
                normalized.openingBalance = Number(normalized.openingBalance ?? 0);
            } else if (key === 'invoices') {
                normalized.rate = Number(normalized.rate ?? exchangeRate);
                normalized.discount = Number(normalized.discount ?? 0);
                normalized.currency = normalized.currency || 'USD';
                normalized.totalSYP = Number(normalized.totalSYP ?? Math.round(normalized.totalUSD * normalized.rate));
                normalized.items = mergeInvoiceLines(normalized.items.map(line => {
                    const normalizedLine = { ...line, qty: Number(line.qty) };
                    const priceOrig = Number(line.priceOrig || 0);
                    for (const field of ['priceOrig', 'priceUSD', 'subOrig', 'costUSD', 'discountUSD']) {
                        if (normalizedLine[field] !== undefined) normalizedLine[field] = Number(normalizedLine[field]);
                    }
                    if (normalizedLine.priceUSD === undefined) normalizedLine.priceUSD = priceOrig / normalized.rate;
                    if (normalizedLine.subOrig === undefined) normalizedLine.subOrig = normalizedLine.qty * priceOrig;
                    return normalizedLine;
                }));
            } else if (key === 'vouchers') {
                normalized.origAmount = Number(normalized.origAmount ?? normalized.amountUSD);
                normalized.rate = Number(normalized.rate ?? exchangeRate);
                normalized.currency = normalized.currency || 'USD';
            } else if (key === 'returns') {
                normalized.priceUSD = Number(normalized.priceUSD ?? (normalized.qty ? normalized.totalUSD / normalized.qty : 0));
                normalized.totalSYP = Number(normalized.totalSYP ?? Math.round(normalized.totalUSD * (normalized.rate ?? exchangeRate)));
                normalized.rate = Number(normalized.rate ?? exchangeRate);
            } else if (key === 'cashboxes') {
                normalized.openingBalance = Number(normalized.openingBalance ?? 0);
            } else if (key === 'employees') {
                normalized.salary = Number(normalized.salary ?? 0);
            } else if (key === 'installments') {
                normalized.amountUSD = Number(normalized.amountUSD ?? 0);
                normalized.originalAmountUSD = Number(
                    normalized.originalAmountUSD ?? legacyInstallmentOriginals.get(normalized.id) ?? normalized.amountUSD
                );
            }
            return normalized;
        });

        return {
            ok: true,
            data: {
                ...value,
                settings: {
                    companyName: 'محاسب محترف سوريا',
                    companySub: 'بإدارة باسل محمد الخابور - 0952575089',
                    companyLogo: '',
                    ...value.settings,
                    exchangeRate,
                    ...(value.settings.appPin !== undefined ? { appPin: String(value.settings.appPin) } : {})
                },
                items: normalizeCollection('items'),
                accounts: normalizeCollection('accounts'),
                invoices: normalizeCollection('invoices'),
                vouchers: normalizeCollection('vouchers'),
                returns: Array.isArray(value.returns) ? normalizeCollection('returns') : [],
                cashboxes: Array.isArray(value.cashboxes) ? normalizeCollection('cashboxes') : [],
                warehouses: Array.isArray(value.warehouses) ? value.warehouses : [],
                expenses: Array.isArray(value.expenses) ? normalizeCollection('expenses') : [],
                employees: Array.isArray(value.employees) ? normalizeCollection('employees') : [],
                installments: Array.isArray(value.installments) ? normalizeCollection('installments') : [],
                auditLog: Array.isArray(value.auditLog) ? value.auditLog : []
            }
        };
    }

    return {
        escapeHtml,
        safeImageUrl,
        getLocalDateString,
        roundMoney,
        splitMoneyEvenly,
        distributeMoneyProportionally,
        findInsufficientStock,
        isValidQuantity,
        nextDocumentNumber,
        isCashPayment,
        isSettledReturn,
        refundVoucherTypeForReturn,
        calculateReturnRefundedUSD,
        calculateAccountBalanceUSD,
        calculateReturnAmount,
        mergeInvoiceLines,
        applyReturnToInstallments,
        calculateProfit,
        isCashInvoice,
        calculateCashboxBalance,
        calculateEndOfDayMetrics,
        voucherTypeForInvoice,
        shiftDateByInterval,
        validateDatabaseBackup
    };
});
