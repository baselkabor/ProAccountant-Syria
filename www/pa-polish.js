/* إخفاء الأزرار العائمة عند ظهور لوحة المفاتيح أو نافذة منبثقة */
(function () {
  const fab = () => document.querySelector('.fixed.bottom-5.left-4');
  function update() {
    const f = fab(); if (!f) return;
    const vv = window.visualViewport;
    const kb = vv && (window.innerHeight - vv.height) > 120;
    const modal = Array.from(document.querySelectorAll('.fixed.inset-0, #android-print-modal, #ob-modal.show')).some(m => m !== f && !m.classList.contains('hidden') && getComputedStyle(m).display !== 'none');
    f.style.display = (kb || modal) ? 'none' : '';
  }
  if (window.visualViewport) window.visualViewport.addEventListener('resize', update);
  new MutationObserver(update).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true });
  update();
})();
