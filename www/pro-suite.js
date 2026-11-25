/* ===== ProAccountant Syria — Advanced Organized Suite JS ===== */
(function() {
    // 1. Code-128B Pure Offline Vector SVG Barcode Generator
    const CODE128_PATTERNS = [
        "11011001100","11001101100","11001100110","10010011000","10010001100","10001001100",
        "10011001000","10011000100","10001100100","11001001000","11001000100","11000100100",
        "10110011100","10011011100","10011001110","10111001100","10011101100","10011100110",
        "11001110010","11001011100","11001001110","11011100100","11001110100","11101101110",
        "11101001100","11100101100","11100100110","11101100100","11100110100","11100110010",
        "11011011000","11011000110","11000110110","10100011000","10001011000","10001000110",
        "10110001000","10001101000","10001100010","11010001000","11000101000","11000100010",
        "10110111000","10110001110","10001101110","10111011000","10111000110","10001110110",
        "11101110110","11010001110","11000101110","11011101000","11011100010","11011101110",
        "11101011000","11101000110","11100010110","11101101000","11101100010","11100011010",
        "11101111010","11001000010","11110001010","10100110000","10100001100","10010110000",
        "10010000110","10000101100","10000100110","10110010000","10110000100","10011010000",
        "10011000010","10000110100","10000110010","11000010010","11001010000","11110111010",
        "11000010100","10001111010","10100111100","10010111100","10010011110","10111100100",
        "10011110100","10011110010","11110100100","11110010100","11110010010","11011011110",
        "11011110110","11110110110","10101111000","10100011110","10001011110","10111101000",
        "10111100010","11110101000","11110100010","10111011110","10111101110","11101011110",
        "11110101110","11010000100","11010010000","11010011100","1100011101011"
    ];

    window.generateCode128SVG = function(rawText, barHeight = 42) {
        const text = String(rawText || '000000').replace(/[^ -~]/g, '') || '000000';
        const safeHeight = Math.max(1, Math.round(Number(barHeight) || 42));
        const codes = [104]; // Start Code B
        let checksum = 104;
        for (let i = 0; i < text.length; i++) {
            const codeVal = text.charCodeAt(i) - 32;
            const safeVal = (codeVal >= 0 && codeVal <= 95) ? codeVal : 16;
            codes.push(safeVal);
            checksum += safeVal * (i + 1);
        }
        codes.push(checksum % 103);
        codes.push(106); // Stop

        const bits = codes.map(c => CODE128_PATTERNS[c] || CODE128_PATTERNS[0]).join('');
        const quietZone = 10;
        const totalWidth = bits.length + quietZone * 2;
        let rects = '';
        let x = quietZone;
        let i = 0;
        while (i < bits.length) {
            if (bits[i] === '1') {
                let run = 1;
                while (i + run < bits.length && bits[i + run] === '1') run++;
                rects += `<rect x="${x}" y="0" width="${run}" height="${safeHeight}" fill="#000"/>`;
                x += run;
                i += run;
            } else {
                x++;
                i++;
            }
        }
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${safeHeight}" preserveAspectRatio="none" style="display:block;width:100%;background:#fff;">${rects}</svg>`;
    };

    // 2. Product Image Handling & Compression
    let currentEditingItemImage = '';

    window.handleProductImageUpload = function(event) {
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function(e) {
            const img = new Image();
            img.onload = function() {
                const maxDim = 160;
                let w = img.width;
                let h = img.height;
                if (w > h && w > maxDim) {
                    h = Math.round((h * maxDim) / w);
                    w = maxDim;
                } else if (h >= w && h > maxDim) {
                    w = Math.round((w * maxDim) / h);
                    h = maxDim;
                }
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, w, h);
                currentEditingItemImage = canvas.toDataURL('image/jpeg', 0.65);
                updateItemImagePreviewUI(currentEditingItemImage);
                showToast('تم تجهيز صورة المنتج بنجاح ✔', 'success');
            };
            img.src = PA_CORE.safeImageUrl(e.target.result);
        };
        reader.readAsDataURL(file);
        event.target.value = '';
    };

    window.clearProductImagePreview = function() {
        currentEditingItemImage = '';
        updateItemImagePreviewUI('');
    };

    function updateItemImagePreviewUI(dataUrl) {
        const box = document.getElementById('item-image-preview-box');
        const clearBtn = document.getElementById('item-image-clear-btn');
        if (!box) return;
        const imageUrl = PA_CORE.safeImageUrl(dataUrl);
        if (imageUrl) {
            box.innerHTML = `<img src="${PA_CORE.escapeHtml(imageUrl)}" alt="صورة المنتج" class="w-16 h-16 rounded-xl object-cover border border-sky-400">`;
            if (clearBtn) clearBtn.classList.remove('hidden');
        } else {
            box.innerHTML = `<div class="w-16 h-16 rounded-xl border border-dashed border-slate-600 flex items-center justify-center text-2xl text-slate-400">🖼️</div>`;
            if (clearBtn) clearBtn.classList.add('hidden');
        }
    }

    // 3. Enhanced Items Management (Category, Image, Search, Sorting)
    let activeItemCategoryFilter = 'all';

    window.setItemCategoryFilter = function(cat) {
        activeItemCategoryFilter = cat;
        renderItemsTable();
    };

    window.generateAutoBarcodeForInput = function() {
        const inp = document.getElementById('item-code');
        if (!inp) return;
        const randomCode = '621' + String(Math.floor(100000000 + Math.random() * 900000000));
        inp.value = randomCode;
        showToast('تم توليد باركود تلقائي: ' + randomCode, 'info');
    };


    window.updateItemPriceLabels = function() {
        const cur = document.getElementById('item-price-currency')?.value || 'USD';
        const sym = cur === 'SYP' ? 'ل.س' : '$';
        const cLbl = document.getElementById('item-cost-label');
        const pLbl = document.getElementById('item-price-label');
        if (cLbl) cLbl.textContent = `سعر التكلفة (${sym})`;
        if (pLbl) pLbl.textContent = `سعر المبيع (${sym})`;
    };

    window.saveItemCard = async function() {
        const editId = document.getElementById('item-edit-id').value;
        const name = document.getElementById('item-name').value.trim();
        const type = document.getElementById('item-type').value;
        const code = document.getElementById('item-code').value.trim();
        const category = (document.getElementById('item-category')?.value || '').trim() || 'عام';
        const priceCurrency = document.getElementById('item-price-currency')?.value || 'USD';
        const rate = Number(db.settings.exchangeRate);
        const rawCost = Number(document.getElementById('item-cost').value);
        const rawPrice = Number(document.getElementById('item-price').value);
        const qty = Number(document.getElementById('item-qty').value);
        const minQty = Number(document.getElementById('item-min-qty').value);

        if (!name) {
            showToast('يرجى إدخال اسم المادة أو الخدمة', 'error');
            return;
        }
        if (![rawCost, rawPrice, qty, minQty].every(Number.isFinite) || rawCost < 0 || rawPrice < 0 || qty < 0 || minQty < 0
            || Math.abs(qty * 1000 - Math.round(qty * 1000)) > 1e-7
            || (priceCurrency === 'SYP' && (!Number.isFinite(rate) || rate <= 0))) {
            showToast('يرجى إدخال قيم صحيحة، والكمية بثلاث منازل كحد أقصى', 'error');
            return;
        }
        if (code && db.items.some(item => item.id !== editId && item.code === code)) {
            showToast('رمز الباركود مستخدم لصنف آخر', 'error');
            return;
        }
        const cost = priceCurrency === 'SYP' ? PA_CORE.roundMoney(rawCost / rate) : rawCost;
        const price = priceCurrency === 'SYP' ? PA_CORE.roundMoney(rawPrice / rate) : rawPrice;

        const payload = {
            name,
            type,
            code,
            category,
            priceCurrency,
            rawCost,
            rawPrice,
            image: currentEditingItemImage,
            cost,
            price,
            qty,
            minQty
        };

        const saved = await commitDatabaseMutation(() => {
            if (editId) {
                const index = db.items.findIndex(item => item.id === editId);
                if (index === -1) throw new Error('الصنف غير موجود');
                db.items[index] = { ...db.items[index], ...payload };
            } else {
                db.items.push({ id: 'itm_' + Date.now(), ...payload });
            }
            return true;
        });
        if (!saved) return;
        clearItemForm();
        refreshAllViews();
        if (typeof renderBarcodeStudioList === 'function') renderBarcodeStudioList();
        showToast(editId ? 'تم تعديل بطاقة المادة' : 'تمت إضافة المادة', 'success');
    };

    window.editItemCard = function(id) {
        const itm = db.items.find(i => i.id === id);
        if (!itm) return;
        const cur = itm.priceCurrency || 'USD';
        const rate = db.settings.exchangeRate || 15000;
        document.getElementById('item-edit-id').value = itm.id;
        document.getElementById('item-name').value = itm.name;
        document.getElementById('item-type').value = itm.type;
        document.getElementById('item-code').value = itm.code || '';
        if (document.getElementById('item-category')) {
            document.getElementById('item-category').value = itm.category || 'عام';
        }
        if (document.getElementById('item-price-currency')) {
            document.getElementById('item-price-currency').value = cur;
        }
        updateItemPriceLabels();
        const showCost = (itm.priceCurrency === 'SYP' && itm.rawCost !== undefined)
            ? itm.rawCost
            : (cur === 'SYP' ? Math.round((itm.cost || 0) * rate) : (itm.cost || 0));
        const showPrice = (itm.priceCurrency === 'SYP' && itm.rawPrice !== undefined)
            ? itm.rawPrice
            : (cur === 'SYP' ? Math.round((itm.price || 0) * rate) : (itm.price || 0));
        document.getElementById('item-cost').value = showCost;
        document.getElementById('item-price').value = showPrice;
        document.getElementById('item-qty').value = itm.qty;
        document.getElementById('item-min-qty').value = itm.minQty;
        currentEditingItemImage = itm.image || '';
        updateItemImagePreviewUI(currentEditingItemImage);
        toggleStockFields();
        const formCard = document.getElementById('item-name');
        if (formCard) formCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };

    window.clearItemForm = function() {
        document.getElementById('item-edit-id').value = '';
        document.getElementById('item-name').value = '';
        document.getElementById('item-code').value = '';
        if (document.getElementById('item-category')) document.getElementById('item-category').value = 'عام';
        if (document.getElementById('item-price-currency')) document.getElementById('item-price-currency').value = 'USD';
        updateItemPriceLabels();
        document.getElementById('item-cost').value = 0;
        document.getElementById('item-price').value = 0;
        document.getElementById('item-qty').value = 0;
        document.getElementById('item-min-qty').value = 3;
        document.getElementById('item-type').value = 'stock';
        currentEditingItemImage = '';
        updateItemImagePreviewUI('');
        toggleStockFields();
    };

    window.deleteItemCard = async function(id) {
        const referenced = (db.invoices || []).some(invoice => invoice.items.some(line => line.itemId === id))
            || (db.returns || []).some(record => record.itemId === id);
        if (referenced) return showToast('لا يمكن حذف صنف مرتبط بفواتير أو مرتجعات؛ يمكنك إيقاف استخدامه بدلاً من حذفه', 'error');
        if (!window.confirm('هل تريد حذف هذا الصنف؟')) return;
        const saved = await commitDatabaseMutation(() => {
            const index = db.items.findIndex(item => item.id === id);
            if (index === -1) return null;
            db.items.splice(index, 1);
            return true;
        });
        if (!saved) return;
        refreshAllViews();
        if (typeof renderBarcodeStudioList === 'function') renderBarcodeStudioList();
        showToast('تم حذف الصنف من المخزن', 'info');
    };

    window.renderItemsTable = function() {
        const search = (document.getElementById('item-search')?.value || '').trim().toLowerCase();
        const sortBy = document.getElementById('item-sort-select')?.value || 'default';
        const tbody = document.getElementById('items-table-body');
        const catBar = document.getElementById('items-category-chips');
        if (!tbody) return;
        const rate = db.settings.exchangeRate || 15000;

        // Build dynamic category filter chips
        if (catBar) {
            const cats = ['all', ...new Set(db.items.map(i => (i.category || 'عام').trim()).filter(Boolean))];
            catBar.innerHTML = cats.map(c => {
                const label = c === 'all' ? `الكل (${db.items.length})` : c;
                const activeCls = activeItemCategoryFilter === c ? 'active' : '';
                return `<button type="button" data-item-category="${PA_CORE.escapeHtml(c)}" class="pro-chip-btn ${activeCls}">${PA_CORE.escapeHtml(label)}</button>`;
            }).join('');
            catBar.querySelectorAll('[data-item-category]').forEach(btn => {
                btn.addEventListener('click', () => window.setItemCategoryFilter(btn.getAttribute('data-item-category')));
            });
        }

        let filtered = db.items.filter(i => {
            const cat = (i.category || 'عام').trim();
            if (activeItemCategoryFilter !== 'all' && cat !== activeItemCategoryFilter) return false;
            if (!search) return true;
            return (i.name || '').toLowerCase().includes(search) ||
                   (i.code || '').toLowerCase().includes(search) ||
                   cat.toLowerCase().includes(search);
        });

        if (sortBy === 'name_asc') filtered = [...filtered].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
        else if (sortBy === 'qty_desc') filtered = [...filtered].sort((a, b) => (b.qty || 0) - (a.qty || 0));
        else if (sortBy === 'qty_asc') filtered = [...filtered].sort((a, b) => (a.qty || 0) - (b.qty || 0));
        else if (sortBy === 'price_asc') filtered = [...filtered].sort((a, b) => (a.price || 0) - (b.price || 0));
        else if (sortBy === 'price_desc') filtered = [...filtered].sort((a, b) => (b.price || 0) - (a.price || 0));

        tbody.innerHTML = '';
        if (filtered.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" class="p-4 text-center text-slate-400">لا توجد أصناف مطابقة للبحث</td></tr>`;
            return;
        }

        filtered.forEach(itm => {
            const imageUrl = PA_CORE.safeImageUrl(itm.image);
            const thumbHtml = imageUrl
                ? `<img src="${PA_CORE.escapeHtml(imageUrl)}" alt="" class="item-thumb-box">`
                : `<span class="item-thumb-placeholder">${itm.type === 'service' ? '⚡' : '📦'}</span>`;

            const typeLabel = itm.type === 'stock'
                ? `<span class="bg-sky-500/20 text-sky-300 px-2 py-0.5 rounded text-xs">${PA_CORE.escapeHtml(itm.category || 'مخزنية')}</span>`
                : `<span class="bg-purple-500/20 text-purple-300 px-2 py-0.5 rounded text-xs">خدمة</span>`;

            let stockBadge = '-';
            if (itm.type === 'stock') {
                const isLow = Number(itm.qty || 0) <= Number(itm.minQty || 0);
                stockBadge = `<span class="font-mono font-bold ${isLow ? 'text-rose-400' : 'text-emerald-400'}">${Number(itm.qty || 0)}</span>`;
            }

            tbody.innerHTML += `
                <tr class="hover:bg-slate-700/30">
                    <td class="p-3">
                        <div class="flex items-center gap-2.5">
                            ${thumbHtml}
                            <div>
                                <div class="font-bold">${PA_CORE.escapeHtml(itm.name)}</div>
                                <div class="text-[11px] font-mono text-slate-400">${itm.code ? 'باركود: ' + PA_CORE.escapeHtml(itm.code) : 'بدون باركود'}</div>
                            </div>
                        </div>
                    </td>
                    <td class="p-3">${typeLabel}</td>
                    <td class="p-3 font-mono text-slate-400">$${Number(itm.cost || 0).toFixed(2)}</td>
                    <td class="p-3 font-mono font-bold text-emerald-400">$${Number(itm.price || 0).toFixed(2)}</td>
                    <td class="p-3 font-mono text-amber-400">${Math.round(Number(itm.price || 0) * Number(rate || 0)).toLocaleString()} ل.س</td>
                    <td class="p-3">${stockBadge}</td>
                    <td class="p-3 text-center">
                        <div class="flex justify-center gap-1 flex-wrap">
                            <button type="button" data-item-action="edit" data-item-id="${PA_CORE.escapeHtml(itm.id)}" class="bg-slate-700 hover:bg-amber-500 hover:text-slate-950 px-2.5 py-1 rounded text-xs font-bold transition">تعديل</button>
                            <button type="button" data-item-action="barcode" data-item-id="${PA_CORE.escapeHtml(itm.id)}" class="bg-sky-700/70 hover:bg-sky-600 text-white px-2 py-1 rounded text-xs font-bold transition" title="طباعة ملصق باركود واحد">🏷️</button>
                            <button type="button" data-item-action="barcode-copies" data-item-id="${PA_CORE.escapeHtml(itm.id)}" class="bg-emerald-700/70 hover:bg-emerald-600 text-white px-2 py-1 rounded text-xs font-bold transition" title="طباعة عدد نسخ مخصص">🖨️×N</button>
                        </div>
                    </td>
                </tr>
            `;
        });
        tbody.querySelectorAll('[data-item-action]').forEach(btn => {
            btn.addEventListener('click', () => {
                const itemId = btn.getAttribute('data-item-id');
                if (btn.getAttribute('data-item-action') === 'edit') window.editItemCard(itemId);
                else if (btn.getAttribute('data-item-action') === 'barcode') window.printItemBarcode(itemId, 1);
                else window.promptPrintItemBarcode(itemId);
            });
        });
    };

    // 4. Barcode Generator & Label Printing Studio (`#view-barcodes`)
    let barcodeSelectionMap = {}; // itemId -> label count

    window.quickSendItemToBarcode = function(itemId) {
        barcodeSelectionMap[itemId] = (barcodeSelectionMap[itemId] || 0) + 1;
        switchTab('barcodes');
    };

    window.setBarcodeItemQty = function(itemId, qtyVal) {
        const q = Math.min(500, Math.max(0, parseInt(qtyVal, 10) || 0));
        if (q === 0) delete barcodeSelectionMap[itemId];
        else barcodeSelectionMap[itemId] = q;
        renderBarcodeLabelsPreview();
    };

    window.adjustBarcodeItemQty = function(itemId, delta) {
        const cur = barcodeSelectionMap[itemId] || 0;
        setBarcodeItemQty(itemId, Math.max(0, cur + delta));
        renderBarcodeStudioList();
    };

    window.assignBarcodeToItemInline = async function(itemId) {
        const item = db.items.find(entry => entry.id === itemId);
        if (!item) return;
        let code;
        do {
            const random = new Uint32Array(1);
            window.crypto.getRandomValues(random);
            code = '621' + String(100000000 + (random[0] % 900000000));
        } while (db.items.some(entry => entry.id !== itemId && entry.code === code));
        const saved = await commitDatabaseMutation(() => {
            item.code = code;
            return true;
        });
        if (!saved) return;
        renderBarcodeStudioList();
        renderBarcodeLabelsPreview();
        showToast(`تم توليد باركود للصنف "${item.name}": ${code}`, 'success');
    };

    window.clearAllBarcodeSelections = function() {
        barcodeSelectionMap = {};
        renderBarcodeStudioList();
        renderBarcodeLabelsPreview();
    };

    window.renderBarcodeStudioList = function() {
        const tbody = document.getElementById('barcode-items-select-body');
        if (!tbody) return;
        const q = (document.getElementById('barcode-studio-search')?.value || '').trim().toLowerCase();

        const list = db.items.filter(i => !q || (i.name || '').toLowerCase().includes(q) || (i.code || '').toLowerCase().includes(q));
        if (list.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" class="p-4 text-center text-slate-400">لا توجد أصناف مطابقة</td></tr>`;
            return;
        }

        tbody.innerHTML = list.map(itm => {
            const count = Math.max(0, Number(barcodeSelectionMap[itm.id]) || 0);
            const codeCell = itm.code
                ? `<span class="font-mono text-xs text-sky-300">${PA_CORE.escapeHtml(itm.code)}</span>`
                : `<button type="button" data-barcode-action="assign" data-item-id="${PA_CORE.escapeHtml(itm.id)}" class="bg-amber-500/20 text-amber-300 border border-amber-500/40 px-2 py-0.5 rounded text-[11px] font-bold">+ توليد باركود</button>`;
            return `
                <tr class="${count > 0 ? 'bg-sky-950/35' : ''}">
                    <td class="p-2.5 font-bold text-xs">${PA_CORE.escapeHtml(itm.name)}</td>
                    <td class="p-2.5">${codeCell}</td>
                    <td class="p-2.5 font-mono text-xs text-emerald-400">$${Number(itm.price || 0).toFixed(2)}</td>
                    <td class="p-2.5">
                        <div class="flex items-center justify-center gap-1">
                            <button type="button" data-barcode-action="adjust" data-item-id="${PA_CORE.escapeHtml(itm.id)}" data-delta="-1" class="w-7 h-7 rounded-lg bg-slate-700 text-white font-black">-</button>
                            <input type="number" min="0" max="500" value="${count}" data-barcode-qty data-item-id="${PA_CORE.escapeHtml(itm.id)}"
                                class="amin-input w-14 text-center font-mono font-bold text-xs py-1 rounded-lg">
                            <button type="button" data-barcode-action="adjust" data-item-id="${PA_CORE.escapeHtml(itm.id)}" data-delta="1" class="w-7 h-7 rounded-lg bg-sky-600 text-white font-black">+</button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
        tbody.querySelectorAll('[data-barcode-action="assign"]').forEach(btn => {
            btn.addEventListener('click', () => window.assignBarcodeToItemInline(btn.getAttribute('data-item-id')));
        });
        tbody.querySelectorAll('[data-barcode-action="adjust"]').forEach(btn => {
            btn.addEventListener('click', () => window.adjustBarcodeItemQty(btn.getAttribute('data-item-id'), Number(btn.getAttribute('data-delta'))));
        });
        tbody.querySelectorAll('[data-barcode-qty]').forEach(input => {
            input.addEventListener('change', () => window.setBarcodeItemQty(input.getAttribute('data-item-id'), input.value));
        });

        renderBarcodeLabelsPreview();
    };

    window.renderBarcodeLabelsPreview = function() {
        const previewGrid = document.getElementById('barcode-labels-preview-grid');
        const counterBadge = document.getElementById('barcode-total-labels-badge');
        if (!previewGrid) return;

        const showCompany = document.getElementById('bc-opt-company')?.checked !== false;
        const showPrice = document.getElementById('bc-opt-price')?.checked !== false;
        const priceCurrency = document.getElementById('bc-opt-currency')?.value || 'USD';
        const rate = db.settings.exchangeRate || 15000;

        let totalLabels = 0;
        let cardsHtml = '';

        Object.entries(barcodeSelectionMap).forEach(([itemId, qty]) => {
            if (qty <= 0) return;
            const itm = db.items.find(i => i.id === itemId);
            if (!itm) return;
            totalLabels += Number(qty) || 0;
            const codeVal = itm.code || 'بدون باركود';
            const svgHtml = itm.code ? generateCode128SVG(codeVal, 38) : '';
            const priceText = priceCurrency === 'SYP'
                ? `${Math.round(Number(itm.price || 0) * Number(rate || 0)).toLocaleString()} ل.س`
                : `$${Number(itm.price || 0).toFixed(2)}`;

            // Show up to 24 cards in live preview for performance, while printing prints ALL `qty`
            const previewCap = Math.min(qty, 12);
            for (let k = 0; k < previewCap; k++) {
                cardsHtml += `
                    <div class="barcode-preview-card">
                        ${showCompany ? `<div style="font-size:10px;font-weight:800;color:#0f172a;">${PA_CORE.escapeHtml(db.settings.companyName)}</div>` : ''}
                        <div style="font-size:11px;font-weight:900;color:#000;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${PA_CORE.escapeHtml(itm.name)}</div>
                        <div style="width:92%;margin:2px auto;">${svgHtml}</div>
                        <div style="font-size:10px;font-family:monospace;font-weight:700;letter-spacing:1px;">${PA_CORE.escapeHtml(codeVal)}</div>
                        ${showPrice ? `<div style="font-size:12px;font-weight:900;color:#000;">${priceText}</div>` : ''}
                    </div>
                `;
            }
        });

        if (counterBadge) counterBadge.textContent = `الإجمالي: ${totalLabels} ملصق — المعاينة مختصرة والطباعة تشمل العدد كاملاً`;
        previewGrid.innerHTML = totalLabels === 0
            ? `<div class="col-span-full text-center text-slate-400 py-8 text-xs">حدد عدداً من اللصاقات للأصناف أعلاه لمعاينة الباركود وطباعته</div>`
            : cardsHtml;
    };

    window.printSelectedBarcodeLabels = function() {
        const entries = Object.entries(barcodeSelectionMap).filter(([, q]) => q > 0);
        if (entries.length === 0) {
            showToast('يرجى تحديد صنف واحد وعدد لصاقات على الأقل للطباعة', 'error');
            return;
        }
        if (entries.some(([itemId]) => !db.items.find(item => item.id === itemId)?.code)) {
            showToast('ولّد رمز باركود لكل صنف محدد قبل الطباعة حتى يعمل المسح والبحث', 'error');
            return;
        }

        const layout = document.getElementById('bc-opt-size')?.value || '50x30';
        const showCompany = document.getElementById('bc-opt-company')?.checked !== false;
        const showPrice = document.getElementById('bc-opt-price')?.checked !== false;
        const priceCurrency = document.getElementById('bc-opt-currency')?.value || 'USD';
        const rate = db.settings.exchangeRate || 15000;
        const labels = [];
        entries.forEach(([itemId, qty]) => {
            const itm = db.items.find(i => i.id === itemId);
            if (!itm) return;
            const codeVal = itm.code || 'بدون باركود';
            const svgHtml = itm.code ? generateCode128SVG(codeVal, layout === '40x25' ? 25 : 30) : '';
            const priceText = priceCurrency === 'SYP'
                ? `${Math.round(Number(itm.price || 0) * Number(rate || 0)).toLocaleString()} ل.س`
                : `$${Number(itm.price || 0).toFixed(2)}`;

            const label = PA_PRINT.labelMarkup({ name: itm.name }, svgHtml, {
                companyName: db.settings.companyName,
                code: codeVal,
                priceText,
                showCompany,
                showPrice
            });
            for (let k = 0; k < qty; k++) labels.push(label);
        });

        const html = PA_PRINT.buildLabelSheet(labels, layout);
        triggerPrint(html, layout === 'a4_grid' ? 'a4' : 'thermal', {
            title: 'ملصقات الباركود',
            fileName: `Labels_${layout}_${Date.now()}.pdf`,
            kind: 'labels'
        });
    };

    // 5. Focused Practical Settings Controller
    window.switchSettingsSubtab = function() {};

    window.applyAdvancedAppSettings = function() {
        const hasDraft = Array.from(document.querySelectorAll('#invoice-items-body tr'))
            .some(row => row.querySelector('.row-item-select')?.value)
            || Number(document.getElementById('inv-discount')?.value || 0) !== 0
            || !!document.getElementById('inv-notes')?.value.trim();
        if (hasDraft) return;
        const s = db.settings || {};
        const payEl = document.getElementById('inv-payment-type');
        if (payEl && s.defaultPaymentType) payEl.value = s.defaultPaymentType;
        const curEl = document.getElementById('inv-currency');
        if (curEl && s.defaultCurrency) curEl.value = s.defaultCurrency;
        recalculateInvoice();
        handlePaymentTypeChange();
    };

    window.populateAdvancedSettingsUI = function() {
        const s = db.settings || {};
        const setVal = (id, val) => { const el = document.getElementById(id); if (el && val !== undefined) el.value = val; };
        const setChk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };

        setVal('set-company-name', s.companyName || 'محاسب محترف سوريا');
        setVal('set-company-sub', s.companySub || 'بإدارة باسل محمد الخابور - 0952575089');
        setVal('set-default-payment', s.defaultPaymentType || 'cash');
        setVal('set-default-currency', s.defaultCurrency || 'USD');
        setVal('set-default-paper', s.defaultPaper || 'a4');
        setChk('set-auto-print-invoice', !!s.autoPrintInvoice);
        setVal('set-invoice-template', s.invoiceTemplate || 'modern');
        setVal('set-invoice-accent', s.invoiceAccent || '');
        if (typeof updateDataSizeInfo === 'function') updateDataSizeInfo();
        setVal('set-tax-number', s.taxNumber || '');
        setVal('set-invoice-footer', s.invoiceFooter || 'البضاعة المباعة تُرد وتُستبدل خلال 3 أيام بحالتها الأصلية');
        setChk('set-inv-show-qr', s.invShowQr !== false);
        setChk('set-inv-show-logo', s.invShowLogo !== false);
        setChk('set-inv-show-balance', s.invShowBalance !== false);
    };

    window.saveAllAdvancedSettings = async function() {
        const getVal = (id, fallback) => document.getElementById(id)?.value ?? fallback;
        const getChk = (id) => !!document.getElementById(id)?.checked;
        const settings = {
            companyName: getVal('set-company-name', 'محاسب محترف سوريا').trim() || 'محاسب محترف سوريا',
            companySub: getVal('set-company-sub', 'بإدارة باسل محمد الخابور - 0952575089').trim(),
            defaultPaymentType: getVal('set-default-payment', 'cash'),
            defaultCurrency: getVal('set-default-currency', 'USD'),
            defaultPaper: getVal('set-default-paper', 'a4'),
            autoPrintInvoice: getChk('set-auto-print-invoice'),
            invoiceTemplate: getVal('set-invoice-template', 'modern'),
            invoiceAccent: getVal('set-invoice-accent', ''),
            taxNumber: getVal('set-tax-number', '').trim(),
            invoiceFooter: getVal('set-invoice-footer', '').trim(),
            invShowQr: getChk('set-inv-show-qr'),
            invShowLogo: getChk('set-inv-show-logo'),
            invShowBalance: getChk('set-inv-show-balance')
        };
        const saved = await commitDatabaseMutation(() => {
            Object.assign(db.settings, settings);
            return true;
        });
        if (!saved) return;
        applyAdvancedAppSettings();
        showToast('تم حفظ الإعدادات', 'success');
    };
    // Auto-print hook when saving an invoice if enabled in settings
    const baseSaveInv = window.saveInvoice;
    if (typeof baseSaveInv === 'function') {
        window.saveInvoice = async function(returnObj = false) {
            const saved = await baseSaveInv(true);
            if (saved && !returnObj && db.settings && db.settings.autoPrintInvoice) {
                printInvoiceById(saved.id, db.settings.defaultPaper || 'a4');
            }
            return saved;
        };
    }

    // Hook into `switchTab` to support `barcodes` and initialize settings UI
    const prevSwitchTab = window.switchTab;
    window.switchTab = function(tabName) {
        if (tabName === 'barcodes') {
            const allViews = [
                'view-home', 'view-invoice', 'view-returns', 'view-vouchers',
                'view-items', 'view-barcodes', 'view-accounts', 'view-reports',
                'view-eod', 'view-cashboxes', 'view-employees', 'view-profit', 'view-settings'
            ];
            allViews.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.classList.add('hidden');
            });
            document.querySelectorAll('.amin-btn').forEach(btn => btn.classList.remove('active'));
            const v = document.getElementById('view-barcodes');
            if (v) v.classList.remove('hidden');
            renderBarcodeStudioList();
            return true;
        }

        if (typeof prevSwitchTab === 'function' && prevSwitchTab(tabName) === false) return false;

        if (tabName === 'settings') {
            populateAdvancedSettingsUI();
        }
        return true;
    };

    // Run on startup once DOM is ready
    document.addEventListener('DOMContentLoaded', function() {
        setTimeout(() => {
            applyAdvancedAppSettings();
            populateAdvancedSettingsUI();
        }, 250);
    });
})();
