package io.github.mogie13.mogtranslator;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

/**
 * Mog Translator for Android: hosts the web app (copied from the repo root into
 * assets/www at build time) in a WebView. Everything works offline.
 *
 * The page is served from https://appassets.androidplatform.net/ rather than file://
 * because app.js is an ES module (blocked on file://) and IndexedDB, the microphone
 * and fetch() all need a proper secure origin.
 */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START = "https://" + HOST + "/index.html";
    private static final int PICK_FILE = 41, MIC = 42;

    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("html", "text/html");
        MIME.put("js", "text/javascript");
        MIME.put("mjs", "text/javascript");
        MIME.put("json", "application/json");
        MIME.put("webmanifest", "application/manifest+json");
        MIME.put("svg", "image/svg+xml");
        MIME.put("png", "image/png");
        MIME.put("woff2", "font/woff2");
        MIME.put("txt", "text/plain");
        MIME.put("css", "text/css");
    }

    /**
     * Export uses a blob: link with a download name, which a WebView can't save by
     * itself. This hands such links to the native side instead.
     */
    private static final String DOWNLOAD_HOOK =
        "(function(){if(window.__mogDl)return;window.__mogDl=1;" +
        "document.addEventListener('click',function(e){" +
        "var a=e.target&&e.target.closest&&e.target.closest('a[download]');" +
        "if(!a||!/^(blob|data):/.test(a.href))return;e.preventDefault();" +
        "fetch(a.href).then(function(r){return r.blob()}).then(function(b){" +
        "var fr=new FileReader();fr.onload=function(){" +
        "MogAndroid.saveFile(String(fr.result).split(',')[1],a.download||'mog-export',b.type||'application/octet-stream')};" +
        "fr.readAsDataURL(b)})},true)})();";

    private WebView web;
    private ValueCallback<Uri[]> pendingPick;
    private PermissionRequest pendingMic;

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        web.setBackgroundColor(0xff6b1626);
        setContentView(web);
        keepClearOfSystemBars();

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);           // saved words, settings, history
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);            // everything comes through serveAsset()
        s.setAllowContentAccess(true);          // picked import files
        // Debug builds may talk to an http:// test server from the app's https:// page.
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                return serveAsset(req.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (HOST.equals(u.getHost()) || "blob".equals(u.getScheme()) || "data".equals(u.getScheme())) return false;
                // source links (IIT Guwahati, ICPhS) open in the browser
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (ActivityNotFoundException ignored) { }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                view.evaluateJavascript(DOWNLOAD_HOOK, null);
            }
        });

        // sw.js isn't bundled (the app is already offline), so registration fails quietly;
        // this only guards against an old worker serving stale files.
        if (Build.VERSION.SDK_INT >= 24) {
            ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebResourceRequest req) {
                    return serveAsset(req.getUrl());
                }
            });
        }

        web.setWebChromeClient(new WebChromeClient() {
            // "Import file" in Contribute opens the system picker
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingPick != null) pendingPick.onReceiveValue(null);
                pendingPick = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("*/*");   // many file managers don't tag .json files, so the page checks the content
                try {
                    startActivityForResult(Intent.createChooser(pick, "Choose a contributions file"), PICK_FILE);
                } catch (ActivityNotFoundException e) {
                    pendingPick = null;
                    return false;
                }
                return true;
            }

            // "Record" in Contribute: ask Android for the microphone, then let the page use it
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    if (!Arrays.asList(request.getResources()).contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
                            || !HOST.equals(request.getOrigin().getHost())) {
                        request.deny();
                        return;
                    }
                    if (Build.VERSION.SDK_INT < 23
                            || checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                    } else {
                        if (pendingMic != null) pendingMic.deny();
                        pendingMic = request;
                        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, MIC);
                    }
                });
            }
        });

        web.addJavascriptInterface(new Bridge(), "MogAndroid");

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(START);
    }

    /** Serves assets/www/<path> for the app's origin; anything else goes to the network. */
    private WebResourceResponse serveAsset(Uri url) {
        if (!HOST.equals(url.getHost())) return null;
        String path = url.getPath();
        if (path == null || path.equals("/") || path.isEmpty()) path = "/index.html";
        if (path.contains("..")) return notFound();
        String ext = path.substring(path.lastIndexOf('.') + 1).toLowerCase();
        String mime = MIME.containsKey(ext) ? MIME.get(ext) : "application/octet-stream";
        try {
            InputStream in = getAssets().open("www" + path);
            WebResourceResponse r = new WebResourceResponse(mime, mime.startsWith("text/") || mime.contains("json") ? "utf-8" : null, in);
            Map<String, String> h = new HashMap<>();
            h.put("Cache-Control", "no-cache");
            r.setResponseHeaders(h);
            return r;
        } catch (IOException e) {
            return notFound();
        }
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<>(),
                new ByteArrayInputStream(new byte[0]));
    }

    /** Android 15 draws apps edge to edge; pad the page so the header and tabs aren't under the bars. */
    private void keepClearOfSystemBars() {
        web.setOnApplyWindowInsetsListener((v, insets) -> {
            int l, t, r, b;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                l = i.left; t = i.top; r = i.right; b = i.bottom;
            } else {
                l = insets.getSystemWindowInsetLeft(); t = insets.getSystemWindowInsetTop();
                r = insets.getSystemWindowInsetRight(); b = insets.getSystemWindowInsetBottom();
            }
            v.setPadding(l, t, r, b);
            return insets;
        });
    }

    /** Called from JavaScript with an exported file as base64. */
    private class Bridge {
        @JavascriptInterface
        public void saveFile(String base64, String name, String mime) {
            boolean ok = false;
            try {
                byte[] data = Base64.decode(base64, Base64.DEFAULT);
                String safe = name.replace('/', '-');
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Downloads.DISPLAY_NAME, safe);
                    v.put(MediaStore.Downloads.MIME_TYPE, mime);
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    if (uri != null) {
                        try (OutputStream out = getContentResolver().openOutputStream(uri)) { out.write(data); }
                        ok = true;
                    }
                } else {
                    File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    try (FileOutputStream out = new FileOutputStream(new File(dir, safe))) { out.write(data); }
                    ok = true;
                }
            } catch (Exception ignored) { }
            final boolean saved = ok;
            runOnUiThread(() -> Toast.makeText(MainActivity.this,
                    saved ? "Saved to Downloads: " + name : "Couldn't save the file", Toast.LENGTH_LONG).show());
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode == MIC && pendingMic != null) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
                pendingMic.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            } else {
                pendingMic.deny();
            }
            pendingMic = null;
            return;
        }
        super.onRequestPermissionsResult(requestCode, permissions, results);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == PICK_FILE && pendingPick != null) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) result = new Uri[]{ data.getData() };
            pendingPick.onReceiveValue(result);
            pendingPick = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }
}
