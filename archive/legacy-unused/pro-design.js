/* ===== أزرار الكمية +/- داخل الفاتورة (بدون المساس بمنطق الحساب) ===== */
(function(){
  function enhance(row){
    const q=row.querySelector&&row.querySelector('input.row-qty');
    if(!q||q.dataset.stepper)return;
    q.dataset.stepper='1';
    const wrap=document.createElement('div');wrap.className='pa-qty';
    const mk=(cls,txt,d)=>{const b=document.createElement('button');b.type='button';b.className=cls;b.textContent=txt;
      b.onclick=e=>{e.preventDefault();const v=(parseFloat(q.value)||0)+d;q.value=Math.max(0,+v.toFixed(3));
        q.dispatchEvent(new Event('input',{bubbles:true}));q.dispatchEvent(new Event('change',{bubbles:true}));};return b;};
    q.parentNode.insertBefore(wrap,q);wrap.appendChild(mk('pa-minus','−',-1));wrap.appendChild(q);wrap.appendChild(mk('pa-plus','+',1));
  }
  const body=document.getElementById('invoice-items-body');
  if(!body)return;
  body.querySelectorAll('tr').forEach(enhance);
  new MutationObserver(ms=>ms.forEach(m=>m.addedNodes.forEach(n=>{if(n.nodeType===1)n.matches('tr')?enhance(n):n.querySelectorAll('tr').forEach(enhance);}))).observe(body,{childList:true,subtree:true});
})();
