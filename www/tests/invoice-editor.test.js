const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const suite = fs.readFileSync(path.join(__dirname, '../pro-suite.js'), 'utf8');

function between(source, start, end) {
    const offset = source.indexOf(start);
    assert.ok(offset >= 0);
    const finish = source.indexOf(end, offset + start.length);
    assert.ok(finish > offset);
    return source.slice(offset, finish);
}

function editor() {
    const fields = {
        'inv-currency': { value: 'USD', dataset: { currency: 'USD' } },
        'inv-discount': { value: '10' },
        'inv-discount-label': {},
        'inv-total-usd': {},
        'inv-total-syp': {},
        'inv-notes': { value: '' },
        'inv-payment-type': { value: 'credit' }
    };
    const rowFields = {
        '.row-item-select': { value: 'item' },
        '.row-qty': { value: '1' },
        '.row-price': { value: '100' },
        '.row-price-label': {},
        '.row-subtotal': {}
    };
    const row = { dataset: { priceUSD: '100' }, querySelector: name => rowFields[name] };
    const context = vm.createContext({
        db: { settings: { exchangeRate: 15000 } },
        document: { getElementById: id => fields[id], querySelectorAll: () => [row] },
        window: {}, handlePaymentTypeChange() {}
    });
    vm.runInContext(between(app, '        function handleInvoiceCurrencyChange()', '        function handlePaymentTypeChange()'), context);
    return { context, fields, rowFields, row };
}

test('converts discount with invoice prices in both directions without changing net value', () => {
    const { context, fields, rowFields } = editor();
    vm.runInContext('recalculateInvoice()', context);
    assert.equal(fields['inv-total-usd'].textContent, '$90.00');
    fields['inv-currency'].value = 'SYP';
    vm.runInContext('handleInvoiceCurrencyChange()', context);
    assert.equal(Number(rowFields['.row-price'].value), 1500000);
    assert.equal(Number(fields['inv-discount'].value), 150000);
    assert.equal(fields['inv-total-usd'].textContent, '$90.00');
    assert.equal(fields['inv-discount-label'].textContent, 'الخصم (ل.س)');
    fields['inv-currency'].value = 'USD';
    vm.runInContext('handleInvoiceCurrencyChange()', context);
    assert.equal(Number(fields['inv-discount'].value), 10);
    assert.equal(fields['inv-total-usd'].textContent, '$90.00');
});

test('same-currency changes do not repeatedly convert the discount', () => {
    const { context, fields } = editor();
    vm.runInContext('handleInvoiceCurrencyChange(); handleInvoiceCurrencyChange()', context);
    assert.equal(Number(fields['inv-discount'].value), 10);
});

test('settings defaults do not change a selected invoice draft', () => {
    const { context, fields } = editor();
    context.db.settings.defaultCurrency = 'SYP';
    context.db.settings.defaultPaymentType = 'cash';
    vm.runInContext(between(suite, '    window.applyAdvancedAppSettings = function()', '    window.populateAdvancedSettingsUI'), context);
    context.window.applyAdvancedAppSettings();
    assert.equal(fields['inv-currency'].value, 'USD');
    assert.equal(fields['inv-payment-type'].value, 'credit');
});

test('settings defaults preserve a discount-only draft', () => {
    const { context, fields, rowFields } = editor();
    rowFields['.row-item-select'].value = '';
    context.db.settings.defaultCurrency = 'SYP';
    vm.runInContext(between(suite, '    window.applyAdvancedAppSettings = function()', '    window.populateAdvancedSettingsUI'), context);
    context.window.applyAdvancedAppSettings();
    assert.equal(fields['inv-currency'].value, 'USD');
});

test('barcode repeats keep the negotiated price and only increment quantity', () => {
    const { context, fields, rowFields, row } = editor();
    rowFields['.row-price'].value = '80';
    row.dataset.priceUSD = '80';
    fields['inv-discount'].value = '0';
    context.db.items = [{ id: 'item', code: 'ABC', name: 'Test item', price: 100 }];
    context.barcodeTargetMode = 'invoice';
    context.currentInvoiceMode = 'sales';
    context.showToast = () => {};
    context.playBeepSound = () => {};
    context.onRowItemSelect = () => { throw new Error('Existing item must not be repriced'); };
    vm.runInContext(between(app, '        function handleBarcodeScanned(', '        async function openCameraBarcodeScanner('), context);
    vm.runInContext('handleBarcodeScanned("ABC")', context);
    assert.equal(Number(rowFields['.row-qty'].value), 2);
    assert.equal(Number(rowFields['.row-price'].value), 80);
    assert.equal(fields['inv-total-usd'].textContent, '$160.00');
});

test('draft identity distinguishes reset drafts and later edits', () => {
    const { context, fields } = editor();
    context.currentInvoiceMode = 'sales';
    context.invoiceDraftRevision = 1;
    context.installmentFrequency = 'monthly';
    context.document.querySelectorAll = () => Object.entries(fields).map(([id, field]) => ({ ...field, id }));
    vm.runInContext(between(app, '        function invoiceDraftState()', '        const origSaveInvoice'), context);
    const original = context.invoiceDraftState();
    context.invoiceDraftRevision += 1;
    assert.notEqual(context.invoiceDraftState(), original);
    context.invoiceDraftRevision -= 1;
    fields['inv-notes'].value = 'Later draft edit';
    assert.notEqual(context.invoiceDraftState(), original);
});
