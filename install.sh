#!/bin/sh
# Installs Shigoto no Mori on a Linux machine: the latest release's
# Linux build, its host run by the user's systemd, and its terminal
# command. Run again, it installs the latest over what is there.
#
#   curl -fsSL https://raw.githubusercontent.com/sylophi/shigoto-no-mori/main/install.sh | sh
#
# With a release's tarball as its argument it installs that one
# instead. The layout is packages/engine/src/linuxInstall.ts's: each
# version in a folder under versions/, `current` linking the one that
# runs, and the command linked to current's.
set -eu

repo=sylophi/shigoto-no-mori

fail() {
  echo "install.sh: $1" >&2
  exit 1
}

[ "$(uname -s)" = Linux ] || fail "this installs the Linux build. On a Mac, download the app."
[ "$(uname -m)" = x86_64 ] || fail "there is a build for x86_64 alone."
for tool in curl tar sha256sum systemctl; do
  command -v "$tool" >/dev/null 2>&1 || fail "it needs $tool."
done

work=$(mktemp -d)
incoming=
trap 'rm -rf "$work" ${incoming:+"$incoming"}' EXIT
trap 'exit 1' HUP INT TERM

if [ $# -gt 0 ]; then
  tarball=$1
  [ -f "$tarball" ] || fail "no file at $tarball."
else
  # The latest release's Linux asset, and the digest GitHub keeps of it.
  # The API pretty-prints, an asset's digest before its URL.
  release=$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest") ||
    fail "couldn't read the latest release."
  found=$(printf '%s\n' "$release" | awk -F'"' '
    $2 == "digest" { digest = $4 }
    $2 == "browser_download_url" && $4 ~ /-linux-x64-[^\/]*\.tar\.gz$/ { print $4, digest; exit }
  ')
  [ -n "$found" ] || fail "the latest release has no Linux build yet."
  url=${found% *}
  digest=${found#* }
  case $digest in
    sha256:*) ;;
    *) fail "the latest release names no digest for its Linux build." ;;
  esac
  tarball=$work/${url##*/}
  echo "Downloading ${url##*/}"
  curl -fL --progress-bar -o "$tarball" "$url" || fail "the download failed."
  echo "${digest#sha256:}  $tarball" | sha256sum -c --status - ||
    fail "the download doesn't match the release's digest."
fi

# <configDir>-linux-x64-<version>.tar.gz, holding one folder of that name.
name=$(basename "$tarball" .tar.gz)
config_dir=${name%%-linux-x64-*}
version=${name#*-linux-x64-}
[ "$config_dir" != "$name" ] && [ -n "$version" ] ||
  fail "$(basename "$tarball") isn't a release's Linux build."
# Prod's command is sm, a test flavor's sm<word>; the spelled-out one
# beside it is named as the folders are.
binary=sm${config_dir#shigomori}
binary=$(printf '%s' "$binary" | tr -d -)

root=${XDG_DATA_HOME:-$HOME/.local/share}/$config_dir
bin=${XDG_BIN_HOME:-$HOME/.local/bin}
mkdir -p "$root/versions" "$bin"

# Unpacked beside versions/, where the updater's pruning doesn't look,
# and moved in whole. A version names one build, so one already there
# is kept.
if [ ! -d "$root/versions/$version" ]; then
  incoming=$root/.incoming-$$
  mkdir "$incoming"
  tar -xzf "$tarball" -C "$incoming" || fail "couldn't unpack $(basename "$tarball")."
  [ -x "$incoming/$name/$binary" ] || fail "$(basename "$tarball") holds no $binary."
  mv "$incoming/$name" "$root/versions/$version"
fi

ln -sfn "versions/$version" "$root/current.new"
mv -T "$root/current.new" "$root/current"

for command in "$binary" "$config_dir"; do
  if [ -e "$bin/$command" ] && [ ! -L "$bin/$command" ]; then
    echo "Left $bin/$command alone: it isn't a link this installed." >&2
    continue
  fi
  ln -sfn "$root/current/$binary" "$bin/$command"
done

"$root/current/$binary" service install

echo "Installed $version: $bin/$binary"
case ":$PATH:" in
  *":$bin:"*) ;;
  *) echo "$bin isn't on your PATH yet: add it in your shell's profile." ;;
esac
