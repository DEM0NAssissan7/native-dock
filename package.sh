#!/bin/bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

gnome-extensions pack --force .

cp -f "native-dock@mawi.ink.shell-extension.zip" "native-dock@mawi.ink.zip"

echo "Package ready for upload to https://extensions.gnome.org/upload/:"
echo " - native-dock@mawi.ink.shell-extension.zip"
echo " - native-dock@mawi.ink.zip"
