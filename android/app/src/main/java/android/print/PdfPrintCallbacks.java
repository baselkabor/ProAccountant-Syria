package android.print;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

public final class PdfPrintCallbacks {
    private PdfPrintCallbacks() {
    }

    public interface LayoutListener {
        void onLayoutFinished(int pageCount, boolean changed);
        void onLayoutFailed(CharSequence error);
    }

    public interface WriteListener {
        void onWriteFinished(PageRange[] pages);
        void onWriteFailed(CharSequence error);
    }

    public static PrintDocumentAdapter.LayoutResultCallback createLayout(LayoutListener listener) {
        final AtomicBoolean completed = new AtomicBoolean(false);
        return new PrintDocumentAdapter.LayoutResultCallback() {
            @Override
            public void onLayoutFinished(PrintDocumentInfo info, boolean changed) {
                if (!completed.compareAndSet(false, true)) return;
                if (info == null) {
                    listener.onLayoutFailed("معلومات تخطيط PDF غير متاحة");
                    return;
                }
                listener.onLayoutFinished(info.getPageCount(), changed);
            }

            @Deprecated
            public void onLayoutFinished(PageRange[] pages, boolean changed) {
                if (!completed.compareAndSet(false, true)) return;
                listener.onLayoutFinished(pages == null ? 0 : pages.length, changed);
            }

            @Override
            public void onLayoutCancelled() {
                if (completed.compareAndSet(false, true)) {
                    listener.onLayoutFailed("تم إلغاء تجهيز الطباعة");
                }
            }

            @Override
            public void onLayoutFailed(CharSequence error) {
                if (completed.compareAndSet(false, true)) {
                    listener.onLayoutFailed(errorText(error, "تعذر تجهيز الطباعة"));
                }
            }
        };
    }

    public static PrintDocumentAdapter.WriteResultCallback createWrite(WriteListener listener) {
        return createWrite(-1, listener);
    }

    public static PrintDocumentAdapter.WriteResultCallback createWrite(int expectedPageCount, WriteListener listener) {
        final AtomicBoolean completed = new AtomicBoolean(false);
        return new PrintDocumentAdapter.WriteResultCallback() {
            @Override
            public void onWriteFinished(PageRange[] pages) {
                if (!completed.compareAndSet(false, true)) return;
                String validationError;
                try {
                    validationError = validateWrittenPages(pages, expectedPageCount);
                } catch (Exception e) {
                    validationError = "نطاقات صفحات PDF غير صالحة";
                }
                if (validationError != null) {
                    listener.onWriteFailed(validationError);
                    return;
                }
                listener.onWriteFinished(pages);
            }

            @Override
            public void onWriteCancelled() {
                if (completed.compareAndSet(false, true)) {
                    listener.onWriteFailed("تم إلغاء كتابة PDF");
                }
            }

            @Override
            public void onWriteFailed(CharSequence error) {
                if (completed.compareAndSet(false, true)) {
                    listener.onWriteFailed(errorText(error, "تعذرت كتابة PDF"));
                }
            }
        };
    }

    private static String validateWrittenPages(PageRange[] pages, int expectedPageCount) {
        if (pages == null || pages.length == 0) return "لم تُكتب أي صفحات PDF";
        if (expectedPageCount == -1) return null;
        if (expectedPageCount <= 0) return "عدد صفحات PDF المتوقعة غير صالح";

        List<PageRange> ordered = new ArrayList<>(pages.length);
        for (PageRange range : pages) {
            if (range == null) return "نطاق صفحات PDF مفقود";
            int start = range.getStart();
            int end = range.getEnd();
            boolean allPages = start == 0 && end == Integer.MAX_VALUE;
            if (!allPages && (start < 0 || end < start || end >= expectedPageCount)) {
                return "نطاق صفحات PDF خارج العدد المتوقع";
            }
            ordered.add(range);
        }
        Collections.sort(ordered, (first, second) -> {
            int firstStart = first.getStart();
            int secondStart = second.getStart();
            int startCompare = Integer.compare(firstStart, secondStart);
            if (startCompare != 0) return startCompare;
            return Integer.compare(first.getEnd(), second.getEnd());
        });

        int nextPage = 0;
        for (PageRange range : ordered) {
            int start = range.getStart();
            int end = range.getEnd() == Integer.MAX_VALUE ? expectedPageCount - 1 : range.getEnd();
            if (start != nextPage) {
                return start < nextPage ? "صفحات PDF مكررة" : "صفحات PDF ناقصة";
            }
            nextPage = end + 1;
        }
        return nextPage == expectedPageCount ? null : "صفحات PDF ناقصة";
    }

    private static String errorText(CharSequence error, String fallback) {
        return error == null || error.toString().trim().isEmpty() ? fallback : error.toString();
    }
}
