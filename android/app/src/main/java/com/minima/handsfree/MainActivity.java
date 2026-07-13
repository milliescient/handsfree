package com.minima.handsfree;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
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
import com.getcapacitor.BridgeActivity;
import android.os.Handler;
import android.os.Looper;
import java.util.Locale;

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
    }
}
