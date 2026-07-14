package com.minima.handsfree;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import com.getcapacitor.BridgeActivity;
import android.os.Handler;
import android.os.Looper;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.URL;
import java.security.cert.X509Certificate;
import java.util.Locale;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

public class MainActivity extends BridgeActivity implements TextToSpeech.OnInitListener {

    private static final int MIC_PERMISSION_REQUEST = 1001;
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private WebView webView;
    private Handler handler = new Handler(Looper.getMainLooper());
    private boolean bridgeInjected = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Initialize TTS
        tts = new TextToSpeech(this, this);

        // Request microphone permission at startup
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this,
                    new String[]{Manifest.permission.RECORD_AUDIO},
                    MIC_PERMISSION_REQUEST);
        }

        // Keep trying to inject the bridge until it succeeds
        tryInjectBridge();
    }

    private void tryInjectBridge() {
        if (bridgeInjected) return;

        try {
            if (getBridge() != null && getBridge().getWebView() != null) {
                webView = getBridge().getWebView();
                webView.addJavascriptInterface(new AudioBridgeInterface(), "AudioBridge");
                bridgeInjected = true;
                android.util.Log.d("Handsfree", "AudioBridge injected successfully");

                // Allow self-signed certificates for local development
                webView.setWebViewClient(new WebViewClient() {
                    @Override
                    public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                        handler.proceed();
                    }
                });

                // Handle WebView permission requests (for getUserMedia)
                webView.setWebChromeClient(new WebChromeClient() {
                    @Override
                    public void onPermissionRequest(final PermissionRequest request) {
                        runOnUiThread(() -> request.grant(request.getResources()));
                    }
                });
            } else {
                // Retry in 100ms
                android.util.Log.d("Handsfree", "Bridge not ready, retrying...");
                handler.postDelayed(this::tryInjectBridge, 100);
            }
        } catch (Exception e) {
            android.util.Log.e("Handsfree", "Error injecting bridge", e);
            handler.postDelayed(this::tryInjectBridge, 100);
        }
    }

    @Override
    public void onInit(int status) {
        if (status == TextToSpeech.SUCCESS) {
            tts.setLanguage(Locale.US);
            tts.setSpeechRate(1.05f);
            ttsReady = true;

            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override
                public void onStart(String utteranceId) {}

                @Override
                public void onDone(String utteranceId) {
                    if (webView != null) {
                        runOnUiThread(() -> webView.evaluateJavascript("window.onNativeTTSDone && window.onNativeTTSDone()", null));
                    }
                }

                @Override
                public void onError(String utteranceId) {
                    if (webView != null) {
                        runOnUiThread(() -> webView.evaluateJavascript("window.onNativeTTSDone && window.onNativeTTSDone()", null));
                    }
                }
            });
        }
    }

    @Override
    public void onDestroy() {
        if (tts != null) {
            tts.stop();
            tts.shutdown();
        }
        super.onDestroy();
    }

    // Separate class for the JavaScript interface (more stable than anonymous class)
    private class AudioBridgeInterface {
        @JavascriptInterface
        public void startAudioService() {
            Intent intent = new Intent(MainActivity.this, AudioService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent);
            } else {
                startService(intent);
            }
        }

        @JavascriptInterface
        public void stopAudioService() {
            Intent intent = new Intent(MainActivity.this, AudioService.class);
            stopService(intent);
        }

        @JavascriptInterface
        public void speak(String text) {
            if (ttsReady && tts != null) {
                Bundle params = new Bundle();
                tts.speak(text, TextToSpeech.QUEUE_ADD, params, "utterance_" + System.currentTimeMillis());
            }
        }

        @JavascriptInterface
        public void stopSpeaking() {
            if (tts != null) {
                tts.stop();
            }
        }

        @JavascriptInterface
        public boolean isTTSReady() {
            return ttsReady;
        }

        @JavascriptInterface
        public void installUpdate(String apkUrl) {
            new Thread(() -> {
                try {
                    android.util.Log.d("Handsfree", "Downloading APK from: " + apkUrl);

                    // Trust all certificates (for self-signed dev server)
                    TrustManager[] trustAllCerts = new TrustManager[] {
                        new X509TrustManager() {
                            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                            public void checkClientTrusted(X509Certificate[] certs, String authType) {}
                            public void checkServerTrusted(X509Certificate[] certs, String authType) {}
                        }
                    };
                    SSLContext sc = SSLContext.getInstance("TLS");
                    sc.init(null, trustAllCerts, new java.security.SecureRandom());

                    URL url = new URL(apkUrl);
                    HttpsURLConnection conn = (HttpsURLConnection) url.openConnection();
                    conn.setSSLSocketFactory(sc.getSocketFactory());
                    conn.setHostnameVerifier((hostname, session) -> true);
                    conn.connect();

                    // Save to app's files directory
                    File updateDir = new File(getFilesDir(), "updates");
                    updateDir.mkdirs();
                    File apkFile = new File(updateDir, "update.apk");

                    InputStream input = conn.getInputStream();
                    FileOutputStream output = new FileOutputStream(apkFile);
                    byte[] buffer = new byte[4096];
                    int bytesRead;
                    while ((bytesRead = input.read(buffer)) != -1) {
                        output.write(buffer, 0, bytesRead);
                    }
                    output.close();
                    input.close();
                    conn.disconnect();

                    android.util.Log.d("Handsfree", "APK downloaded, starting install");

                    // Install the APK
                    runOnUiThread(() -> {
                        Uri apkUri = FileProvider.getUriForFile(MainActivity.this,
                            getPackageName() + ".fileprovider", apkFile);
                        Intent intent = new Intent(Intent.ACTION_VIEW);
                        intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
                        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        startActivity(intent);
                    });
                } catch (Exception e) {
                    android.util.Log.e("Handsfree", "Failed to install update", e);
                    // Notify JS of failure
                    if (webView != null) {
                        runOnUiThread(() -> webView.evaluateJavascript(
                            "window.onUpdateError && window.onUpdateError('" + e.getMessage().replace("'", "\\'") + "')", null));
                    }
                }
            }).start();
        }
    }
}
