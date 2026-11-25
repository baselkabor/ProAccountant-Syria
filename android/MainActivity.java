package com.mhtrfsyria.accountant;

import android.Manifest;
import android.accounts.AccountManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.DashPathEffect;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.graphics.pdf.PdfDocument;
import android.net.Uri;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PdfPrintCallbacks;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintDocumentInfo;
import android.util.Base64;
import android.print.PrintManager;
import android.text.Layout;
import android.text.StaticLayout;
import android.text.TextDirectionHeuristics;
import android.text.TextPaint;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;
import com.getcapacitor.BridgeWebViewClient;
import com.google.android.gms.auth.GoogleAuthUtil;
import com.google.android.gms.auth.UserRecoverableAuthException;
import com.google.android.gms.common.AccountPicker;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Queue;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

public class MainActivity extends BridgeActivity {
    private static final int CAMERA_PERMISSION_REQUEST_CODE = 1001;
    private static final long DOCUMENT_TIMEOUT_MS = 20000L;
    private static final long HTML_TRANSFER_TIMEOUT_MS = 120000L;
    private static final int HTML_TRANSFER_CHUNK_BYTES = 128 * 1024;
    private static final long HTML_TRANSFER_MAX_BYTES = 16L * 1024 * 1024;
    private static final String HTML_TRANSFER_FILE_PREFIX = ".html-transfer-";
    private static final Object DATABASE_LOCK = new Object();
    private static final Object PDF_JOB_LOCK = new Object();

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Set<WebView> activeWebViews = Collections.synchronizedSet(new HashSet<>());
    private final Set<HtmlPdfJob> activeHtmlPdfJobs = Collections.synchronizedSet(new HashSet<>());
    private final Queue<Runnable> pdfJobQueue = new ArrayDeque<>();
    private final AtomicBoolean cameraResumePending = new AtomicBoolean(false);
    private final Map<String, HtmlTransferSession> htmlTransferSessions =
            Collections.synchronizedMap(new HashMap<>());

    private WebView webView;
    private volatile Runnable pendingDriveAction;
    private ActivityResultLauncher<Intent> accountPickerLauncher;
    private ActivityResultLauncher<Intent> consentLauncher;

    private volatile String pendingEmail;
    private volatile String pendingFileName;
    private volatile String pendingJsonContent;
    private volatile String pendingCameraMode = "invoice";
    private volatile boolean appInForeground;

