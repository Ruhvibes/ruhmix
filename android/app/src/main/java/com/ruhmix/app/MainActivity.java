package com.ruhmix.app;

import android.Manifest;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.media.MediaRecorder;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.FileProvider;

import com.google.android.gms.ads.AdRequest;
import com.google.android.gms.ads.FullScreenContentCallback;
import com.google.android.gms.ads.LoadAdError;
import com.google.android.gms.ads.MobileAds;
import com.google.android.gms.ads.OnUserEarnedRewardListener;
import com.google.android.gms.ads.RequestConfiguration;
import com.google.android.gms.ads.rewarded.RewardItem;
import com.google.android.gms.ads.rewarded.RewardedAd;
import com.google.android.gms.ads.rewarded.RewardedAdLoadCallback;
import com.google.android.gms.ads.interstitial.InterstitialAd;
import com.google.android.gms.ads.interstitial.InterstitialAdLoadCallback;

import org.json.JSONArray;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * RuhMix - thin native wrapper.
 * A full-screen WebView loads the local web app (file:///android_asset/www/index.html).
 * All audio logic lives in JavaScript (Web Audio API). The native side exposes:
 *
 *   Android.pickAudio()                 — system audio picker (MP3/WAV/M4A/FLAC, multi-select);
 *                                         copies chosen files into the app cache and calls
 *                                         JS onAudioPicked(["file:///...", ...]).
 *   Android.startRecording(fileName)    — starts the mic recorder, returns the output
 *                                         file path immediately ("file:///.../rec/name.3gp");
 *                                         JS is also notified via onRecordingStarted(path).
 *   Android.stopRecording()             — stops recording, returns the final file path;
 *                                         JS is also notified via onRecordingStopped(path, ms).
 *   Android.shareFile(path, mime)       — system share sheet via FileProvider.
 *   Android.downloadApk(url)            — DownloadManager APK download (in-app update system).
 *   Android.getCacheDir()               — returns the app cache dir path.
 *   Android.clearCache()                — wipes the app cache, returns bytes freed.
 *   Android.openUrl(url)                — opens a link in the system browser.
 *
 * JS callbacks the web app should implement (all optional):
 *   onAudioPicked(pathsArray)           — pathsArray is a JS array of file:// strings
 *   onRecordingStarted(path)
 *   onRecordingStopped(path, durationMs)
 *   onRecordingError(message)
 *
 * NOTE: no READ_CONTACTS anywhere — no feature uses contacts, and requesting it
 * would be unprofessional and a Play Store review risk.
 */
public class MainActivity extends ComponentActivity {

    private static final int REQ_AUDIO_PERM = 1001;
    private static final int REQ_MIC_PERM = 1002;
    private static final String FILEPROVIDER_AUTH = "com.ruhmix.app.fileprovider";

    private WebView webView;

    // ---------- AdMob (rewarded video + interstitial) ----------
    // Ads must NEVER crash the app: every ad call is wrapped in try/catch
    // and every failure reports back to JS so the feature degrades gracefully.
    private RewardedAd rewardedAd = null;
    private String rewardedUnitLoading = null;
    private InterstitialAd interstitialAd = null;

    /** Initializes AdMob safely (idempotent). */
    private void initAds() {
        try {
            RequestConfiguration conf = new RequestConfiguration.Builder()
                    .setTagForChildDirectedTreatment(
                            RequestConfiguration.TAG_FOR_CHILD_DIRECTED_TREATMENT_FALSE)
                    .setMaxAdContentRating(RequestConfiguration.MAX_AD_CONTENT_RATING_G)
                    .build();
            MobileAds.setRequestConfiguration(conf);
            MobileAds.initialize(this, initializationStatus -> {
            });
        } catch (Exception ignored) {
        }
    }

    private void jsCallback(String js) {
        try {
            final WebView wv = webView;
            if (wv == null) return;
            runOnUiThread(() -> {
                try { wv.evaluateJavascript(js, null); } catch (Exception ignored) {}
            });
        } catch (Exception ignored) {
        }
    }

    private static String jsStr(String s) {
        if (s == null) return "''";
        return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'";
    }

    /** Preloads a rewarded + interstitial ad so they show without delay. */
    private void preloadAds(final String rewardedUnitId, final String interstitialUnitId) {
        runOnUiThread(() -> {
            try {
                loadRewarded(rewardedUnitId, null);
            } catch (Exception ignored) {
            }
            try {
                loadInterstitial(interstitialUnitId);
            } catch (Exception ignored) {
            }
        });
    }

    private void loadRewarded(final String unitId, final Runnable onLoadedShow) {
        try {
            if (unitId == null || unitId.isEmpty()) return;
            rewardedUnitLoading = unitId;
            AdRequest req = new AdRequest.Builder().build();
            RewardedAd.load(this, unitId, req, new RewardedAdLoadCallback() {
                @Override
                public void onAdLoaded(RewardedAd ad) {
                    rewardedAd = ad;
                    if (onLoadedShow != null) {
                        try { onLoadedShow.run(); } catch (Exception ignored) {}
                    }
                }

                @Override
                public void onAdFailedToLoad(LoadAdError err) {
                    rewardedAd = null;
                }
            });
        } catch (Exception ignored) {
        }
    }

    private void loadInterstitial(final String unitId) {
        try {
            if (unitId == null || unitId.isEmpty()) return;
            AdRequest req = new AdRequest.Builder().build();
            InterstitialAd.load(this, unitId, req, new InterstitialAdLoadCallback() {
                @Override
                public void onAdLoaded(InterstitialAd ad) {
                    interstitialAd = ad;
                }

                @Override
                public void onAdFailedToLoad(LoadAdError err) {
                    interstitialAd = null;
                }
            });
        } catch (Exception ignored) {
        }
    }

    /**
     * Shows a rewarded video ad. JS is always called back exactly once via
     * RM.ads._onRewarded('earned' | 'closed' | 'failed').
     */
    private void showRewarded(final String unitId) {
        runOnUiThread(() -> {
            try {
                if (rewardedAd != null && unitId != null && unitId.equals(rewardedUnitLoading)) {
                    showRewardedNow(unitId);
                } else {
                    // Not preloaded (or different unit): load then show.
                    loadRewarded(unitId, () -> {
                        try {
                            if (rewardedAd != null) showRewardedNow(unitId);
                            else jsCallback("window.RM&&RM.ads&&RM.ads._onRewarded('failed')");
                        } catch (Exception ignored) {
                            jsCallback("window.RM&&RM.ads&&RM.ads._onRewarded('failed')");
                        }
                    });
                    // Safety: if load hangs, the JS side has its own 25s timeout.
                }
            } catch (Exception ignored) {
                jsCallback("window.RM&&RM.ads&&RM.ads._onRewarded('failed')");
            }
        });
    }

    private void showRewardedNow(final String unitId) {
        final RewardedAd ad = rewardedAd;
        rewardedAd = null; // one-shot: reload after showing
        final boolean[] earned = {false};
        try {
            ad.setFullScreenContentCallback(new FullScreenContentCallback() {
                @Override
                public void onAdDismissedFullScreenContent() {
                    jsCallback("window.RM&&RM.ads&&RM.ads._onRewarded(" +
                            jsStr(earned[0] ? "earned" : "closed") + ")");
                    try { loadRewarded(unitId, null); } catch (Exception ignored) {}
                }

                @Override
                public void onAdFailedToShowFullScreenContent(com.google.android.gms.ads.AdError err) {
                    jsCallback("window.RM&&RM.ads&&RM.ads._onRewarded('failed')");
                    try { loadRewarded(unitId, null); } catch (Exception ignored) {}
                }
            });
            ad.show(this, (OnUserEarnedRewardListener) (RewardItem rewardItem) -> {
                earned[0] = true;
            });
        } catch (Exception ignored) {
            jsCallback("window.RM&&RM.ads&&RM.ads._onRewarded('failed')");
            try { loadRewarded(unitId, null); } catch (Exception ignored2) {}
        }
    }

    /** Shows a preloaded interstitial if one is ready; silently skips otherwise. */
    private void showInterstitial(final String unitId) {
        runOnUiThread(() -> {
            try {
                final InterstitialAd ad = interstitialAd;
                interstitialAd = null; // one-shot: reload after showing
                if (ad != null) {
                    ad.show(MainActivity.this);
                }
            } catch (Exception ignored) {
            } finally {
                // Keep one warm for next time; failure is silent by design.
                try { loadInterstitial(unitId); } catch (Exception ignored) {}
            }
        });
    }
    private ValueCallback<Uri[]> filePathCallback;
    private boolean audioPermDeniedBefore = false;
    private boolean micPermDeniedBefore = false;
    private Runnable pendingAudioAction;
    private Runnable pendingMicAction;

    // Recording state
    private MediaRecorder recorder;
    private File recordingFile;
    private long recordingStartMs;

    private final ActivityResultLauncher<Intent> audioPickerLauncher =
            registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
                if (result.getResultCode() == RESULT_OK && result.getData() != null) {
                    handlePickedAudio(result.getData());
                } else {
                    callJs("if(window.onAudioPicked){window.onAudioPicked([])}");
                }
            });

    private final ActivityResultLauncher<Intent> fileChooserLauncher =
            registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
                Uri[] uris = null;
                if (result.getResultCode() == RESULT_OK && result.getData() != null) {
                    Uri uri = result.getData().getData();
                    if (uri != null) {
                        try {
                            getContentResolver().takePersistableUriPermission(
                                    uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        } catch (SecurityException ignored) {
                        }
                        uris = new Uri[]{uri};
                    }
                }
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(uris);
                    filePathCallback = null;
                }
            });

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Drop the splash launch theme now that we're past window creation —
        // the branded splash only shows during cold start.
        setTheme(android.R.style.Theme_Material_NoActionBar);

        webView = new WebView(this);
        webView.setBackgroundColor(0xFF0F0B24);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        // Allow fetch()/XHR of cached audio copies (file://) from the file:// web app.
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setDomStorageEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);

        webView.addJavascriptInterface(new NativeBridge(), "Android");
        initAds();
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest request) {
                Uri url = request.getUrl();
                String scheme = url.getScheme();
                // External links open in the system browser, never inside the app.
                if ("http".equals(scheme) || "https".equals(scheme)) {
                    try {
                        Intent i = new Intent(Intent.ACTION_VIEW, url);
                        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        view.getContext().startActivity(i);
                    } catch (Exception ignored) {
                    }
                    return true;
                }
                return false;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;
                ensureAudioPermission(() -> {
                    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("audio/*");
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                    try {
                        fileChooserLauncher.launch(Intent.createChooser(intent, "Audio chunein"));
                    } catch (Exception e) {
                        cancelPendingFileChooser();
                    }
                });
                return true;
            }

            // JS alert()/confirm()/prompt() need native dialogs in a WebView,
            // otherwise they silently fail.
            @Override
            public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok, (d, w) -> result.confirm())
                        .setCancelable(false)
                        .show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok, (d, w) -> result.confirm())
                        .setNegativeButton(android.R.string.cancel, (d, w) -> result.cancel())
                        .setCancelable(false)
                        .show();
                return true;
            }

            @Override
            public boolean onJsPrompt(WebView view, String url, String message,
                                      String defaultValue, JsPromptResult result) {
                final EditText input = new EditText(MainActivity.this);
                input.setText(defaultValue);
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setView(input)
                        .setPositiveButton(android.R.string.ok,
                                (d, w) -> result.confirm(input.getText().toString()))
                        .setNegativeButton(android.R.string.cancel, (d, w) -> result.cancel())
                        .setCancelable(false)
                        .show();
                return true;
            }
        });

        // Immersive full-screen
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);

        setContentView(webView);
        webView.loadUrl("file:///android_asset/www/index.html");
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            // Confirm before exiting — no accidental closes mid-mix.
            new AlertDialog.Builder(this)
                    .setTitle("RuhMix band karein?")
                    .setMessage("Kya aap app se bahar nikalna chahte hain?")
                    .setPositiveButton("Haan", (d, w) -> MainActivity.super.onBackPressed())
                    .setNegativeButton("Nahi", null)
                    .show();
        }
    }

    @Override
    protected void onDestroy() {
        stopRecorderSilently();
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }

    // ---------- JS helper ----------

    private void callJs(final String js) {
        runOnUiThread(() -> {
            try {
                if (webView != null) webView.evaluateJavascript(js, null);
            } catch (Exception ignored) {
            }
        });
    }

    private static String jsString(String s) {
        if (s == null) return "''";
        return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'";
    }

    // ---------- Permissions ----------

    private String audioPermission() {
        return Build.VERSION.SDK_INT >= 33
                ? Manifest.permission.READ_MEDIA_AUDIO
                : Manifest.permission.READ_EXTERNAL_STORAGE;
    }

    private boolean hasAudioReadPermission() {
        return checkSelfPermission(audioPermission()) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasMicPermission() {
        return checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    /** Professional runtime-permission UX: explain why, then ask, then run the action. */
    private void ensureAudioPermission(Runnable after) {
        if (hasAudioReadPermission()) {
            after.run();
            return;
        }
        pendingAudioAction = after;
        final String perm = audioPermission();
        if (audioPermDeniedBefore && !shouldShowRequestPermissionRationale(perm)) {
            new AlertDialog.Builder(this)
                    .setTitle("Permission needed \uD83D\uDE4F")
                    .setMessage("RuhMix couldn't access your audio files. " +
                            "Go to Settings > Apps > RuhMix > Permissions and allow it, " +
                            "then you can pick audio.")
                    .setPositiveButton("Open Settings", (d, w) -> {
                        try {
                            Intent i = new Intent(
                                    android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                    Uri.parse("package:" + getPackageName()));
                            startActivity(i);
                        } catch (Exception ignored) {
                        }
                        pendingAudioAction = null;
                        cancelPendingFileChooser();
                    })
                    .setNegativeButton("Not now", (d, w) -> {
                        pendingAudioAction = null;
                        cancelPendingFileChooser();
                    })
                    .setCancelable(false)
                    .show();
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle("Audio access \uD83C\uDFB6")
                .setMessage("RuhMix needs access to your audio files " +
                        "so you can pick songs and create mixes.")
                .setPositiveButton("Allow",
                        (d, w) -> requestPermissions(new String[]{perm}, REQ_AUDIO_PERM))
                .setNegativeButton("Not now", (d, w) -> {
                    pendingAudioAction = null;
                    cancelPendingFileChooser();
                })
                .setCancelable(false)
                .show();
    }

    private void ensureMicPermission(Runnable after) {
        if (hasMicPermission()) {
            after.run();
            return;
        }
        pendingMicAction = after;
        final String perm = Manifest.permission.RECORD_AUDIO;
        if (micPermDeniedBefore && !shouldShowRequestPermissionRationale(perm)) {
            new AlertDialog.Builder(this)
                    .setTitle("Permission needed \uD83D\uDE4F")
                    .setMessage("RuhMix couldn't access your microphone. " +
                            "Go to Settings > Apps > RuhMix > Permissions and allow it, " +
                            "then you can record.")
                    .setPositiveButton("Open Settings", (d, w) -> {
                        try {
                            Intent i = new Intent(
                                    android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                    Uri.parse("package:" + getPackageName()));
                            startActivity(i);
                        } catch (Exception ignored) {
                        }
                        pendingMicAction = null;
                    })
                    .setNegativeButton("Not now", (d, w) -> pendingMicAction = null)
                    .setCancelable(false)
                    .show();
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle("Microphone access \uD83C\uDFA4")
                .setMessage("RuhMix needs your microphone so you can record audio.")
                .setPositiveButton("Allow",
                        (d, w) -> requestPermissions(new String[]{perm}, REQ_MIC_PERM))
                .setNegativeButton("Not now", (d, w) -> pendingMicAction = null)
                .setCancelable(false)
                .show();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        boolean granted = grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (requestCode == REQ_AUDIO_PERM) {
            Runnable after = pendingAudioAction;
            pendingAudioAction = null;
            if (granted) {
                audioPermDeniedBefore = false;
                if (after != null) after.run();
            } else {
                audioPermDeniedBefore = true;
                cancelPendingFileChooser();
                Toast.makeText(this,
                        "Permission nahi mila \u2014 Settings > Apps > RuhMix me allow karo \uD83D\uDE4F",
                        Toast.LENGTH_LONG).show();
            }
        } else if (requestCode == REQ_MIC_PERM) {
            Runnable after = pendingMicAction;
            pendingMicAction = null;
            if (granted) {
                micPermDeniedBefore = false;
                if (after != null) after.run();
            } else {
                micPermDeniedBefore = true;
                callJs("if(window.onRecordingError){window.onRecordingError('Microphone permission nahi mili')}");
                Toast.makeText(this,
                        "Permission nahi mila \u2014 Settings > Apps > RuhMix me allow karo \uD83D\uDE4F",
                        Toast.LENGTH_LONG).show();
            }
        }
    }

    private void cancelPendingFileChooser() {
        if (filePathCallback != null) {
            filePathCallback.onReceiveValue(null);
            filePathCallback = null;
        }
    }

    // ---------- Audio picker (JS bridge) ----------

    private void launchAudioPicker() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("audio/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav",
                "audio/mp4", "audio/x-m4a", "audio/flac", "audio/aac", "audio/ogg"
        });
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            audioPickerLauncher.launch(Intent.createChooser(intent, "Audio chunein"));
        } catch (Exception e) {
            callJs("if(window.onAudioPicked){window.onAudioPicked([])}");
        }
    }

    /** Copies every picked URI into the app cache and hands file:// paths back to JS. */
    private void handlePickedAudio(Intent data) {
        new Thread(() -> {
            JSONArray arr = new JSONArray();
            try {
                if (data.getClipData() != null) {
                    ClipData clip = data.getClipData();
                    for (int i = 0; i < clip.getItemCount(); i++) {
                        String p = copyUriToCache(clip.getItemAt(i).getUri(), i);
                        if (p != null) arr.put(p);
                    }
                } else if (data.getData() != null) {
                    String p = copyUriToCache(data.getData(), 0);
                    if (p != null) arr.put(p);
                }
            } catch (Exception e) {
                // fall through: hand back whatever was copied successfully
            }
            final String json = arr.toString();
            callJs("if(window.onAudioPicked){window.onAudioPicked(" + json + ")}");
        }).start();
    }

    private String copyUriToCache(Uri uri, int index) {
        if (uri == null) return null;
        try {
            String name = queryDisplayName(uri);
            if (name == null || name.isEmpty()) name = "audio_" + index + ".mp3";
            name = name.replaceAll("[/\\\\]", "_");
            File dir = new File(getCacheDir(), "imports");
            if (!dir.exists()) dir.mkdirs();
            File dst = uniqueFile(dir, name);
            ContentResolver cr = getContentResolver();
            try (InputStream in = cr.openInputStream(uri);
                 OutputStream out = new FileOutputStream(dst)) {
                if (in == null) return null;
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
            return "file://" + dst.getAbsolutePath();
        } catch (Exception e) {
            return null;
        }
    }

    private String queryDisplayName(Uri uri) {
        try (Cursor c = getContentResolver().query(uri,
                new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) return c.getString(idx);
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private File uniqueFile(File dir, String name) {
        File f = new File(dir, name);
        if (!f.exists()) return f;
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        int i = 1;
        while (f.exists()) {
            f = new File(dir, base + "_" + (i++) + ext);
        }
        return f;
    }

    // ---------- Mic recording ----------

    private void stopRecorderSilently() {
        if (recorder != null) {
            try {
                recorder.stop();
            } catch (Exception ignored) {
            }
            try {
                recorder.release();
            } catch (Exception ignored) {
            }
            recorder = null;
        }
    }

    // ---------- Share / open URL / APK download ----------

    private void shareFileViaSystem(String path, String mime) {
        try {
            if (path == null || path.isEmpty()) throw new Exception("empty path");
            String p = path.startsWith("file://") ? path.substring(7) : path;
            File file = new File(p);
            if (!file.exists()) {
                Toast.makeText(this, "File nahi mili \uD83D\uDE1E", Toast.LENGTH_LONG).show();
                return;
            }
            Uri uri = FileProvider.getUriForFile(this, FILEPROVIDER_AUTH, file);
            Intent i = new Intent(Intent.ACTION_SEND);
            i.setType(mime == null || mime.isEmpty() ? "*/*" : mime);
            i.putExtra(Intent.EXTRA_STREAM, uri);
            i.setClipData(ClipData.newRawUri(file.getName(), uri));
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(Intent.createChooser(i, "Share via"));
        } catch (Exception e) {
            Toast.makeText(this, "Share fail ho gaya \uD83D\uDE1E", Toast.LENGTH_LONG).show();
        }
    }

    private void openExternalUrl(String url) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Exception ignored) {
        }
    }

    private void downloadApkViaManager(String url) {
        try {
            if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) {
                Toast.makeText(this, "Download link sahi nahi hai", Toast.LENGTH_LONG).show();
                return;
            }
            DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            long dlId = -1;
            try {
                if (dm != null) {
                    DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                    req.setTitle("RuhMix Update");
                    req.setDescription("Naya version download ho raha hai\u2026");
                    req.setNotificationVisibility(
                            DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    req.setDestinationInExternalPublicDir(
                            Environment.DIRECTORY_DOWNLOADS, "RuhMix.apk");
                    req.setMimeType("application/vnd.android.package-archive");
                    req.setAllowedOverMetered(true);
                    req.setAllowedOverRoaming(true);
                    dlId = dm.enqueue(req);
                }
            } catch (Exception ignored) {
                dlId = -1;
            }
            if (dlId != -1) {
                Toast.makeText(this,
                        "\u2B07 Download shuru ho gaya \u2014 notification me dekho",
                        Toast.LENGTH_LONG).show();
            } else {
                openExternalUrl(url);
                Toast.makeText(this, "Browser me download khul raha hai\u2026",
                        Toast.LENGTH_LONG).show();
            }
        } catch (Exception e) {
            openExternalUrl(url);
        }
    }

    // ---------- Cache manager ----------

    private long clearCacheDir(File dir) {
        long freed = 0;
        if (dir == null || !dir.exists()) return 0;
        File[] files = dir.listFiles();
        if (files == null) return 0;
        for (File f : files) {
            if (f.isDirectory()) {
                freed += clearCacheDir(f);
                f.delete();
            } else {
                freed += f.length();
                f.delete();
            }
        }
        return freed;
    }

    /**
     * The JS bridge, called from JavaScript as Android.pickAudio() etc.
     */
    private class NativeBridge {

        // ---------- AdMob bridge (rewarded + interstitial) ----------
        @JavascriptInterface
        public void preloadAds(final String rewardedUnitId, final String interstitialUnitId) {
            try { MainActivity.this.preloadAds(rewardedUnitId, interstitialUnitId); }
            catch (Exception ignored) {}
        }

        @JavascriptInterface
        public void showRewarded(final String unitId) {
            try { MainActivity.this.showRewarded(unitId); }
            catch (Exception ignored) {
                try { jsCallback("window.RM&&RM.ads&&RM.ads._onRewarded('failed')"); }
                catch (Exception ignored2) {}
            }
        }

        @JavascriptInterface
        public void showInterstitial(final String unitId) {
            try { MainActivity.this.showInterstitial(unitId); }
            catch (Exception ignored) {}
        }

        @JavascriptInterface
        public void pickAudio() {
            runOnUiThread(() -> ensureAudioPermission(() -> launchAudioPicker()));
        }

        /**
         * Starts mic recording. Returns the output file path immediately
         * ("file:///.../rec/<name>.3gp") or "" on failure.
         * NOTE: Android's MediaRecorder has no WAV encoder — output is 3GP (AMR-NB).
         */
        @JavascriptInterface
        public String startRecording(final String fileName) {
            final String[] result = {""};
            // Must run synchronously on the UI thread so the return value is real.
            final Object lock = new Object();
            runOnUiThread(() -> {
                synchronized (lock) {
                    try {
                        ensureMicPermission(() -> {
                            synchronized (lock) {
                                result[0] = beginRecording(fileName);
                                lock.notify();
                            }
                        });
                        // If permission was already granted, beginRecording ran above
                        // and result[0] is set. If a dialog was shown instead,
                        // beginRecording runs after the grant and the result
                        // arrives via onRecordingStarted(path).
                    } finally {
                        lock.notify();
                    }
                }
            });
            synchronized (lock) {
                try {
                    lock.wait(3000);
                } catch (InterruptedException ignored) {
                }
            }
            return result[0];
        }

        private String beginRecording(String fileName) {
            stopRecorderSilently();
            try {
                String safe = (fileName == null || fileName.isEmpty())
                        ? "ruhmix-recording" : fileName.replaceAll("[/\\\\]", "_");
                if (!safe.toLowerCase().endsWith(".3gp")) safe += ".3gp";
                File dir = new File(getCacheDir(), "rec");
                if (!dir.exists()) dir.mkdirs();
                recordingFile = uniqueFile(dir, safe);
                recorder = new MediaRecorder();
                recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
                recorder.setOutputFormat(MediaRecorder.OutputFormat.THREE_GPP);
                recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AMR_NB);
                recorder.setOutputFile(recordingFile.getAbsolutePath());
                recorder.prepare();
                recorder.start();
                recordingStartMs = System.currentTimeMillis();
                final String path = "file://" + recordingFile.getAbsolutePath();
                callJs("if(window.onRecordingStarted){window.onRecordingStarted("
                        + jsString(path) + ")}");
                return path;
            } catch (Exception e) {
                stopRecorderSilently();
                recordingFile = null;
                callJs("if(window.onRecordingError){window.onRecordingError("
                        + jsString("Recording start fail: " + e.getMessage()) + ")}");
                return "";
            }
        }

        /**
         * Stops recording. Returns the final file path ("" if nothing was recording).
         */
        @JavascriptInterface
        public String stopRecording() {
            final String[] result = {""};
            final long[] dur = {0};
            final Object lock = new Object();
            runOnUiThread(() -> {
                synchronized (lock) {
                    try {
                        if (recorder != null && recordingFile != null) {
                            try {
                                recorder.stop();
                            } catch (RuntimeException e) {
                                // Too short / already stopped — drop the file.
                                if (recordingFile != null) recordingFile.delete();
                                recordingFile = null;
                            }
                            try {
                                recorder.release();
                            } catch (Exception ignored) {
                            }
                            recorder = null;
                            if (recordingFile != null && recordingFile.exists()) {
                                result[0] = "file://" + recordingFile.getAbsolutePath();
                                dur[0] = System.currentTimeMillis() - recordingStartMs;
                            }
                        }
                    } finally {
                        lock.notify();
                    }
                }
            });
            synchronized (lock) {
                try {
                    lock.wait(3000);
                } catch (InterruptedException ignored) {
                }
            }
            final String path = result[0];
            final long ms = dur[0];
            if (!path.isEmpty()) {
                callJs("if(window.onRecordingStopped){window.onRecordingStopped("
                        + jsString(path) + "," + ms + ")}");
            }
            return path;
        }

        @JavascriptInterface
        public void shareFile(final String path, final String mime) {
            runOnUiThread(() -> shareFileViaSystem(path, mime));
        }

        /**
         * Saves base64-encoded file data into the app cache share/ dir
         * (served via FileProvider) and returns the absolute path,
         * or "" on failure. Used by the web app's export pipeline:
         * saveFile(b64, name, mime) -> shareFile(path, mime).
         */
        @JavascriptInterface
        public String saveFile(final String base64Data, final String fileName, final String mime) {
            try {
                if (base64Data == null || base64Data.isEmpty()) return "";
                String safe = (fileName == null || fileName.isEmpty() ? "ruhmix-export" : fileName)
                        .replaceAll("[^A-Za-z0-9._-]", "_");
                File dir = new File(getApplicationContext().getCacheDir(), "share");
                if (!dir.exists() && !dir.mkdirs()) return "";
                File out = new File(dir, safe);
                byte[] data = Base64.decode(base64Data, Base64.DEFAULT);
                FileOutputStream fos = new FileOutputStream(out);
                fos.write(data);
                fos.flush();
                fos.close();
                return out.getAbsolutePath();
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public void downloadApk(final String url) {
            runOnUiThread(() -> downloadApkViaManager(url));
        }

        @JavascriptInterface
        public String getCacheDir() {
            return getApplicationContext().getCacheDir().getAbsolutePath();
        }

        @JavascriptInterface
        public long clearCache() {
            return clearCacheDir(getApplicationContext().getCacheDir());
        }

        @JavascriptInterface
        public void openUrl(final String url) {
            runOnUiThread(() -> openExternalUrl(url));
        }
    }
}
