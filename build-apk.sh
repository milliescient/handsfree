#!/bin/bash
# Build the Android APK and restart server to ensure version sync

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
cd ..

echo ""
echo "Built handsfree.apk version $GIT_SHA"

# Restart server so it picks up the same git SHA
echo "Restarting server..."
# Kill both the supervisor (run.sh) and the node server to avoid duplicates
pkill -f "run.sh" 2>/dev/null || true
pkill -f "node.*server.js" 2>/dev/null || true
sleep 2
# Start fresh with supervisor
nohup ./run.sh >> /dev/null 2>&1 &
sleep 2

echo "Server restarted with version $GIT_SHA"
echo "APK available at: public/handsfree.apk"
