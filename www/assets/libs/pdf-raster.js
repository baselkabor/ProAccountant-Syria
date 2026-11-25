/* PA_PDF: يحوّل نفس مستند المعاينة (HTML) إلى PDF مطابق 100% للمعاينة
   عبر رسم المستند كصورة (SVG foreignObject → Canvas) ثم كتابة ملف PDF بصفحات JPEG.
   لا يعتمد على مكتبات خارجية ويعمل بدون إنترنت. */
(function (global) {
    const PAPER = {
        a4: { widthPx: 794, widthPt: 595.28, pageHeightPt: 841.89, paged: true },
        thermal: { widthPx: 302, widthPt: 226.77, paged: false },
        '58mm': { widthPx: 219, widthPt: 164.41, paged: false }
    };
    const SCALE = 2;
    const QUALITY = 0.9;

    function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

    async function loadFrame(html, widthPx) {
        const frame = document.createElement('iframe');
        frame.setAttribute('aria-hidden', 'true');
        frame.style.cssText = `position:fixed;left:-20000px;top:0;width:${widthPx}px;height:1200px;border:0;opacity:0;pointer-events:none;`;
        document.body.appendChild(frame);
        await new Promise(resolve => { frame.onload = resolve; frame.srcdoc = html; });
        const doc = frame.contentDocument;
        try { if (doc.fonts && doc.fonts.ready) await doc.fonts.ready; } catch (e) {}
        await Promise.all(Array.from(doc.images).map(img => img.complete ? null : new Promise(r => { img.onload = img.onerror = r; })));
        await wait(60);
        return frame;
    }

    /* نقاط القطع الآمنة بين الصفحات (لا نقطع صف جدول أو مربع الإجمالي) */
    function breakCandidates(doc) {
        const sel = 'tr, .pa-receipt-item, .pa-invoice-totals, .pa-invoice-notes, .pa-document-footer, .pa-invoice-meta, .pa-labels-page, .pa-report h2, .pa-report h3, .pa-report > div';
        const ys = new Set();
        doc.querySelectorAll(sel).forEach(el => {
            const r = el.getBoundingClientRect();
            ys.add(Math.round(r.top));
        });
        return Array.from(ys).sort((a, b) => a - b);
    }

    async function rasterize(html, paperId) {
        const paper = PAPER[paperId] || PAPER.a4;
        const frame = await loadFrame(html, paper.widthPx);
        try {
            const doc = frame.contentDocument;
            const root = doc.documentElement;
            const width = paper.widthPx;
            let height = Math.ceil(Math.max(root.scrollHeight, doc.body.scrollHeight));
            if (!paper.paged) {
                /* الورق الحراري: طول الصفحة = طول المحتوى الفعلي (بدون الحد الأدنى 297mm) */
                doc.body.style.minHeight = '0';
                const main = doc.querySelector('.pa-document') || doc.body;
                height = Math.ceil(main.getBoundingClientRect().bottom + 4);
            }
            frame.style.height = height + 'px';
            const cuts = breakCandidates(doc);
            const xhtml = new XMLSerializer().serializeToString(root);
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject x="0" y="0" width="${width}" height="${height}">${xhtml}</foreignObject></svg>`;
            const img = new Image();
            img.decoding = 'sync';
            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = () => reject(new Error('تعذر رسم المستند'));
                img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
            });
            await wait(30);
            const full = document.createElement('canvas');
            full.width = Math.round(width * SCALE);
            full.height = Math.round(height * SCALE);
            const ctx = full.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, full.width, full.height);
            ctx.drawImage(img, 0, 0, full.width, full.height);

            const pages = [];
            if (!paper.paged) {
                pages.push({ canvas: full, widthPt: paper.widthPt, heightPt: paper.widthPt * height / width });
                return pages;
            }
            const pageH = Math.round(width * 297 / 210);       /* 1123px */
            const margin = Math.round(10 * width / 210);        /* 10mm */
            /* نهاية المحتوى الفعلي: نتجاهل الفراغ الناتج عن الحد الأدنى لارتفاع A4 */
            const contentBottom = Math.max(0, ...Array.from(doc.querySelectorAll('.pa-document *')).map(e => Math.ceil(e.getBoundingClientRect().bottom)));
            if (contentBottom > 0) height = Math.min(height, contentBottom + margin);
            let start = 0;
            let first = true;
            while (start < height - 2) {
                const room = first ? pageH : pageH - margin * 2;
                let end = start + room;
                if (end >= height) {
                    end = height;
                } else {
                    const safe = cuts.filter(y => y > start + room * 0.5 && y <= end);
                    if (safe.length) end = safe[safe.length - 1];
                }
                /* تجاهل بقايا فارغة في آخر الصفحة (الحد الأدنى لارتفاع A4) */
                const page = document.createElement('canvas');
                page.width = Math.round(width * SCALE);
                page.height = Math.round(pageH * SCALE);
                const pctx = page.getContext('2d');
                pctx.fillStyle = '#ffffff';
                pctx.fillRect(0, 0, page.width, page.height);
                const offsetY = first ? 0 : margin;
                pctx.drawImage(full, 0, Math.round(start * SCALE), full.width, Math.round((end - start) * SCALE),
                    0, Math.round(offsetY * SCALE), page.width, Math.round((end - start) * SCALE));
                pages.push({ canvas: page, widthPt: paper.widthPt, heightPt: paper.pageHeightPt });
                start = end;
                first = false;
                if (pages.length > 60) break;
                if (start >= height - 2) break;
            }
            return pages;
        } finally {
            frame.remove();
        }
    }

    function base64ToBytes(b64) {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    function bytesToBase64(bytes) {
        let s = '';
        const CH = 0x8000;
        for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
        return btoa(s);
    }

    function buildPdf(pages) {
        const enc = new TextEncoder();
        const parts = [];
        const offsets = [];
        let length = 0;
        const push = data => {
            const b = typeof data === 'string' ? enc.encode(data) : data;
            parts.push(b);
            length += b.length;
        };
        push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
        const n = pages.length;
        /* 1: Catalog, 2: Pages, ثم لكل صفحة: Page, Content, Image */
        const pageObj = i => 3 + i * 3;
        const obj = (id, body) => { offsets[id] = length; push(`${id} 0 obj\n`); body(); push('\nendobj\n'); };
        obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
        obj(2, () => push(`<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>`));
        pages.forEach((p, i) => {
            const id = pageObj(i);
            const w = p.widthPt.toFixed(2);
            const h = p.heightPt.toFixed(2);
            const jpeg = base64ToBytes(p.canvas.toDataURL('image/jpeg', QUALITY).split(',')[1]);
            obj(id, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`));
            const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
            obj(id + 1, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
            obj(id + 2, () => {
                push(`<< /Type /XObject /Subtype /Image /Width ${p.canvas.width} /Height ${p.canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
                push(jpeg);
                push('\nendstream');
            });
        });
        const total = 3 + n * 3;
        const xref = length;
        let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
        for (let i = 1; i < total; i++) x += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
        push(x);
        push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
        const out = new Uint8Array(length);
        let pos = 0;
        parts.forEach(b => { out.set(b, pos); pos += b.length; });
        return out;
    }

    async function fromHtml(html, paperId) {
        const pages = await rasterize(html, paperId);
        const bytes = buildPdf(pages);
        return { bytes, base64: bytesToBase64(bytes), pageCount: pages.length };
    }

    global.PA_PDF = { fromHtml, rasterize, buildPdf };
})(window);
