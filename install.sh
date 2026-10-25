#!/bin/sh
# Install `fb`: prebuilt binary from the latest GitHub release, else build from source with cargo.
# Usage: curl -fsSL https://raw.githubusercontent.com/hieu-lee/facebook-cli/main/install.sh | sh
set -eu

REPO="hieu-lee/facebook-cli"
BIN_DIR="${FB_BIN_DIR:-$HOME/.local/bin}"

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$arch" in x86_64|amd64) arch=x86_64 ;; aarch64|arm64) arch=aarch64 ;; esac
asset="fb-$arch-$os.tar.gz"

mkdir -p "$BIN_DIR"
# a running daemon keeps executing the old binary: stop it (it restarts on the next command)
[ -x "$BIN_DIR/fb" ] && "$BIN_DIR/fb" stop >/dev/null 2>&1 || true
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

installed=""
if command -v curl >/dev/null 2>&1; then
  url="https://github.com/$REPO/releases/latest/download/$asset"
  # the binary must also run here (libc etc.), otherwise fall through to a source build
  if curl -fsSL "$url" -o "$tmp/fb.tar.gz" 2>/dev/null && tar -xzf "$tmp/fb.tar.gz" -C "$tmp" 2>/dev/null && [ -f "$tmp/fb" ] && "$tmp/fb" help >/dev/null 2>&1; then
    install -m 755 "$tmp/fb" "$BIN_DIR/fb"
    installed="prebuilt binary"
  fi
fi

if [ -z "$installed" ]; then
  if ! command -v cargo >/dev/null 2>&1; then
    echo "fb: no prebuilt binary for $arch-$os and no Rust toolchain found." >&2
    echo "    install Rust first:  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal" >&2
    echo "    then run this installer again." >&2
    exit 1
  fi
  cargo install --locked --git "https://github.com/$REPO" --root "$tmp/cargo" fb
  install -m 755 "$tmp/cargo/bin/fb" "$BIN_DIR/fb"
  installed="built from source"
fi

echo "fb installed to $BIN_DIR/fb ($installed)"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "add to PATH:  export PATH=\"$BIN_DIR:\$PATH\"" ;; esac
echo "next: fb login    (reuses the Facebook session of your normal Chrome; one Allow click)"
