const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../assets/libs/print-core.js'), 'utf8');

function loadPrintCore(document, schedule = fn => fn(), clear = () => {}) {
    const window = {};
    vm.runInNewContext(source, { window, document, setTimeout: schedule, clearTimeout: clear });
    return window.PA_PRINT;
}

function cssRule(html, selector) {
    const style = html.match(/<style>([\s\S]*?)<\/style>/);
    assert.ok(style, 'document contains print CSS');
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = style[1].match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
    assert.ok(match, `CSS rule exists: ${selector}`);
    return Object.fromEntries(match[1].split(';').filter(Boolean).map(declaration => {
        const separator = declaration.indexOf(':');
        return [declaration.slice(0, separator).trim(), declaration.slice(separator + 1).trim()];
    }));
}

function makeLabels(core, count) {
    return Array.from({ length: count }, (_, index) => core.labelMarkup({ name: `Label ${index}` }, '<svg></svg>'));
}

function labelPages(sheet) {
    return Array.from(sheet.matchAll(/<section class="pa-labels-page">([\s\S]*?)<\/section>/g), match => match[1]);
}

function labelsIn(page) {
    return (page.match(/class="pa-label"/g) || []).length;
}

function manualTimers() {
    const queue = new Map();
    let nextId = 0;
    return {
        setTimeout(callback, delay) {
            const id = ++nextId;
            queue.set(id, { callback, delay });
            return id;
        },
        clearTimeout(id) {
            queue.delete(id);
        },
        pending() {
            return Array.from(queue.values());
        },
        runNext() {
            assert.ok(queue.size, 'a timer is queued');
            const [id, timer] = queue.entries().next().value;
            queue.delete(id);
            timer.callback();
            return timer.delay;
        }
    };
}

test('retains the public API and normalizes supported paper sizes', () => {
    const core = loadPrintCore();
    assert.deepEqual(Object.keys(core).sort(), [
        'buildDocument', 'buildLabelSheet', 'chunkHtml', 'labelMarkup', 'normalizePaper', 'printDocument'
    ]);
    assert.equal(core.normalizePaper('a4').id, 'a4');
    assert.equal(core.normalizePaper('thermal').id, 'thermal');
    assert.equal(core.normalizePaper('58mm').id, '58mm');
    assert.equal(core.normalizePaper('unknown').id, 'a4');
});

test('preserves named A4, thermal80, and thermal58 pages with exact paper widths', () => {
    const core = loadPrintCore();
    const cases = [
        ['a4', 'pa-paper-a4', 'a4', 'A4 portrait', '210mm'],
        ['thermal', 'pa-paper-thermal', 'thermal80', '80mm 297mm', '80mm'],
        ['58mm', 'pa-paper-58mm', 'thermal58', '58mm 297mm', '58mm']
    ];
    for (const [paper, className, pageName, size, width] of cases) {
        const html = core.buildDocument('<article>مستند</article>', paper);
        assert.match(html, new RegExp(`class="${className}"`));
        assert.equal(cssRule(html, `@page ${pageName}`).size, size);
        assert.equal(cssRule(html, `@page ${pageName}`).margin, '0');
        const body = cssRule(html, `body.${className}`);
        assert.equal(body.width, width);
        assert.equal(body['min-height'], '297mm');
        assert.equal(body.page, pageName);
    }
    const narrow = core.buildDocument('', '58mm');
    const bodyClass = narrow.match(/<body class="([^"]*)"/)[1];
    assert.ok(!bodyClass.split(/\s+/).includes('pa-paper-thermal'));
    assert.doesNotMatch(narrow, /@media print\s*\{\s*html,\s*body\s*\{[^}]*width\s*:/);
});

test('builds one isolated document and escapes its title', () => {
    const core = loadPrintCore();
    const html = core.buildDocument('<article class="pa-invoice">فاتورة</article>', 'thermal', 'عنوان <تجريبي> & "آمن"', 'invoice');
    assert.match(html, /<!DOCTYPE html>/);
    assert.match(html, /<title>عنوان &lt;تجريبي&gt; &amp; &quot;آمن&quot;<\/title>/);
    assert.match(html, /class="pa-paper-thermal"/);
    assert.match(html, /@page thermal80/);
    assert.match(html, /class="pa-invoice"/);
    assert.doesNotMatch(html, /<section class="pa-labels-page"/);
});

