/* ===== رسائل الترحيب + الجولة التعريفية عند أول استخدام ===== */
(function(){
  const KEY='pa_onboarded_v1';
  const get=()=>{try{return localStorage.getItem(KEY);}catch(e){return null;}};
  const set=()=>{try{localStorage.setItem(KEY,'1');}catch(e){}};
  const steps=[
    {logo:true,t:'أهلاً بك في محاسب محترف سوريا',p:'برنامج متكامل للفواتير والمخزون والحسابات يعمل بدون إنترنت. جولة سريعة من 5 خطوات تعرّفك على كل شيء.'},
    {i:'🏠',t:'الرئيسية: كل شيء بلمسة',p:'اضغط على أي بلاطة لفتح نافذتها. استخدم زر › أعلى الشاشة أو زر الرجوع في هاتفك للعودة، وزر 🏠 للرئيسية.'},
    {i:'🧾',t:'أنشئ فاتورتك بسرعة',p:'من «فاتورة مبيعات» اختر نقدي أو آجل أو تقسيط، وأضف الأصناف بزر «اختر الأصناف» أو بمسح الباركود، ثم اضغط إتمام.'},
    {i:'👥',t:'تابع العملاء والديون',p:'في «العملاء والموردون» ترى الأرصدة وكشف الحساب، وتتواصل مع المدينين بالاتصال أو واتساب أو الرسائل، وتطبع التقارير وتشاركها.'},
    {i:'🔒',t:'بياناتك آمنة',p:'فعّل رمز PIN من الإعدادات، وخذ نسخة احتياطية دورية على جوجل درايف أو ملف JSON حتى لا تفقد بياناتك أبداً.'}
  ];
  let k=0;
  const m=document.createElement('div');m.id='ob-modal';
  m.innerHTML='<div id="ob-card"><div class="ic" id="ob-ic"></div><h3 id="ob-t"></h3><p id="ob-p"></p><div id="ob-lang" data-no-i18n><button type="button" onclick="setLang(\'ar\')">العربية</button><button type="button" onclick="setLang(\'en\')">English</button></div><div id="ob-dots"></div><div id="ob-actions"><button id="ob-prev">السابق</button><button id="ob-next">التالي</button></div><button id="ob-skip">تخطي الجولة</button></div>';
  document.body.appendChild(m);
  const $=id=>document.getElementById(id);
  function paint(){
    const s=steps[k];
    $('ob-ic').innerHTML=s.logo?'<img src="logo.svg" alt="">':s.i;
    $('ob-lang').style.display=(k===0)?'flex':'none';$('ob-t').textContent=s.t;$('ob-p').textContent=s.p;
    $('ob-dots').innerHTML=steps.map((_,i)=>'<i class="'+(i===k?'on':'')+'"></i>').join('');
    $('ob-prev').style.visibility=k?'visible':'hidden';
    $('ob-next').textContent=k===steps.length-1?'ابدأ الآن 🚀':'التالي';
  }
  function close(){m.classList.remove('show');set();try{showToast('مرحباً بك! يمكنك إعادة الجولة من زر ❓ في الرئيسية','success');}catch(e){}}
  window.openTour=function(){k=0;paint();m.classList.add('show');};
  $('ob-next').onclick=()=>{if(k<steps.length-1){k++;paint();}else close();};
  $('ob-prev').onclick=()=>{if(k>0){k--;paint();}};
  $('ob-skip').onclick=close;

  /* بطاقة الترحيب في أعلى الرئيسية */
  const home=document.getElementById('view-home');
  function buildGreeting(){
  if(home){
    const hr=new Date().getHours();
    const hello=hr<5?'مساء الخير 🌙':hr<12?'صباح الخير ☀️':hr<17?'نهارك سعيد 🌤️':'مساء الخير 🌆';
    const date=new Date().toLocaleDateString((window.paLang&&paLang()==='en')?'en-GB':'ar-SY',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
    const g=document.createElement('div');g.id='home-greeting';
    g.innerHTML='<img src="logo.svg" alt=""><div><div class="t">'+hello+'</div><div class="s">'+date+'</div></div><button type="button" onclick="openTour()">❓ شرح البرنامج</button>';
    home.insertBefore(g,home.firstChild);
  }
  }
  buildGreeting();
  window.addEventListener('palang',()=>{const gg=document.getElementById('home-greeting');if(gg){gg.remove();buildGreeting();}});
  if(!get())setTimeout(()=>window.openTour(),500);
})();
