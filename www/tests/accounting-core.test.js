const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../accounting-core');

test('rejects aggregated sales quantity above available stock', () => {
    const items = [{ id: 'itm_1', name: 'راوتر', type: 'stock', qty: 10 }];
    const result = core.findInsufficientStock([
        { itemId: 'itm_1', qty: 6 },
        { itemId: 'itm_1', qty: 5 }
    ], items, 'sales');

    assert.equal(result.itemId, 'itm_1');
    assert.equal(result.requested, 11);
    assert.equal(result.available, 10);
});

test('allows sufficient stock, services, and purchases', () => {
    const items = [
        { id: 'itm_1', name: 'راوتر', type: 'stock', qty: 10 },
        { id: 'itm_2', name: 'خدمة', type: 'service', qty: 0 }
    ];

    assert.equal(core.findInsufficientStock([{ itemId: 'itm_1', qty: 10 }], items, 'sales'), null);
    assert.equal(core.findInsufficientStock([{ itemId: 'itm_2', qty: 100 }], items, 'sales'), null);
    assert.equal(core.findInsufficientStock([{ itemId: 'itm_1', qty: 100 }], items, 'purchase'), null);
});

test('calculates cashbox balance from every linked movement', () => {
    const data = {
        cashboxes: [{ id: 'cb_main', name: 'الصندوق', openingBalance: 100 }],
        invoices: [
            { cashboxId: 'cb_main', paymentType: 'cash', payMethod: 'cash_pay', type: 'sales', totalUSD: 50 },
            { cashboxId: 'cb_main', paymentType: 'cash', payMethod: 'cash_pay', type: 'purchase', totalUSD: 20 },
            { cashboxId: 'cb_main', paymentType: 'credit', type: 'sales', totalUSD: 999 },
            { cashboxId: 'cb_main', paymentType: 'cash', payMethod: 'bank_transfer', type: 'sales', totalUSD: 999 }
        ],
        vouchers: [
            { cashboxId: 'cb_main', type: 'receipt', amountUSD: 30 },
            { cashboxId: 'cb_main', type: 'payment', amountUSD: 10 }
        ],
        returns: [
            { cashboxId: 'cb_main', type: 'sales_return', totalUSD: 5 },
            { cashboxId: 'cb_main', type: 'purchase_return', totalUSD: 4 }
        ],
        expenses: [
            { cashboxId: 'cb_main', kind: 'expense', amountUSD: 7 },
            { cashboxId: 'cb_main', kind: 'revenue', amountUSD: 2 }
        ]
    };

    assert.equal(core.calculateCashboxBalance('cb_main', data), 144);
    data.invoices.push({ cashboxId: 'cb_main', paymentType: 'cash', type: 'sales', totalUSD: 1 });
    assert.equal(core.calculateCashboxBalance('cb_main', data), 145);
    assert.equal(core.calculateCashboxBalance('missing', data), 0);
});

test('uses payment vouchers for purchases and receipts for sales', () => {
    assert.equal(core.voucherTypeForInvoice({ type: 'sales' }), 'receipt');
    assert.equal(core.voucherTypeForInvoice({ type: 'purchase' }), 'payment');
});

test('splits installments without negative amounts or rounding drift', () => {
    assert.deepEqual(core.splitMoneyEvenly(100, 3), [33.34, 33.33, 33.33]);
    assert.deepEqual(core.splitMoneyEvenly(0.01, 2), [0.01, 0]);
    assert.deepEqual(core.splitMoneyEvenly(10, 1), [10]);
    assert.equal(core.roundMoney(0.335), 0.34);
});

test('formats the device local date without UTC drift', () => {
    const localMorning = new Date(2026, 0, 2, 1, 0, 0);
    assert.equal(core.getLocalDateString(localMorning), '2026-01-02');
});

test('shifts installment dates without UTC drift or month-end overflow', () => {
    assert.equal(core.shiftDateByInterval('2026-01-31', 'monthly', 0), '2026-01-31');
    assert.equal(core.shiftDateByInterval('2026-01-31', 'monthly', 1), '2026-02-28');
    assert.equal(core.shiftDateByInterval('2026-01-31', 'monthly', 2), '2026-03-31');
    assert.equal(core.shiftDateByInterval('2026-01-31', 'monthly', 3), '2026-04-30');
    assert.equal(core.shiftDateByInterval('2026-01-31', 'weekly', 1), '2026-02-07');
    assert.equal(core.shiftDateByInterval('2026-02-31', 'monthly', 0), '');
});

