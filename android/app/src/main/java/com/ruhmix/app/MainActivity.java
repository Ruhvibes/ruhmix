package com.ruhmix.app;

import android.Manifest;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.media.MediaRecorder;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
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
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
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
 *                                         JS onAudioPicked({ok:["file:///...", ...],
 *                                         failed:[{name, reason}]}).
 *   Android.listMusic()                 — lists up to 2000 on-device music tracks via
 *                                         MediaStore (background thread); JS gets
 *                                         onMusicListed({ok:true, tracks:[...]}) or
 *                                         onMusicListed({ok:false, reason}).
 *   Android.requestMusicPermission()    — asks for the audio-library permission (JS shows
 *                                         the rationale); the list is retried if granted.
 *   Android.importMusic(uriString)      — copies one MediaStore track into the app cache
 *                                         via the hardened import pipeline; JS gets
 *                                         onAudioPicked({ok:[...], failed:[...]}).
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
 *   onAudioPicked(result)               — result = {ok:["file:///...", ...],
 *                                         failed:[{name, reason:"empty"|"unreadable"|
 *                                         "unsupported"}]}
 *   onMusicListed(result)               — result = {ok:true, tracks:[{title, artist,
 *                                         album, durationMs, size, uri}]} or
 *                                         {ok:false, reason:"permission-denied"|"error"}
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
    private static final int REQ_MUSIC_PERM = 1003;
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
        return "'" + s.replace("\\", "\\\\").replace("'", "\\'")
                .replace("\n", "\\n").replace("\r", "\\r") + "'";
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
    private boolean pendingMusicList = false;

    // Recording state
    private MediaRecorder recorder;
    private File recordingFile;
    private long recordingStartMs;

    private final ActivityResultLauncher<Intent> audioPickerLauncher =
            registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
                if (result.getResultCode() == RESULT_OK && result.getData() != null) {
                    handlePickedAudio(result.getData());
                } else {
                    callJs("if(window.onAudioPicked){window.onAudioPicked({ok:[],failed:[]})}");
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
            // Professional English dialog (Hasnain: clear "Exit" label, no Hindi Yes/No).
            AlertDialog exitDialog = new AlertDialog.Builder(this)
                    .setTitle("Exit RuhMix?")
                    .setMessage("Are you sure you want to exit the app?")
                    .setPositiveButton("Exit", (d, w) -> MainActivity.super.onBackPressed())
                    .setNegativeButton("Cancel", null)
                    .create();
            exitDialog.show();
            exitDialog.getButton(AlertDialog.BUTTON_POSITIVE).setTextColor(0xFFE53935);
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
        return "'" + s.replace("\\", "\\\\").replace("'", "\\'")
                .replace("\n", "\\n").replace("\r", "\\r") + "'";
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
                    .setTitle("अनुमति चाहिए \uD83D\uDE4F")
                    .setMessage("RuhMix आपकी ऑडियो फाइलों तक नहीं पहुंच पाया। " +
                            "Settings > Apps > RuhMix > Permissions में जाकर अनुमति दें, " +
                            "फिर ऑडियो चुन सकेंगे।")
                    .setPositiveButton("सेटिंग्स खोलें", (d, w) -> {
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
                    .setNegativeButton("अभी नहीं", (d, w) -> {
                        pendingAudioAction = null;
                        cancelPendingFileChooser();
                    })
                    .setCancelable(false)
                    .show();
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle("ऑडियो एक्सेस \uD83C\uDFB6")
                .setMessage("ऑडियो चुनने और मिक्स बनाने के लिए RuhMix को " +
                        "आपकी ऑडियो फाइलों तक पहुंच चाहिए।")
                .setPositiveButton("अनुमति दें",
                        (d, w) -> requestPermissions(new String[]{perm}, REQ_AUDIO_PERM))
                .setNegativeButton("अभी नहीं", (d, w) -> {
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
                    .setTitle("अनुमति चाहिए \uD83D\uDE4F")
                    .setMessage("RuhMix आपके माइक्रोफोन तक नहीं पहुंच पाया। " +
                            "Settings > Apps > RuhMix > Permissions में जाकर अनुमति दें, " +
                            "फिर रिकॉर्डिंग कर सकेंगे।")
                    .setPositiveButton("सेटिंग्स खोलें", (d, w) -> {
                        try {
                            Intent i = new Intent(
                                    android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                    Uri.parse("package:" + getPackageName()));
                            startActivity(i);
                        } catch (Exception ignored) {
                        }
                        pendingMicAction = null;
                    })
                    .setNegativeButton("अभी नहीं", (d, w) -> pendingMicAction = null)
                    .setCancelable(false)
                    .show();
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle("माइक्रोफोन एक्सेस \uD83C\uDFA4")
                .setMessage("ऑडियो रिकॉर्ड करने के लिए RuhMix को माइक्रोफोन की अनुमति चाहिए।")
                .setPositiveButton("अनुमति दें",
                        (d, w) -> requestPermissions(new String[]{perm}, REQ_MIC_PERM))
                .setNegativeButton("अभी नहीं", (d, w) -> pendingMicAction = null)
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
                        "अनुमति नहीं मिली \u2014 Settings > Apps > RuhMix में जाकर अनुमति दें \uD83D\uDE4F",
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
                callJs("if(window.onRecordingError){window.onRecordingError('माइक्रोफोन की अनुमति नहीं मिली')}");
                Toast.makeText(this,
                        "अनुमति नहीं मिली \u2014 Settings > Apps > RuhMix में जाकर अनुमति दें \uD83D\uDE4F",
                        Toast.LENGTH_LONG).show();
            }
        } else if (requestCode == REQ_MUSIC_PERM) {
            boolean retry = pendingMusicList;
            pendingMusicList = false;
            if (granted) {
                audioPermDeniedBefore = false;
                if (retry) {
                    try {
                        new Thread(() -> queryMusicLibrary()).start();
                    } catch (Exception e) {
                        sendMusicListError("error");
                    }
                }
            } else {
                audioPermDeniedBefore = true;
                // No dialogs or toasts here by design — JS shows the rationale.
                sendMusicListError("permission-denied");
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
            callJs("if(window.onAudioPicked){window.onAudioPicked({ok:[],failed:[]})}");
        }
    }

    /**
     * Copies every picked URI into the app cache and hands a structured result
     * back to JS: window.onAudioPicked({ok:["file://..."], failed:[{name, reason}]}).
     */
    private void handlePickedAudio(Intent data) {
        new Thread(() -> {
            JSONArray ok = new JSONArray();
            JSONArray failed = new JSONArray();
            try {
                if (data.getClipData() != null) {
                    ClipData clip = data.getClipData();
                    for (int i = 0; i < clip.getItemCount(); i++) {
                        reportImport(copyUriToCache(clip.getItemAt(i).getUri(), i), ok, failed);
                    }
                } else if (data.getData() != null) {
                    reportImport(copyUriToCache(data.getData(), 0), ok, failed);
                }
            } catch (Exception e) {
                // fall through: hand back whatever was copied successfully
            }
            sendImportResult(ok, failed);
        }).start();
    }

    /** Structured outcome of one URI → cache copy. reason is null on success. */
    private static class ImportResult {
        final String name;
        final String path;   // "file://..." on success, null on failure
        final String reason; // null | "empty" | "unreadable" | "unsupported"

        ImportResult(String name, String path, String reason) {
            this.name = name;
            this.path = path;
            this.reason = reason;
        }

        boolean ok() {
            return reason == null;
        }
    }

    private void reportImport(ImportResult r, JSONArray ok, JSONArray failed) {
        if (r == null) return;
        if (r.ok()) {
            ok.put(r.path);
        } else {
            try {
                JSONObject o = new JSONObject();
                o.put("name", r.name);
                o.put("reason", r.reason);
                failed.put(o);
            } catch (Exception ignored) {
            }
        }
    }

    private void sendImportResult(JSONArray ok, JSONArray failed) {
        String payload = jsSafeJson(
                "{\"ok\":" + ok.toString() + ",\"failed\":" + failed.toString() + "}");
        callJs("if(window.onAudioPicked){window.onAudioPicked(" + payload + ")}");
    }

    /** org.json output is valid JS except U+2028/U+2029 inside strings — escape those. */
    private static String jsSafeJson(String json) {
        return json.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
    }

    /**
     * Hardened copy of a content URI into the app cache.
     *
     * Root fixes for the "Decode failed on every song" bug:
     *  - the read loop uses != -1 (read() may legally return 0; "> 0" truncated files),
     *  - verifies the real byte count AND dst.length() (0 bytes -> "empty"),
     *  - magic-byte check for MP3/WAV/M4A/FLAC/OGG/AAC (-> "unsupported"),
     *  - failed copies are deleted and reported with a reason, never silently dropped.
     */
    private ImportResult copyUriToCache(Uri uri, int index) {
        String fallback = "audio_" + index + ".mp3";
        if (uri == null) return new ImportResult(fallback, null, "unreadable");
        String name = queryDisplayName(uri);
        if (name == null || name.trim().isEmpty()) name = fallback;
        name = sanitizeFileName(name);
        try {
            File dir = new File(getCacheDir(), "imports");
            if (!dir.exists() && !dir.mkdirs()) {
                return new ImportResult(name, null, "unreadable");
            }
            File dst = uniqueFile(dir, name);
            ContentResolver cr = getContentResolver();
            long bytes = 0;
            try (InputStream in = cr.openInputStream(uri);
                 OutputStream out = new FileOutputStream(dst)) {
                if (in == null) {
                    dst.delete();
                    return new ImportResult(name, null, "unreadable");
                }
                byte[] buf = new byte[65536];
                int n;
                // NOTE: InputStream.read() may legally return 0 — only -1 means EOF.
                while ((n = in.read(buf)) != -1) {
                    if (n > 0) {
                        out.write(buf, 0, n);
                        bytes += n;
                    }
                }
                out.flush();
            } catch (Exception e) {
                dst.delete();
                return new ImportResult(name, null, "unreadable");
            }
            if (bytes == 0 || dst.length() == 0) {
                dst.delete();
                return new ImportResult(name, null, "empty");
            }
            if (!isSupportedAudio(dst)) {
                dst.delete();
                return new ImportResult(name, null, "unsupported");
            }
            return new ImportResult(name, "file://" + dst.getAbsolutePath(), null);
        } catch (Exception e) {
            return new ImportResult(name, null, "unreadable");
        }
    }

    /** Strips path separators, reserved chars and control chars from a display name. */
    private static String sanitizeFileName(String name) {
        String s = name.replaceAll("[/\\\\:*?\"<>|]", "_")
                .replaceAll("\\p{Cntrl}", "_")
                .trim();
        if (s.isEmpty()) s = "audio.mp3";
        if (s.length() > 120) {
            int dot = s.lastIndexOf('.');
            String ext = (dot > 0 && dot > s.length() - 12) ? s.substring(dot) : "";
            s = s.substring(0, Math.min(120 - ext.length(), s.length())) + ext;
        }
        return s;
    }

    /**
     * Magic-byte sniff: MP3 (ID3 / MPEG frame sync), WAV (RIFF), FLAC (fLaC),
     * M4A/MP4 (ftyp at offset 4), OGG (OggS), AAC-ADTS (frame sync).
     */
    private static boolean isSupportedAudio(File f) {
        try (InputStream in = new FileInputStream(f)) {
            byte[] h = new byte[12];
            int read = 0;
            while (read < h.length) {
                int n = in.read(h, read, h.length - read);
                if (n == -1) break;
                read += n;
            }
            if (read < 4) return false;
            if (h[0] == 'I' && h[1] == 'D' && h[2] == '3') return true;               // MP3 w/ ID3
            if ((h[0] & 0xFF) == 0xFF && (h[1] & 0xE0) == 0xE0) return true;           // MP3/AAC frame sync
            if (h[0] == 'R' && h[1] == 'I' && h[2] == 'F' && h[3] == 'F') return true;  // WAV
            if (h[0] == 'f' && h[1] == 'L' && h[2] == 'a' && h[3] == 'C') return true;   // FLAC
            if (read >= 8 && h[4] == 'f' && h[5] == 't' && h[6] == 'y' && h[7] == 'p')
                return true;                                                          // M4A/MP4
            if (h[0] == 'O' && h[1] == 'g' && h[2] == 'g' && h[3] == 'S') return true;   // OGG
            return false;
        } catch (Exception e) {
            return false;
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

    // ---------- Music library bridge (MediaStore) ----------

    /** Queries MediaStore for on-device music and reports to JS via onMusicListed. */
    private void queryMusicLibrary() {
        try {
            Uri base = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
            String[] projection = {
                    MediaStore.Audio.Media._ID,
                    MediaStore.Audio.Media.TITLE,
                    MediaStore.Audio.Media.ARTIST,
                    MediaStore.Audio.Media.ALBUM,
                    MediaStore.Audio.Media.DURATION,
                    MediaStore.Audio.Media.SIZE
            };
            JSONArray tracks = new JSONArray();
            try (Cursor c = getContentResolver().query(
                    base, projection,
                    MediaStore.Audio.Media.IS_MUSIC + " != 0",
                    null,
                    MediaStore.Audio.Media.TITLE + " ASC")) {
                if (c == null) {
                    sendMusicListError("error");
                    return;
                }
                int idCol = c.getColumnIndex(MediaStore.Audio.Media._ID);
                int titleCol = c.getColumnIndex(MediaStore.Audio.Media.TITLE);
                int artistCol = c.getColumnIndex(MediaStore.Audio.Media.ARTIST);
                int albumCol = c.getColumnIndex(MediaStore.Audio.Media.ALBUM);
                int durCol = c.getColumnIndex(MediaStore.Audio.Media.DURATION);
                int sizeCol = c.getColumnIndex(MediaStore.Audio.Media.SIZE);
                int count = 0;
                while (c.moveToNext() && count < 2000) {
                    try {
                        JSONObject t = new JSONObject();
                        t.put("title", colStr(c, titleCol));
                        t.put("artist", colStr(c, artistCol));
                        t.put("album", colStr(c, albumCol));
                        t.put("durationMs", durCol >= 0 ? c.getLong(durCol) : 0);
                        t.put("size", sizeCol >= 0 ? c.getLong(sizeCol) : 0);
                        t.put("uri", ContentUris
                                .withAppendedId(base, c.getLong(idCol)).toString());
                        tracks.put(t);
                        count++;
                    } catch (Exception ignored) {
                        // Skip a bad row, keep the rest.
                    }
                }
            }
            String payload = jsSafeJson("{\"ok\":true,\"tracks\":" + tracks.toString() + "}");
            callJs("if(window.onMusicListed){window.onMusicListed(" + payload + ")}");
        } catch (SecurityException se) {
            sendMusicListError("permission-denied");
        } catch (Exception e) {
            sendMusicListError("error");
        }
    }

    private static String colStr(Cursor c, int col) {
        try {
            if (col < 0) return "";
            String v = c.getString(col);
            return v == null ? "" : v;
        } catch (Exception e) {
            return "";
        }
    }

    private void sendMusicListError(String reason) {
        callJs("if(window.onMusicListed){window.onMusicListed({\"ok\":false,\"reason\":"
                + jsString(reason) + "})}");
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
                Toast.makeText(this, "फ़ाइल नहीं मिली \uD83D\uDE1E", Toast.LENGTH_LONG).show();
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
            Toast.makeText(this, "शेयर नहीं हो पाया \uD83D\uDE1E", Toast.LENGTH_LONG).show();
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
         * Lists up to 2000 on-device music tracks (MediaStore) on a background thread.
         * If the audio-library permission is missing it is requested; the list is
         * retried after the grant, or onMusicListed({ok:false, reason:"permission-denied"})
         * is delivered. No rationale UI here — JS shows that.
         */
        @JavascriptInterface
        public void listMusic() {
            try {
                if (hasAudioReadPermission()) {
                    new Thread(() -> queryMusicLibrary()).start();
                } else {
                    pendingMusicList = true;
                    runOnUiThread(() -> {
                        try {
                            requestPermissions(new String[]{audioPermission()}, REQ_MUSIC_PERM);
                        } catch (Exception e) {
                            pendingMusicList = false;
                            sendMusicListError("error");
                        }
                    });
                }
            } catch (Exception e) {
                sendMusicListError("error");
            }
        }

        /**
         * Asks for the audio-library permission on demand (JS shows the rationale).
         * If already granted, the music list is returned right away.
         */
        @JavascriptInterface
        public void requestMusicPermission() {
            runOnUiThread(() -> {
                try {
                    if (hasAudioReadPermission()) {
                        new Thread(() -> queryMusicLibrary()).start();
                    } else {
                        pendingMusicList = true;
                        requestPermissions(new String[]{audioPermission()}, REQ_MUSIC_PERM);
                    }
                } catch (Exception e) {
                    pendingMusicList = false;
                    sendMusicListError("error");
                }
            });
        }

        /**
         * Copies one MediaStore track (content:// URI string) into the app cache
         * using the hardened import pipeline; JS gets
         * onAudioPicked({ok:["file://..."], failed:[]}).
         */
        @JavascriptInterface
        public void importMusic(final String uriString) {
            new Thread(() -> {
                JSONArray ok = new JSONArray();
                JSONArray failed = new JSONArray();
                try {
                    Uri uri = (uriString == null || uriString.isEmpty())
                            ? null : Uri.parse(uriString);
                    reportImport(
                            copyUriToCache(uri, (int) (System.currentTimeMillis() % 100000)),
                            ok, failed);
                } catch (Exception e) {
                    try {
                        JSONObject o = new JSONObject();
                        o.put("name", "unknown");
                        o.put("reason", "unreadable");
                        failed.put(o);
                    } catch (Exception ignored) {
                    }
                }
                sendImportResult(ok, failed);
            }).start();
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