test('uses exact border-box label cell geometry for every layout', () => {
    const core = loadPrintCore();
    const labels = makeLabels(core, 1);
    const a4 = core.buildDocument(core.buildLabelSheet(labels, 'a4_grid'), 'a4', 'ProAccountant', 'labels');
    const small = core.buildDocument(core.buildLabelSheet(labels, '40x25'), 'thermal', 'ProAccountant', 'labels');
    const single = core.buildDocument(core.buildLabelSheet(labels, '50x30'), '58mm', 'ProAccountant', 'labels');

    assert.equal(cssRule(a4, '*')['box-sizing'], 'border-box');
    assert.equal(cssRule(a4, '.pa-labels')['grid-auto-rows'], undefined);
    assert.equal(cssRule(a4, '.pa-labels-a4_grid')['grid-template-columns'], 'repeat(3, 50mm)');
    assert.equal(cssRule(a4, '.pa-labels-a4_grid')['grid-auto-rows'], '30mm');
    assert.equal(cssRule(a4, '.pa-labels-a4_grid .pa-label').width, '50mm');
    assert.equal(cssRule(a4, '.pa-labels-a4_grid .pa-label').height, '30mm');

    assert.equal(cssRule(small, '.pa-labels-40x25')['grid-template-columns'], '40mm');
    assert.equal(cssRule(small, '.pa-labels-40x25')['grid-auto-rows'], '25mm');
    assert.equal(cssRule(small, '.pa-labels-40x25').gap, '2mm');
    assert.equal(cssRule(small, '.pa-labels-40x25 .pa-label').width, '40mm');
    assert.equal(cssRule(small, '.pa-labels-40x25 .pa-label').height, '25mm');

    assert.equal(cssRule(single, '.pa-labels-50x30')['grid-template-columns'], '50mm');
    assert.equal(cssRule(single, '.pa-labels-50x30')['grid-auto-rows'], '30mm');
    assert.equal(cssRule(single, '.pa-labels-50x30 .pa-label').width, '50mm');
    assert.equal(cssRule(single, '.pa-labels-50x30 .pa-label').height, '30mm');
});

test('keeps label grids inside safe A4, thermal80, and thermal58 margins', () => {
    const core = loadPrintCore();
    const label = makeLabels(core, 1);
    const cases = [
        ['a4_grid', 'a4', 'pa-paper-a4', 210, 156],
        ['40x25', 'thermal', 'pa-paper-thermal', 80, 40],
        ['50x30', 'thermal', 'pa-paper-thermal', 80, 50],
        ['40x25', '58mm', 'pa-paper-58mm', 58, 40],
        ['50x30', '58mm', 'pa-paper-58mm', 58, 50]
    ];
    for (const [layout, paper, className, paperWidth, gridWidth] of cases) {
        const html = core.buildDocument(core.buildLabelSheet(label, layout), paper, 'ProAccountant', 'labels');
        const padding = parseFloat(cssRule(html, `body.pa-labels-document.${className} .pa-document`).padding);
        assert.ok(padding >= 3, `${layout} on ${paper} has a safe margin`);
        assert.ok(gridWidth <= paperWidth - (padding * 2), `${layout} fits inside ${paper}`);
    }
});

test('paginates labels in complete rows without losing or reordering items', () => {
    const core = loadPrintCore();
    const cases = [
        ['a4_grid', 49, [24, 24, 1]],
        ['40x25', 21, [10, 10, 1]],
        ['50x30', 17, [8, 8, 1]],
        ['invalid', 9, [8, 1]]
    ];
    for (const [layout, count, expected] of cases) {
        const sheet = core.buildLabelSheet(makeLabels(core, count), layout);
        const pages = labelPages(sheet);
        assert.deepEqual(pages.map(labelsIn), expected, `${layout} page sizes`);
        assert.equal(pages.reduce((total, page) => total + labelsIn(page), 0), count);
        assert.deepEqual(Array.from(sheet.matchAll(/class="pa-label-name">Label (\d+)</g), match => Number(match[1])),
            Array.from({ length: count }, (_, index) => index));
    }
    assert.equal(core.buildLabelSheet([], 'a4_grid'), '');
    assert.equal(core.buildLabelSheet(null, '50x30'), '');
});

