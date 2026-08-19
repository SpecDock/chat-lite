package com.specdock.chatlite;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.view.DisplayCutout;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.MimeTypeMap;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

public class MainActivity extends Activity {
    private static final String HOME_URL = "https://chat.zzxandyl.cn";
    private static final String ALLOWED_HOST = "chat.zzxandyl.cn";
    private static final int FILE_CHOOSER_REQUEST = 4101;
    private static final Pattern MIME_TYPE_PATTERN = Pattern.compile(
            "^[a-z0-9][a-z0-9!#$&^_.+-]*/(?:\\*|[a-z0-9][a-z0-9!#$&^_.+-]*)$");

    private FrameLayout root;
    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;
    private OnBackInvokedDispatcher backDispatcher;
    private OnBackInvokedCallback backCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        configureWindow();

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(250, 249, 245));
        root.setFitsSystemWindows(false);
        setContentView(root);
        installSafeAreaHandling();

        createWebView();
        registerBackCallback();
        webView.loadUrl(HOME_URL);
    }

    private void configureWindow() {
        Window window = getWindow();
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.getAttributes().layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
        hideSystemBars();
    }

    private void installSafeAreaHandling() {
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            int left = 0;
            int top = 0;
            int right = 0;
            int bottom = 0;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                DisplayCutout cutout = insets.getDisplayCutout();
                if (cutout != null) {
                    left = Math.max(left, cutout.getSafeInsetLeft());
                    top = Math.max(top, cutout.getSafeInsetTop());
                    right = Math.max(right, cutout.getSafeInsetRight());
                    bottom = Math.max(bottom, cutout.getSafeInsetBottom());
                }
            }

            Insets gestureInsets;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                gestureInsets = insets.getInsets(WindowInsets.Type.systemGestures());
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                gestureInsets = insets.getSystemGestureInsets();
            } else {
                gestureInsets = Insets.NONE;
            }
            left = Math.max(left, gestureInsets.left);
            right = Math.max(right, gestureInsets.right);
            bottom = Math.max(bottom, gestureInsets.bottom);
            view.setPadding(left, top, right, bottom);
            return insets;
        });
        root.post(root::requestApplyInsets);
    }

    private void hideSystemBars() {
        Window window = getWindow();
        View decorView = window.getDecorView();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false);
            WindowInsetsController controller = decorView.getWindowInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.systemBars());
                controller.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
            return;
        }

        decorView.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    private void createWebView() {
        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(250, 249, 245));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(true);
        }

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, false);

        webView.setWebViewClient(new FixedDomainWebViewClient());
        webView.setWebChromeClient(new ChatWebChromeClient());
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT);
        root.addView(webView, params);
    }

    private void registerBackCallback() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return;
        }
        backDispatcher = getOnBackInvokedDispatcher();
        backCallback = this::handleBack;
        backDispatcher.registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_DEFAULT, backCallback);
    }

    private void unregisterBackCallback() {
        if (backDispatcher == null || backCallback == null) {
            return;
        }
        backDispatcher.unregisterOnBackInvokedCallback(backCallback);
        backDispatcher = null;
        backCallback = null;
    }

    private void handleBack() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            finish();
        }
    }

    private void showBlockedNavigation() {
        Toast.makeText(this, R.string.blocked_navigation, Toast.LENGTH_SHORT).show();
    }

    private void handleFileChooserResult(int resultCode, Intent data) {
        ValueCallback<Uri[]> callback = filePathCallback;
        filePathCallback = null;
        if (callback == null) {
            return;
        }
        if (resultCode != RESULT_OK || data == null) {
            callback.onReceiveValue(null);
            return;
        }

        Set<Uri> selected = new LinkedHashSet<>();
        ClipData clipData = data.getClipData();
        if (clipData != null) {
            for (int index = 0; index < clipData.getItemCount(); index++) {
                Uri uri = clipData.getItemAt(index).getUri();
                if (uri != null) {
                    selected.add(uri);
                }
            }
        }
        Uri singleUri = data.getData();
        if (singleUri != null) {
            selected.add(singleUri);
        }
        callback.onReceiveValue(selected.isEmpty() ? null : selected.toArray(new Uri[0]));
    }

    private Intent createFilePickerIntent(WebChromeClient.FileChooserParams params) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);

        String[] acceptTypes = params == null ? new String[0] : params.getAcceptTypes();
        String[] normalizedTypes = normalizeAcceptTypes(acceptTypes);
        if (normalizedTypes.length == 0) {
            intent.setType("*/*");
        } else if (normalizedTypes.length == 1) {
            intent.setType(normalizedTypes[0]);
        } else {
            intent.setType(commonMimeType(normalizedTypes));
            intent.putExtra(Intent.EXTRA_MIME_TYPES, normalizedTypes);
        }

        boolean multiple = params != null
                && params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE;
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        return intent;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_REQUEST) {
            handleFileChooserResult(resultCode, data);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
        }
        hideSystemBars();
    }

    @Override
    protected void onPause() {
        if (webView != null) {
            webView.onPause();
        }
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    public void onBackPressed() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            handleBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            hideSystemBars();
        }
    }

    @Override
    protected void onDestroy() {
        unregisterBackCallback();
        if (filePathCallback != null) {
            filePathCallback.onReceiveValue(null);
            filePathCallback = null;
        }
        if (webView != null) {
            webView.stopLoading();
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            root.removeView(webView);
            webView.removeAllViews();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private static boolean isAllowedMainFrameUrl(String rawUrl) {
        if (rawUrl == null) {
            return false;
        }
        Uri uri;
        try {
            uri = Uri.parse(rawUrl);
        } catch (Exception ignored) {
            return false;
        }
        String scheme = uri.getScheme();
        String host = uri.getHost();
        int port = uri.getPort();
        return "https".equalsIgnoreCase(scheme)
                && ALLOWED_HOST.equalsIgnoreCase(host)
                && (port == -1 || port == 443);
    }

    private static WebResourceResponse blockedResponse() {
        return new WebResourceResponse(
                "text/plain",
                StandardCharsets.UTF_8.name(),
                new ByteArrayInputStream(new byte[0]));
    }

    private static String[] normalizeAcceptTypes(String[] acceptTypes) {
        if (acceptTypes == null) {
            return new String[0];
        }

        Set<String> types = new LinkedHashSet<>();
        for (String raw : acceptTypes) {
            if (raw == null) {
                continue;
            }
            for (String part : raw.split(",")) {
                String type = part.trim().toLowerCase(Locale.ROOT);
                if (type.startsWith(".")) {
                    type = mimeTypeForExtension(type.substring(1));
                }
                if (type != null
                        && ("*/*".equals(type) || MIME_TYPE_PATTERN.matcher(type).matches())) {
                    types.add(type);
                }
            }
        }
        return types.toArray(new String[0]);
    }

    private static String mimeTypeForExtension(String extension) {
        if (extension == null || extension.isEmpty()) {
            return null;
        }
        String normalized = extension.toLowerCase(Locale.ROOT);
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(normalized);
    }

    private static String commonMimeType(String[] mimeTypes) {
        String topLevel = null;
        for (String mimeType : mimeTypes) {
            if ("*/*".equals(mimeType)) {
                return "*/*";
            }
            int slash = mimeType.indexOf('/');
            if (slash <= 0) {
                return "*/*";
            }
            String candidate = mimeType.substring(0, slash);
            if (topLevel == null) {
                topLevel = candidate;
            } else if (!topLevel.equals(candidate)) {
                return "*/*";
            }
        }
        return topLevel == null ? "*/*" : topLevel + "/*";
    }

    private final class FixedDomainWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (request == null || !request.isForMainFrame()) {
                return false;
            }
            String url = request.getUrl() == null ? null : request.getUrl().toString();
            if (isAllowedMainFrameUrl(url)) {
                return false;
            }
            showBlockedNavigation();
            return true;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            if (isAllowedMainFrameUrl(url)) {
                return false;
            }
            showBlockedNavigation();
            return true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(
                WebView view, WebResourceRequest request) {
            if (request != null && request.isForMainFrame()) {
                String url = request.getUrl() == null ? null : request.getUrl().toString();
                if (!isAllowedMainFrameUrl(url)) {
                    return blockedResponse();
                }
            }
            return super.shouldInterceptRequest(view, request);
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            if (!isAllowedMainFrameUrl(url)) {
                view.stopLoading();
                showBlockedNavigation();
                return;
            }
            super.onPageStarted(view, url, favicon);
        }

        @Override
        public void onReceivedSslError(
                WebView view, SslErrorHandler handler, SslError error) {
            handler.cancel();
        }

        @Override
        public void onReceivedError(
                WebView view, WebResourceRequest request, WebResourceError error) {
            super.onReceivedError(view, request, error);
        }
    }

    private final class ChatWebChromeClient extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(
                WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (callback == null) {
                return false;
            }
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(null);
            }
            filePathCallback = callback;

            Intent picker = createFilePickerIntent(params);
            try {
                startActivityForResult(picker, FILE_CHOOSER_REQUEST);
            } catch (Exception firstFailure) {
                try {
                    picker.setAction(Intent.ACTION_GET_CONTENT);
                    picker.removeFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                    startActivityForResult(picker, FILE_CHOOSER_REQUEST);
                } catch (Exception secondFailure) {
                    filePathCallback.onReceiveValue(null);
                    filePathCallback = null;
                    Toast.makeText(MainActivity.this, R.string.file_picker_unavailable,
                            Toast.LENGTH_SHORT).show();
                }
            }
            return true;
        }

        @Override
        public boolean onCreateWindow(
                WebView view, boolean isDialog, boolean isUserGesture, android.os.Message resultMsg) {
            return false;
        }
    }
}
