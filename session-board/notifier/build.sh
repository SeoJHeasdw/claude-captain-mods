#!/bin/zsh
# Builds the two banner apps the board raises its notifications through, one per icon and sound:
#   Done.app  "Claude 완료"  icons/done.png  sounds/done.wav  a session finished
#   Call.app  "Claude 호출"  icons/call.png  sounds/call.wav  a session waits on an answer or an approval
# To change an icon, replace its PNG (1024x1024, transparent margin) and run this again; to
# change a sound, replace its WAV (or edit and run sounds/make_sounds.py) and run this again.
# Without a WAV the app's banners are quiet.
set -euo pipefail

HERE=${0:A:h}
OUT=$HOME/.claude/session-board/notifier
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
# A new version each build, so the system takes up a changed icon.
VERSION=$(date +%Y%m%d%H%M%S)

swiftc -O -swift-version 5 -target arm64-apple-macos13 "$HERE/Notifier.swift" -o "$WORK/Notifier"

build() {
  local file=$1 name=$2 id=$3 icon=$4 sound=$5
  local app=$OUT/$file.app
  local iconset=$WORK/$file.iconset

  mkdir -p "$iconset"
  for size in 16 32 128 256 512; do
    sips -z $size $size "$icon" --out "$iconset/icon_${size}x${size}.png" >/dev/null
    sips -z $((size * 2)) $((size * 2)) "$icon" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
  done

  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  cp "$WORK/Notifier" "$app/Contents/MacOS/Notifier"
  iconutil -c icns "$iconset" -o "$app/Contents/Resources/AppIcon.icns"
  # The system finds a banner's sound by name among ~/Library/Sounds, not in the app (the
  # bundle's copy only names it), and remembers a name it once failed to find: so each sound
  # is named after its contents, and a changed sound is a name never looked up before.
  if [[ -f $sound ]]; then
    local tone=session-board-${sound:t:r}-$(md5 -q "$sound" | cut -c1-8).wav
    mkdir -p "$HOME/Library/Sounds"
    rm -f -- "$HOME/Library/Sounds/"session-board-${sound:t:r}*.wav(N)
    cp "$sound" "$HOME/Library/Sounds/$tone"
    cp "$sound" "$app/Contents/Resources/$tone"
  fi
  cat >"$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$id</string>
  <key>CFBundleName</key><string>$name</string>
  <key>CFBundleDisplayName</key><string>$name</string>
  <key>CFBundleExecutable</key><string>Notifier</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
  codesign --force --sign - "$app" >/dev/null
  "$LSREGISTER" -f "$app"
  echo "built $app"
}

mkdir -p "$OUT"
build Done 'Claude 완료' local.session-board.done "$HERE/icons/done.png" "$HERE/sounds/done.wav"
build Call 'Claude 호출' local.session-board.call "$HERE/icons/call.png" "$HERE/sounds/call.wav"