test('escapes HTML and accepts only safe image sources', () => {
    assert.equal(core.escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
    assert.equal(core.escapeHtml('"quoted" & text'), '&quot;quoted&quot; &amp; text');
    assert.equal(core.safeImageUrl('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
    assert.equal(core.safeImageUrl('https://example.com/logo.png'), 'https://example.com/logo.png');
    assert.equal(core.safeImageUrl('javascript:alert(1)'), '');
    assert.equal(core.safeImageUrl('data:image/svg+xml,<svg onload=alert(1)>'), '');
});

test('accepts a valid backup and fills optional stores', () => {
    const result = core.validateDatabaseBackup({
        settings: { exchangeRate: 15000 },
        items: [],
        accounts: [],
        invoices: [],
        vouchers: []
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.data.returns, []);
    assert.deepEqual(result.data.cashboxes, []);
    assert.equal(result.data.settings.companyName, 'محاسب محترف سوريا');

    const numeric = core.validateDatabaseBackup({
        settings: { exchangeRate: '15000', appPin: 1234 },
        items: [{ id: 'itm_1', name: 'صنف', qty: '10', cost: '2.5' }],
        accounts: [],
        invoices: [],
        vouchers: []
    });
    assert.equal(numeric.ok, true);
    assert.equal(numeric.data.items[0].qty, 10);
    assert.equal(numeric.data.items[0].cost, 2.5);
    assert.equal(numeric.data.settings.exchangeRate, 15000);
    assert.equal(numeric.data.settings.appPin, '1234');

    const invoice = core.validateDatabaseBackup({
        settings: { exchangeRate: 15000 },
        items: [{ id: 'itm_1', name: 'صنف', type: 'stock', qty: 2 }],
        accounts: [{ id: 'acc_1', name: 'عميل', type: 'customer' }], vouchers: [],
        invoices: [{ id: 'inv_1', type: 'sales', paymentType: 'cash', accountId: 'acc_1', totalUSD: '7', items: [{ itemId: 'itm_1', qty: '2', priceUSD: '3.5' }] }]
    });
    assert.equal(invoice.ok, true);
    assert.equal(invoice.data.invoices[0].items[0].qty, 2);
    assert.equal(invoice.data.invoices[0].items[0].priceUSD, 3.5);
    assert.equal(invoice.data.invoices[0].rate, 15000);
    assert.equal(invoice.data.invoices[0].totalSYP, 105000);
});

test('returns historical net prices and respects original quantities', () => {
    const invoice = {
        rate: 15000, discount: 4.5,
        items: [{ qty: 3, priceUSD: 10, priceOrig: 10, subOrig: 30 }]
    };
    assert.equal(core.calculateReturnAmount(invoice, invoice.items[0], 2), 17);
    assert.equal(core.calculateReturnAmount(invoice, invoice.items[0], 4), 0);
    assert.equal(core.calculateReturnAmount(invoice, invoice.items[0], 0), 0);
});

test('reduces unpaid installments without changing paid amounts', () => {
    const data = {
        returns: [{ id: 'r1', invoiceId: 'inv1', type: 'sales_return', totalUSD: 60 }],
        installments: [
            { id: 'i1', invoiceId: 'inv1', installmentNo: 1, amountUSD: 50, originalAmountUSD: 50, paid: true },
            { id: 'i2', invoiceId: 'inv1', installmentNo: 2, amountUSD: 50, originalAmountUSD: 50, paid: false },
            { id: 'i3', invoiceId: 'inv1', installmentNo: 3, amountUSD: 50, originalAmountUSD: 50, paid: false }
        ]
    };
    core.applyReturnToInstallments(data, { invoiceId: 'inv1', type: 'sales_return', totalUSD: 60 });
    assert.equal(data.installments[0].amountUSD, 50);
    assert.equal(data.installments[1].amountUSD, 0);
    assert.equal(data.installments[1].cancelledByReturn, true);
    assert.equal(data.installments[2].amountUSD, 40);
});

for (const type of ['sales', 'purchase']) {
    test(`preserves discounted ${type} installments through sequential payments and repeated reconciliation`, () => {
        const voucherType = core.voucherTypeForInvoice({ type });
        const data = {
            accounts: [{ id: 'acc1', openingBalance: 0 }],
            invoices: [{ id: 'inv1', accountId: 'acc1', type, paymentType: 'installment', totalUSD: 100 }],
            returns: [{ id: 'r1', invoiceId: 'inv1', accountId: 'acc1', type: `${type}_return`, totalUSD: 20 }],
            vouchers: [],
            installments: [
                { id: 'i1', invoiceId: 'inv1', installmentNo: 1, amountUSD: 50, originalAmountUSD: 50, paid: false },
                { id: 'i2', invoiceId: 'inv1', installmentNo: 2, amountUSD: 50, originalAmountUSD: 50, paid: false }
            ]
        };
        core.applyReturnToInstallments(data, data.returns[0]);
        assert.deepEqual(data.installments.map(entry => entry.amountUSD), [30, 50]);

        for (const installment of data.installments) {
            installment.paid = true;
            data.vouchers.push({
                id: `vch_${installment.id}`, accountId: 'acc1', invoiceId: 'inv1', type: voucherType,
                amountUSD: installment.amountUSD, origAmount: installment.originalAmountUSD
            });
            const snapshot = structuredClone(data);
            for (let repeat = 0; repeat < 3; repeat += 1) {
                core.applyReturnToInstallments(data, data.returns[0]);
                assert.deepEqual(data, snapshot);
            }
            assert.deepEqual(data.installments.map(entry => entry.amountUSD), [30, 50]);
            assert.equal(core.calculateAccountBalanceUSD(data, 'acc1'), installment.id === 'i1' ? (type === 'sales' ? 50 : -50) : 0);
        }
        assert.deepEqual(data.installments.map(entry => entry.originalAmountUSD), [50, 50]);
    });
}

test('uses linked voucher amounts to recover paid amounts and bounds consumed credits at zero', () => {
    for (const [paidUSD, unpaidUSD] of [[30, 50], [0, 50], [55, 30]]) {
        const data = {
            returns: [{ id: 'r1', invoiceId: 'inv1', totalUSD: 20 }],
            vouchers: [
                { id: 'unrelated', invoiceId: 'inv1', amountUSD: 1 },
                { id: 'vch_i1', invoiceId: 'inv1', amountUSD: paidUSD, origAmount: 50 }
            ],
            installments: [
                { id: 'i1', invoiceId: 'inv1', installmentNo: 1, amountUSD: 50, originalAmountUSD: 50, paid: true, cancelledByReturn: true },
                { id: 'i2', invoiceId: 'inv1', installmentNo: 2, amountUSD: 50, originalAmountUSD: 50, paid: false }
            ]
        };
        core.applyReturnToInstallments(data, data.returns[0]);
        assert.deepEqual(data.installments.map(entry => entry.amountUSD), [paidUSD, unpaidUSD]);
        assert.equal(data.installments[0].cancelledByReturn, false);
        assert.deepEqual(data.installments.map(entry => entry.originalAmountUSD), [50, 50]);
        const snapshot = structuredClone(data);
        core.applyReturnToInstallments(data, data.returns[0]);
        assert.deepEqual(data, snapshot);
    }
});

test('preserves actual paid amounts without vouchers during sequential payments and undo', () => {
    const data = {
        returns: [{ id: 'r1', invoiceId: 'inv1', totalUSD: 20 }],
        installments: [
            { id: 'i1', invoiceId: 'inv1', installmentNo: 1, amountUSD: 50, originalAmountUSD: 50, paid: false },
            { id: 'i2', invoiceId: 'inv1', installmentNo: 2, amountUSD: 50, originalAmountUSD: 50, paid: false }
        ]
    };
    core.applyReturnToInstallments(data, data.returns[0]);
    for (const installment of data.installments) {
        installment.paid = true;
        core.applyReturnToInstallments(data, data.returns[0]);
        assert.deepEqual(data.installments.map(entry => entry.amountUSD), [30, 50]);
        const snapshot = structuredClone(data);
        core.applyReturnToInstallments(data, data.returns[0]);
        assert.deepEqual(data, snapshot);
    }
    data.installments[0].paid = false;
    core.applyReturnToInstallments(data, data.returns[0]);
    assert.deepEqual(data.installments.map(entry => entry.amountUSD), [30, 50]);
    assert.deepEqual(data.installments.map(entry => entry.originalAmountUSD), [50, 50]);
});

test('redistributes consumed credits when discounted payments are undone', () => {
    const data = {
        returns: [{ id: 'r1', invoiceId: 'inv1', totalUSD: 60 }],
        vouchers: [{ id: 'vch_i1', amountUSD: 30 }, { id: 'vch_i2', amountUSD: 10 }],
        installments: [
            { id: 'i1', invoiceId: 'inv1', installmentNo: 1, amountUSD: 30, originalAmountUSD: 50, paid: true },
            { id: 'i2', invoiceId: 'inv1', installmentNo: 2, amountUSD: 10, originalAmountUSD: 50, paid: true },
            { id: 'i3', invoiceId: 'inv1', installmentNo: 3, amountUSD: 50, originalAmountUSD: 50, paid: false }
        ]
    };
    core.applyReturnToInstallments(data, data.returns[0]);
    assert.deepEqual(data.installments.map(entry => entry.amountUSD), [30, 10, 50]);

    data.installments[0].paid = false;
    data.vouchers = data.vouchers.filter(entry => entry.id !== 'vch_i1');
    core.applyReturnToInstallments(data, data.returns[0]);
    assert.deepEqual(data.installments.map(entry => entry.amountUSD), [30, 10, 50]);

    data.installments[1].paid = false;
    // An undone installment's stale voucher must not consume return credits.
    core.applyReturnToInstallments(data, data.returns[0]);
    assert.deepEqual(data.installments.map(entry => entry.amountUSD), [0, 40, 50]);
    assert.deepEqual(data.installments.map(entry => entry.cancelledByReturn), [true, false, false]);
    assert.deepEqual(data.installments.map(entry => entry.originalAmountUSD), [50, 50, 50]);
    const snapshot = structuredClone(data);
    core.applyReturnToInstallments(data, data.returns[0]);
    assert.deepEqual(data, snapshot);
});

test('applies only additional return credits after discounted installments are paid', () => {
    const data = {
        returns: [{ id: 'r1', invoiceId: 'inv1', totalUSD: 20.01 }],
        vouchers: [],
        // Storage order must not affect installment-number allocation.
        installments: [
            { id: 'i3', invoiceId: 'inv1', installmentNo: 3, amountUSD: 50, originalAmountUSD: 50, paid: false },
            { id: 'i1', invoiceId: 'inv1', installmentNo: 1, amountUSD: 50, originalAmountUSD: 50, paid: false },
            { id: 'i2', invoiceId: 'inv1', installmentNo: 2, amountUSD: 50, originalAmountUSD: 50, paid: false }
        ]
    };
    const [third, first, second] = data.installments;
    core.applyReturnToInstallments(data, data.returns[0]);
    assert.deepEqual(data.installments.map(entry => entry.amountUSD), [50, 29.99, 50]);
    first.paid = true;
    data.vouchers.push({ id: 'vch_i1', amountUSD: 29.99 });
    data.returns.push({ id: 'r2', invoiceId: 'inv1', totalUSD: 40.02 });
    data.returns.push({ id: 'other_return', invoiceId: 'inv2', totalUSD: 999 });
    core.applyReturnToInstallments(data, data.returns[1]);
    assert.deepEqual(data.installments.map(entry => entry.amountUSD), [50, 29.99, 9.98]);

    second.paid = true;
    data.vouchers.push({ id: 'vch_i2', amountUSD: 9.98 });
    data.returns.push({ id: 'r3', invoiceId: 'inv1', totalUSD: 10 });
    core.applyReturnToInstallments(data, data.returns[0]);
    assert.deepEqual(data.installments.map(entry => entry.amountUSD), [40, 29.99, 9.98]);
    assert.equal(third.paid, false);
    const snapshot = structuredClone(data);
    for (const record of data.returns.filter(entry => entry.invoiceId === 'inv1')) {
        core.applyReturnToInstallments(data, record);
        assert.deepEqual(data, snapshot);
    }
});

test('keeps previously full-paid installments unchanged and caps returns to unpaid originals', () => {
    const data = {
        returns: [{ id: 'r1', invoiceId: 'inv1', totalUSD: 100 }],
        vouchers: [{ id: 'vch_i1', amountUSD: 50 }],
        installments: [
            { id: 'i1', invoiceId: 'inv1', installmentNo: 1, amountUSD: 50, originalAmountUSD: 50, paid: true },
            { id: 'i2', invoiceId: 'inv1', installmentNo: 2, amountUSD: 50, originalAmountUSD: 50, paid: true },
            { id: 'i3', invoiceId: 'inv1', installmentNo: 3, amountUSD: 50, originalAmountUSD: 50, paid: false }
        ]
    };
    core.applyReturnToInstallments(data, data.returns[0]);
    assert.deepEqual(data.installments.map(entry => entry.amountUSD), [50, 50, 0]);
    assert.deepEqual(data.installments.map(entry => entry.cancelledByReturn), [false, false, true]);
    const snapshot = structuredClone(data);
    core.applyReturnToInstallments(data, data.returns[0]);
    assert.deepEqual(data, snapshot);

    data.returns[0].totalUSD = 10;
    core.applyReturnToInstallments(data, data.returns[0]);
    assert.deepEqual(data.installments.map(entry => entry.amountUSD), [50, 50, 40]);
    assert.equal(data.installments[2].cancelledByReturn, false);
    assert.deepEqual(data.installments.map(entry => entry.originalAmountUSD), [50, 50, 50]);
});

test('captures missing original amounts once so reconciliation and removing returns are stable', () => {
    const unrelated = { id: 'i3', invoiceId: 'inv2', amountUSD: 75, paid: false };
    const data = {
        returns: [{ id: 'r1', invoiceId: 'inv1', totalUSD: 20 }],
        installments: [
            { id: 'i1', invoiceId: 'inv1', installmentNo: 1, amountUSD: 50, paid: false },
            { id: 'i2', invoiceId: 'inv1', installmentNo: 2, amountUSD: 50, paid: false },
            { ...unrelated }
        ]
    };
    core.applyReturnToInstallments(data, data.returns[0]);
    assert.deepEqual(data.installments.slice(0, 2).map(entry => entry.amountUSD), [30, 50]);
    assert.deepEqual(data.installments.slice(0, 2).map(entry => entry.originalAmountUSD), [50, 50]);
    const snapshot = structuredClone(data);
    core.applyReturnToInstallments(data, data.returns[0]);
    assert.deepEqual(data, snapshot);

    data.returns = [];
    core.applyReturnToInstallments(data, { invoiceId: 'inv1' });
    assert.deepEqual(data.installments.slice(0, 2).map(entry => entry.amountUSD), [50, 50]);
    assert.deepEqual(data.installments.slice(0, 2).map(entry => entry.originalAmountUSD), [50, 50]);
    assert.deepEqual(data.installments[2], unrelated);
});

test('calculates fractional-unit returns from the aggregate without cent rounding drift', () => {
    const invoice = {
        rate: 15000, discount: 0, totalUSD: 4.9,
        items: [{ qty: 1000, priceUSD: 0.0049, priceOrig: 0.0049, subOrig: 4.9 }]
    };
    assert.ok(Math.abs(core.calculateReturnAmount(invoice, invoice.items[0], 1000) - 4.9) < 1e-9);
    assert.ok(Math.abs(core.calculateReturnAmount(invoice, invoice.items[0], 1) - 0.0049) < 1e-9);
});

test('merges duplicate invoice lines with weighted prices and combined notes', () => {
    const merged = core.mergeInvoiceLines([
        { itemId: 'itm1', qty: 2, priceOrig: 10, priceUSD: 10, costUSD: 6, subOrig: 20, note: 'أول' },
        { itemId: 'itm1', qty: 3, priceOrig: 20, priceUSD: 20, costUSD: 8, subOrig: 60, note: 'ثاني' },
        { itemId: 'itm2', qty: 1, priceOrig: 5, priceUSD: 5, costUSD: 2, subOrig: 5 }
    ]);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].qty, 5);
    assert.equal(merged[0].priceUSD, 16);
    assert.equal(merged[0].costUSD, 7.2);
    assert.equal(merged[0].subOrig, 80);
    assert.equal(merged[0].note, 'أول | ثاني');
});

test('reconciles purchase returns and rebuilds unpaid amounts after unpaying', () => {
    const purchase = {
        returns: [{ id: 'r1', invoiceId: 'inv1', type: 'purchase_return', totalUSD: 20 }],
        installments: [
            { id: 'i1', invoiceId: 'inv1', installmentNo: 1, amountUSD: 50, originalAmountUSD: 50, paid: false },
            { id: 'i2', invoiceId: 'inv1', installmentNo: 2, amountUSD: 50, originalAmountUSD: 50, paid: false }
        ]
    };
    core.applyReturnToInstallments(purchase, { invoiceId: 'inv1', type: 'purchase_return', totalUSD: 20 });
    assert.deepEqual(purchase.installments.map(entry => entry.amountUSD), [30, 50]);

    const sale = {
        returns: [{ id: 'r2', invoiceId: 'inv2', type: 'sales_return', totalUSD: 60 }],
        installments: [
            { id: 'i3', invoiceId: 'inv2', installmentNo: 1, amountUSD: 50, originalAmountUSD: 50, paid: true },
            { id: 'i4', invoiceId: 'inv2', installmentNo: 2, amountUSD: 0, originalAmountUSD: 50, paid: false }
        ]
    };
    core.applyReturnToInstallments(sale, { invoiceId: 'inv2', type: 'sales_return', totalUSD: 60 });
    sale.installments[0].paid = false;
    core.applyReturnToInstallments(sale, { invoiceId: 'inv2', type: 'sales_return', totalUSD: 60 });
    assert.deepEqual(sale.installments.map(entry => entry.amountUSD), [0, 40]);
});

test('uses historical cost and subtracts returned sales and cost', () => {
    const data = {
        items: [{ id: 'itm1', cost: 99 }],
        invoices: [{ type: 'sales', date: '2026-11-24', totalUSD: 30, items: [{ itemId: 'itm1', qty: 3, costUSD: 4 }] }],
        returns: [{ type: 'sales_return', date: '2026-11-24', totalUSD: 10, qty: 1, itemId: 'itm1', costUSD: 4 }]
    };
    assert.deepEqual(core.calculateProfit(data), { sales: 20, costOfSales: 8, purchases: 0 });
});

test('allocates document numbers from the maximum restored record', () => {
    const records = [{ number: '#1009' }, { number: '#1012' }, { number: '#bad' }, { number: 'other' }];
    assert.equal(core.nextDocumentNumber(records, '#', 1001), '#1013');
    assert.equal(core.nextDocumentNumber([{ number: 'RET-3' }], 'RET-', 101), 'RET-101');
    assert.equal(core.nextDocumentNumber([{ number: 'A.1' }], 'A.', 1), 'A.2');
});

test('validates original installment totals after returns reduce balances', () => {
    const data = {
        settings: { exchangeRate: 15000 },
        items: [{ id: 'itm1', name: 'صنف', type: 'stock', qty: 2 }],
        accounts: [{ id: 'acc1', name: 'عميل', type: 'customer' }],
        vouchers: [],
        invoices: [{
            id: 'inv1', number: '#1', type: 'sales', paymentType: 'installment', accountId: 'acc1',
            downPaymentUSD: 10, totalUSD: 100, rate: 15000,
            items: [{ itemId: 'itm1', qty: 2, priceUSD: 50 }]
        }],
        installments: [
            { id: 'i1', invoiceId: 'inv1', accountId: 'acc1', amountUSD: 90, originalAmountUSD: 90 },
            { id: 'i2', invoiceId: 'inv1', accountId: 'acc1', amountUSD: 0, originalAmountUSD: 0 }
        ]
    };
    assert.equal(core.validateDatabaseBackup(data).ok, true);
    data.installments[0].amountUSD = 45;
    assert.equal(core.validateDatabaseBackup(data).ok, true);
    data.installments[0].originalAmountUSD = 80;
    assert.equal(core.validateDatabaseBackup(data).ok, false);
});

test('migrates blank optional references and reconstructs legacy installment originals', () => {
    const result = core.validateDatabaseBackup({
        settings: { exchangeRate: 15000 },
        items: [{ id: 'itm1', name: 'صنف', type: 'stock', qty: 2 }],
        accounts: [{ id: 'acc1', name: 'عميل', type: 'customer' }],
        expenses: [{ id: 'exp1', kind: 'expense', amountUSD: 1, cashboxId: '' }],
        vouchers: [{ id: 'vch1', type: 'receipt', accountId: 'acc1', amountUSD: 5, invoiceId: 'inv1', cashboxId: null }],
        returns: [{ id: 'ret1', type: 'sales_return', accountId: 'acc1', invoiceId: 'inv1', itemId: 'itm1', qty: 1, totalUSD: 40 }],
        invoices: [{
            id: 'inv1', type: 'sales', paymentType: 'installment', accountId: 'acc1',
            downPaymentUSD: 10, totalUSD: 100, cashboxId: '', items: [{ itemId: 'itm1', qty: 2, priceUSD: 50 }]
        }],
        installments: [
            { id: 'i1', invoiceId: 'inv1', accountId: 'acc1', amountUSD: 20, paid: true },
            { id: 'i2', invoiceId: 'inv1', accountId: 'acc1', amountUSD: 30, paid: false }
        ]
    });

    assert.equal(result.ok, true);
    assert.equal(Object.hasOwn(result.data.invoices[0], 'cashboxId'), false);
    assert.equal(Object.hasOwn(result.data.vouchers[0], 'cashboxId'), false);
    assert.equal(Object.hasOwn(result.data.expenses[0], 'cashboxId'), false);
    assert.deepEqual(result.data.installments.map(entry => entry.originalAmountUSD), [20, 70]);
    assert.equal(result.data.installments[1].amountUSD, 30);
});

test('accepts only quantities with three-decimal precision', () => {
    assert.equal(core.isValidQuantity(1.234), true);
    assert.equal(core.isValidQuantity(1.2345), false);
    assert.equal(core.isValidQuantity(0), false);
    assert.equal(core.isValidQuantity('2.001'), true);
});

test('allocates purchase discounts proportionally without losing cents', () => {
    assert.deepEqual(core.distributeMoneyProportionally(10, [1, 3]), [2.5, 7.5]);
    assert.deepEqual(core.distributeMoneyProportionally(0.05, [1, 1, 1]), [0.02, 0.02, 0.01]);
});

test('computes end-of-day cash from settled cash movements only', () => {
    const day = '2026-11-24';
    const data = {
        settings: { exchangeRate: 15000 },
        invoices: [
            { id: 'inv_cash', type: 'sales', paymentType: 'cash', payMethod: 'cash_pay', date: day, totalUSD: 50 },
            { id: 'inv_card', type: 'sales', paymentType: 'cash', payMethod: 'card_check', date: day, totalUSD: 120 },
            { id: 'inv_credit', type: 'sales', paymentType: 'credit', date: day, totalUSD: 80 }
        ],
        vouchers: [
            { type: 'receipt', payMethod: 'cash_pay', date: day, amountUSD: 30 },
            { type: 'receipt', payMethod: 'card_check', date: day, amountUSD: 100 }
        ],
        returns: [
            { type: 'sales_return', invoiceId: 'inv_cash', payMethod: 'cash_pay', date: day, totalUSD: 5 },
            { type: 'sales_return', invoiceId: 'inv_card', payMethod: 'card_check', date: day, totalUSD: 20 },
            { type: 'sales_return', invoiceId: 'inv_credit', payMethod: 'bank_transfer', date: day, totalUSD: 10 }
        ],
        expenses: []
    };

    const metrics = core.calculateEndOfDayMetrics(data, day);
    assert.equal(metrics.totalSalesUSD, 250);
    assert.equal(metrics.receiptsUSD, 130);
    assert.equal(metrics.cashReceiptsUSD, 30);
    assert.equal(metrics.salesReturnsUSD, 35);
    assert.equal(metrics.cashSalesReturnsUSD, 5);
    assert.equal(metrics.netCashUSD, 75);
});

test('honors an explicit unsettled flag on linked cash returns', () => {
    const day = '2026-11-24';
    const data = {
        settings: { exchangeRate: 15000 },
        cashboxes: [{ id: 'cb1', name: 'الصندوق', openingBalance: 100 }],
        invoices: [{ id: 'inv1', type: 'sales', paymentType: 'cash', payMethod: 'cash_pay', cashboxId: 'cb1', date: day, totalUSD: 50 }],
        returns: [{ id: 'ret1', type: 'sales_return', invoiceId: 'inv1', payMethod: 'cash_pay', cashboxId: 'cb1', date: day, totalUSD: 10, cashSettled: false }],
        vouchers: [],
        expenses: []
    };

    assert.equal(core.isSettledReturn(data.returns[0], data.invoices), false);
    assert.equal(core.calculateCashboxBalance('cb1', data), 150);
    const metrics = core.calculateEndOfDayMetrics(data, day);
    assert.equal(metrics.salesReturnsUSD, 10);
    assert.equal(metrics.cashSalesReturnsUSD, 0);
    assert.equal(metrics.netCashUSD, 50);
});

test('rejects refund vouchers when the account has no actual credit', () => {
    const data = {
        settings: { exchangeRate: 15000 },
        items: [{ id: 'itm1', name: 'صنف', type: 'stock', qty: 0 }],
        accounts: [{ id: 'acc1', name: 'عميل', type: 'customer' }],
        invoices: [{ id: 'inv1', type: 'sales', paymentType: 'credit', accountId: 'acc1', totalUSD: 100, items: [{ itemId: 'itm1', qty: 1, priceUSD: 100 }] }],
        returns: [{ id: 'ret1', type: 'sales_return', invoiceId: 'inv1', accountId: 'acc1', itemId: 'itm1', qty: 1, totalUSD: 100 }],
        vouchers: [{ id: 'vch1', type: 'payment', accountId: 'acc1', returnId: 'ret1', amountUSD: 100 }]
    };

    assert.equal(core.calculateAccountBalanceUSD(data, 'acc1'), 100);
    assert.equal(core.validateDatabaseBackup(data).ok, false);
    data.invoices[0].paymentType = 'cash';
    data.invoices[0].payMethod = 'card_check';
    assert.equal(core.calculateAccountBalanceUSD(data, 'acc1'), 0);
    assert.equal(core.validateDatabaseBackup(data).ok, true);
});

test('rejects a second refund voucher for an already cash-settled return', () => {
    const data = {
        settings: { exchangeRate: 15000 },
        items: [{ id: 'itm1', name: 'صنف', type: 'stock', qty: 0 }],
        accounts: [{ id: 'acc1', name: 'عميل', type: 'customer' }],
        invoices: [{ id: 'inv1', type: 'sales', paymentType: 'cash', payMethod: 'cash_pay', accountId: 'acc1', totalUSD: 100, items: [{ itemId: 'itm1', qty: 1, priceUSD: 100 }] }],
        returns: [{ id: 'ret1', type: 'sales_return', invoiceId: 'inv1', accountId: 'acc1', itemId: 'itm1', qty: 1, totalUSD: 100, payMethod: 'cash_pay' }],
        vouchers: [{ id: 'vch1', type: 'payment', accountId: 'acc1', returnId: 'ret1', amountUSD: 100 }]
    };

    assert.equal(core.isSettledReturn(data.returns[0], data.invoices), true);
    assert.equal(core.validateDatabaseBackup(data).ok, false);
});

test('validates linked refund vouchers and prevents over-refunding returns', () => {
    const data = {
        settings: { exchangeRate: 15000 },
        items: [{ id: 'itm1', name: 'صنف', type: 'stock', qty: 0 }],
        accounts: [
            { id: 'acc1', name: 'عميل', type: 'customer' },
            { id: 'acc2', name: 'مورد', type: 'supplier' }
        ],
        invoices: [
            { id: 'inv1', type: 'sales', paymentType: 'cash', payMethod: 'card_check', accountId: 'acc1', totalUSD: 120, items: [{ itemId: 'itm1', qty: 1, priceUSD: 120 }] },
            { id: 'inv2', type: 'purchase', paymentType: 'installment', accountId: 'acc2', downPaymentUSD: 0, totalUSD: 100, items: [{ itemId: 'itm1', qty: 1, priceUSD: 100 }] }
        ],
        vouchers: [
            { id: 'vch1', type: 'payment', accountId: 'acc2', invoiceId: 'inv2', amountUSD: 100 },
            { id: 'vch2', type: 'payment', accountId: 'acc1', returnId: 'ret1', source: 'return_refund', amountUSD: 120 },
            { id: 'vch3', type: 'receipt', accountId: 'acc2', returnId: 'ret2', source: 'return_refund', amountUSD: 100 }
        ],
        returns: [
            { id: 'ret1', type: 'sales_return', accountId: 'acc1', invoiceId: 'inv1', itemId: 'itm1', qty: 1, totalUSD: 120 },
            { id: 'ret2', type: 'purchase_return', accountId: 'acc2', invoiceId: 'inv2', itemId: 'itm1', qty: 1, totalUSD: 100 }
        ],
        installments: [
            { id: 'inst1', invoiceId: 'inv2', accountId: 'acc2', amountUSD: 100, originalAmountUSD: 100, paid: true }
        ]
    };

    assert.equal(core.validateDatabaseBackup(data).ok, true);
    assert.equal(core.calculateReturnRefundedUSD('ret1', data.vouchers), 120);
    assert.equal(core.refundVoucherTypeForReturn(data.returns[0]), 'payment');
    assert.equal(core.refundVoucherTypeForReturn(data.returns[1]), 'receipt');

    data.vouchers[1].type = 'receipt';
    assert.equal(core.validateDatabaseBackup(data).ok, false);
    data.vouchers[1].type = 'payment';
    data.vouchers.push({ id: 'vch4', type: 'payment', accountId: 'acc1', returnId: 'ret1', amountUSD: 1 });
    assert.equal(core.validateDatabaseBackup(data).ok, false);
});

test('rejects malformed, duplicate, unsafe, and non-numeric backup data', () => {
    const valid = {
        settings: { exchangeRate: 15000 },
        items: [{ id: 'itm_1', name: 'صنف' }],
        accounts: [],
        invoices: [],
        vouchers: []
    };

    assert.equal(core.validateDatabaseBackup(null).ok, false);
    assert.equal(core.validateDatabaseBackup({ ...valid, settings: {} }).ok, false);
    assert.equal(core.validateDatabaseBackup({ ...valid, items: [{ id: 'bad id', name: 'صنف' }] }).ok, false);
    assert.equal(core.validateDatabaseBackup({
        ...valid,
        accounts: [{ id: 'itm_1', name: 'حساب' }]
    }).ok, false);
    assert.equal(core.validateDatabaseBackup({
        ...valid,
        invoices: [{ id: 'inv_1', type: 'sales', items: [], totalUSD: 'not-a-number' }]
    }).ok, false);
    assert.equal(core.validateDatabaseBackup({
        ...valid,
        invoices: [{ id: 'inv_1', type: 'sales', items: [{ itemId: 'itm_1', qty: -2 }] }]
    }).ok, false);
    assert.equal(core.validateDatabaseBackup({
        ...valid,
        invoices: [{ id: 'inv_1', type: 'sales', items: [{ itemId: 'itm_1', qty: 1, priceUSD: 'invalid' }] }]
    }).ok, false);
    assert.equal(core.validateDatabaseBackup({
        ...valid,
        vouchers: [{ id: 'vch_1', type: 'receipt', amountUSD: -10 }]
    }).ok, false);
    assert.equal(core.validateDatabaseBackup({
        ...valid,
        items: [{ id: 'itm_1', name: 'صنف', qty: 'invalid' }]
    }).ok, false);

    const invoiceBackup = {
        ...valid,
        accounts: [{ id: 'acc_1', name: 'عميل', type: 'customer' }],
        invoices: [{ id: 'inv_1', type: 'sales', paymentType: 'cash', accountId: 'acc_1', totalUSD: 10, items: [{ itemId: 'itm_1', qty: 1 }] }]
    };
    assert.equal(core.validateDatabaseBackup({
        ...invoiceBackup,
        invoices: [{ ...invoiceBackup.invoices[0], totalUSD: undefined }]
    }).ok, false);
    assert.equal(core.validateDatabaseBackup({
        ...invoiceBackup,
        invoices: [{ ...invoiceBackup.invoices[0], paymentType: 'unknown' }]
    }).ok, false);
    assert.equal(core.validateDatabaseBackup({
        ...invoiceBackup,
        invoices: [{ ...invoiceBackup.invoices[0], accountId: 'acc_missing' }]
    }).ok, false);
    assert.equal(core.validateDatabaseBackup({
        ...invoiceBackup,
        invoices: [{ ...invoiceBackup.invoices[0], cashboxId: 'cb_missing' }]
    }).ok, false);
    assert.equal(core.validateDatabaseBackup({
        ...invoiceBackup,
        vouchers: [{ id: 'vch_1', type: 'receipt', accountId: 'acc_1', amountUSD: undefined }]
    }).ok, false);
    assert.equal(core.validateDatabaseBackup({
        ...invoiceBackup,
        vouchers: [{ id: 'vch_1', type: 'receipt', accountId: 'acc_1', amountUSD: 1, invoiceId: 'inv_missing' }]
    }).ok, false);
});
