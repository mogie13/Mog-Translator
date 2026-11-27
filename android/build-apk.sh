#!/usr/bin/env bash
# Build the Rally Lens APK from the terminal (macOS / Linux).
# Needs: JDK 17+ and the Android SDK command-line tools (see README.md).
set -e
cd "$(dirname "$0")"

command -v java >/dev/null || { echo "Java not found. Install JDK 17 (e.g. 'brew install openjdk@17' or 'sudo apt install openjdk-17-jdk')."; exit 1; }
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
[ -d "$SDK" ] || { echo "Android SDK not found at $SDK. Set ANDROID_HOME (see README.md)."; exit 1; }
echo "sdk.dir=$SDK" > local.properties

# install the pieces this project needs (first run only)
SDKM="$SDK/cmdline-tools/latest/bin/sdkmanager"
if [ -x "$SDKM" ]; then
  yes | "$SDKM" --licenses >/dev/null || true
  "$SDKM" "platforms;android-35" "build-tools;35.0.0" "platform-tools" >/dev/null
fi

chmod +x gradlew
./gradlew assembleDebug

APK=app/build/outputs/apk/debug/app-debug.apk
echo; echo "Built: $(pwd)/$APK"
if [ "$1" = "--install" ]; then "$SDK/platform-tools/adb" install -r "$APK"; fi
