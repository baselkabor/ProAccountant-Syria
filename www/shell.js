/* ===== App Shell JS ===== */
(function(){
  const TITLES={
    home:'الرئيسية',
    sales:'فاتورة مبيعات',
    purchases:'فاتورة مشتريات',
    items:'الأصناف في المخزن',
    barcodes:'صناعة وطباعة الباركود',
    accounts:'الزبائن والموردون',
    vouchers:'سند قبض والدفع',
    returns:'المرتجعات',
    cashboxes:'الصناديق والمصاريف',
    employees:'الموظفون والأقساط',
    profit:'حركة الشركة',
    eod:'حركات الفواتير ونهاية اليوم',
    reports:'تقرير شامل وكشف حسابات',
    settings:'إعدادات التطبيق'
  };
  const isMobile=()=>true;
  let stack=['home'],cur='home',lastBack=0,orig=window.switchTab,busy=false;
  document.body.classList.toggle('app-shell',isMobile());
  window.addEventListener('resize',()=>document.body.classList.toggle('app-shell',isMobile()));
  const bar=document.createElement('div');bar.id='app-subbar';
  bar.innerHTML='<button id="sb-back" aria-label="رجوع">›</button><div class="ttl" id="sb-title"></div><button id="sb-home" aria-label="الرئيسية">🏠</button>';
  const header=document.querySelector('header');
  header.after(bar);
  const syncHeaderHeight=()=>document.documentElement.style.setProperty('--hdr-h',`${header.getBoundingClientRect().height}px`);
  syncHeaderHeight();
  if(window.ResizeObserver)new ResizeObserver(syncHeaderHeight).observe(header);
  window.addEventListener('resize',syncHeaderHeight);
  function paint(t){cur=t;document.body.dataset.view=t;document.getElementById('sb-title').textContent=TITLES[t]||'';bar.classList.toggle('show',t!=='home'&&document.body.classList.contains('app-shell'));window.scrollTo(0,0);}
  window.switchTab=function(t){
    if(orig(t)===false)return false;
    if(!busy&&t!==cur){stack.push(t);try{history.pushState({t},'');}catch(e){}}
    paint(t);
    return true;
  };
  function back(){
    if(document.getElementById('picker-modal').classList.contains('show')){closePicker();return;}
    if(document.getElementById('android-print-modal')){closeAndroidPrintModal();return;}
    /* إغلاق أي نافذة منبثقة مفتوحة أولاً */
    const pop=Array.from(document.querySelectorAll('.pa-modal-backdrop')).pop();
    if(pop){if(window.paCloseExitDialog&&window.paCloseExitDialog())return;const c=pop.querySelector('.cancel,.pa-x');if(c)c.click();else pop.remove();return;}
    const openModal=Array.from(document.querySelectorAll('.fixed.inset-0:not(.hidden)')).filter(m=>m.id!=='pin-lock-screen'&&getComputedStyle(m).display!=='none').pop();
    if(openModal){openModal.classList.add('hidden');return;}
    if(document.getElementById('pin-lock-screen')&&!document.getElementById('pin-lock-screen').classList.contains('hidden')){const A=window.Capacitor&&Capacitor.Plugins&&Capacitor.Plugins.App;if(A&&A.minimizeApp)A.minimizeApp();return;}
    if(cur==='home'){
      try{history.pushState({t:'home'},'');}catch(e){}
      if(typeof window.paConfirmExit==='function'){window.paConfirmExit();return;}
      if(window.confirm('هل تريد الخروج من البرنامج؟')){const A=window.Capacitor&&Capacitor.Plugins&&Capacitor.Plugins.App;if(A&&A.exitApp)A.exitApp();else if(window.AndroidNative&&AndroidNative.exitApp)AndroidNative.exitApp();}
      return;
    }
    const current=cur;stack.pop();const prev=stack[stack.length-1]||'home';busy=true;
    if(orig(prev)===false){stack.push(current);try{history.pushState({t:current},'');}catch(e){}}
    else paint(prev);
    busy=false;
  }
  window.addEventListener('popstate',()=>{ if(document.getElementById('picker-modal').classList.contains('show')){closePicker();try{history.pushState({t:cur},'');}catch(e){}return;} back(); });
  try{history.replaceState({t:'home'},'');history.pushState({t:'home'},'');}catch(e){}
  const A=window.Capacitor&&Capacitor.Plugins&&Capacitor.Plugins.App;
  if(A&&A.addListener)A.addListener('backButton',()=>back());
  window.handleAndroidBack=function(){back();return true;};
  document.getElementById('sb-back').onclick=()=>{try{history.back();}catch(e){back();}};
  document.getElementById('sb-home').onclick=()=>{stack=['home'];busy=true;orig('home');paint('home');busy=false;};

  /* ===== نافذة اختيار الأصناف داخل الفاتورة ===== */
  const m=document.createElement('div');m.id='picker-modal';
  m.innerHTML='<div style="display:flex;gap:8px;align-items:center"><button onclick="closePicker()" style="background:#e11d48;color:#fff;border-radius:12px;height:44px;padding:0 16px;font-weight:800">✕ إغلاق</button><input id="picker-q" class="amin-input" placeholder="ابحث عن صنف أو باركود أو تصنيف" style="flex:1;height:44px;border-radius:12px;padding:0 12px"></div><div class="chips" id="picker-chips"></div><div id="picker-grid"></div><button onclick="closePicker()" style="margin-top:8px;height:50px;border-radius:14px;background:#12456f;color:#fff;font-weight:800">تم — العودة للفاتورة</button>';
  document.body.appendChild(m);
  let filt='all';
  const chips=[['all','الكل'],['stock','مخزون'],['service','خدمات'],['low','منخفض']];
  function render(){
    const q=document.getElementById('picker-q').value.trim().toLowerCase();
    const cats=[...new Set(db.items.map(i=>(i.category||'').trim()).filter(Boolean))];
    const allChips=chips.concat(cats.map(c=>['cat:'+c,c]));
    document.getElementById('picker-chips').innerHTML=allChips.map(c=>`<span class="chip ${filt===c[0]?'on':''}" data-f="${PA_CORE.escapeHtml(c[0])}">${PA_CORE.escapeHtml(c[1])}</span>`).join('');
    document.querySelectorAll('#picker-chips .chip').forEach(el=>el.onclick=()=>window.pickerFilter(el.getAttribute('data-f')));
    const picked={};document.querySelectorAll('#invoice-items-body .row-item-select').forEach(s=>{if(s.value)picked[s.value]=1;});
    const list=db.items.filter(i=>{
      if(filt==='stock'&&i.type==='service')return false;
      if(filt==='service'&&i.type!=='service')return false;
      if(filt==='low'&&!(i.type!=='service'&&Number(i.qty||0)<=(Number(i.minQty)||0)))return false;
      if(filt.indexOf('cat:')===0&&(i.category||'').trim()!==filt.slice(4))return false;
      return !q||(i.name||'').toLowerCase().includes(q)||(i.code||'')===q||(i.code||'').toLowerCase().includes(q)||(i.category||'').toLowerCase().includes(q);
    });
    const g=document.getElementById('picker-grid');
    g.innerHTML=list.length?list.map(i=>{
      const imageUrl=PA_CORE.safeImageUrl(i.image);
      const visual = imageUrl
        ? `<img src="${PA_CORE.escapeHtml(imageUrl)}" alt="" style="width:54px;height:54px;border-radius:12px;object-fit:cover;margin:0 auto 4px auto;border:1px solid #cbd5e1;">`
        : `<div style="font-size:30px">${i.type==='service'?'🛠️':'📦'}</div>`;
      return `<div class="card ${picked[i.id]?'sel':''}" data-item-id="${PA_CORE.escapeHtml(i.id)}">${visual}${PA_CORE.escapeHtml(i.name)}<small>${i.type==='service'?'خدمة':'المتوفر: '+Number(i.qty||0)}</small><span class="pr">$${Number(i.price||0).toFixed(2)}</span></div>`;
    }).join(''):'<div style="grid-column:1/-1;text-align:center;color:#94a3b8;padding:30px">لا توجد أصناف مطابقة</div>';
    g.querySelectorAll('[data-item-id]').forEach(el=>el.onclick=()=>window.pickItem(el.getAttribute('data-item-id')));
  }
  window.openPicker=function(){m.classList.add('show');document.getElementById('picker-q').value='';render();try{history.pushState({t:'picker'},'');}catch(e){}};
  window.closePicker=function(){m.classList.remove('show');};
  window.pickerFilter=function(f){filt=f;render();};
  document.getElementById('picker-q').addEventListener('input',render);
  document.getElementById('picker-q').addEventListener('keydown',e=>{if(e.key==='Enter'){const q=e.target.value.trim();const it=db.items.find(i=>i.code&&i.code===q);if(it){pickItem(it.id);e.target.value='';render();}}});
  window.pickItem=function(id){
    const rows=[...document.querySelectorAll('#invoice-items-body tr')];
    let tr=rows.find(r=>{const s=r.querySelector('.row-item-select');return s&&s.value===id;});
    if(tr){const q=tr.querySelector('.row-qty');q.value=(parseFloat(q.value)||0)+1;q.dispatchEvent(new Event('input',{bubbles:true}));}
    else{
      tr=rows.find(r=>{const s=r.querySelector('.row-item-select');return s&&!s.value;});
      if(!tr){addInvoiceRow(false);const all=document.querySelectorAll('#invoice-items-body tr');tr=all[all.length-1];}
      const s=tr.querySelector('.row-item-select');s.value=id;onRowItemSelect(s);
    }
    try{recalculateInvoice();}catch(e){}
    showToast('تمت إضافة الصنف للفاتورة ✔','success');render();
  };
  const host=document.getElementById('invoice-items-body');
  if(host){const tbl=host.closest('table');const btn=document.createElement('button');btn.type='button';btn.id='open-picker-btn';
    btn.textContent='🧩 اختر الأصناف (بحث وشبكة)';
    btn.onclick=openPicker;(tbl.parentElement.classList.contains('overflow-x-auto')?tbl.parentElement:tbl).before(btn);}
  paint('home');
})();
