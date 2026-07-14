# Handsfree Project Notes

## APK Build Process

The Android APK bundles a copy of `public/index.html` inside the app at build time. Changes to the HTML require rebuilding the APK.

**Use the build script:**

```bash
./build-apk.sh
```

This script:
1. Gets the current git SHA and embeds it in public/index.html as APP_VERSION
2. Copies index.html to the Android assets
3. Builds the APK
4. Copies it to public/handsfree.apk

The server also reads the git SHA at startup. When the app connects, if its embedded SHA differs from the server's current SHA, it prompts the user to update.

**Important:** Commit your changes before running the build script. The APK embeds the current git SHA, so if you build before committing, the APK will have the old SHA and won't trigger updates.

Simply restarting the server is NOT enough for HTML changes to take effect in the app.