    private Typeface cachedTajawalTypeface;
    private String trustedOrigin = "";
    private boolean pdfJobRunning;
    private boolean pdfQueueStopped;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                handleNativeBack();
            }
        });

        accountPickerLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> {
                    if (result.getResultCode() == RESULT_OK && result.getData() != null) {
                        String email = result.getData().getStringExtra(AccountManager.KEY_ACCOUNT_NAME);
                        if (email != null && webView != null) {
                            webView.post(() -> webView.evaluateJavascript("window.onAndroidGoogleAccountSelected(" + jsQuote(email) + ")", null));
                        }
                    }
                }
        );

        consentLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> {
                    Runnable pendingAction = pendingDriveAction;
                    pendingDriveAction = null;
                    if (result.getResultCode() == RESULT_OK && pendingAction != null) {
                        pendingAction.run();
                    } else if (pendingAction != null && webView != null) {
                        webView.post(() -> webView.evaluateJavascript("window.onDriveBackupsError && window.onDriveBackupsError(" + jsQuote("تم إلغاء منح الصلاحية") + ")", null));
                    } else if (result.getResultCode() == RESULT_OK && pendingEmail != null) {
                        performDriveUpload(pendingEmail, pendingFileName, pendingJsonContent, false);
                    } else if (webView != null) {
                        webView.post(() -> webView.evaluateJavascript("window.onAndroidDriveSyncError(" + jsQuote("تم إلغاء منح الصلاحية") + ")", null));
                    }
                }
        );

        setupNativeBridge();
    }

    @Override
    public void onStart() {
        super.onStart();
        setupNativeBridge();
    }

    @Override
    public void onResume() {
        super.onResume();
        appInForeground = true;
        setupNativeBridge();
        resumeCameraDetection();
    }

    @Override
    public void onPause() {
        appInForeground = false;
        pauseCameraDetection();
        super.onPause();
    }

    private Typeface getAppFontTypeface() {
        if (cachedTajawalTypeface != null) {
            return cachedTajawalTypeface;
        }
        String[] assetPaths = {
                "public/tajawal.ttf",
                "tajawal.ttf",
                "public/Tajawal.ttf",
                "Tajawal.ttf"
        };
        for (String path : assetPaths) {
            try {
                cachedTajawalTypeface = Typeface.createFromAsset(getAssets(), path);
                if (cachedTajawalTypeface != null) {
                    return cachedTajawalTypeface;
                }
            } catch (Exception ignored) {
            }
        }
        cachedTajawalTypeface = Typeface.create(Typeface.SANS_SERIF, Typeface.NORMAL);
        return cachedTajawalTypeface;
    }

    private void setupNativeBridge() {
        if (this.bridge != null && this.bridge.getWebView() != null) {
            if (webView != this.bridge.getWebView()) {
                webView = this.bridge.getWebView();
                if (webView.getUrl() != null) trustedOrigin = getOrigin(webView.getUrl());
                webView.getSettings().setJavaScriptEnabled(true);
                webView.getSettings().setMediaPlaybackRequiresUserGesture(false);
                webView.addJavascriptInterface(new AndroidNativeBridge(this, webView), "AndroidNative");

                webView.setWebChromeClient(new BridgeWebChromeClient(this.bridge) {
                    @Override
                    public void onPermissionRequest(final PermissionRequest request) {
                        runOnUiThread(() -> {
                            try {
                                String[] requested = request.getResources();
                                boolean wantsVideo = false;
                                if (requested != null) {
                                    for (String resource : requested) {
                                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                                            wantsVideo = true;
                                            break;
                                        }
                                    }
                                }
                                if (!wantsVideo || !isTrustedOrigin(request.getOrigin().toString())
                                        || ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                                    request.deny();
                                    return;
                                }
                                request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                            } catch (Exception e) {
                                notifyNativeError("تعذر معالجة إذن الكاميرا: " + errorMessage(e));
                            }
                        });
                    }
                });

                webView.setWebViewClient(new BridgeWebViewClient(this.bridge) {
                    @Override
                    public void onPageFinished(WebView view, String url) {
                        try {
                            super.onPageFinished(view, url);
                        } catch (Exception e) {
                            notifyNativeError("تعذر تحميل الصفحة: " + errorMessage(e));
                        }
                        try {
                            if (view == webView) injectPrintBridgeScript(view);
                        } catch (Exception e) {
                            notifyNativeError("تعذر تهيئة الجسر الأصلي: " + errorMessage(e));
                        }
                    }
                });

                injectPrintBridgeScript(webView);
            }
        }
    }

    private void pauseCameraDetection() {
        WebView target = webView;
        if (target == null) return;
        try {
            target.onPause();
        } catch (Exception e) {
            notifyNativeError("تعذر إيقاف الكاميرا: " + errorMessage(e));
        }
        String script = "(function(){try{" +
                "var m=document.getElementById('barcode-camera-modal');" +
                "var open=!!(m&&!m.classList.contains('hidden'));" +
                "if(open&&typeof window.closeCameraBarcodeScanner==='function'){window.closeCameraBarcodeScanner();}" +
                "return open;" +
                "}catch(e){return false;}})();";
        evaluateJavascriptSafely(target, script, result -> cameraResumePending.set("true".equals(result)));
    }

    private void resumeCameraDetection() {
        WebView target = webView;
        if (target == null) return;
        try {
            target.onResume();
        } catch (Exception e) {
            notifyNativeError("تعذر استئناف الكاميرا: " + errorMessage(e));
        }
        if (!cameraResumePending.compareAndSet(true, false)) return;
        String script = "(function(){try{" +
                "if(document.getElementById('barcode-camera-modal')&&typeof window.startCameraStreamDirectly==='function'){" +
                "var mode='invoice';" +
                "try{mode=(typeof barcodeTargetMode!=='undefined'&&barcodeTargetMode)?barcodeTargetMode:'invoice';}catch(e){}" +
                "Promise.resolve(window.startCameraStreamDirectly(mode)).catch(function(){});" +
                "}" +
                "}catch(e){}})();";
        evaluateJavascriptSafely(target, script, null);
    }

    private void handleNativeBack() {
        if (webView == null) {
            moveTaskToBack(true);
            return;
        }
        webView.evaluateJavascript(
                "(function(){if(typeof window.handleAndroidBack==='function'){return String(window.handleAndroidBack());}return false;})()",
                handled -> {
                    if (!"true".equals(handled)) {
                        if (webView.canGoBack()) webView.goBack();
                        else moveTaskToBack(true);
                    }
                }
        );
    }

    private String getOrigin(String url) {
        try {
            Uri uri = Uri.parse(url);
            String scheme = uri.getScheme();
            if (scheme == null || uri.getHost() == null) return "";
            return scheme + "://" + uri.getHost() + (uri.getPort() >= 0 ? ":" + uri.getPort() : "");
        } catch (Exception e) {
            return "";
        }
    }

    private boolean isTrustedOrigin(String origin) {
        if (origin == null) return false;
        if (!trustedOrigin.isEmpty() && trustedOrigin.equalsIgnoreCase(origin)) return true;
        Uri uri = Uri.parse(origin);
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (host == null) return false;
        return ("https".equalsIgnoreCase(scheme) || "http".equalsIgnoreCase(scheme) || "capacitor".equalsIgnoreCase(scheme))
                && ("localhost".equalsIgnoreCase(host) || "127.0.0.1".equals(host));
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == CAMERA_PERMISSION_REQUEST_CODE) {
            WebView target = webView;
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                if (!appInForeground) {
                    cameraResumePending.set(true);
                } else if (target != null) {
                    evaluateJavascriptSafely(target,
                            "window.startCameraStreamDirectly(" + jsQuote(pendingCameraMode) + ");", null);
                }
            } else if (target != null && appInForeground) {
                evaluateJavascriptSafely(target, "window.onAndroidCameraPermissionDenied();", null);
            }
        }
    }

    private String safePdfFileName(String fileName) {
        String name = fileName == null ? "" : fileName.trim().replace('\\', '/');
        int slash = name.lastIndexOf('/');
        if (slash >= 0) name = name.substring(slash + 1);
        name = name.replaceAll("[^A-Za-z0-9._-]+", "_");
        if (name.isEmpty() || ".".equals(name) || "..".equals(name)) {
            name = "Invoice_" + System.currentTimeMillis() + ".pdf";
        }
        if (!name.toLowerCase(Locale.ROOT).endsWith(".pdf")) name += ".pdf";
        if (name.length() > 120) name = name.substring(0, 115) + ".pdf";
        return name;
    }

    private float drawWrappedText(Canvas canvas, String text, float rightX, float y, float maxWidth, TextPaint paint) {
        if (text == null || text.trim().isEmpty()) return y;
        String trimmed = text.trim();
        StaticLayout layout = StaticLayout.Builder
                .obtain(trimmed, 0, trimmed.length(), paint, Math.max(50, (int) maxWidth))
                .setAlignment(Layout.Alignment.ALIGN_NORMAL)
                .setTextDirection(TextDirectionHeuristics.RTL)
                .setLineSpacing(0f, 1.25f)
                .setIncludePad(false)
                .build();
        canvas.save();
        canvas.translate(rightX - layout.getWidth(), y);
        layout.draw(canvas);
        canvas.restore();
        return y + layout.getHeight() + 6f;
    }

    private void createPdfAndShare(String fileName, String htmlDoc, String fallbackText, String paper) {
        if (isFinishing() || isDestroyed()) return;
        final String uniqueFileName = uniquePdfFileName(fileName);
        enqueuePdfJob(() -> {
            if (isFinishing() || isDestroyed()) {
                completePdfJob();
                return;
            }
            if (htmlDoc != null && !htmlDoc.trim().isEmpty()) {
                createHtmlPdfAndShare(uniqueFileName, htmlDoc, fallbackText, paper);
            } else {
                createTextPdfAndShare(uniqueFileName, fallbackText, paper, this::completePdfJob);
            }
        });
    }

    private String uniquePdfFileName(String fileName) {
        String safeName = safePdfFileName(fileName);
        String baseName = safeName.substring(0, safeName.length() - 4);
        return baseName + "_" + System.currentTimeMillis() + "_"
                + UUID.randomUUID().toString().substring(0, 8) + ".pdf";
    }

    private void enqueuePdfJob(Runnable job) {
        boolean startNow;
        synchronized (PDF_JOB_LOCK) {
            if (pdfQueueStopped) return;
            pdfJobQueue.add(job);
            startNow = !pdfJobRunning;
            if (startNow) pdfJobRunning = true;
        }
        if (startNow) runOnUiThread(job);
    }

    private void completePdfJob() {
        Runnable nextJob;
        synchronized (PDF_JOB_LOCK) {
            if (!pdfJobRunning) return;
            nextJob = pdfJobQueue.poll();
            if (nextJob == null) {
                pdfJobRunning = false;
                return;
            }
        }
        runOnUiThread(nextJob);
    }

    private File getPdfTargetDirectory() throws IOException {
        File baseDir = getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS);
        File targetDir = baseDir != null ? new File(baseDir, "Invoices") : new File(getFilesDir(), "Documents/Invoices");
        if (!targetDir.exists() && !targetDir.mkdirs()) {
            targetDir = new File(getCacheDir(), "Invoices");
            if (!targetDir.exists() && !targetDir.mkdirs()) throw new IOException("تعذر إنشاء مجلد ملفات PDF");
        }
        if (!targetDir.isDirectory()) throw new IOException("مسار ملفات PDF غير صالح");
        return targetDir;
    }

    private PrintAttributes getDocumentPrintAttributes(String paper) {
        PrintAttributes.MediaSize mediaSize;
        if ("58mm".equals(paper)) {
            mediaSize = new PrintAttributes.MediaSize("thermal58", "Thermal 58mm", 2283, 11693);
        } else if ("thermal".equals(paper)) {
            mediaSize = new PrintAttributes.MediaSize("thermal80", "Thermal 80mm", 3150, 11693);
        } else {
            mediaSize = PrintAttributes.MediaSize.ISO_A4;
        }
        return new PrintAttributes.Builder()
                .setMediaSize(mediaSize)
                .setResolution(new PrintAttributes.Resolution("pdf", "pdf", 300, 300))
                .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                .build();
    }

    private void createHtmlPdfAndShare(String safeFileName, String htmlDoc, String fallbackText, String paper) {
        final HtmlPdfJob job;
        try {
            job = new HtmlPdfJob(safeFileName, htmlDoc, fallbackText, paper);
        } catch (Exception e) {
            String message = "تعذر تشغيل مولّد PDF: " + errorMessage(e);
            notifyNativeError(message);
            createTextPdfAndShare(safeFileName, fallbackText, paper, this::completePdfJob);
            return;
        }
        try {
            job.start();
        } catch (Exception e) {
            job.fail("تعذر تشغيل مولّد PDF: " + errorMessage(e));
        }
    }

    private final class HtmlPdfJob {
        private final String finalFileName;
        private final String htmlDocument;
        private final String fallbackText;
        private final String paper;
        private final WebView view;
        private final AtomicBoolean completed = new AtomicBoolean(false);
        private final AtomicBoolean rendering = new AtomicBoolean(false);
        private final Runnable timeoutRunnable;

        private volatile File temporaryPdf;
        private volatile ParcelFileDescriptor descriptor;
        private volatile CancellationSignal layoutCancellation;
        private volatile CancellationSignal writeCancellation;

        HtmlPdfJob(String finalFileName, String htmlDocument, String fallbackText, String paper) {
            this.finalFileName = finalFileName;
            this.htmlDocument = htmlDocument;
            this.fallbackText = fallbackText;
            this.paper = paper;
            this.view = new WebView(MainActivity.this);
            this.timeoutRunnable = () -> fail("انتهت مهلة إنشاء ملف PDF");
            activeWebViews.add(view);
            activeHtmlPdfJobs.add(this);
        }

        void start() {
            mainHandler.postDelayed(timeoutRunnable, DOCUMENT_TIMEOUT_MS);
            try {
                view.setBackgroundColor(Color.WHITE);
                view.getSettings().setJavaScriptEnabled(false);
                view.getSettings().setAllowFileAccess(true);
                view.getSettings().setBuiltInZoomControls(false);
                view.setWebViewClient(new WebViewClient() {
                    @Override
                    public void onPageFinished(WebView pageView, String url) {
                        if (completed.get() || !rendering.compareAndSet(false, true)) return;
                        try {
                            File targetDir = getPdfTargetDirectory();
                            temporaryPdf = new File(targetDir, ".pdf-" + UUID.randomUUID() + ".part");
                            PrintDocumentAdapter adapter = pageView.createPrintDocumentAdapter(finalFileName);
                            layoutCancellation = new CancellationSignal();
                            adapter.onLayout(null, getDocumentPrintAttributes(paper), layoutCancellation,
                                    PdfPrintCallbacks.createLayout(new PdfPrintCallbacks.LayoutListener() {
                                        @Override
                                        public void onLayoutFinished(int pageCount, boolean changed) {
                                            if (completed.get()) return;
                                            if (pageCount <= 0) {
                                                fail("لم يتم العثور على صفحات قابلة للطباعة");
                                                return;
                                            }
                                            final File temp = temporaryPdf;
                                            if (temp == null) {
                                                fail("تعذر إنشاء ملف PDF المؤقت");
                                                return;
                                            }
                                            try {
                                                ParcelFileDescriptor opened = ParcelFileDescriptor.open(temp,
                                                        ParcelFileDescriptor.MODE_CREATE
                                                                | ParcelFileDescriptor.MODE_TRUNCATE
                                                                | ParcelFileDescriptor.MODE_WRITE_ONLY);
                                                descriptor = opened;
                                                if (completed.get()) {
                                                    closeQuietly(opened);
                                                    deleteQuietly(temp);
                                                    return;
                                                }
                                                writeCancellation = new CancellationSignal();
                                                adapter.onWrite(new PageRange[]{PageRange.ALL_PAGES}, opened,
                                                        writeCancellation,
                                                        PdfPrintCallbacks.createWrite(pageCount,
                                                                new PdfPrintCallbacks.WriteListener() {
                                                                    @Override
                                                                    public void onWriteFinished(PageRange[] writtenPages) {
                                                                        if (completed.get()) return;
                                                                        finishOnce(() -> finalizeWrittenPdf(temp));
                                                                    }

                                                                    @Override
                                                                    public void onWriteFailed(CharSequence error) {
                                                                        fail(errorMessage(error));
                                                                    }
                                                                }));
                                            } catch (Exception e) {
                                                fail("تعذر كتابة ملف PDF: " + errorMessage(e));
                                            }
                                        }

                                        @Override
                                        public void onLayoutFailed(CharSequence error) {
                                            fail(errorMessage(error));
                                        }
                                    }), null);
                        } catch (Exception e) {
                            fail("تعذر تجهيز ملف PDF: " + errorMessage(e));
                        }
                    }

                    @Override
                    public void onReceivedError(WebView pageView, int errorCode, String description, String failingUrl) {
                        if (!rendering.get()) fail(description == null ? "تعذر تحميل مستند PDF" : description);
                    }

                    @Override
                    public void onReceivedError(WebView pageView, WebResourceRequest request, WebResourceError error) {
                        if (request == null || request.isForMainFrame()) {
                            if (!rendering.get()) fail(error == null ? "تعذر تحميل مستند PDF" : error.getDescription().toString());
                        }
                    }

                    @Override
                    public boolean onRenderProcessGone(WebView pageView, RenderProcessGoneDetail detail) {
                        fail("تعذر عرض مستند PDF");
                        return true;
                    }
                });
                view.loadDataWithBaseURL("file:///android_asset/public/", htmlDocument, "text/html", "UTF-8", null);
            } catch (Exception e) {
                fail("تعذر تشغيل مولّد PDF: " + errorMessage(e));
            }
        }

        private void finalizeWrittenPdf(File temp) {
            try {
                new Thread(() -> {
                    File output = null;
                    try {
                        if (isFinishing() || isDestroyed()) {
                            deleteQuietly(temp);
                            completePdfJob();
                            return;
                        }
                        validatePdfFile(temp);
                        output = new File(getPdfTargetDirectory(), finalFileName);
                        movePdfFile(temp, output);
                        deleteQuietly(temp);
                        final File outputToShare = output;
                        runOnUiThread(() -> {
                            try {
                                if (!isFinishing() && !isDestroyed()) shareGeneratedPdfUri(outputToShare);
                            } finally {
                                completePdfJob();
                            }
                        });
                    } catch (Exception e) {
                        deleteQuietly(temp);
                        deleteQuietly(output);
                        fallbackAfterCompletion("تعذر حفظ ملف PDF: " + errorMessage(e));
                    }
                }, "pdf-finalize").start();
            } catch (Exception e) {
                fallbackAfterCompletion("تعذر حفظ ملف PDF: " + errorMessage(e));
            }
        }

        private void fail(String message) {
            finishOnce(() -> {
                File temp = temporaryPdf;
                temporaryPdf = null;
                deleteQuietly(temp);
                if (isFinishing() || isDestroyed()) {
                    completePdfJob();
                    return;
                }
                fallbackAfterCompletion(message);
            });
        }

        private void fallbackAfterCompletion(String message) {
            notifyNativeError(message);
            createTextPdfAndShare(finalFileName, fallbackText, paper, MainActivity.this::completePdfJob);
        }

        private boolean finishOnce(Runnable terminalAction) {
            if (!completed.compareAndSet(false, true)) return false;
            activeHtmlPdfJobs.remove(this);
            mainHandler.removeCallbacks(timeoutRunnable);
            cancelQuietly(layoutCancellation);
            cancelQuietly(writeCancellation);
            closeQuietly(descriptor);
            descriptor = null;
            try {
                terminalAction.run();
            } finally {
                destroyActiveWebView(view);
            }
            return true;
        }

        private void cancelForDestroy() {
            finishOnce(() -> {
                File temp = temporaryPdf;
                temporaryPdf = null;
                deleteQuietly(temp);
            });
        }
    }

    private void validatePdfFile(File file) throws IOException {
        if (file == null || !file.isFile() || file.length() == 0) {
            throw new IOException("ملف PDF فارغ أو غير موجود");
        }
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] header = new byte[5];
            int read = input.read(header);
            String signature = read == header.length
                    ? new String(header, 0, header.length, StandardCharsets.ISO_8859_1) : "";
            if (!"%PDF-".equals(signature)) throw new IOException("توقيع ملف PDF غير صالح");
        }
    }

    private void movePdfFile(File source, File target) throws IOException {
        if (target.exists() && !target.delete()) throw new IOException("تعذر استبدال ملف PDF النهائي");
        if (!source.renameTo(target)) {
            if (!copyFile(source, target)) {
                deleteQuietly(target);
                throw new IOException("تعذر نقل ملف PDF النهائي");
            }
            if (!source.delete()) source.deleteOnExit();
        }
    }

    private void closeQuietly(ParcelFileDescriptor descriptor) {
        if (descriptor == null) return;
        try {
            descriptor.close();
        } catch (Exception ignored) {
        }
    }

    private void cancelQuietly(CancellationSignal signal) {
        if (signal == null) return;
        try {
            signal.cancel();
        } catch (Exception ignored) {
        }
    }

    private void deleteQuietly(File file) {
        if (file == null || !file.exists()) return;
        if (!file.delete()) file.deleteOnExit();
    }

    private static String errorMessage(CharSequence error) {
        return error == null || error.toString().trim().isEmpty() ? "خطأ أصلي غير معروف" : error.toString();
    }

    private static String errorMessage(Exception error) {
        String message = error == null ? null : error.getMessage();
        return message == null || message.trim().isEmpty() ? "خطأ أصلي غير معروف" : message;
    }

    private void createTextPdfAndShare(String fileName, String receiptText, String paper, Runnable onFinished) {
        final String safeFileName = safePdfFileName(fileName);
        final boolean thermal = "thermal".equals(paper) || "58mm".equals(paper);
        final AtomicBoolean completionHandled = new AtomicBoolean(false);
        final Runnable finishJob = () -> {
            if (completionHandled.compareAndSet(false, true) && onFinished != null) onFinished.run();
        };
        if (isFinishing() || isDestroyed()) {
            finishJob.run();
            return;
        }
        Thread thread = new Thread(() -> {
            PdfDocument document = null;
            File temporaryPdf = null;
            File pdfFile = null;
            try {
                if (isFinishing() || isDestroyed()) return;
                document = new PdfDocument();
                File targetDir = getPdfTargetDirectory();
                temporaryPdf = new File(targetDir, ".text-pdf-" + UUID.randomUUID() + ".part");
                pdfFile = new File(targetDir, safeFileName);
                int pageWidth = thermal ? ("58mm".equals(paper) ? 164 : 227) : 595;
                int pageHeight = thermal ? 1100 : 842;
                PdfDocument.PageInfo pageInfo = new PdfDocument.PageInfo.Builder(pageWidth, pageHeight, 1).create();
                PdfDocument.Page page = document.startPage(pageInfo);
                int pageNo = 1;

                Canvas canvas = page.getCanvas();
                canvas.drawColor(Color.WHITE);

                Typeface baseFont = getAppFontTypeface();
                Typeface boldFont = Typeface.create(baseFont, Typeface.BOLD);

                float margin = thermal ? 10f : 28f;
                float leftX = margin;
                float rightX = pageWidth - margin;
                float contentWidth = pageWidth - (margin * 2f);
                float y = thermal ? 24f : 42f;

                Paint borderPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
                borderPaint.setColor(Color.parseColor("#CBD5E1"));
                borderPaint.setStyle(Paint.Style.STROKE);
                borderPaint.setStrokeWidth(1f);

                Paint darkLinePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
                darkLinePaint.setColor(Color.parseColor("#0F172A"));
                darkLinePaint.setStrokeWidth(1.5f);

                Paint headerBgPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
                headerBgPaint.setColor(Color.parseColor("#F1F5F9"));
                headerBgPaint.setStyle(Paint.Style.FILL);

                Paint totalBoxBgPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
                totalBoxBgPaint.setColor(Color.parseColor("#F8FAFC"));
                totalBoxBgPaint.setStyle(Paint.Style.FILL);

                TextPaint bodyPaint = new TextPaint(Paint.ANTI_ALIAS_FLAG);
                bodyPaint.setTypeface(baseFont);
                bodyPaint.setColor(Color.parseColor("#0F172A"));
                bodyPaint.setTextSize(thermal ? 9.5f : 13f);

                TextPaint boldBodyPaint = new TextPaint(Paint.ANTI_ALIAS_FLAG);
                boldBodyPaint.setTypeface(boldFont);
                boldBodyPaint.setColor(Color.parseColor("#0F172A"));
                boldBodyPaint.setTextSize(thermal ? 10f : 13.5f);
                boldBodyPaint.setFakeBoldText(true);

                Paint centerTitlePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
                centerTitlePaint.setTypeface(boldFont);
                centerTitlePaint.setColor(Color.parseColor("#0F172A"));
                centerTitlePaint.setTextSize(thermal ? 13f : 19f);
                centerTitlePaint.setFakeBoldText(true);
                centerTitlePaint.setTextAlign(Paint.Align.CENTER);

                Paint centerSubPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
                centerSubPaint.setTypeface(baseFont);
                centerSubPaint.setColor(Color.parseColor("#334155"));
                centerSubPaint.setTextSize(thermal ? 8.5f : 12.5f);
                centerSubPaint.setTextAlign(Paint.Align.CENTER);

                Paint centerBoldPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
                centerBoldPaint.setTypeface(boldFont);
                centerBoldPaint.setColor(Color.parseColor("#0F172A"));
                centerBoldPaint.setTextSize(thermal ? 11f : 16f);
                centerBoldPaint.setFakeBoldText(true);
                centerBoldPaint.setTextAlign(Paint.Align.CENTER);

                Paint centerSubBoldPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
                centerSubBoldPaint.setTypeface(boldFont);
                centerSubBoldPaint.setColor(Color.parseColor("#0F172A"));
                centerSubBoldPaint.setTextSize(thermal ? 9.5f : 13.5f);
                centerSubBoldPaint.setFakeBoldText(true);
                centerSubBoldPaint.setTextAlign(Paint.Align.CENTER);

                String safeText = (receiptText != null && !receiptText.trim().isEmpty())
                        ? receiptText
                        : "محاسب محترف سوريا\nبإدارة باسل محمد الخابور - 0952575089\nفاتورة";

                String[] rawLines = safeText.split("\n");
                List<String> nonEmptyRaw = new ArrayList<>();
                for (String rl : rawLines) {
                    String t = rl.trim();
                    if (!t.isEmpty()) {
                        nonEmptyRaw.add(t);
                    }
                }

                String dynamicCompanyTitle = "محاسب محترف سوريا";
                String dynamicCompanySub = "بإدارة باسل محمد الخابور - 0952575089";
                int consumedHeaderLines = 0;

                if (!nonEmptyRaw.isEmpty()) {
                    String firstLine = nonEmptyRaw.get(0);
                    if (!firstLine.startsWith("فاتورة") && !firstLine.startsWith("سند") && !firstLine.startsWith("كشف حساب") && !firstLine.startsWith("إشعار") && !firstLine.startsWith("تقرير")) {
                        dynamicCompanyTitle = firstLine;
                        consumedHeaderLines = 1;
                        if (nonEmptyRaw.size() > 1) {
                            String secondLine = nonEmptyRaw.get(1);
                            if (!secondLine.startsWith("فاتورة") && !secondLine.startsWith("سند") && !secondLine.startsWith("كشف حساب") && !secondLine.startsWith("إشعار") && !secondLine.startsWith("تقرير")) {
                                dynamicCompanySub = secondLine;
                                consumedHeaderLines = 2;
                            }
                        }
                    }
                }

                canvas.drawText(dynamicCompanyTitle, pageWidth / 2f, y, centerTitlePaint);
                y += 19f;
                canvas.drawText(dynamicCompanySub, pageWidth / 2f, y, centerSubPaint);
                y += 12f;
                canvas.drawLine(leftX, y, rightX, y, darkLinePaint);
                y += 18f;

                List<String> lines = new ArrayList<>();
                for (int idx = consumedHeaderLines; idx < nonEmptyRaw.size(); idx++) {
                    String t = nonEmptyRaw.get(idx);
                    if (!t.contains("شكراً") && !t.contains("Thank you")) {
                        lines.add(t);
                    }
                }

                boolean isVoucher = false;
                boolean isStatement = false;
                for (String l : lines) {
                    if (l.contains("سند قبض") || l.contains("سند دفع") || l.contains("إشعار مرتجع") || l.contains("توقيع المستلم") || l.contains("توقيع المحاسب")) {
                        isVoucher = true;
                        break;
                    }
                    if (l.contains("كشف حساب تفصيلي") || (l.contains("مدين") && l.contains("دائن") && l.contains("الرصيد"))) {
                        isStatement = true;
                        break;
                    }
                }

                if (isVoucher) {
                    float boxTop = y;
                    float innerLeft = leftX + 14f;
                    float innerRight = rightX - 14f;
                    float innerWidth = innerRight - innerLeft;
                    float curY = y + 14f;

                    String voucherBanner = null;
                    List<String> voucherDetails = new ArrayList<>();
                    List<String> signatures = new ArrayList<>();

                    for (String l : lines) {
                        if (l.contains("سند قبض") || l.contains("سند دفع") || l.contains("إشعار مرتجع")) {
                            voucherBanner = l;
                        } else if (l.contains("توقيع المستلم") || l.contains("توقيع المحاسب") || l.matches("^\\.+\\s*\\.+.*$")) {
                            signatures.add(l);
                        } else {
                            voucherDetails.add(l);
                        }
                    }

                    if (voucherBanner != null) {
                        float bannerH = 30f;
                        canvas.drawRect(innerLeft, curY, innerRight, curY + bannerH, headerBgPaint);
                        canvas.drawRect(innerLeft, curY, innerRight, curY + bannerH, borderPaint);
                        Paint bannerPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
                        bannerPaint.setTypeface(boldFont);
                        bannerPaint.setColor(Color.parseColor("#0F172A"));
                        bannerPaint.setTextSize(14f);
                        bannerPaint.setFakeBoldText(true);
                        bannerPaint.setTextAlign(Paint.Align.CENTER);
                        canvas.drawText(voucherBanner, pageWidth / 2f, curY + 20f, bannerPaint);
                        curY += bannerH + 16f;
                    }

                    for (String vd : voucherDetails) {
                        boolean isBoldField = vd.startsWith("التاريخ") || vd.startsWith("استلمنا") || vd.startsWith("دفعنا") || vd.startsWith("مبلغ");
                        curY = drawWrappedText(canvas, vd, innerRight, curY, innerWidth, isBoldField ? boldBodyPaint : bodyPaint);
                        curY += 6f;
                    }

                    if (!signatures.isEmpty()) {
                        curY += 22f;
                        Paint sigRightPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
                        sigRightPaint.setTypeface(boldFont);
                        sigRightPaint.setColor(Color.parseColor("#0F172A"));
                        sigRightPaint.setTextSize(13f);
                        sigRightPaint.setTextAlign(Paint.Align.RIGHT);

                        Paint sigLeftPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
                        sigLeftPaint.setTypeface(boldFont);
                        sigLeftPaint.setColor(Color.parseColor("#0F172A"));
                        sigLeftPaint.setTextSize(13f);
                        sigLeftPaint.setTextAlign(Paint.Align.LEFT);

                        String rightSig = null;
                        String leftSig = null;
                        List<String> dotLines = new ArrayList<>();
                        for (String s : signatures) {
                            if (s.contains("توقيع المستلم")) rightSig = s;
                            else if (s.contains("توقيع المحاسب")) leftSig = s;
                            else dotLines.add(s);
                        }

                        if (rightSig != null) canvas.drawText(rightSig, innerRight, curY, sigRightPaint);
                        if (leftSig != null) canvas.drawText(leftSig, innerLeft, curY, sigLeftPaint);
                        curY += 20f;

                        for (String dl : dotLines) {
                            String[] splitDots = dl.split("\\s{2,}");
                            if (splitDots.length >= 2) {
                                canvas.drawText(splitDots[0].trim(), innerRight, curY, sigRightPaint);
                                canvas.drawText(splitDots[splitDots.length - 1].trim(), innerLeft, curY, sigLeftPaint);
                            } else {
                                canvas.drawText(dl, pageWidth / 2f, curY, centerSubPaint);
                            }
                            curY += 20f;
                        }
                    }

                    curY += 12f;
                    Paint outerBoxStroke = new Paint(Paint.ANTI_ALIAS_FLAG);
                    outerBoxStroke.setColor(Color.parseColor("#0F172A"));
                    outerBoxStroke.setStyle(Paint.Style.STROKE);
                    outerBoxStroke.setStrokeWidth(1.5f);
                    canvas.drawRect(leftX, boxTop, rightX, curY, outerBoxStroke);

                    curY += 14f;
                    Paint vDashPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
                    vDashPaint.setColor(Color.parseColor("#94A3B8"));
                    vDashPaint.setStrokeWidth(0.8f);
                    vDashPaint.setPathEffect(new DashPathEffect(new float[]{5f, 3f}, 0));
                    canvas.drawLine(leftX, curY, rightX, curY, vDashPaint);
                    curY += 13f;

                    Paint vFooterPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
                    vFooterPaint.setTypeface(baseFont);
                    vFooterPaint.setColor(Color.parseColor("#475569"));
                    vFooterPaint.setTextSize(9.5f);
                    vFooterPaint.setTextAlign(Paint.Align.CENTER);
                    canvas.drawText("شكراً لاختياركم نظام المحاسبة - محاسب محترف سوريا | باسل محمد الخابور - 0952575089", pageWidth / 2f, curY, vFooterPaint);
                    curY += 12f;
                    canvas.drawText("Thank you for choosing our accounting system - ProAccountant Syria | Dev: Basel Al-Kabor | 0952575089", pageWidth / 2f, curY, vFooterPaint);
                } else if (isStatement) {
                    String stmtBanner = null;
                    List<String> stmtRows = new ArrayList<>();
                    String finalBalanceLine = null;
                    boolean afterStmtHeader = false;

                    for (String l : lines) {
                        if (l.contains("كشف حساب تفصيلي")) {
                            stmtBanner = l;
                        } else if (l.contains("مدين") && l.contains("دائن") && l.contains("الرصيد")) {
                            afterStmtHeader = true;
                        } else if (l.startsWith("الرصيد النهائي")) {
                            afterStmtHeader = false;
                            finalBalanceLine = l;
                        } else if (afterStmtHeader) {
                            stmtRows.add(l);
                        }
                    }

                    if (stmtBanner != null) {
                        float bannerH = 28f;
                        canvas.drawRect(leftX, y, rightX, y + bannerH, headerBgPaint);
                        canvas.drawRect(leftX, y, rightX, y + bannerH, borderPaint);
                        Paint bannerPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
                        bannerPaint.setTypeface(boldFont);
                        bannerPaint.setColor(Color.parseColor("#0F172A"));
                        bannerPaint.setTextSize(14f);
                        bannerPaint.setFakeBoldText(true);
                        bannerPaint.setTextAlign(Paint.Align.CENTER);
                        canvas.drawText(stmtBanner, pageWidth / 2f, y + 19f, bannerPaint);
                        y += bannerH + 12f;
                    }

                    // 6 columns for Statement: [الرصيد ($)] [دائن ($)] [مدين ($)] [البيان] [المرجع] [التاريخ]
                    float columnScale = contentWidth / 539f;
                    float colBalW = 96f * columnScale;
                    float colCrW = 76f * columnScale;
                    float colDrW = 76f * columnScale;
                    float colRefW = 68f * columnScale;
                    float colDateW = 84f * columnScale;
                    float colDescW = contentWidth - (colBalW + colCrW + colDrW + colRefW + colDateW);

                    float xBalRight = leftX + colBalW;
                    float xCrRight = xBalRight + colCrW;
                    float xDrRight = xCrRight + colDrW;
                    float xDescRight = xDrRight + colDescW;
                    float xRefRight = xDescRight + colRefW;

                    float headerH = 28f;
                    canvas.drawRect(leftX, y, rightX, y + headerH, headerBgPaint);
                    canvas.drawLine(leftX, y, rightX, y, darkLinePaint);
                    canvas.drawLine(leftX, y + headerH, rightX, y + headerH, darkLinePaint);

                    Paint cellHeaderPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
                    cellHeaderPaint.setTypeface(boldFont);
                    cellHeaderPaint.setColor(Color.parseColor("#0F172A"));
                    cellHeaderPaint.setTextSize(11.5f);
                    cellHeaderPaint.setFakeBoldText(true);
                    cellHeaderPaint.setTextAlign(Paint.Align.CENTER);

                    float headerTextY = y + 18f;
                    canvas.drawText("الرصيد ($)", xBalRight - colBalW / 2f, headerTextY, cellHeaderPaint);
                    canvas.drawText("دائن ($)", xCrRight - colCrW / 2f, headerTextY, cellHeaderPaint);
                    canvas.drawText("مدين ($)", xDrRight - colDrW / 2f, headerTextY, cellHeaderPaint);
                    canvas.drawText("البيان", xDescRight - colDescW / 2f, headerTextY, cellHeaderPaint);
                    canvas.drawText("المرجع", xRefRight - colRefW / 2f, headerTextY, cellHeaderPaint);
                    canvas.drawText("التاريخ", rightX - colDateW / 2f, headerTextY, cellHeaderPaint);

                    y += headerH;

                    for (String sr : stmtRows) {
                        float rowH = 30f;
                        if (y + rowH > pageHeight - 60f) {
                            drawPageFooter(canvas, pageNo, pageWidth, pageHeight, baseFont);
                            document.finishPage(page);
                            pageNo++;
                            page = document.startPage(new PdfDocument.PageInfo.Builder(pageWidth, pageHeight, pageNo).create());
                            canvas = page.getCanvas();
                            canvas.drawColor(Color.WHITE);
                            y = 42f;
                        }
                        canvas.drawLine(leftX, y + rowH, rightX, y + rowH, borderPaint);

                        String datePart = "";
                        String refPart = "-";
                        String balPart = "";
                        String crPart = "-";
                        String drPart = "-";
                        String descPart = sr;

                        String cleanRow = sr.trim();
                        if (cleanRow.startsWith("افتتاحي")) {
                            datePart = "افتتاحي";
                            cleanRow = cleanRow.substring("افتتاحي".length()).trim();
                        } else {
                            String[] tok = cleanRow.split("\\s+", 2);
                            if (tok.length > 0) {
                                datePart = tok[0];
                                cleanRow = tok.length > 1 ? tok[1].trim() : "";
                            }
                        }

                        if (cleanRow.startsWith("-")) {
                            refPart = "-";
                            cleanRow = cleanRow.substring(1).trim();
                        } else {
                            String[] tok2 = cleanRow.split("\\s+", 2);
                            if (tok2.length > 0) {
                                refPart = tok2[0];
                                cleanRow = tok2.length > 1 ? tok2[1].trim() : "";
                            }
                        }

                        // Extract trailing balance like "$200.00 له" or "$50.00 عليه"
                        java.util.regex.Matcher balMatcher = java.util.regex.Pattern.compile("(\\$[0-9,.]+(?:\\s+(?:عليه|له))?)\\s*$").matcher(cleanRow);
                        if (balMatcher.find()) {
                            balPart = balMatcher.group(1).trim();
                            cleanRow = cleanRow.substring(0, balMatcher.start()).trim();
                        }

                        // Extract all $ amounts in remaining string
                        java.util.List<String> amts = new ArrayList<>();
                        java.util.regex.Matcher amtMatcher = java.util.regex.Pattern.compile("(\\$[0-9,.]+)").matcher(cleanRow);
                        while (amtMatcher.find()) {
                            amts.add(amtMatcher.group(1));
                        }
                        cleanRow = cleanRow.replaceAll("\\$[0-9,.]+", "").replaceAll("\\s*-\\s*", " ").trim();
                        if (!cleanRow.isEmpty()) {
                            descPart = cleanRow;
                        }
                        if (amts.size() >= 2) {
                            drPart = amts.get(0);
                            crPart = amts.get(1);
                        } else if (amts.size() == 1) {
                            if (sr.contains("سند قبض") || sr.contains("مشتريات") || balPart.contains("له")) {
                                crPart = amts.get(0);
                            } else {
                                drPart = amts.get(0);
                            }
                        }

                        Paint cellValPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
                        cellValPaint.setTypeface(baseFont);
                        cellValPaint.setColor(Color.parseColor("#0F172A"));
                        cellValPaint.setTextSize(11.5f);
                        cellValPaint.setTextAlign(Paint.Align.CENTER);

                        Paint descPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
                        descPaint.setTypeface(baseFont);
                        descPaint.setColor(Color.parseColor("#0F172A"));
                        descPaint.setTextSize(11.5f);
                        descPaint.setTextAlign(Paint.Align.RIGHT);

                        float textY = y + 19f;
                        canvas.drawText(balPart, xBalRight - colBalW / 2f, textY, cellValPaint);
                        canvas.drawText(crPart, xCrRight - colCrW / 2f, textY, cellValPaint);
                        canvas.drawText(drPart, xDrRight - colDrW / 2f, textY, cellValPaint);
                        canvas.drawText(descPart, xDescRight - 6f, textY, descPaint);
                        canvas.drawText(refPart, xRefRight - colRefW / 2f, textY, cellValPaint);
                        canvas.drawText(datePart, rightX - colDateW / 2f, textY, cellValPaint);

                        y += rowH;
                    }

                    if (finalBalanceLine != null) {
                        if (y + 110f > pageHeight - 60f) {
                            drawPageFooter(canvas, pageNo, pageWidth, pageHeight, baseFont);
                            document.finishPage(page);
                            pageNo++;
                            page = document.startPage(new PdfDocument.PageInfo.Builder(pageWidth, pageHeight, pageNo).create());
                            canvas = page.getCanvas();
                            canvas.drawColor(Color.WHITE);
                            y = 42f;
                        }
                        y += 14f;
                        float boxH = 38f;
                        canvas.drawRect(leftX, y, rightX, y + boxH, totalBoxBgPaint);
                        canvas.drawLine(leftX, y, rightX, y, darkLinePaint);
                        canvas.drawLine(leftX, y + boxH, rightX, y + boxH, darkLinePaint);
                        canvas.drawText(finalBalanceLine, pageWidth / 2f, y + 24f, centerBoldPaint);
                        y += boxH + 10f;
                    }

                    y += 10f;
                    if (y + 60f > pageHeight - 40f) {
                        drawPageFooter(canvas, pageNo, pageWidth, pageHeight, baseFont);
                        document.finishPage(page);
                        pageNo++;
                        page = document.startPage(new PdfDocument.PageInfo.Builder(pageWidth, pageHeight, pageNo).create());
                        canvas = page.getCanvas();
                        canvas.drawColor(Color.WHITE);
                        y = 42f;
                    }
                    Paint dashPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
                    dashPaint.setColor(Color.parseColor("#94A3B8"));
                    dashPaint.setStrokeWidth(0.8f);
                    dashPaint.setPathEffect(new DashPathEffect(new float[]{5f, 3f}, 0));
                    canvas.drawLine(leftX, y, rightX, y, dashPaint);
                    y += 13f;

                    Paint smallFooterPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
                    smallFooterPaint.setTypeface(baseFont);
                    smallFooterPaint.setColor(Color.parseColor("#475569"));
                    smallFooterPaint.setTextSize(9.5f);
                    smallFooterPaint.setTextAlign(Paint.Align.CENTER);

                    canvas.drawText("شكراً لاختياركم نظام المحاسبة - محاسب محترف سوريا | باسل محمد الخابور - 0952575089", pageWidth / 2f, y, smallFooterPaint);
                    y += 12f;
                    canvas.drawText("Thank you for choosing our accounting system - ProAccountant Syria | Dev: Basel Al-Kabor | 0952575089", pageWidth / 2f, y, smallFooterPaint);
                    y += 12f;
                } else {
                    String invoiceTypeLine = null;
                    String invoiceNumLine = null;
                    List<String> metaLines = new ArrayList<>();
                    List<String> itemRows = new ArrayList<>();
                    List<String> totalLines = new ArrayList<>();
                    String footerLine = null;

                    boolean afterTableHeader = false;
                    for (String l : lines) {
                        if (l.startsWith("فاتورة مبيعات") || l.startsWith("فاتورة مشتريات")) {
                            invoiceTypeLine = l;
                        } else if (l.startsWith("رقم:") || l.startsWith("رقم :")) {
                            invoiceNumLine = l;
                        } else if (l.contains("#") && l.contains("المادة") && l.contains("المجموع")) {
                            afterTableHeader = true;
                        } else if (l.startsWith("الصافي") || l.startsWith("المعادل")) {
                            afterTableHeader = false;
                            totalLines.add(l);
                        } else if (l.startsWith("شكراً")) {
                            afterTableHeader = false;
                            footerLine = l;
                        } else if (afterTableHeader) {
                            itemRows.add(l);
                        } else if (!afterTableHeader && totalLines.isEmpty() && footerLine == null) {
                            metaLines.add(l);
                        }
                    }

                    if (invoiceTypeLine != null || invoiceNumLine != null) {
                        Paint rightBold = new Paint(Paint.ANTI_ALIAS_FLAG);
                        rightBold.setTypeface(boldFont);
                        rightBold.setColor(Color.parseColor("#0F172A"));
                        rightBold.setTextSize(14f);
                        rightBold.setFakeBoldText(true);
                        rightBold.setTextAlign(Paint.Align.RIGHT);

                        Paint leftBold = new Paint(Paint.ANTI_ALIAS_FLAG);
                        leftBold.setTypeface(boldFont);
                        leftBold.setColor(Color.parseColor("#0F172A"));
                        leftBold.setTextSize(14f);
                        leftBold.setFakeBoldText(true);
                        leftBold.setTextAlign(Paint.Align.LEFT);

                        if (invoiceTypeLine != null) {
                            canvas.drawText(invoiceTypeLine, rightX, y, rightBold);
                        }
                        if (invoiceNumLine != null) {
                            canvas.drawText(invoiceNumLine, leftX, y, leftBold);
                        }
                        y += 22f;
                    }

                    for (String ml : metaLines) {
                        y = drawWrappedText(canvas, ml, rightX, y, contentWidth, bodyPaint);
                    }
                    y += 6f;

                    float columnScale = contentWidth / 539f;
                    float colTotalW = 84f * columnScale;
                    float colPriceW = 76f * columnScale;
                    float colQtyW = 72f * columnScale;
                    float colNumW = 36f * columnScale;
                    float colItemW = contentWidth - (colTotalW + colPriceW + colQtyW + colNumW);

                    float xTotalRight = leftX + colTotalW;
                    float xPriceRight = xTotalRight + colPriceW;
                    float xQtyRight = xPriceRight + colQtyW;
                    float xItemRight = xQtyRight + colItemW;

                    float headerH = 26f;
                    canvas.drawRect(leftX, y, rightX, y + headerH, headerBgPaint);
                    canvas.drawLine(leftX, y, rightX, y, darkLinePaint);
                    canvas.drawLine(leftX, y + headerH, rightX, y + headerH, darkLinePaint);

                    Paint cellHeaderPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
                    cellHeaderPaint.setTypeface(boldFont);
                    cellHeaderPaint.setColor(Color.parseColor("#0F172A"));
                    cellHeaderPaint.setTextSize(12f);
                    cellHeaderPaint.setFakeBoldText(true);
                    cellHeaderPaint.setTextAlign(Paint.Align.CENTER);

                    float headerTextY = y + 17f;
                    canvas.drawText("المجموع", xTotalRight - colTotalW / 2f, headerTextY, cellHeaderPaint);
                    canvas.drawText("السعر", xPriceRight - colPriceW / 2f, headerTextY, cellHeaderPaint);
                    canvas.drawText("الكمية", xQtyRight - colQtyW / 2f, headerTextY, cellHeaderPaint);
                    canvas.drawText("المادة", xItemRight - colItemW / 2f, headerTextY, cellHeaderPaint);
                    canvas.drawText("#", rightX - colNumW / 2f, headerTextY, cellHeaderPaint);

                    y += headerH;

                    for (String ir : itemRows) {
                        String[] parts = ir.split("\\s+");
                        float rowH = 28f;
                        if (y + rowH > pageHeight - 60f) {
                            drawPageFooter(canvas, pageNo, pageWidth, pageHeight, baseFont);
                            document.finishPage(page);
                            pageNo++;
                            page = document.startPage(new PdfDocument.PageInfo.Builder(pageWidth, pageHeight, pageNo).create());
                            canvas = page.getCanvas();
                            canvas.drawColor(Color.WHITE);
                            y = 42f;
                        }
                        canvas.drawLine(leftX, y + rowH, rightX, y + rowH, borderPaint);

                        if (parts.length >= 4) {
                            String idxStr = parts[0];
                            String totalStr = parts[parts.length - 1];
                            String priceStr = parts[parts.length - 2];
                            String qtyStr = parts[parts.length - 3];

                            StringBuilder itemBuilder = new StringBuilder();
                            for (int i = 1; i < parts.length - 3; i++) {
                                if (i > 1) itemBuilder.append(" ");
                                itemBuilder.append(parts[i]);
                            }
                            String itemStr = itemBuilder.toString();

                            Paint cellValPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
                            cellValPaint.setTypeface(baseFont);
                            cellValPaint.setColor(Color.parseColor("#0F172A"));
                            cellValPaint.setTextSize(12f);
                            cellValPaint.setTextAlign(Paint.Align.CENTER);

                            Paint itemNamePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
                            itemNamePaint.setTypeface(baseFont);
                            itemNamePaint.setColor(Color.parseColor("#0F172A"));
                            itemNamePaint.setTextSize(12f);
                            itemNamePaint.setTextAlign(Paint.Align.RIGHT);

                            float textY = y + 18f;
                            canvas.drawText(totalStr, xTotalRight - colTotalW / 2f, textY, cellValPaint);
                            canvas.drawText(priceStr, xPriceRight - colPriceW / 2f, textY, cellValPaint);
                            canvas.drawText(qtyStr, xQtyRight - colQtyW / 2f, textY, cellValPaint);
                            canvas.drawText(itemStr, xItemRight - 6f, textY, itemNamePaint);
                            canvas.drawText(idxStr, rightX - colNumW / 2f, textY, cellValPaint);
                        } else {
                            y = drawWrappedText(canvas, ir, rightX, y + 4f, contentWidth, bodyPaint);
                            continue;
                        }
                        y += rowH;
                    }

                    if (!totalLines.isEmpty()) {
                        if (y + totalLines.size() * 24f + 110f > pageHeight - 60f) {
                            drawPageFooter(canvas, pageNo, pageWidth, pageHeight, baseFont);
                            document.finishPage(page);
                            pageNo++;
                            page = document.startPage(new PdfDocument.PageInfo.Builder(pageWidth, pageHeight, pageNo).create());
                            canvas = page.getCanvas();
                            canvas.drawColor(Color.WHITE);
                            y = 42f;
                        }
                        y += 12f;
                        float boxH = totalLines.size() * 24f + 16f;
                        canvas.drawRect(leftX, y, rightX, y + boxH, totalBoxBgPaint);
                        canvas.drawLine(leftX, y, rightX, y, darkLinePaint);
                        canvas.drawLine(leftX, y + boxH, rightX, y + boxH, darkLinePaint);

                        float ty = y + 22f;
                        for (int i = 0; i < totalLines.size(); i++) {
                            Paint tp = (i == 0) ? centerBoldPaint : centerSubBoldPaint;
                            canvas.drawText(totalLines.get(i), pageWidth / 2f, ty, tp);
                            ty += 24f;
                        }
                        y += boxH + 10f;
                    }

                    y += 10f;
                    if (y + 60f > pageHeight - 40f) {
                        drawPageFooter(canvas, pageNo, pageWidth, pageHeight, baseFont);
                        document.finishPage(page);
                        pageNo++;
                        page = document.startPage(new PdfDocument.PageInfo.Builder(pageWidth, pageHeight, pageNo).create());
                        canvas = page.getCanvas();
                        canvas.drawColor(Color.WHITE);
                        y = 42f;
                    }
                    Paint dashPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
                    dashPaint.setColor(Color.parseColor("#94A3B8"));
                    dashPaint.setStrokeWidth(0.8f);
                    dashPaint.setPathEffect(new DashPathEffect(new float[]{5f, 3f}, 0));
                    canvas.drawLine(leftX, y, rightX, y, dashPaint);
                    y += 13f;

                    Paint smallFooterPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
                    smallFooterPaint.setTypeface(baseFont);
                    smallFooterPaint.setColor(Color.parseColor("#475569"));
                    smallFooterPaint.setTextSize(9.5f);
                    smallFooterPaint.setTextAlign(Paint.Align.CENTER);

                    canvas.drawText("شكراً لاختياركم نظام المحاسبة - محاسب محترف سوريا | باسل محمد الخابور - 0952575089", pageWidth / 2f, y, smallFooterPaint);
                    y += 12f;
                    canvas.drawText("Thank you for choosing our accounting system - ProAccountant Syria | Dev: Basel Al-Kabor | 0952575089", pageWidth / 2f, y, smallFooterPaint);
                    y += 12f;
                }

                drawPageFooter(canvas, pageNo, pageWidth, pageHeight, baseFont);
                document.finishPage(page);

                try (FileOutputStream fos = new FileOutputStream(temporaryPdf)) {
                    document.writeTo(fos);
                    fos.flush();
                    fos.getFD().sync();
                }
                validatePdfFile(temporaryPdf);
                movePdfFile(temporaryPdf, pdfFile);
                deleteQuietly(temporaryPdf);
                temporaryPdf = null;

                final File output = pdfFile;
                runOnUiThread(() -> {
                    if (!isFinishing() && !isDestroyed()) shareGeneratedPdfUri(output);
                });
            } catch (Exception e) {
                deleteQuietly(temporaryPdf);
                deleteQuietly(pdfFile);
                if (!isFinishing() && !isDestroyed()) {
                    String message = "تعذر إنشاء أو مشاركة ملف PDF: " + errorMessage(e);
                    notifyNativeError(message);
                    runOnUiThread(() -> Toast.makeText(MainActivity.this, message, Toast.LENGTH_LONG).show());
                }
            } finally {
                if (document != null) {
                    try {
                        document.close();
                    } catch (Exception ignored) {
                    }
                }
                finishJob.run();
            }
        }, "text-pdf");
        try {
            thread.start();
        } catch (Exception e) {
            if (!isFinishing() && !isDestroyed()) {
                String message = "تعذر تشغيل مولّد PDF النصي: " + errorMessage(e);
                notifyNativeError(message);
                runOnUiThread(() -> Toast.makeText(MainActivity.this, message, Toast.LENGTH_LONG).show());
            }
            finishJob.run();
        }
    }

    private void drawPageFooter(Canvas c, int no, int w, int h, Typeface font) {
        Paint fp = new Paint(Paint.ANTI_ALIAS_FLAG);
        fp.setTypeface(font);
        fp.setColor(Color.parseColor("#64748B"));
        fp.setTextSize(10f);
        fp.setTextAlign(Paint.Align.CENTER);
        c.drawText("- " + no + " -", w / 2f, h - 18f, fp);
    }

    private void shareGeneratedPdfUri(File pdfFile) {
        if (isFinishing() || isDestroyed()) return;
        try {
            validatePdfFile(pdfFile);
            Uri contentUri = FileProvider.getUriForFile(
                    this,
                    getPackageName() + ".fileprovider",
                    pdfFile
            );

            Intent sendIntent = new Intent(Intent.ACTION_SEND);
            sendIntent.setType("application/pdf");
            sendIntent.putExtra(Intent.EXTRA_STREAM, contentUri);
            sendIntent.putExtra(Intent.EXTRA_SUBJECT, "فاتورة - محاسب محترف سوريا");
            sendIntent.putExtra(Intent.EXTRA_TEXT, "مرفق ملف الفاتورة بصيغة PDF");
            sendIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            Intent chooser = Intent.createChooser(sendIntent, "مشاركة أو طباعة ملف PDF");
            chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(chooser);
        } catch (Exception e) {
            String message = "تعذر مشاركة ملف PDF: " + errorMessage(e);
            notifyNativeError(message);
            Toast.makeText(this, message, Toast.LENGTH_LONG).show();
        }
    }

    private String jsQuote(String input) {
        return JSONObject.quote(input == null ? "" : input);
    }

    private void evaluateJavascriptSafely(WebView target, String script, ValueCallback<String> callback) {
        if (target == null || script == null) return;
        Runnable action = () -> {
            try {
                target.evaluateJavascript(script, callback);
            } catch (Exception ignored) {
            }
        };
        if (Looper.myLooper() == Looper.getMainLooper()) action.run();
        else mainHandler.post(action);
    }

    private void startBiometricPrompt(String title, String subtitle) {
        try {
            BiometricPrompt prompt = new BiometricPrompt(this, ContextCompat.getMainExecutor(this),
                    new BiometricPrompt.AuthenticationCallback() {
                        @Override
                        public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                            sendBiometricResult(true, "");
                        }

                        @Override
                        public void onAuthenticationError(int errorCode, @NonNull CharSequence errString) {
                            sendBiometricResult(false, errString == null ? "" : errString.toString());
                        }
                    });
            BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                    .setTitle(title == null || title.isEmpty() ? "فتح محاسب محترف سوريا" : title)
                    .setSubtitle(subtitle == null ? "" : subtitle)
                    .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_WEAK
                            | BiometricManager.Authenticators.DEVICE_CREDENTIAL)
                    .build();
            prompt.authenticate(info);
        } catch (Throwable t) {
            sendBiometricResult(false, t.getMessage() == null ? "تعذر تشغيل البصمة" : t.getMessage());
        }
    }

    private void sendBiometricResult(boolean ok, String message) {
        runOnUiThread(() -> {
            WebView target = webView;
            if (target == null || isFinishing() || isDestroyed()) return;
            String script = "(function(){try{if(typeof window.onBiometricResult==='function')window.onBiometricResult("
                    + (ok ? "true" : "false") + "," + jsQuote(message) + ");}catch(e){}})();";
            try {
                target.evaluateJavascript(script, null);
            } catch (Exception ignored) {
            }
        });
    }

    private void notifyNativeError(String message) {
        final String safeMessage = message == null ? "خطأ أصلي غير معروف" : message;
        runOnUiThread(() -> {
            if (isFinishing() || isDestroyed()) return;
            WebView target = webView;
            if (target == null) {
                showNativeErrorToast(safeMessage);
                return;
            }
            String script = "(function(){try{" +
                    "var m=" + jsQuote(safeMessage) + ";" +
                    "if(typeof window.onAndroidNativeError==='function'){window.onAndroidNativeError(m);return true;}" +
                    "if(typeof window.onAndroidPdfError==='function'){window.onAndroidPdfError(m);return true;}" +
                    "}catch(e){}return false;})();";
            try {
                target.evaluateJavascript(script, handled -> {
                    if (!"true".equals(handled)) showNativeErrorToast(safeMessage);
                });
            } catch (Exception e) {
                showNativeErrorToast(safeMessage);
            }
        });
    }

    private void showNativeErrorToast(String message) {
        if (isFinishing() || isDestroyed()) return;
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
    }

    private File getDatabaseFile() {
        return new File(getFilesDir(), "database.json");
    }

    private String loadNativeData() {
        synchronized (DATABASE_LOCK) {
            File file = getDatabaseFile();
            if (!file.exists()) return "";
            try (FileInputStream input = new FileInputStream(file);
                 ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
                return new String(output.toByteArray(), StandardCharsets.UTF_8);
            } catch (Exception e) {
                return null;
            }
        }
    }

    private boolean saveNativeData(String jsonContent) {
        if (jsonContent == null || jsonContent.trim().isEmpty()) return false;
        synchronized (DATABASE_LOCK) {
            File target = getDatabaseFile();
            File temp = new File(getFilesDir(), "database.json.tmp");
            File backup = new File(getFilesDir(), "database.json.bak");
            try (FileOutputStream output = new FileOutputStream(temp)) {
                output.write(jsonContent.getBytes(StandardCharsets.UTF_8));
                output.flush();
                output.getFD().sync();
                if (target.exists() && !copyFile(target, backup)) return false;
                if (!temp.renameTo(target)) throw new IOException("تعذر استبدال ملف قاعدة البيانات");
                return true;
            } catch (Exception e) {
                return false;
            } finally {
                if (temp.exists()) temp.delete();
            }
        }
    }

    private boolean clearNativeData() {
        synchronized (DATABASE_LOCK) {
            File target = getDatabaseFile();
            File temp = new File(getFilesDir(), "database.json.tmp");
            temp.delete();
            return !target.exists() || target.delete();
        }
    }

    private boolean preserveInvalidNativeData(String raw) {
        if (raw == null || raw.isEmpty()) return false;
        synchronized (DATABASE_LOCK) {
            File invalid = new File(getFilesDir(), "invalid_database_" + System.currentTimeMillis() + ".json");
            try (FileOutputStream output = new FileOutputStream(invalid)) {
                output.write(raw.getBytes(StandardCharsets.UTF_8));
                output.flush();
                output.getFD().sync();
                return true;
            } catch (Exception e) {
                return false;
            }
        }
    }

    private boolean copyFile(File source, File target) {
        try (FileInputStream input = new FileInputStream(source);
             FileOutputStream output = new FileOutputStream(target)) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
            output.flush();
            output.getFD().sync();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private void injectPrintBridgeScript(WebView target) {
        if (target == null) return;
        String script = "(function() {" +
                "if (!window.AndroidNative) { window.AndroidNative = {}; }" +
                "if (!Object.prototype.hasOwnProperty.call(window.AndroidNative,'__proAccountantPrintWrapped')) {" +
                "  var nativePrintPage = window.AndroidNative.printPage;" +
                "  if (typeof nativePrintPage === 'function') {" +
                "    window.AndroidNative.printPage = function() {" +
                "      return nativePrintPage.apply(window.AndroidNative, arguments);" +
                "    };" +
                "    window.AndroidNative.__proAccountantPrintWrapped = true;" +
                "  }" +
                "}" +
                "window.print = function() {" +
                "  if (window.AndroidNative && typeof window.AndroidNative.printPage === 'function') {" +
                "    window.AndroidNative.printPage();" +
                "  }" +
                "};" +
                "window.AndroidNativeReady = true;" +
                "if (!window.__proAccountantAndroidBridgeReady) {" +
                "  window.__proAccountantAndroidBridgeReady = true;" +
                "  window.dispatchEvent(new Event('androidnative-ready'));" +
                "}" +
                "})();";
        evaluateJavascriptSafely(target, script, null);
    }

    private void triggerWebViewPrint(WebView targetWebView) {
        WebView target = (targetWebView != null) ? targetWebView : webView;
        if (target == null && this.bridge != null) {
            target = this.bridge.getWebView();
            webView = target;
        }
        if (target == null) return;

        final WebView finalWebView = target;
        runOnUiThread(() -> {
            try {
                finalWebView.evaluateJavascript(
                        "(function(){var p=document.getElementById('print-area');if(p){p.style.display='block';p.style.visibility='visible';}})();",
                        val -> {
                            try {
                                PrintManager printManager = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                                if (printManager == null) {
                                    notifyNativeError("خدمة الطباعة غير متاحة");
                                    return;
                                }

                                String jobName = "فاتورة - محاسب محترف سوريا_"
                                        + System.currentTimeMillis() + "_" + UUID.randomUUID().toString().substring(0, 8);
                                PrintDocumentAdapter adapter = finalWebView.createPrintDocumentAdapter(jobName);
                                PrintAttributes attributes = new PrintAttributes.Builder()
                                        .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                                        .setResolution(new PrintAttributes.Resolution("pdf", "pdf", 300, 300))
                                        .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                                        .build();

                                printManager.print(jobName, adapter, attributes);
                            } catch (Exception e) {
                                notifyNativeError("تعذرت الطباعة: " + errorMessage(e));
                            }
                        }
                );
            } catch (Exception e) {
                notifyNativeError("تعذرت الطباعة: " + errorMessage(e));
            }
        });
    }

    // طباعة مستند HTML كامل (باركود، كشف حساب، تقارير) عبر نظام الطباعة مع إمكانية الحفظ كـ PDF
    private void printHtmlDocument(final String html, final String jobName, final String paper) {
        runOnUiThread(() -> {
            if (isFinishing() || isDestroyed()) return;
            try {
                new HtmlPrintJob(html, jobName, paper).start();
            } catch (Exception e) {
                notifyNativeError("تعذرت الطباعة: " + errorMessage(e));
                Toast.makeText(MainActivity.this, "تعذرت الطباعة: " + errorMessage(e), Toast.LENGTH_LONG).show();
            }
        });
    }

    private final class HtmlPrintJob {
        private final WebView view;
        private final String html;
        private final String paper;
        private final String jobName;
        private final AtomicBoolean completed = new AtomicBoolean(false);
        private final AtomicBoolean pageHandled = new AtomicBoolean(false);
        private final Runnable timeoutRunnable;

        HtmlPrintJob(String html, String jobName, String paper) {
            this.html = html;
            this.paper = paper;
            String baseName = jobName == null || jobName.trim().isEmpty() ? "ProAccountant" : jobName.trim();
            this.jobName = baseName + "_" + System.currentTimeMillis() + "_"
                    + UUID.randomUUID().toString().substring(0, 8);
            this.view = new WebView(MainActivity.this);
            this.timeoutRunnable = () -> fail("انتهت مهلة تجهيز الطباعة");
            activeWebViews.add(view);
        }

        void start() {
            mainHandler.postDelayed(timeoutRunnable, DOCUMENT_TIMEOUT_MS);
            try {
                view.getSettings().setJavaScriptEnabled(false);
                view.getSettings().setAllowFileAccess(true);
                view.setWebViewClient(new WebViewClient() {
                    @Override
                    public void onPageFinished(WebView pageView, String url) {
                        if (completed.get() || !pageHandled.compareAndSet(false, true)) return;
                        mainHandler.removeCallbacks(timeoutRunnable);
                        if (isFinishing() || isDestroyed()) {
                            completeOnce();
                            return;
                        }
                        try {
                            PrintManager pm = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                            if (pm == null) {
                                fail("خدمة الطباعة غير متاحة");
                                return;
                            }
                            PrintDocumentAdapter delegate = pageView.createPrintDocumentAdapter(jobName);
                            pm.print(jobName, new CleanupPrintDocumentAdapter(delegate, HtmlPrintJob.this),
                                    getDocumentPrintAttributes(paper));
                        } catch (Exception e) {
                            fail("تعذرت الطباعة: " + errorMessage(e));
                        }
                    }

                    @Override
                    public void onReceivedError(WebView pageView, int errorCode, String description, String failingUrl) {
                        if (!pageHandled.get()) fail(description == null ? "تعذر تحميل مستند الطباعة" : description);
                    }

                    @Override
                    public void onReceivedError(WebView pageView, WebResourceRequest request, WebResourceError error) {
                        if ((request == null || request.isForMainFrame()) && !pageHandled.get()) {
                            fail(error == null ? "تعذر تحميل مستند الطباعة" : error.getDescription().toString());
                        }
                    }

                    @Override
                    public boolean onRenderProcessGone(WebView pageView, RenderProcessGoneDetail detail) {
                        fail("تعذر عرض مستند الطباعة");
                        return true;
                    }
                });
                view.loadDataWithBaseURL("file:///android_asset/public/", html != null ? html : "", "text/html", "UTF-8", null);
            } catch (Exception e) {
                fail("تعذر تشغيل الطباعة: " + errorMessage(e));
            }
        }

        private void fail(String message) {
            if (!completed.compareAndSet(false, true)) return;
            mainHandler.removeCallbacks(timeoutRunnable);
            destroyActiveWebView(view);
            if (!isFinishing() && !isDestroyed()) {
                notifyNativeError(message);
                runOnUiThread(() -> Toast.makeText(MainActivity.this, message, Toast.LENGTH_LONG).show());
            }
        }

        private void completeOnce() {
            if (!completed.compareAndSet(false, true)) return;
            mainHandler.removeCallbacks(timeoutRunnable);
            destroyActiveWebView(view);
        }

        private void onPrintFinished() {
            completeOnce();
        }
    }

    /* محوّل طباعة يكتب ملف PDF جاهزاً كما هو (واجهات أندرويد العامة فقط) */
    private static class PdfFilePrintAdapter extends PrintDocumentAdapter {
        private final File file;
        private final String name;

        PdfFilePrintAdapter(File file, String name) {
            this.file = file;
            this.name = name;
        }

        @Override
        public void onLayout(PrintAttributes oldAttributes, PrintAttributes newAttributes,
                             CancellationSignal cancellationSignal, LayoutResultCallback callback, Bundle extras) {
            if (cancellationSignal != null && cancellationSignal.isCanceled()) {
                callback.onLayoutCancelled();
                return;
            }
            PrintDocumentInfo info = new PrintDocumentInfo.Builder(name.replaceAll("[^A-Za-z0-9._-]+", "_") + ".pdf")
                    .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
                    .setPageCount(PrintDocumentInfo.PAGE_COUNT_UNKNOWN)
                    .build();
            callback.onLayoutFinished(info, true);
        }

        @Override
        public void onWrite(PageRange[] pages, ParcelFileDescriptor destination,
                            CancellationSignal cancellationSignal, WriteResultCallback callback) {
            try (FileInputStream in = new FileInputStream(file);
                 FileOutputStream out = new FileOutputStream(destination.getFileDescriptor())) {
                byte[] buffer = new byte[16384];
                int read;
                while ((read = in.read(buffer)) > 0) {
                    if (cancellationSignal != null && cancellationSignal.isCanceled()) {
                        callback.onWriteCancelled();
                        return;
                    }
                    out.write(buffer, 0, read);
                }
                callback.onWriteFinished(new PageRange[]{PageRange.ALL_PAGES});
            } catch (Exception e) {
                callback.onWriteFailed(e.getMessage());
            }
        }

        @Override
        public void onFinish() {
            if (file != null && file.exists() && !file.delete()) file.deleteOnExit();
        }
    }

    private static class CleanupPrintDocumentAdapter extends PrintDocumentAdapter {
        private final PrintDocumentAdapter delegate;
        private final HtmlPrintJob job;

        CleanupPrintDocumentAdapter(PrintDocumentAdapter delegate, HtmlPrintJob job) {
            this.delegate = delegate;
            this.job = job;
        }

        @Override
        public void onStart() {
            try {
                delegate.onStart();
            } catch (Exception e) {
                job.fail("تعذر بدء الطباعة: " + errorMessage(e));
            }
        }

        @Override
        public void onLayout(PrintAttributes oldAttributes, PrintAttributes newAttributes,
                             CancellationSignal cancellationSignal, LayoutResultCallback callback, Bundle extras) {
            try {
                delegate.onLayout(oldAttributes, newAttributes, cancellationSignal, callback, extras);
            } catch (Exception e) {
                callback.onLayoutFailed(e.getMessage());
            }
        }

        @Override
        public void onWrite(PageRange[] pages, ParcelFileDescriptor destination,
                            CancellationSignal cancellationSignal, WriteResultCallback callback) {
            try {
                delegate.onWrite(pages, destination, cancellationSignal, callback);
            } catch (Exception e) {
                callback.onWriteFailed(e.getMessage());
            }
        }

        @Override
        public void onFinish() {
            try {
                delegate.onFinish();
            } catch (Exception e) {
                job.fail("تعذر إنهاء الطباعة: " + errorMessage(e));
            } finally {
                job.onPrintFinished();
            }
        }
    }

    private void destroyActiveWebView(WebView view) {
        if (view == null) return;
        runOnUiThread(() -> {
            activeWebViews.remove(view);
            destroyWebViewNow(view);
        });
    }

    private void destroyAllActiveWebViews() {
        runOnUiThread(() -> {
            List<WebView> views;
            synchronized (activeWebViews) {
                views = new ArrayList<>(activeWebViews);
                activeWebViews.clear();
            }
            for (WebView view : views) destroyWebViewNow(view);
        });
    }

    private void destroyWebViewNow(WebView view) {
        if (view == null) return;
        try {
            view.removeAllViews();
            view.destroy();
        } catch (Exception ignored) {
        }
    }

    private static final class HtmlTransferSession {
        final String action;
        final String fileName;
        final String jobName;
        final String paper;
        final String fallbackText;
        final File file;
        final Writer writer;
        final long createdAt;
        long bytesWritten;

        HtmlTransferSession(String action, String fileName, String jobName, String paper, String fallbackText, File file) throws IOException {
            this.action = action;
            this.fileName = fileName;
            this.jobName = jobName;
            this.paper = paper;
            this.fallbackText = fallbackText == null ? "" : fallbackText;
            this.file = file;
            this.createdAt = System.currentTimeMillis();
            this.writer = new OutputStreamWriter(new FileOutputStream(file), StandardCharsets.UTF_8);
        }
    }

    private String beginHtmlTransferNative(String action, String fileName, String jobName, String paper) {
        return beginHtmlTransferNative(action, fileName, jobName, paper, "");
    }

    private String beginHtmlTransferNative(String action, String fileName, String jobName, String paper, String fallbackText) {
        File tempFile = null;
        try {
            final String normalizedAction = action == null ? "" : action.trim().toLowerCase(Locale.ROOT);
            if (!"print".equals(normalizedAction) && !"pdf".equals(normalizedAction) && !"whatsapp".equals(normalizedAction)) {
                notifyHtmlTransferError("إجراء نقل مستند HTML غير مدعوم");
                return null;
            }
            synchronized (htmlTransferSessions) {
                expireHtmlTransfersLocked();
                String sessionId = UUID.randomUUID().toString();
                tempFile = File.createTempFile(HTML_TRANSFER_FILE_PREFIX, ".tmp", getCacheDir());
                HtmlTransferSession session = new HtmlTransferSession(
                        normalizedAction,
                        fileName == null ? "" : fileName,
                        jobName == null ? "" : jobName,
                        paper == null ? "" : paper,
                        fallbackText == null ? "" : fallbackText,
                        tempFile
                );
                htmlTransferSessions.put(sessionId, session);
                return sessionId;
            }
        } catch (Exception e) {
            if (tempFile != null) deleteHtmlTransferQuietly(tempFile);
            notifyHtmlTransferError("تعذر بدء نقل مستند HTML: " + errorMessage(e));
            return null;
        }
    }

    private boolean appendHtmlTransferNative(String sessionId, String chunk) {
        try {
            if (sessionId == null || sessionId.trim().isEmpty() || chunk == null) {
                notifyHtmlTransferError("بيانات جزء مستند HTML غير صالحة");
                return false;
            }
            synchronized (htmlTransferSessions) {
                expireHtmlTransfersLocked();
                HtmlTransferSession session = htmlTransferSessions.get(sessionId);
                if (session == null) {
                    notifyHtmlTransferError("جلسة نقل مستند HTML غير صالحة أو منتهية");
                    return false;
                }
                byte[] bytes = chunk.getBytes(StandardCharsets.UTF_8);
                if (bytes.length > HTML_TRANSFER_CHUNK_BYTES) {
                    notifyHtmlTransferError("جزء مستند HTML أكبر من الحد المسموح");
                    return false;
                }
                if (session.bytesWritten + bytes.length > HTML_TRANSFER_MAX_BYTES) {
                    notifyHtmlTransferError("مستند HTML أكبر من الحد المسموح");
                    return false;
                }
                try {
                    session.writer.write(chunk);
                    session.writer.flush();
                    session.bytesWritten += bytes.length;
                } catch (Exception e) {
                    htmlTransferSessions.remove(sessionId);
                    closeHtmlTransferQuietly(session);
                    deleteHtmlTransferQuietly(session.file);
                    throw e;
                }
                return true;
            }
        } catch (Exception e) {
            notifyHtmlTransferError("تعذر إضافة جزء مستند HTML: " + errorMessage(e));
            return false;
        }
    }

    private boolean finishHtmlTransferNative(String sessionId) {
        try {
            if (sessionId == null || sessionId.trim().isEmpty()) {
                notifyHtmlTransferError("جلسة نقل مستند HTML غير صالحة");
                return false;
            }
            synchronized (htmlTransferSessions) {
                expireHtmlTransfersLocked();
                HtmlTransferSession session = htmlTransferSessions.remove(sessionId);
                if (session == null) {
                    notifyHtmlTransferError("جلسة نقل مستند HTML غير صالحة أو منتهية");
                    return false;
                }
                String html;
                try {
                    session.writer.close();
                    html = readHtmlTransferFile(session.file);
                } finally {
                    deleteQuietly(session.file);
                }
                if (html == null || html.trim().isEmpty()) {
                    throw new IOException("مستند HTML فارغ");
                }
                final String transferAction = session.action;
                final String transferFileName = session.fileName;
                final String transferJobName = session.jobName;
                final String transferPaper = session.paper;
                final String transferFallback = session.fallbackText;
                runOnUiThread(() -> {
                    try {
                        if ("print".equals(transferAction)) {
                            printHtmlDocument(html, transferJobName, transferPaper);
                        } else if ("pdf".equals(transferAction)) {
                            createPdfAndShare(transferFileName, html, transferFallback, transferPaper);
                        } else if ("whatsapp".equals(transferAction)) {
                            createPdfAndShare(transferFileName, html, transferFallback, "a4");
                        }
                    } catch (Exception e) {
                        notifyHtmlTransferError("تعذر تنفيذ مستند HTML: " + errorMessage(e));
                    }
                });
                return true;
            }
        } catch (Exception e) {
            notifyHtmlTransferError("تعذر إنهاء نقل مستند HTML: " + errorMessage(e));
            return false;
        }
    }

    private String readHtmlTransferFile(File file) throws IOException {
        try (FileInputStream input = new FileInputStream(file);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private void expireHtmlTransfersLocked() {
        long now = System.currentTimeMillis();
        Iterator<Map.Entry<String, HtmlTransferSession>> iterator = htmlTransferSessions.entrySet().iterator();
        while (iterator.hasNext()) {
            HtmlTransferSession session = iterator.next().getValue();
            if (now - session.createdAt >= HTML_TRANSFER_TIMEOUT_MS) {
                iterator.remove();
                closeHtmlTransferQuietly(session);
                deleteHtmlTransferQuietly(session.file);
            }
        }
    }

    private void closeHtmlTransferQuietly(HtmlTransferSession session) {
        if (session == null) return;
        try {
            session.writer.close();
        } catch (Exception ignored) {
        }
    }

    private void deleteHtmlTransferQuietly(File file) {
        try {
            deleteQuietly(file);
        } catch (Exception ignored) {
        }
    }

    private boolean abortHtmlTransferNative(String sessionId) {
        if (sessionId == null || sessionId.trim().isEmpty()) return false;
        synchronized (htmlTransferSessions) {
            HtmlTransferSession session = htmlTransferSessions.remove(sessionId);
            if (session == null) return false;
            closeHtmlTransferQuietly(session);
            deleteHtmlTransferQuietly(session.file);
            return true;
        }
    }

    private void notifyHtmlTransferError(String message) {
        try {
            notifyNativeError(message);
        } catch (Exception ignored) {
        }
    }

    private void cleanupHtmlTransfers() {
        synchronized (htmlTransferSessions) {
            Iterator<Map.Entry<String, HtmlTransferSession>> iterator = htmlTransferSessions.entrySet().iterator();
            while (iterator.hasNext()) {
                HtmlTransferSession session = iterator.next().getValue();
                iterator.remove();
                closeHtmlTransferQuietly(session);
                deleteHtmlTransferQuietly(session.file);
            }
            htmlTransferSessions.clear();
            try {
                File cacheDir = getCacheDir();
                File[] files = cacheDir == null ? null : cacheDir.listFiles();
                if (files != null) {
                    for (File file : files) {
                        if (file.isFile() && file.getName().startsWith(HTML_TRANSFER_FILE_PREFIX)) {
                            deleteHtmlTransferQuietly(file);
                        }
                    }
                }
            } catch (Exception ignored) {
            }
        }
    }

    @Override
    public void onDestroy() {
        synchronized (PDF_JOB_LOCK) {
            pdfQueueStopped = true;
            pdfJobRunning = false;
            pdfJobQueue.clear();
        }
        mainHandler.removeCallbacksAndMessages(null);
        List<HtmlPdfJob> pdfJobs;
        synchronized (activeHtmlPdfJobs) {
            pdfJobs = new ArrayList<>(activeHtmlPdfJobs);
        }
        for (HtmlPdfJob job : pdfJobs) job.cancelForDestroy();
        destroyAllActiveWebViews();
        cleanupHtmlTransfers();
        cameraResumePending.set(false);
        super.onDestroy();
    }

    private void performDriveUpload(String email, String fileName, String jsonContent, boolean allowConsentPrompt) {
        new Thread(() -> {
            try {
                String scope = "oauth2:https://www.googleapis.com/auth/drive.file";
                String token = GoogleAuthUtil.getToken(MainActivity.this, email, scope);
                String safeFileName = fileName == null || fileName.trim().isEmpty()
                        ? "ProAccountant_Syria_Backup.json"
                        : fileName.trim().replace('\\', '_').replace('/', '_');
                String safeJson = jsonContent == null ? "{}" : jsonContent;
                String fileId = findDriveFileId(token, safeFileName);
                boolean update = fileId != null && !fileId.isEmpty();
                String endpoint = update
                        ? "https://www.googleapis.com/upload/drive/v3/files/" + URLEncoder.encode(fileId, "UTF-8") + "?uploadType=multipart"
                        : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
                int responseCode = uploadDriveMultipart(new URL(endpoint), token, safeFileName, safeJson, update ? "PATCH" : "POST");
                if (responseCode == 200 || responseCode == 201) {
                    notifyDriveSuccess();
                } else {
                    notifyDriveError("HTTP " + responseCode);
                }
            } catch (UserRecoverableAuthException e) {
                if (allowConsentPrompt && e.getIntent() != null && consentLauncher != null) {
                    pendingEmail = email;
                    pendingFileName = fileName;
                    pendingJsonContent = jsonContent;
                    runOnUiThread(() -> consentLauncher.launch(e.getIntent()));
                } else {
                    notifyDriveError("يتطلب موافقة الحساب");
                }
            } catch (Exception e) {
                notifyDriveError(e.getMessage() == null ? "تعذر الاتصال بـ Google Drive" : e.getMessage());
            }
        }).start();
    }

    private String findDriveFileId(String token, String fileName) throws Exception {
        String query = "name = '" + fileName.replace("\\", "\\\\").replace("'", "\\'") + "' and trashed = false";
        URL url = new URL("https://www.googleapis.com/drive/v3/files?q=" + URLEncoder.encode(query, "UTF-8")
                + "&fields=" + URLEncoder.encode("files(id)", "UTF-8") + "&spaces=drive");
        HttpURLConnection conn = openDriveConnection(url, token, "GET");
        try {
            int code = conn.getResponseCode();
            String response = readDriveResponse(conn);
            if (code != 200) throw new IOException("Drive search HTTP " + code + ": " + response);
            JSONObject root = new JSONObject(response);
            JSONArray files = root.optJSONArray("files");
            if (files == null || files.length() == 0) return null;
            return files.getJSONObject(0).optString("id", null);
        } finally {
            conn.disconnect();
        }
    }

    private int uploadDriveMultipart(URL url, String token, String fileName, String jsonContent, String method) throws Exception {
        String boundary = "----ProAccountant_" + UUID.randomUUID().toString();
        JSONObject metadata = new JSONObject();
        metadata.put("name", fileName);
        metadata.put("mimeType", "application/json");
        HttpURLConnection conn = openDriveConnection(url, token, method);
        conn.setDoOutput(true);
        conn.setRequestProperty("Content-Type", "multipart/related; boundary=" + boundary);
        try (OutputStream output = conn.getOutputStream()) {
            writeUtf8(output, "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n"
                    + metadata.toString() + "\r\n");
            writeUtf8(output, "--" + boundary + "\r\nContent-Type: application/json\r\n\r\n"
                    + jsonContent + "\r\n");
            writeUtf8(output, "--" + boundary + "--\r\n");
            output.flush();
            return conn.getResponseCode();
        } finally {
            conn.disconnect();
        }
    }

    private HttpURLConnection openDriveConnection(URL url, String token, String method) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod(method);
        conn.setRequestProperty("Authorization", "Bearer " + token);
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(30000);
        conn.setUseCaches(false);
        conn.setInstanceFollowRedirects(false);
        return conn;
    }

    private String readDriveResponse(HttpURLConnection conn) throws Exception {
        java.io.InputStream stream = conn.getResponseCode() >= 400 ? conn.getErrorStream() : conn.getInputStream();
        if (stream == null) return "";
        try (java.io.InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int read;
            int total = 0;
            while ((read = input.read(buffer)) != -1 && total < 8192) {
                output.write(buffer, 0, Math.min(read, 8192 - total));
                total += Math.min(read, 8192 - total);
            }
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private void writeUtf8(OutputStream output, String value) throws IOException {
        output.write(value.getBytes(StandardCharsets.UTF_8));
    }

    /* ===== قائمة نسخ Google Drive واستعادتها مباشرة ===== */
    private void listDriveBackups(String email, boolean allowConsent) {
        new Thread(() -> {
            try {
                String token = GoogleAuthUtil.getToken(MainActivity.this, email, "oauth2:https://www.googleapis.com/auth/drive.file");
                String q = "name contains 'ProAccountant' and trashed = false";
                URL url = new URL("https://www.googleapis.com/drive/v3/files?q=" + URLEncoder.encode(q, "UTF-8")
                        + "&orderBy=" + URLEncoder.encode("modifiedTime desc", "UTF-8")
                        + "&pageSize=100&spaces=drive&fields=" + URLEncoder.encode("files(id,name,modifiedTime,createdTime,size)", "UTF-8"));
                HttpURLConnection conn = openDriveConnection(url, token, "GET");
                String body;
                int code;
                try {
                    code = conn.getResponseCode();
                    body = readFullResponse(conn);
                } finally {
                    conn.disconnect();
                }
                if (code != 200) throw new IOException("Drive HTTP " + code);
                JSONArray files = new JSONObject(body).optJSONArray("files");
                final String json = files == null ? "[]" : files.toString();
                if (webView != null) webView.post(() -> webView.evaluateJavascript("window.onDriveBackupsList && window.onDriveBackupsList(" + jsQuote(json) + ")", null));
            } catch (UserRecoverableAuthException e) {
                if (allowConsent && e.getIntent() != null && consentLauncher != null) {
                    pendingDriveAction = () -> listDriveBackups(email, false);
                    runOnUiThread(() -> consentLauncher.launch(e.getIntent()));
                } else {
                    notifyDriveListError("يتطلب موافقة حساب Google");
                }
            } catch (Exception e) {
                notifyDriveListError(e.getMessage() == null ? "تعذر الاتصال بـ Google Drive" : e.getMessage());
            }
        }).start();
    }

    private void downloadDriveBackup(String email, String fileId, boolean allowConsent) {
        new Thread(() -> {
            try {
                String token = GoogleAuthUtil.getToken(MainActivity.this, email, "oauth2:https://www.googleapis.com/auth/drive.file");
                URL url = new URL("https://www.googleapis.com/drive/v3/files/" + URLEncoder.encode(fileId, "UTF-8") + "?alt=media");
                HttpURLConnection conn = openDriveConnection(url, token, "GET");
                conn.setReadTimeout(60000);
                String body;
                int code;
                try {
                    code = conn.getResponseCode();
                    body = readFullResponse(conn);
                } finally {
                    conn.disconnect();
                }
                if (code != 200) throw new IOException("Drive HTTP " + code);
                final String content = body;
                if (webView != null) webView.post(() -> webView.evaluateJavascript("window.onAndroidDriveRestoreSuccess(" + jsQuote(content) + ")", null));
            } catch (UserRecoverableAuthException e) {
                if (allowConsent && e.getIntent() != null && consentLauncher != null) {
                    pendingDriveAction = () -> downloadDriveBackup(email, fileId, false);
                    runOnUiThread(() -> consentLauncher.launch(e.getIntent()));
                } else {
                    notifyDriveListError("يتطلب موافقة حساب Google");
                }
            } catch (Exception e) {
                notifyDriveListError(e.getMessage() == null ? "تعذر تنزيل النسخة" : e.getMessage());
            }
        }).start();
    }

    private String readFullResponse(HttpURLConnection conn) throws Exception {
        java.io.InputStream stream = conn.getResponseCode() >= 400 ? conn.getErrorStream() : conn.getInputStream();
        if (stream == null) return "";
        try (java.io.InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16384];
            int read;
            long total = 0;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > 60L * 1024 * 1024) throw new IOException("الملف كبير جداً");
                output.write(buffer, 0, read);
            }
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private void notifyDriveListError(String message) {
        if (webView != null) webView.post(() -> webView.evaluateJavascript("window.onDriveBackupsError && window.onDriveBackupsError(" + jsQuote(message) + ")", null));
    }

    private void notifyDriveSuccess() {
        if (webView != null) webView.post(() -> webView.evaluateJavascript("window.onAndroidDriveSyncSuccess()", null));
    }

    private void notifyDriveError(String message) {
        if (webView != null) webView.post(() -> webView.evaluateJavascript("window.onAndroidDriveSyncError(" + jsQuote(message) + ")", null));
    }

    public class AndroidNativeBridge {
        Context context;
        WebView wv;

        AndroidNativeBridge(Context c, WebView w) {
            context = c;
            wv = w;
        }

        @JavascriptInterface
        public boolean requestCameraPermission(String mode) {
            pendingCameraMode = mode == null || mode.trim().isEmpty() ? "invoice" : mode;
            if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                return true;
            }
            runOnUiThread(() -> ActivityCompat.requestPermissions(
                    MainActivity.this,
                    new String[]{Manifest.permission.CAMERA},
                    CAMERA_PERMISSION_REQUEST_CODE
            ));
            return false;
        }

        @JavascriptInterface
        public String loadData() {
            return loadNativeData();
        }

        @JavascriptInterface
        public boolean saveData(String jsonContent) {
            return saveNativeData(jsonContent);
        }

        @JavascriptInterface
        public boolean clearData() {
            return clearNativeData();
        }

        @JavascriptInterface
        public boolean preserveInvalidData(String raw) {
            return preserveInvalidNativeData(raw);
        }

        @JavascriptInterface
        public void requestStorageAndSharePdf(String fileName, String htmlDoc, String fallbackText) {
            createPdfAndShare(fileName, htmlDoc, fallbackText, "a4");
        }

        @JavascriptInterface
        public void requestStorageAndSharePdfWithPaper(String fileName, String htmlDoc, String fallbackText, String paper) {
            createPdfAndShare(fileName, htmlDoc, fallbackText, paper);
        }

        @JavascriptInterface
        public void sharePdfToWhatsApp(String fileName, String htmlDoc, String fallbackText) {
            createPdfAndShare(fileName, htmlDoc, fallbackText, "a4");
        }

        @JavascriptInterface
        public void openAppSettings() {
            runOnUiThread(() -> {
                Intent intent = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                intent.setData(Uri.fromParts("package", getPackageName(), null));
                startActivity(intent);
            });
        }

        @JavascriptInterface
        public void printPage() {
            triggerWebViewPrint(wv);
        }

        // جديد: طباعة مستند HTML بالتنسيق الكامل مع الرسوم (الباركود وكشف الحساب)
        @JavascriptInterface
        public void printHtml(String html, String jobName, String paper) {
            printHtmlDocument(html, jobName, paper);
        }

        @JavascriptInterface
        public String beginHtmlTransfer(String action, String fileName, String jobName, String paper) {
            return beginHtmlTransferNative(action, fileName, jobName, paper);
        }

        @JavascriptInterface
        public String beginHtmlTransferWithFallback(String action, String fileName, String jobName, String paper, String fallbackText) {
            return beginHtmlTransferNative(action, fileName, jobName, paper, fallbackText);
        }

        @JavascriptInterface
        public boolean appendHtmlTransfer(String sessionId, String chunk) {
            return appendHtmlTransferNative(sessionId, chunk);
        }

        @JavascriptInterface
        public boolean finishHtmlTransfer(String sessionId) {
            return finishHtmlTransferNative(sessionId);
        }

        @JavascriptInterface
        public boolean abortHtmlTransfer(String sessionId) {
            return abortHtmlTransferNative(sessionId);
        }

        // جديد: الخروج من التطبيق عند الضغط على رجوع مرتين من الشاشة الرئيسية
        /* PDF جاهز من الواجهة (مطابق للمعاينة 100%) — مشاركة */
        @JavascriptInterface
        public boolean sharePdfBase64(String fileName, String base64Pdf) {
            try {
                final byte[] bytes = Base64.decode(base64Pdf == null ? "" : base64Pdf, Base64.DEFAULT);
                if (bytes.length < 5) return false;
                final File output = new File(getPdfTargetDirectory(), uniquePdfFileName(fileName));
                try (FileOutputStream out = new FileOutputStream(output)) {
                    out.write(bytes);
                }
                validatePdfFile(output);
                runOnUiThread(() -> shareGeneratedPdfUri(output));
                return true;
            } catch (Exception e) {
                notifyNativeError("تعذر حفظ ملف PDF: " + errorMessage(e));
                return false;
            }
        }

        /* PDF جاهز من الواجهة (مطابق للمعاينة 100%) — طباعة عبر خدمة الطباعة في أندرويد */
        @JavascriptInterface
        public boolean printPdfBase64(String jobName, String base64Pdf, String paper) {
            try {
                final byte[] bytes = Base64.decode(base64Pdf == null ? "" : base64Pdf, Base64.DEFAULT);
                if (bytes.length < 5) return false;
                final File temp = new File(getCacheDir(), "print_" + System.currentTimeMillis() + ".pdf");
                try (FileOutputStream out = new FileOutputStream(temp)) {
                    out.write(bytes);
                }
                validatePdfFile(temp);
                final String name = (jobName == null || jobName.trim().isEmpty()) ? "ProAccountant" : jobName.trim();
                runOnUiThread(() -> {
                    try {
                        PrintManager pm = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                        pm.print(name, new PdfFilePrintAdapter(temp, name), getDocumentPrintAttributes(paper));
                    } catch (Exception e) {
                        notifyNativeError("تعذر بدء الطباعة: " + errorMessage(e));
                    }
                });
                return true;
            } catch (Exception e) {
                notifyNativeError("تعذر تجهيز الطباعة: " + errorMessage(e));
                return false;
            }
        }

        /* ===== فتح التطبيق بالبصمة (اختياري) ===== */
        @JavascriptInterface
        public String biometricStatus() {
            try {
                int r = BiometricManager.from(MainActivity.this).canAuthenticate(
                        BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL);
                if (r == BiometricManager.BIOMETRIC_SUCCESS) return "available";
                if (r == BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED) return "not_enrolled";
                return "unavailable";
            } catch (Throwable t) {
                return "unavailable";
            }
        }

        @JavascriptInterface
        public void authenticateBiometric(String title, String subtitle) {
            runOnUiThread(() -> startBiometricPrompt(title, subtitle));
        }

        /* حفظ نسخة احتياطية (مشفّرة أو عادية) في مجلد التطبيق ومشاركتها (Drive / الملفات / واتساب) */
        @JavascriptInterface
        public boolean shareBackupFile(String fileName, String content) {
            try {
                String name = (fileName == null ? "backup.json" : fileName).replaceAll("[^A-Za-z0-9._-]+", "_");
                if (!name.toLowerCase(Locale.ROOT).endsWith(".json")) name += ".json";
                File base = getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS);
                File dir = base != null ? new File(base, "Backups") : new File(getFilesDir(), "Documents/Backups");
                if (!dir.exists() && !dir.mkdirs()) return false;
                final File out = new File(dir, name);
                try (FileOutputStream fos = new FileOutputStream(out)) {
                    fos.write((content == null ? "" : content).getBytes(StandardCharsets.UTF_8));
                }
                runOnUiThread(() -> {
                    try {
                        Uri uri = FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".fileprovider", out);
                        Intent send = new Intent(Intent.ACTION_SEND);
                        send.setType("application/json");
                        send.putExtra(Intent.EXTRA_STREAM, uri);
                        send.putExtra(Intent.EXTRA_SUBJECT, "نسخة احتياطية - محاسب محترف سوريا");
                        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        Intent chooser = Intent.createChooser(send, "حفظ أو مشاركة النسخة الاحتياطية");
                        chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        startActivity(chooser);
                    } catch (Exception e) {
                        notifyNativeError("تم حفظ النسخة في مجلد التطبيق لكن تعذرت المشاركة: " + errorMessage(e));
                    }
                });
                return true;
            } catch (Exception e) {
                notifyNativeError("تعذر حفظ النسخة الاحتياطية: " + errorMessage(e));
                return false;
            }
        }

        @JavascriptInterface
        public void listDriveBackupFiles(String email) {
            if (email == null || email.trim().isEmpty()) { notifyDriveListError("لم يتم اختيار حساب Google"); return; }
            listDriveBackups(email.trim(), true);
        }

        @JavascriptInterface
        public void downloadDriveBackupFile(String email, String fileId) {
            if (email == null || fileId == null || fileId.trim().isEmpty()) { notifyDriveListError("نسخة غير صالحة"); return; }
            downloadDriveBackup(email.trim(), fileId.trim(), true);
        }

        @JavascriptInterface
        public void exitApp() {
            runOnUiThread(() -> finishAffinity());
        }

        @JavascriptInterface
        public void openGoogleDriveForRestore() {
            runOnUiThread(() -> {
                try {
                    Intent launchIntent = getPackageManager().getLaunchIntentForPackage("com.google.android.apps.docs");
                    if (launchIntent != null) {
                        startActivity(launchIntent);
                    } else {
                        Intent browserIntent = new Intent(Intent.ACTION_VIEW, Uri.parse("https://drive.google.com"));
                        startActivity(browserIntent);
                    }
                } catch (Exception e) {
                    Intent browserIntent = new Intent(Intent.ACTION_VIEW, Uri.parse("https://drive.google.com"));
                    startActivity(browserIntent);
                }
            });
        }

        @JavascriptInterface
        public void pickGoogleAccount() {
            runOnUiThread(() -> {
                Intent intent = AccountPicker.newChooseAccountIntent(
                        new AccountPicker.AccountChooserOptions.Builder()
                                .setAllowableAccountsTypes(Collections.singletonList("com.google"))
                                .build()
                );
                accountPickerLauncher.launch(intent);
            });
        }

        @JavascriptInterface
        public void uploadToDrive(String email, String fileName, String jsonContent) {
            performDriveUpload(email, fileName, jsonContent, true);
        }
    }
}