(function (global) {
    const PRINT_DELAY_MS = 180;
    const PRINT_CLEANUP_DELAY_MS = 2000;
    const PRINT_LOAD_TIMEOUT_MS = 10000;
    const labelLayouts = {
        a4_grid: { columns: 3, cellHeight: 30, rowGap: 3, pageHeight: 297, marginY: 6 },
        // Two 40mm columns cannot fit safely on an 80mm roll; use one centered column.
        '40x25': { columns: 1, cellHeight: 25, rowGap: 2, pageHeight: 297, marginY: 3 },
        '50x30': { columns: 1, cellHeight: 30, rowGap: 3, pageHeight: 297, marginY: 3 }
    };

    const documentCss = `
        :root { color-scheme: light; --pa-ink: #142235; --pa-muted: #5d6b7d; --pa-line: #d7e0e8; --pa-soft: #f6f9fb; --pa-sales: #0f766e; --pa-purchase: #1d4ed8; }
        * { box-sizing: border-box; }
        html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; color: var(--pa-ink) !important; }
        body { font-family: Tahoma, Arial, sans-serif; direction: rtl; text-align: right; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        @page a4 { size: A4 portrait; margin: 0; }
        @page thermal80 { size: 80mm 297mm; margin: 0; }
        @page thermal58 { size: 58mm 297mm; margin: 0; }
        body.pa-paper-a4 { width: 210mm; min-height: 297mm; page: a4; }
        body.pa-paper-thermal { width: 80mm; min-height: 297mm; page: thermal80; }
        body.pa-paper-58mm { width: 58mm; min-height: 297mm; page: thermal58; }
        .pa-document { width: 100%; min-height: inherit; background: #fff; }
        body.pa-paper-a4 .pa-document { padding: 10mm; }
        body.pa-paper-thermal .pa-document { padding: 4mm; font-size: 11px; }
        body.pa-paper-58mm .pa-document { padding: 3mm; font-size: 10px; }
        body.pa-labels-document.pa-paper-a4 .pa-document { padding: 6mm; }
        body.pa-labels-document.pa-paper-thermal .pa-document { padding: 3mm; }
        body.pa-labels-document.pa-paper-58mm .pa-document { padding: 3mm; }
        .pa-invoice { width: 100%; }
        .pa-invoice-header { display: flex; align-items: center; justify-content: space-between; gap: 4mm; padding-bottom: 4mm; margin-bottom: 4mm; border-bottom: 1px solid var(--pa-line); }
        .pa-company { display: flex; align-items: center; gap: 3mm; min-width: 0; }
        .pa-company-logo { width: 14mm; height: 14mm; border-radius: 2.5mm; object-fit: cover; border: 1px solid var(--pa-line); flex: 0 0 auto; }
        .pa-company-name { margin: 0; font-size: 20px; font-weight: 800; line-height: 1.3; }
        .pa-company-sub { margin: 1mm 0 0; color: var(--pa-muted); font-size: 11px; font-weight: 500; line-height: 1.5; }
        .pa-qr { width: 18mm; height: 18mm; border: 1px solid var(--pa-line); border-radius: 2mm; padding: 1mm; flex: 0 0 auto; }
        .pa-invoice-banner { display: flex; align-items: center; justify-content: space-between; gap: 3mm; margin-bottom: 4mm; padding: 3mm 4mm; border: 1px solid var(--pa-line); border-inline-start: 1.2mm solid var(--pa-purchase); border-radius: 3mm; background: var(--pa-soft); color: var(--pa-ink); font-size: 14px; font-weight: 800; }
        .pa-invoice-banner.is-sales { border-inline-start-color: var(--pa-sales); }
        .pa-invoice-banner.is-purchase { border-inline-start-color: var(--pa-purchase); }
        .pa-invoice-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.5mm 6mm; margin-bottom: 4mm; padding: 3.5mm 4mm; border: 1px solid var(--pa-line); border-radius: 3mm; background: var(--pa-soft); font-size: 11px; line-height: 1.6; }
        .pa-invoice-meta > div { min-width: 0; overflow-wrap: anywhere; }
        .pa-invoice-meta span { display: block; margin-bottom: 0.5mm; color: var(--pa-muted); font-size: 9px; font-weight: 600; }
        .pa-invoice-meta strong { font-size: 11px; font-weight: 800; }
        .pa-invoice-meta > div:last-child:nth-child(odd) { grid-column: 1 / -1; }
        .pa-invoice-table { width: 100%; margin-bottom: 4mm; border-collapse: collapse; table-layout: fixed; font-size: 11px; }
        .pa-invoice-table th { padding: 2.5mm 1.5mm; border-top: 1px solid var(--pa-line); border-bottom: 1px solid var(--pa-line); background: var(--pa-soft); color: var(--pa-muted); text-align: center; font-weight: 800; }
        .pa-invoice-table td { padding: 2.7mm 1.5mm; border-bottom: 1px solid var(--pa-line); text-align: center; vertical-align: top; overflow-wrap: anywhere; }
        .pa-invoice-table tbody tr:nth-child(even) td { background: #fbfcfe; }
        .pa-invoice-table td:nth-child(2) { text-align: right; font-weight: 700; }
        .pa-invoice-table th:nth-child(1), .pa-invoice-table td:nth-child(1) { width: 9mm; }
        .pa-invoice-table th:nth-child(2), .pa-invoice-table td:nth-child(2) { width: auto; }
        .pa-invoice-table th:nth-child(3), .pa-invoice-table td:nth-child(3) { width: 20mm; }
        .pa-invoice-table th:nth-child(4), .pa-invoice-table td:nth-child(4) { width: 24mm; }
        .pa-invoice-table th:nth-child(5), .pa-invoice-table td:nth-child(5) { width: 26mm; }
        .pa-invoice-totals { width: 100%; max-width: 100%; margin-top: 5mm; margin-inline: auto; padding: 3.5mm 4mm; border: 1px solid var(--pa-line); border-radius: 3mm; background: var(--pa-soft); text-align: start; }
        .pa-invoice-discount { display: flex; justify-content: space-between; gap: 3mm; margin-bottom: 1.5mm; color: var(--pa-muted); font-size: 11px; }
        .pa-invoice-net, .pa-invoice-syp { display: flex; justify-content: space-between; align-items: baseline; gap: 3mm; }
        .pa-invoice-net { margin-top: 2mm; padding-top: 2mm; border-top: 1px solid var(--pa-line); color: var(--pa-sales); font-size: 18px; font-weight: 900; }
        .pa-invoice.is-purchase .pa-invoice-net { color: var(--pa-purchase); }
        .pa-invoice-syp { margin-top: 1mm; color: var(--pa-muted); font-size: 13px; font-weight: 700; }
        .pa-invoice-notes { margin-top: 4mm; padding: 3mm 4mm; border: 1px solid #f3dfa8; border-inline-start: 1mm solid #d99a16; border-radius: 2mm; background: #fffbeb; font-size: 11px; line-height: 1.7; }
        .pa-document-footer { margin-top: 5mm; padding-top: 2.5mm; border-top: 1px solid var(--pa-line); color: var(--pa-muted); text-align: center; font-size: 8.5px; line-height: 1.6; }
        .pa-invoice thead { display: table-header-group; }
        .pa-invoice tr { break-inside: avoid; page-break-inside: avoid; }
        .pa-report { color: var(--pa-ink); font-size: 12px; }
        .pa-report h1, .pa-report h2, .pa-report h3 { margin: 0 0 4mm; text-align: center; }
        .pa-report table { width: 100%; border-collapse: collapse; table-layout: fixed; }
        .pa-report thead { display: table-header-group; }
        .pa-report tr { break-inside: avoid; page-break-inside: avoid; }
        .pa-report th, .pa-report td { padding: 2mm 1.5mm; border: 1px solid var(--pa-line); overflow-wrap: anywhere; text-align: right; vertical-align: top; }
        .pa-report th { background: #e2e8f0; color: #0f172a; text-align: center; font-weight: 900; }
        .pa-report .text-slate-400, .pa-report .text-slate-300 { color: var(--pa-ink) !important; }
        .pa-report .text-emerald-400, .pa-report .text-sky-300, .pa-report .text-amber-300 { color: #0f172a !important; }
        .pa-report .bg-slate-800 { background: #e2e8f0 !important; }
        .pa-labels-page { display: block; margin: 0; padding: 0; break-inside: avoid; page-break-inside: avoid; break-after: page; page-break-after: always; }
        .pa-labels-page:last-child { break-after: auto; page-break-after: auto; }
        .pa-labels { display: grid; align-content: start; justify-content: center; gap: 3mm; width: 100%; }
        .pa-labels-a4_grid { grid-template-columns: repeat(3, 50mm); grid-auto-rows: 30mm; }
        .pa-labels-40x25 { grid-template-columns: 40mm; grid-auto-rows: 25mm; gap: 2mm; }
        .pa-labels-50x30 { grid-template-columns: 50mm; grid-auto-rows: 30mm; }
        .pa-label { display: flex; flex-direction: column; align-items: stretch; justify-content: center; width: 100%; min-width: 0; height: 30mm; overflow: hidden; padding: 1.5mm; border: 1px solid #94a3b8; background: #fff; color: #000; text-align: center; break-inside: avoid; page-break-inside: avoid; }
        .pa-labels-a4_grid .pa-label { width: 50mm; height: 30mm; }
        .pa-labels-40x25 .pa-label { width: 40mm; height: 25mm; padding: 1mm; }
        .pa-labels-50x30 .pa-label { width: 50mm; height: 30mm; }
        .pa-label-company { overflow: hidden; font-size: 8px; font-weight: 800; line-height: 1.15; text-overflow: ellipsis; white-space: nowrap; }
        .pa-label-name { overflow: hidden; margin-top: 0.5mm; font-size: 9px; font-weight: 900; line-height: 1.15; text-overflow: ellipsis; white-space: nowrap; }
        .pa-barcode { width: 100%; min-height: 0; margin: 0.5mm auto; }
        .pa-barcode svg { display: block; width: 100%; height: 10mm; max-width: 100%; }
        .pa-label-code { overflow: hidden; font-family: monospace; font-size: 8px; font-weight: 700; line-height: 1.1; letter-spacing: 0.3px; text-overflow: ellipsis; white-space: nowrap; }
        .pa-label-price { overflow: hidden; margin-top: 0.5mm; font-size: 10px; font-weight: 900; line-height: 1.1; text-overflow: ellipsis; white-space: nowrap; }
        .pa-labels-40x25 .pa-barcode svg { height: 8mm; }
        .pa-labels-40x25 .pa-label-price { font-size: 9px; }
        .pa-line-note { display: block; margin-top: 1mm; color: var(--pa-muted); font-size: 10px; font-weight: 400; white-space: pre-wrap; }
        .pa-receipt-items { display: none; }
        .pa-invoice-notes { white-space: pre-wrap; overflow-wrap: anywhere; }
        .pa-company-name, .pa-company-sub, .pa-invoice-meta { overflow-wrap: anywhere; }
        /* ===== قوالب الفاتورة (A4) — اللون الرئيسي عبر --pa-acc ===== */
        .pa-invoice { --pa-acc: var(--pa-sales); }
        .pa-invoice.is-purchase { --pa-acc: var(--pa-purchase); }
        .pa-invoice[style*="--pa-acc"] .pa-invoice-net { color: var(--pa-acc); }
        .pa-invoice-banner { border-inline-start-color: var(--pa-acc) !important; }
        .pa-invoice-net { color: var(--pa-acc); }
        .pa-invoice-table th { color: var(--pa-ink); }
        /* 1) corporate — شريط رأس ملوّن وجدول بترويسة ملوّنة */
        body.pa-paper-a4 .tpl-corporate .pa-invoice-header { padding: 5mm; margin: -10mm -10mm 5mm; border: 0; background: var(--pa-acc); color: #fff; }
        body.pa-paper-a4 .tpl-corporate .pa-company-name, body.pa-paper-a4 .tpl-corporate .pa-company-sub { color: #fff; }
        body.pa-paper-a4 .tpl-corporate .pa-company-logo, body.pa-paper-a4 .tpl-corporate .pa-qr { background: #fff; border-color: #fff; }
        body.pa-paper-a4 .tpl-corporate .pa-invoice-banner { background: #fff; border: 0; border-bottom: 0.6mm solid var(--pa-acc); border-radius: 0; padding: 2mm 0; font-size: 16px; }
        body.pa-paper-a4 .tpl-corporate .pa-invoice-meta { background: #fff; border: 0; border-radius: 0; padding: 0 0 3mm; border-bottom: 1px solid var(--pa-line); }
        body.pa-paper-a4 .tpl-corporate .pa-invoice-table th { background: var(--pa-acc); color: #fff; border: 0; }
        body.pa-paper-a4 .tpl-corporate .pa-invoice-table tbody tr:nth-child(even) td { background: #f3f6f9; }
        body.pa-paper-a4 .tpl-corporate .pa-invoice-totals { background: #fff; border: 0; border-top: 0.8mm solid var(--pa-acc); border-radius: 0; box-shadow: 0 0 0 1px var(--pa-line); }
        /* 2) classic — رسمي بحدود مزدوجة */
        body.pa-paper-a4 .tpl-classic { font-family: 'Times New Roman', Tahoma, serif; border: 0.5mm double #222; padding: 5mm; }
        body.pa-paper-a4 .tpl-classic .pa-invoice-header { justify-content: center; flex-direction: row-reverse; border-bottom: 0.5mm double #222; text-align: center; }
        body.pa-paper-a4 .tpl-classic .pa-company { flex-direction: column; text-align: center; }
        body.pa-paper-a4 .tpl-classic .pa-invoice-banner { justify-content: center; gap: 8mm; background: #fff; border: 0; border-top: 0.3mm solid #222; border-bottom: 0.3mm solid #222; border-radius: 0; font-size: 16px; }
        body.pa-paper-a4 .tpl-classic .pa-invoice-meta { background: #fff; border: 0.3mm solid #222; border-radius: 0; }
        body.pa-paper-a4 .tpl-classic .pa-invoice-table th, body.pa-paper-a4 .tpl-classic .pa-invoice-table td { border: 0.3mm solid #222; }
        body.pa-paper-a4 .tpl-classic .pa-invoice-table th { background: #ececec; color: #000; }
        body.pa-paper-a4 .tpl-classic .pa-invoice-table tbody tr:nth-child(even) td { background: #fff; }
        body.pa-paper-a4 .tpl-classic .pa-invoice-totals { background: #fff; border: 0.3mm solid #222; border-radius: 0; }
        body.pa-paper-a4 .tpl-classic .pa-invoice-net { color: #000; border-top-color: #222; }
        /* 3) simple — خفيف بخطوط رفيعة */
        body.pa-paper-a4 .tpl-simple .pa-invoice-header { border-bottom: 0.8mm solid var(--pa-acc); }
        body.pa-paper-a4 .tpl-simple .pa-invoice-banner { background: none; border: 0; padding: 0; font-size: 18px; color: var(--pa-acc); }
        body.pa-paper-a4 .tpl-simple .pa-invoice-meta { background: none; border: 0; border-radius: 0; padding: 0 0 3mm; }
        body.pa-paper-a4 .tpl-simple .pa-invoice-table th { background: none; border-top: 0; border-bottom: 0.5mm solid var(--pa-acc); color: var(--pa-acc); }
        body.pa-paper-a4 .tpl-simple .pa-invoice-table tbody tr:nth-child(even) td { background: none; }
        body.pa-paper-a4 .tpl-simple .pa-invoice-totals { background: none; border: 0; border-top: 0.5mm solid var(--pa-acc); border-radius: 0; padding-inline: 0; }
        /* 4) plain — أبيض وأسود موفّر للحبر */
        body.pa-paper-a4 .tpl-plain { --pa-acc: #000; }
        body.pa-paper-a4 .tpl-plain .pa-invoice-header { border-bottom: 0.4mm solid #000; }
        body.pa-paper-a4 .tpl-plain .pa-invoice-banner { background: #fff; border: 0.4mm solid #000; border-radius: 0; }
        body.pa-paper-a4 .tpl-plain .pa-invoice-meta, body.pa-paper-a4 .tpl-plain .pa-invoice-totals { background: #fff; border: 0.4mm solid #000; border-radius: 0; }
        body.pa-paper-a4 .tpl-plain .pa-invoice-table th, body.pa-paper-a4 .tpl-plain .pa-invoice-table td { border: 0.3mm solid #000; }
        body.pa-paper-a4 .tpl-plain .pa-invoice-table th { background: #e5e5e5; color: #000; }
        body.pa-paper-a4 .tpl-plain .pa-invoice-table tbody tr:nth-child(even) td { background: #fff; }
        body.pa-paper-a4 .tpl-plain .pa-invoice-net, body.pa-paper-a4 .tpl-plain .pa-invoice-syp, body.pa-paper-a4 .tpl-plain .pa-invoice-discount { color: #000; }
        /* 5) compact — كثيف لفواتير طويلة */
        body.pa-paper-a4 .tpl-compact { font-size: 10px; }
        body.pa-paper-a4 .tpl-compact .pa-company-name { font-size: 16px; }
        body.pa-paper-a4 .tpl-compact .pa-company-logo { width: 11mm; height: 11mm; }
        body.pa-paper-a4 .tpl-compact .pa-qr { width: 14mm; height: 14mm; }
        body.pa-paper-a4 .tpl-compact .pa-invoice-header { padding-bottom: 2mm; margin-bottom: 2mm; }
        body.pa-paper-a4 .tpl-compact .pa-invoice-banner { padding: 1.5mm 3mm; margin-bottom: 2mm; font-size: 12px; }
        body.pa-paper-a4 .tpl-compact .pa-invoice-meta { grid-template-columns: repeat(3, minmax(0, 1fr)); padding: 2mm 3mm; margin-bottom: 2mm; font-size: 10px; }
        body.pa-paper-a4 .tpl-compact .pa-invoice-table { font-size: 10px; margin-bottom: 2mm; }
        body.pa-paper-a4 .tpl-compact .pa-invoice-table th { padding: 1.5mm 1mm; }
        body.pa-paper-a4 .tpl-compact .pa-invoice-table td { padding: 1.2mm 1mm; }
        body.pa-paper-a4 .tpl-compact .pa-invoice-totals { padding: 2mm 3mm; }
        body.pa-paper-a4 .tpl-compact .pa-invoice-net { font-size: 15px; }
        /* 6) modern (الافتراضي): شريط لوني جانبي + جدول مخطط */
        body.pa-paper-a4 .tpl-modern .pa-invoice-table th { background: color-mix(in srgb, var(--pa-acc) 10%, #fff); color: var(--pa-acc); }
        body.pa-paper-a4 .tpl-modern .pa-invoice-totals { background: color-mix(in srgb, var(--pa-acc) 6%, #fff); border-color: color-mix(in srgb, var(--pa-acc) 35%, #fff); }
        /* مربع الإجمالي: أعرض وفي منتصف الورقة لكل التصاميم */
        body.pa-paper-a4 .pa-invoice .pa-invoice-totals { width: 100%; margin-inline: 0; padding: 4mm 6mm; }
        body.pa-paper-a4 .pa-invoice .pa-invoice-discount { font-size: 12px; }
        body.pa-paper-a4 .pa-invoice .pa-invoice-net { font-size: 20px; }
        body.pa-paper-a4 .tpl-simple .pa-invoice-totals { padding-inline: 6mm; }
        /* كشف الحساب: 7 أعمدة */
        .pa-stmt-table th:nth-child(1), .pa-stmt-table td:nth-child(1) { width: 8mm; }
        .pa-stmt-table th:nth-child(2), .pa-stmt-table td:nth-child(2) { width: 22mm; text-align: center; font-weight: 400; }
        .pa-stmt-table th:nth-child(3), .pa-stmt-table td:nth-child(3) { width: 22mm; }
        .pa-stmt-table th:nth-child(4), .pa-stmt-table td:nth-child(4) { width: auto; text-align: right; }
        .pa-stmt-table th:nth-child(5), .pa-stmt-table td:nth-child(5), .pa-stmt-table th:nth-child(6), .pa-stmt-table td:nth-child(6) { width: 22mm; }
        .pa-stmt-table th:nth-child(7), .pa-stmt-table td:nth-child(7) { width: 30mm; }
        .pa-stmt-table small { color: var(--pa-muted); font-size: 9px; }
        body.pa-paper-thermal .pa-statement .pa-invoice-table, body.pa-paper-58mm .pa-statement .pa-invoice-table { display: table; font-size: 8px; }
        /* السند: خانات التوقيع */
        .pa-signatures { display: flex; justify-content: space-between; gap: 10mm; margin-top: 14mm; }
        .pa-signatures > div { flex: 1; padding-top: 2mm; border-top: 1px dashed var(--pa-ink); text-align: center; font-size: 11px; color: var(--pa-muted); }
        .pa-voucher .pa-invoice-net { font-size: 22px; }
        /* التقارير */
        .pa-rmeta { margin: 0 0 3mm; color: var(--pa-muted); font-size: 9.5px; }
        .pa-rkpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 2.5mm; margin-bottom: 4mm; }
        .pa-rkpis > div { padding: 2.5mm 3mm; border: 1px solid var(--pa-line); border-radius: 2.5mm; background: var(--pa-soft); border-top: 0.8mm solid var(--pa-acc); }
        .pa-rkpis span { display: block; color: var(--pa-muted); font-size: 9px; font-weight: 700; }
        .pa-rkpis b { display: block; margin-top: 1mm; font-size: 13px; font-weight: 900; }
        .pa-rkpis small { color: var(--pa-muted); font-size: 9px; }
        .pa-rtable { table-layout: auto; }
        .pa-rtable th, .pa-rtable td { width: auto !important; text-align: center; }
        .pa-rtable td:first-child, .pa-rtable th:first-child { text-align: right; font-weight: 700; }
        .pa-rtable.pa-rdense { font-size: 9px; }
        .pa-rtable.pa-rdense th, .pa-rtable.pa-rdense td { padding: 1.6mm 1mm; }
        .pa-rsub td { font-weight: 900; background: var(--pa-soft) !important; }
        .pa-rtotal td, .pa-invoice-table tfoot td { font-weight: 900; border-top: 0.5mm solid var(--pa-acc); background: color-mix(in srgb, var(--pa-acc) 8%, #fff) !important; }
        .pa-invoice-table tfoot { display: table-footer-group; }
        .pa-rdoc .neg { color: #b91c1c; }
        body.pa-paper-thermal .pa-rkpis, body.pa-paper-58mm .pa-rkpis { grid-template-columns: 1fr 1fr; }
        body.pa-paper-thermal .pa-rdoc .pa-invoice-table, body.pa-paper-58mm .pa-rdoc .pa-invoice-table { display: table; font-size: 8px; }
        /* أرقام الجدول: محاذاة موحدة */
        .pa-invoice-table td:nth-child(n+3), .pa-invoice-table th:nth-child(n+3) { font-variant-numeric: tabular-nums; }
        /* تذييل الصفحة الحرارية: خط فاصل متقطع */
        body.pa-paper-thermal .pa-document-footer, body.pa-paper-58mm .pa-document-footer { border-top: 1px dashed #000; }

        body.pa-paper-thermal .pa-invoice-table, body.pa-paper-58mm .pa-invoice-table { display: none; }
        body.pa-paper-thermal .pa-receipt-items, body.pa-paper-58mm .pa-receipt-items { display: block; }
        .pa-receipt-item { padding: 2.5mm 0; border-bottom: 1px solid var(--pa-line); break-inside: avoid; page-break-inside: avoid; overflow-wrap: anywhere; }
        .pa-receipt-item > strong { display: block; font-size: 12px; line-height: 1.5; }
        .pa-receipt-amounts { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 1mm 3mm; margin-top: 1mm; color: var(--pa-muted); font-size: 10px; }
        .pa-receipt-amounts b { color: var(--pa-ink); }
        body.pa-paper-thermal .pa-company-name { font-size: 15px; }
        body.pa-paper-thermal .pa-company-sub { font-size: 9px; }
        body.pa-paper-thermal .pa-company-logo { width: 11mm; height: 11mm; }
        body.pa-paper-thermal .pa-qr { width: 15mm; height: 15mm; }
        body.pa-paper-thermal .pa-invoice-banner { margin-bottom: 3mm; padding: 2.5mm 3mm; background: #fff; font-size: 11px; }
        body.pa-paper-thermal .pa-invoice-meta { gap: 1mm 3mm; margin-bottom: 3mm; padding: 2.5mm 3mm; background: #fff; font-size: 10px; }
        body.pa-paper-thermal .pa-invoice-totals { width: 100%; margin-inline: 0; margin-top: 3mm; padding: 3mm; background: #fff; }
        body.pa-paper-thermal .pa-invoice-net { font-size: 16px; }
        body.pa-paper-thermal .pa-invoice-syp { font-size: 11px; }
        body.pa-paper-58mm .pa-company-name { font-size: 13px; }
        body.pa-paper-58mm .pa-company-sub { font-size: 8px; }
        body.pa-paper-58mm .pa-company-logo { width: 9mm; height: 9mm; }
        body.pa-paper-58mm .pa-qr { width: 11mm; height: 11mm; }
        body.pa-paper-58mm .pa-invoice-header { gap: 2mm; padding-bottom: 3mm; margin-bottom: 3mm; }
        body.pa-paper-58mm .pa-company { gap: 2mm; }
        body.pa-paper-58mm .pa-invoice-banner { flex-wrap: wrap; gap: 1mm; margin-bottom: 3mm; padding: 2mm; background: #fff; font-size: 10px; }
        body.pa-paper-58mm .pa-invoice-meta { grid-template-columns: 1fr; gap: 1.5mm; margin-bottom: 3mm; padding: 2mm; background: #fff; font-size: 9px; }
        body.pa-paper-58mm .pa-invoice-meta span { font-size: 8px; }
        body.pa-paper-58mm .pa-invoice-meta strong { font-size: 9px; }
        body.pa-paper-58mm .pa-invoice-totals { margin-top: 3mm; padding: 2.5mm; background: #fff; }
        body.pa-paper-58mm .pa-invoice-net { font-size: 14px; }
        body.pa-paper-58mm .pa-invoice-syp { font-size: 10px; }
        body.pa-paper-58mm .pa-invoice-discount { font-size: 9px; }
        body.pa-paper-58mm .pa-receipt-item > strong { font-size: 11px; }
        body.pa-paper-58mm .pa-receipt-amounts { font-size: 9px; }
        @media screen {
            body { width: 100% !important; min-height: 100vh; }
            body.pa-paper-a4 { max-width: 210mm; }
            body.pa-paper-thermal { max-width: 80mm; }
            body.pa-paper-58mm { max-width: 58mm; }
            .pa-document { min-height: 100vh; }
        }
        @media print {
            html, body { min-height: 0 !important; }
            .pa-document { min-height: 0; }
        }
    `;

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[char]));
    }

    function normalizePaper(paper) {
        if (paper === '58mm') return { id: '58mm', className: 'pa-paper-58mm' };
        if (paper === 'thermal') return { id: 'thermal', className: 'pa-paper-thermal' };
        return { id: 'a4', className: 'pa-paper-a4' };
    }

    function buildDocument(content, paper = 'a4', title = 'ProAccountant', kind = 'document') {
        const normalized = normalizePaper(paper);
        const safeTitle = escapeHtml(title);
        const safeKind = kind === 'labels' ? ' pa-labels-document' : '';
        return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title><style>${documentCss}</style></head><body class="${normalized.className}${safeKind}"><main class="pa-document">${content || ''}</main></body></html>`;
    }

    function labelMarkup(item, barcodeHtml, options = {}) {
        const showCompany = options.showCompany !== false;
        const showPrice = options.showPrice !== false;
        return `<div class="pa-label">${showCompany ? `<div class="pa-label-company">${escapeHtml(options.companyName || '')}</div>` : ''}<div class="pa-label-name">${escapeHtml(item.name || '')}</div><div class="pa-barcode">${barcodeHtml || ''}</div><div class="pa-label-code">${escapeHtml(options.code || '')}</div>${showPrice ? `<div class="pa-label-price">${escapeHtml(options.priceText || '')}</div>` : ''}</div>`;
    }

    function buildLabelSheet(labels, layout = '50x30') {
        const safeLayout = ['a4_grid', '40x25', '50x30'].includes(layout) ? layout : '50x30';
        const settings = labelLayouts[safeLayout];
        const items = Array.isArray(labels) ? labels : [];
        if (!items.length) return '';

        // Chunk only complete rows so browser grid fragmentation cannot split a row.
        const usableHeight = settings.pageHeight - (settings.marginY * 2);
        const rowsPerPage = Math.max(1, Math.floor((usableHeight + settings.rowGap) / (settings.cellHeight + settings.rowGap)));
        const labelsPerPage = rowsPerPage * settings.columns;
        const pages = [];
        for (let index = 0; index < items.length; index += labelsPerPage) {
            pages.push(`<section class="pa-labels-page"><div class="pa-labels pa-labels-${safeLayout}">${items.slice(index, index + labelsPerPage).join('')}</div></section>`);
        }
        return pages.join('');
    }

    function chunkHtml(html, chunkSize = 32000) {
        const source = String(html || '');
        const size = Math.max(2, Math.floor(Number(chunkSize)) || 32000);
        const chunks = [];
        let offset = 0;
        while (offset < source.length) {
            let end = Math.min(offset + size, source.length);
            if (end < source.length && /[\uD800-\uDBFF]/.test(source.charAt(end - 1))) {
                end = end === offset + 1 ? end + 1 : end - 1;
            }
            chunks.push(source.slice(offset, end));
            offset = end;
        }
        return chunks;
    }

    function printDocument(fullDocument) {
        return new Promise(resolve => {
            const frame = document.createElement('iframe');
            let started = false;
            let settled = false;
            let loadTimer = null;
            frame.setAttribute('aria-hidden', 'true');
            frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;background:#fff;z-index:-1;opacity:0;pointer-events:none;';
            const cleanup = () => {
                if (settled) return;
                settled = true;
                if (loadTimer !== null) clearTimeout(loadTimer);
                // Android WebView can queue print UI after print() returns.
                setTimeout(() => {
                    try {
                        frame.remove();
                    } catch (_) {
                        // The print promise must settle even if the frame is already detached.
                    }
                    resolve();
                }, PRINT_CLEANUP_DELAY_MS);
            };
            frame.onload = () => {
                if (started || settled) return;
                if (loadTimer !== null) clearTimeout(loadTimer);
                started = true;
                setTimeout(() => {
                    try {
                        frame.contentWindow.focus();
                    } catch (_) {
                        // Focus is optional; continue to the print dialog.
                    }
                    try {
                        frame.contentWindow.print();
                    } catch (_) {
                        // A blocked print dialog must not reject or skip cleanup.
                    }
                    cleanup();
                }, PRINT_DELAY_MS);
            };
            frame.onerror = cleanup;
            frame.srcdoc = fullDocument;
            document.body.appendChild(frame);
            loadTimer = setTimeout(() => {
                if (!started) cleanup();
            }, PRINT_LOAD_TIMEOUT_MS);
        });
    }

    global.PA_PRINT = {
        buildDocument,
        buildLabelSheet,
        chunkHtml,
        labelMarkup,
        normalizePaper,
        printDocument
    };
})(window);
