#!/bin/bash
set -eu
cd "$(dirname "$0")/.."
ipad_device="${1:-00008120-001C554628214032}"
canvas_address="${2:-}"
pnpm build:ipad
xcodebuild -project ipad/Canvas.xcodeproj -scheme Canvas -configuration Debug \
  -destination "id=$ipad_device" -derivedDataPath ipad/build \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration build
xcrun devicectl device install app --device "$ipad_device" ipad/build/Build/Products/Debug-iphoneos/Canvas.app
if [ "${3:-}" = "--install-only" ] || [ "$canvas_address" = "--install-only" ]; then exit 0; fi
if [ -n "$canvas_address" ]; then
  xcrun devicectl device process launch --device "$ipad_device" --terminate-existing \
    in.texoport.tldrawipad --canvas-url "$canvas_address"
else
  xcrun devicectl device process launch --device "$ipad_device" --terminate-existing in.texoport.tldrawipad
fi