test('keeps explicit label pages intact and avoids a trailing forced break', () => {
    const core = loadPrintCore();
    const html = core.buildDocument(core.buildLabelSheet(makeLabels(core, 25), 'a4_grid'), 'a4', 'ProAccountant', 'labels');
    const page = cssRule(html, '.pa-labels-page');
    assert.equal(page['break-inside'], 'avoid');
    assert.equal(page['page-break-inside'], 'avoid');
    assert.equal(page['break-after'], 'page');
    assert.equal(page['page-break-after'], 'always');
    const lastPage = cssRule(html, '.pa-labels-page:last-child');
    assert.equal(lastPage['break-after'], 'auto');
    assert.equal(lastPage['page-break-after'], 'auto');
});

test('escapes all label text while preserving trusted barcode SVG', () => {
    const core = loadPrintCore();
    const barcode = '<svg viewBox="0 0 10 10"><path d="M0 0h10" /></svg>';
    const label = core.labelMarkup({ name: '<صنف> & "أ"' }, barcode, {
        companyName: 'شركة & تجارة',
        code: "62'1123",
        priceText: '$10 <USD>'
    });
    assert.match(label, /&lt;صنف&gt; &amp; &quot;أ&quot;/);
    assert.match(label, /شركة &amp; تجارة/);
    assert.match(label, /62&#39;1123/);
    assert.match(label, /\$10 &lt;USD&gt;/);
    assert.ok(label.includes(barcode));
    const hidden = core.labelMarkup({ name: 'صنف' }, '<svg></svg>', { showCompany: false, showPrice: false });
    assert.doesNotMatch(hidden, /pa-label-company|pa-label-price/);
});

test('rejects unsafe layout names by falling back to 50x30', () => {
    const core = loadPrintCore();
    const sheet = core.buildLabelSheet(makeLabels(core, 1), '50x30"><script>alert(1)</script>');
    assert.match(sheet, /pa-labels-50x30/);
    assert.doesNotMatch(sheet, /<script>|alert\(1\)/);
});

test('uses full-width receipt items on narrow paper instead of cramped invoice columns', () => {
    const core = loadPrintCore();
    const html = core.buildDocument('<article class="pa-invoice"><table class="pa-invoice-table"></table><div class="pa-receipt-items"></div></article>', '58mm');
    assert.equal(cssRule(html, '.pa-receipt-items').display, 'none');
    assert.equal(cssRule(html, 'body.pa-paper-thermal .pa-invoice-table, body.pa-paper-58mm .pa-invoice-table').display, 'none');
    assert.equal(cssRule(html, 'body.pa-paper-thermal .pa-receipt-items, body.pa-paper-58mm .pa-receipt-items').display, 'block');
    assert.equal(cssRule(html, '.pa-receipt-item')['break-inside'], 'avoid');
    assert.equal(cssRule(html, '.pa-receipt-amounts')['flex-wrap'], 'wrap');
    assert.equal(cssRule(html, 'body.pa-paper-58mm .pa-invoice-banner')['flex-wrap'], 'wrap');
    assert.doesNotMatch(html, /td:nth-child\(5\)\s*\{\s*width: 13mm/);
});

test('chunks large Unicode HTML below the Android byte limit without splitting characters', () => {
    const core = loadPrintCore();
    const html = `<html><body>${'فاتورة عربية 😀 '.repeat(30000)}</body></html>`;
    const chunks = core.chunkHtml(html, 32000);
    assert.ok(chunks.length > 1);
    assert.equal(chunks.join(''), html);
    for (const chunk of chunks) {
        assert.ok(Buffer.byteLength(chunk, 'utf8') <= 128 * 1024);
        assert.doesNotMatch(chunk, /[\uD800-\uDBFF]$/u);
        assert.doesNotMatch(chunk, /^[\uDC00-\uDFFF]/u);
    }
    assert.equal(core.chunkHtml('', 32000).length, 0);
});

test('a print frame that never loads still cleans up and settles', async () => {
    const timers = manualTimers();
    let removed = false;
    let printCount = 0;
    const frame = {
        style: {},
        contentWindow: { focus() {}, print() { printCount += 1; } },
        setAttribute() {},
        remove() { removed = true; }
    };
    const document = {
        createElement() { return frame; },
        body: { appendChild() {} }
    };
    const core = loadPrintCore(document, timers.setTimeout, timers.clearTimeout);
    const printing = core.printDocument('<html><body>stalled</body></html>');
    assert.equal(timers.runNext(), 10000);
    assert.equal(printCount, 0);
    assert.equal(timers.runNext(), 2000);
    await assert.doesNotReject(printing);
    assert.equal(removed, true);
});

test('prints the supplied document and removes the iframe after cleanup', async () => {
    const timers = manualTimers();
    let printedDocument;
    let removed = false;
    const frame = {
        style: {},
        contentWindow: {
            focus() {},
            print() { printedDocument = frame.srcdoc; }
        },
        setAttribute() {},
        remove() { removed = true; }
    };
    const document = {
        createElement() { return frame; },
        body: { appendChild() {} }
    };
    const core = loadPrintCore(document, timers.setTimeout, timers.clearTimeout);
    const printing = core.printDocument('<html><body>PDF</body></html>');
    frame.onload();
    assert.equal(timers.runNext(), 180);
    assert.equal(timers.runNext(), 2000);
    await printing;
    assert.equal(printedDocument, '<html><body>PDF</body></html>');
    assert.equal(removed, true);
});

test('keeps the iframe alive through print dispatch and delayed cleanup', async () => {
    const timers = manualTimers();
    let appended = false;
    let removed = false;
    let printCount = 0;
    const frame = {
        style: {},
        contentWindow: {
            focus() {},
            print() { printCount += 1; }
        },
        setAttribute() {},
        remove() { removed = true; }
    };
    const document = {
        createElement() { return frame; },
        body: { appendChild() { appended = true; } }
    };
    const core = loadPrintCore(document, timers.setTimeout, timers.clearTimeout);
    let resolved = false;
    const printing = core.printDocument('<html><body>queued</body></html>');
    printing.then(() => { resolved = true; });

    assert.equal(appended, true);
    assert.equal(printCount, 0);
    frame.onload();
    assert.deepEqual(timers.pending().map(timer => timer.delay), [180]);
    assert.equal(timers.runNext(), 180);
    assert.equal(printCount, 1);
    assert.equal(removed, false);
    assert.deepEqual(timers.pending().map(timer => timer.delay), [2000]);
    await Promise.resolve();
    assert.equal(resolved, false, 'promise waits for delayed frame cleanup');
    assert.equal(removed, false, 'Android/browser print UI still owns the frame');

    assert.equal(timers.runNext(), 2000);
    await printing;
    assert.equal(removed, true);
    assert.equal(resolved, true);
    assert.equal(timers.pending().length, 0);
});

test('print and focus exceptions still clean up and resolve reliably', async () => {
    const timers = manualTimers();
    let printCount = 0;
    let removed = false;
    const frame = {
        style: {},
        contentWindow: {
            focus() { throw new Error('focus blocked'); },
            print() {
                printCount += 1;
                throw new Error('print blocked');
            }
        },
        setAttribute() {},
        remove() { removed = true; }
    };
    const document = {
        createElement() { return frame; },
        body: { appendChild() {} }
    };
    const core = loadPrintCore(document, timers.setTimeout, timers.clearTimeout);
    const printing = core.printDocument('<html><body>PDF</body></html>');
    frame.onload();
    timers.runNext();
    assert.equal(printCount, 1);
    assert.equal(removed, false);
    timers.runNext();
    await assert.doesNotReject(printing);
    assert.equal(removed, true);
});

test('duplicate load events cannot dispatch print or cleanup twice', async () => {
    const timers = manualTimers();
    let printCount = 0;
    let removeCount = 0;
    const frame = {
        style: {},
        contentWindow: {
            focus() {},
            print() { printCount += 1; }
        },
        setAttribute() {},
        remove() { removeCount += 1; }
    };
    const document = {
        createElement() { return frame; },
        body: { appendChild() {} }
    };
    const core = loadPrintCore(document, timers.setTimeout, timers.clearTimeout);
    const printing = core.printDocument('<html><body>PDF</body></html>');
    frame.onload();
    frame.onload();
    assert.equal(timers.pending().length, 1);
    timers.runNext();
    timers.runNext();
    await printing;
    assert.equal(printCount, 1);
    assert.equal(removeCount, 1);
});
