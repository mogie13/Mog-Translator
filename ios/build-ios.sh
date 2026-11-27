#!/usr/bin/env bash
# Build the Mog Translator iOS app (macOS only; needs Xcode 15+).
#   ./build-ios.sh            generate the Xcode project and build for the Simulator
#   ./build-ios.sh --open     generate the project and open it in Xcode (to run on your iPhone)
set -e
cd "$(dirname "$0")"

[ "$(uname)" = "Darwin" ] || { echo "iOS apps can only be built on a Mac with Xcode."; exit 1; }
command -v xcodebuild >/dev/null || { echo "Xcode not found. Install it from the App Store, then run: sudo xcode-select -s /Applications/Xcode.app"; exit 1; }
command -v xcodegen >/dev/null || { echo "Installing XcodeGen..."; brew install xcodegen; }

xcodegen generate
if [ "$1" = "--open" ]; then open MogTranslator.xcodeproj; exit 0; fi

xcodebuild -project MogTranslator.xcodeproj -scheme MogTranslator -configuration Debug \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO build | tail -20
echo; echo "Built: $(pwd)/build/Build/Products/Debug-iphonesimulator/Mog Translator.app"
