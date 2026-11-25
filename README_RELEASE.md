# محاسب محترف سوريا — ProAccountant Syria
**الإصدار 3.4.0 (versionCode 34)** — النسخة المرجعية للتحديثات القادمة والنشر على Google Play
المطوّر: باسل محمد الخابور — 0952575089

---

## 1. بنية المشروع

| المسار | المحتوى |
|---|---|
| `www/` | **مصدر التطبيق** (HTML/CSS/JS). أي تعديل يتم هنا فقط. |
| `www/tests/` | اختبارات آلية للحسابات والطباعة (`npm test`). |
| `android/` | مشروع أندرويد (Capacitor). `assets/public` نسخة تلقائية من `www` بعد `npx cap sync`. |
| `android/app/src/main/java/.../MainActivity.java` | الجسر الأصلي: الطباعة، PDF، البصمة، النسخ الاحتياطي، Google Drive. |
| `android/keystore.properties.example` | قالب إعدادات توقيع نسخة المتجر. |
| `store-assets/` | أيقونة المتجر 512×512، صورة الواجهة 1024×500، ملفات SVG الأصلية للشعار. |
| `archive/legacy-unused/` | ملفات تنسيق قديمة غير مستخدمة (للمرجع فقط، لا تُشحن مع التطبيق). |
| `PRIVACY_POLICY.md` | سياسة الخصوصية (مطلوبة في Google Play). |
| `CHANGELOG.md` | سجل التغييرات. |

### ملفات `www` الأساسية (بترتيب التحميل)
`accounting-core.js` (محرك الحسابات) ← `print-core.js` + `pdf-raster.js` (الطباعة و PDF) ← `app.js` (التطبيق) ← `pro-suite.js` ← `reports-pro.js` (الأرباح والتقارير وكشف الحساب) ← `biometric.js` (البصمة) ← `backup-pro.js` (النسخ المشفّر) ← `sync-core.js` (المزامنة الفورية وطابور العمليات) ← `settings-pro.js` (واجهة الإعدادات) ← `shell.js` / `onboarding.js` / `i18n*.js` (التنقل والترحيب والترجمة) ← `pa-polish.js`.
التنسيق: `output.css` (Tailwind مبني محلياً) + `android-theme.css` + `print.css` + `pa-polish.css` (آخر طبقة، كل تعديلات التصميم الحديثة).

---

## 2. المتطلبات (مرة واحدة)
- Android Studio (أحدث إصدار) مع Android SDK 36.
- Node.js 20 أو أحدث.
- JDK 21 (يأتي مع Android Studio).

```bash
npm install
```

## 3. التشغيل والتجربة
```bash
npm test                 # الاختبارات الآلية
npx cap sync android     # نسخ www إلى مشروع أندرويد + المكتبات
npx cap open android     # فتح المشروع في Android Studio ثم Run ▶
```
> بعد أي تعديل على `www` نفّذ `npx cap sync android` قبل البناء.

---

## 4. مفتاح التوقيع (مرة واحدة فقط — احفظه للأبد)
Google Play يتطلب أن تُوقَّع كل التحديثات بنفس المفتاح. **إذا ضاع المفتاح لا يمكنك تحديث التطبيق.**

```bash
cd android
keytool -genkeypair -v -keystore ../proaccountant-release.jks -alias proaccountant \
  -keyalg RSA -keysize 2048 -validity 10000
cp keystore.properties.example keystore.properties   # ثم عدّل كلمات السر داخله
```
احفظ `proaccountant-release.jks` وكلمات السر في مكانين آمنين (مثلاً فلاشة + Google Drive مشفّر). الملفان مستبعدان في `.gitignore`.

## 5. بناء نسخة المتجر (AAB)
```bash
npm run build:aab
# الناتج: android/app/build/outputs/bundle/release/app-release.aab
```
أو من Android Studio: **Build ▸ Generate Signed App Bundle / APK ▸ Android App Bundle**.
لتجربة APK موقّع على هاتف: `npm run build:apk` ← `android/app/build/outputs/apk/release/`.

## 6. النشر على Google Play (أول مرة)
1. أنشئ حساب مطوّر في Google Play Console (رسوم لمرة واحدة).
2. **Create app** ← الاسم: «محاسب محترف سوريا» ← اللغة الافتراضية العربية ← تطبيق مجاني/مدفوع.
3. فعّل **Play App Signing** (الافتراضي) وارفع `app-release.aab` في **Internal testing** أولاً.
4. **Store listing**: الأيقونة `store-assets/playstore-icon-512.png`، صورة الواجهة `store-assets/feature-graphic-1024x500.png`، ولقطات شاشة من الهاتف (2–8 صور).
5. **App content**:
   - Privacy policy: انشر محتوى `PRIVACY_POLICY.md` على رابط عام (مثلاً Google Sites) وضع الرابط.
   - Data safety: البيانات تُخزَّن على الجهاز فقط؛ النسخ إلى Google Drive اختياري وبحساب المستخدم ومشفّر؛ لا مشاركة مع أطراف ثالثة؛ الكاميرا لمسح الباركود فقط؛ البصمة يتحقق منها النظام ولا يصل إليها التطبيق.
   - Ads: لا يحتوي إعلانات. Target audience: 18+ (تطبيق أعمال).
   - Category: Business / Finance.
6. بعد نجاح الاختبار الداخلي ← **Production** ← Send for review.

## 7. إصدار تحديث لاحقاً
1. عدّل الملفات في `www/` ثم `npm test`.
2. ارفع رقم الإصدار في `android/app/build.gradle`:
   `versionCode` (+1 دائماً، مثلاً 34) و `versionName` (مثلاً "3.4.0")، وحدّث `window.PA_APP_VERSION` في `www/index.html`.
3. أضف ملاحظة في `CHANGELOG.md`.
4. `npm run build:aab` وارفع الملف الجديد في Play Console.

## 8. ملاحظات مهمة
- **Google Drive**: يعتمد على Google Sign-In (`play-services-auth`). لكي يعمل في نسخة المتجر سجّل بصمة SHA-1 لمفتاح Play App Signing في Google Cloud Console (OAuth client من نوع Android) وفعّل Google Drive API.
- **البصمة**: مكتبة `androidx.biometric` مضافة في `build.gradle`؛ اضغط **Sync Project with Gradle Files** بعد فتح المشروع.
- **التشفير**: النسخ المشفّرة AES-256-GCM بكلمة سر المستخدم (PBKDF2-SHA256، 250k). كلمة السر لا تُرفع ولا تُحفظ داخل النسخة؛ نسيانها يعني عدم إمكانية فتح النسخ المشفّرة.
- **البيانات**: قاعدة البيانات محفوظة داخل تخزين التطبيق، وتُحفظ نسخة «آخر حالة سليمة» تلقائياً قبل كل حفظ.
