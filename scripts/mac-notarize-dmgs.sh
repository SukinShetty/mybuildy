#!/usr/bin/env bash
# mac-notarize-dmgs.sh — run on macOS CI after `electron-builder --mac dmg`.
# electron-builder has already signed each MyBuildy.app with the Developer ID
# certificate (hardened runtime) and notarized + stapled it. This script:
#   1. checks every packaged .app: Developer ID signature, hardened runtime,
#      Gatekeeper accepts it as notarized, stapled ticket validates — and the
#      same for Buildy's voice engine (native files) inside it, plus its model;
#   2. notarizes each DMG with notarytool (waits for Apple's verdict and prints
#      the log), staples the ticket to it and validates the staple;
#   3. checks Gatekeeper accepts each DMG.
# Any failure stops the job. Needs APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and
# APPLE_TEAM_ID in the environment (repository secrets); never prints them.
set -euo pipefail

: "${APPLE_ID:?APPLE_ID secret is missing}"
: "${APPLE_APP_SPECIFIC_PASSWORD:?APPLE_APP_SPECIFIC_PASSWORD secret is missing}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID secret is missing}"

shopt -s nullglob
apps=(dist/mac*/MyBuildy.app)
dmgs=(dist/MyBuildy-*.dmg)
[ ${#apps[@]} -gt 0 ] || { echo "no packaged MyBuildy.app found"; exit 1; }
[ ${#dmgs[@]} -gt 0 ] || { echo "no MyBuildy DMG found"; exit 1; }

for app in "${apps[@]}"; do
  echo "== app: $app"
  codesign --verify --deep --strict --verbose=2 "$app"
  details=$(codesign -dvv "$app" 2>&1)
  echo "$details" | grep -E 'Authority=Developer ID Application|TeamIdentifier|flags='
  echo "$details" | grep -q "Authority=Developer ID Application" || { echo "not signed with a Developer ID"; exit 1; }
  echo "$details" | grep -q "TeamIdentifier=${APPLE_TEAM_ID}" || { echo "wrong team"; exit 1; }
  echo "$details" | grep -Eq 'flags=.*runtime' || { echo "hardened runtime is off"; exit 1; }
  spctl --assess --type execute --verbose=4 "$app"
  xcrun stapler validate "$app"

  # Buildy's voice: the native engine inside the app is signed like the app
  # (Developer ID, our team, hardened runtime) and built for this app's chip,
  # and the model ships inside the app.
  engine="$app/Contents/Resources/app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v3/darwin"
  app_arch=$(lipo -archs "$app/Contents/MacOS/MyBuildy")
  natives=("$engine"/*/*.node "$engine"/*/*.dylib)
  [ ${#natives[@]} -gt 0 ] || { echo "voice engine missing from $app"; exit 1; }
  for bin in "${natives[@]}"; do
    echo "-- voice engine: ${bin#$app/}"
    codesign --verify --strict --verbose=2 "$bin"
    bin_details=$(codesign -dvv "$bin" 2>&1)
    echo "$bin_details" | grep -E 'Authority=Developer ID Application|TeamIdentifier|flags='
    echo "$bin_details" | grep -q "Authority=Developer ID Application" || { echo "voice engine not signed with a Developer ID"; exit 1; }
    echo "$bin_details" | grep -q "TeamIdentifier=${APPLE_TEAM_ID}" || { echo "voice engine: wrong team"; exit 1; }
    echo "$bin_details" | grep -Eq 'flags=.*runtime' || { echo "voice engine: hardened runtime is off"; exit 1; }
    [ "$(lipo -archs "$bin")" = "$app_arch" ] || { echo "voice engine is $(lipo -archs "$bin"), app is $app_arch"; exit 1; }
  done
  model="$app/Contents/Resources/kokoro/onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model_fp16.onnx"
  [ -f "$model" ] || { echo "Buildy's voice model is missing from $app"; exit 1; }
  echo "voice model: $(du -h "$model" | cut -f1) inside the app"
done

for dmg in "${dmgs[@]}"; do
  echo "== dmg: $dmg"
  codesign --verify --verbose=2 "$dmg"
  out=$(xcrun notarytool submit "$dmg" \
    --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID" \
    --wait --timeout 30m --output-format json)
  echo "$out"
  id=$(echo "$out" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
  status=$(echo "$out" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
  xcrun notarytool log "$id" \
    --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID" || true
  [ "$status" = "Accepted" ] || { echo "notarization of $dmg: $status"; exit 1; }
  echo "notarization of $dmg: Accepted"
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
  spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg"
done

echo "All apps and DMGs are signed, notarized and stapled."
