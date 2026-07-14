#!/bin/bash
# Build the Android APK using git SHA for version tracking

set -e
cd "$(dirname "$0")"

# Get current git SHA (short form)
GIT_SHA=$(git rev-parse --short HEAD)

echo "Building APK for commit $GIT_SHA"

# Update version in index.html (this gets bundled in the APK)
sed -i "s/const APP_VERSION = '[^']*';/const APP_VERSION = '$GIT_SHA';/" public/index.html

# Copy HTML to Android assets
cp public/index.html android/app/src/main/assets/public/index.html

# Build the APK
cd android
./gradlew assembleDebug

# Copy APK to public folder
cp app/build/outputs/apk/debug/app-debug.apk ../public/handsfree.apk

echo ""
echo "Built handsfree.apk version $NEW_VERSION"
echo "APK available at: public/handsfree.apk"
