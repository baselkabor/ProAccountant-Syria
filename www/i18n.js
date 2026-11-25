/* ===== i18n: عربي / English — ترجمة فورية للواجهة بدون المساس بالبيانات والفواتير المطبوعة ===== */
(function(){
  const D=window.PA_DICT||{};
  const KEYS=Object.keys(D).sort((a,b)=>b.length-a.length);
  const SKIP='#print-area,#android-receipt-paper,#android-print-modal,script,style,textarea,[data-no-i18n],[data-user-data]';
  const ATTRS=['placeholder','title','aria-label','alt'];
  let lang='ar';try{lang=localStorage.getItem('pa_lang')||'ar';}catch(e){}
  const nodeMap=new WeakMap();let busy=false;
  const AR=/[\u0600-\u06FF]/;
  /* أنماط ديناميكية (أرقام + كلمات) */
  const PATTERNS=[
    [/^([\d.,]+) فاتورة اليوم$/,'$1 invoices today'],[/^([\d.,]+) فاتورة مبيعات$/,'$1 sales invoices'],[/^([\d.,]+) فاتورة مشتريات$/,'$1 purchase invoices'],[/^الشهر الحالي (\S+)$/,'Current month $1'],[/^السنة الحالية (\S+)$/,'Current year $1'],[/^اليوم (\d{4}-\S+)$/,'Today $1'],[/^من (\S+) إلى (\S+)$/,'From $1 to $2'],[/^([$\d.,-]+) عليه$/,'$1 owes'],[/^([$\d.,-]+) له$/,'$1 credit'],[/^([\d.,]+) فاتورة$/,'$1 invoices'],
    [/^([\d.,]+) حساب مدين$/,'$1 debtor accounts'],[/^([\d.,]+) حساب دائن$/,'$1 creditor accounts'],
    [/^([\d.,]+) صنف \(([\d.,]+) مخزني\)$/,'$1 items ($2 stock)'],[/^([\d.,]+) صنف$/,'$1 items'],[/^منذ ([\d]+) يوم$/,'$1 days ago'],
    [/^([\d.,]+) ملصق$/,'$1 labels'],[/^([\d.,]+) بصورة$/,'$1 with image'],[/^([\d.,]+) قسط$/,'$1 installments'],
    [/^([\d.,]+) موظف$/,'$1 employees'],[/^([\d.,]+) حركة$/,'$1 transactions'],[/^([\d.,]+) سند$/,'$1 vouchers'],
    [/^([\d.,]+) ل\.س$/,'$1 SYP'],[/^ل\.س$/,'SYP'],[/^\(عليه\)$/,'(owes)'],[/^\(له\)$/,'(credit)']
  ];
  const SYM=/^([^؀-ۿA-Za-z0-9$(]*)([\s\S]*?)([^؀-ۿA-Za-z0-9)$%.]*)$/;
  let depth=0;
  function core(t){
    if(D[t])return D[t];
    for(const [re,rep] of PATTERNS){if(re.test(t))return t.replace(re,rep);}
    return null;
  }
  function tr(t){
    if(!t||!AR.test(t))return t;
    const exact=core(t);if(exact!==null)return exact;
    if(depth>6)return t;depth++;
    try{
      /* رموز/إيموجي في البداية أو النهاية */
      const m=t.match(SYM);
      if(m&&(m[1]||m[3])&&m[2]){const c=tr(m[2]);if(c!==m[2])return m[1]+c+m[3];}
      /* فواصل مركّبة */
      for(const sep of [' • ',', ',' | ',' — ',' – ',' · ','، ',' - ']){
        if(t.includes(sep)){const parts=t.split(sep);const out=parts.map(x=>tr(x.trim()));if(out.some((x,i)=>x!==parts[i].trim()))return out.join(sep==='، '?', ':sep);}
      }
      /* «مفتاح: قيمة» */
      const kv=t.match(/^([^:：]+?)\s*[:：]\s*([\s\S]*)$/);
      if(kv){const k=tr(kv[1].trim());const v=tr(kv[2]);if(k!==kv[1].trim()||v!==kv[2])return k+': '+v;}
      /* «نص (تفصيل)» */
      const pr=t.match(/^([\s\S]*?)\s*\(([^()]*)\)\s*([\s\S]*)$/);
      if(pr){const A=pr[1]?tr(pr[1]):'',B=tr(pr[2]),C=pr[3]?tr(pr[3]):'';const o=(A?A+' ':'')+'('+B+')'+(C?' '+C:'');if(o!==t)return o;}
      /* بادئة معروفة + أرقام */
      for(const k of KEYS){
        if(k.length>2&&t.startsWith(k)){const rest=t.slice(k.length);if(/^[\s\d.,$%()\-+/×xX#]*$/.test(rest))return D[k]+rest;}
      }
      /* «رقم + كلمة» أو «كلمة + رقم» */
      const nw=t.match(/^([\d.,$]+)\s+([\s\S]+)$/);if(nw){const w=tr(nw[2]);if(w!==nw[2])return nw[1]+' '+w;}
      const wn=t.match(/^([\s\S]+?)\s+([\d.,$#%]+)$/);if(wn){const w=tr(wn[1]);if(w!==wn[1])return w+' '+wn[2];}
      return t;
    }finally{depth--;}
  }
  function trString(s){
    const t=s.trim();if(!t||!AR.test(t))return null;
    const o=tr(t);return o===t?null:o;
  }
  const lead=s=>s.match(/^\s*/)[0],trail=s=>s.match(/\s*$/)[0];
  function doText(n){
    if(!n.parentElement||n.parentElement.closest(SKIP))return;
    const rec=nodeMap.get(n);
    if(lang==='en'){
      if(rec&&n.nodeValue===rec.out)return;
      const out=trString(n.nodeValue);if(out===null)return;
      const full=lead(n.nodeValue)+out+trail(n.nodeValue);
      nodeMap.set(n,{src:n.nodeValue,out:full});n.nodeValue=full;
    }else if(rec&&n.nodeValue===rec.out){n.nodeValue=rec.src;nodeMap.delete(n);}
  }
  function doAttrs(el){
    if(el.closest&&el.closest(SKIP))return;
    ATTRS.forEach(a=>{
      if(!el.hasAttribute||!el.hasAttribute(a))return;
      const k='data-ar-'+a,cur=el.getAttribute(a);
      if(lang==='en'){
        const src=el.hasAttribute(k)?el.getAttribute(k):cur;
        const out=trString(src);
        if(out!==null){if(!el.hasAttribute(k))el.setAttribute(k,cur);el.setAttribute(a,out);}
      }else if(el.hasAttribute(k)){el.setAttribute(a,el.getAttribute(k));el.removeAttribute(k);}
    });
  }
  function walk(root){
    if(!root)return;busy=true;
    try{
      if(root.nodeType===3){doText(root);return;}
      if(root.nodeType!==1&&root.nodeType!==9)return;
      const tw=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n;while((n=tw.nextNode()))doText(n);
      if(root.nodeType===1)doAttrs(root);
      root.querySelectorAll&&root.querySelectorAll('[placeholder],[title],[aria-label],[alt]').forEach(doAttrs);
    }finally{busy=false;}
  }
  const mo=new MutationObserver(ms=>{
    if(busy)return;
    ms.forEach(m=>{
      if(m.type==='childList')m.addedNodes.forEach(n=>walk(n));
      else if(m.type==='characterData')walk(m.target);
    });
  });
  function setLang(l){
    lang=l==='en'?'en':'ar';
    try{localStorage.setItem('pa_lang',lang);}catch(e){}
    const h=document.documentElement;h.lang=lang;h.dir=lang==='en'?'ltr':'rtl';
    document.body.classList.toggle('lang-en',lang==='en');
    walk(document.body);
    document.title=lang==='en'?'ProAccountant Syria':'محاسب محترف سوريا';
    const b=document.getElementById('pa-lang-btn');if(b)b.textContent=lang==='en'?'🌐 العربية':'🌐 English';
    const sb=document.getElementById('sb-back');if(sb)sb.textContent=lang==='en'?'‹':'›';
    window.dispatchEvent(new CustomEvent('palang',{detail:lang}));
  }
  window.paLang=()=>lang;
  window.setLang=setLang;
  window.t=s=>lang==='en'?(trString(s)||s):s;
  /* حوارات المتصفح النظامية */
  ['alert','confirm','prompt'].forEach(fn=>{const o=window[fn];window[fn]=function(m,...r){
    if(lang==='en'&&typeof m==='string'){let o2=D[m.trim()];if(!o2){o2=m;for(const k of KEYS){if(k.length>5&&o2.includes(k))o2=o2.split(k).join(D[k]);}}m=o2;}
    return o.call(window,m,...r);};});
  /* زر اللغة داخل قائمة الترويسة */
  const panel=document.getElementById('pa-panel');
  if(panel){const b=document.createElement('button');b.type='button';b.id='pa-lang-btn';b.setAttribute('data-no-i18n','');b.className='pa-panelbtn';
    b.onclick=()=>setLang(lang==='en'?'ar':'en');panel.insertBefore(b,panel.firstChild);}
  mo.observe(document.body,{childList:true,subtree:true,characterData:true});
  setLang(lang);
})();
