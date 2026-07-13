# Handsfree Project Notes

## APK Build Process

The Android APK bundles a copy of `public/index.html` inside the app at build time. Changes to the HTML require rebuilding the APK:

```bash
cp public/index.html android/app/src/main/assets/public/index.html
cd android && ./gradlew assembleDebug
cp android/app/build/outputs/apk/debug/app-debug.apk public/handsfree.apk
```

Simply restarting the server is NOT enough for HTML changes to take effect in the app.
