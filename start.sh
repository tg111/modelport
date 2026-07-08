#!/usr/bin/env sh
set -eu

echo "Starting ModelPort..."

NODE_VERSION="${NODE_VERSION:-v20.11.1}"
LOCAL_NODE_ROOT=".local-node"
NODE_BIN=""
NPM_BIN=""

node_major() {
  "$1" -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0
}

find_system_node() {
  if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
    NPM_BIN="$(command -v npm || true)"
  fi
}

install_local_node() {
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin) platform="darwin" ;;
    Linux) platform="linux" ;;
    *)
      echo "Unsupported OS for automatic Node.js install: $os"
      echo "Please install Node.js 20 or later manually: https://nodejs.org/"
      exit 1
      ;;
  esac

  case "$arch" in
    x86_64|amd64) node_arch="x64" ;;
    arm64|aarch64) node_arch="arm64" ;;
    *)
      echo "Unsupported CPU architecture for automatic Node.js install: $arch"
      echo "Please install Node.js 20 or later manually: https://nodejs.org/"
      exit 1
      ;;
  esac

  dist_name="node-$NODE_VERSION-$platform-$node_arch"
  dist_dir="$LOCAL_NODE_ROOT/$dist_name"
  archive="$LOCAL_NODE_ROOT/$dist_name.tar.xz"
  url="https://nodejs.org/dist/$NODE_VERSION/$dist_name.tar.xz"

  if [ ! -x "$dist_dir/bin/node" ]; then
    mkdir -p "$LOCAL_NODE_ROOT"
    echo "Installing local Node.js $NODE_VERSION into ./$LOCAL_NODE_ROOT ..."
    if command -v curl >/dev/null 2>&1; then
      curl -fL "$url" -o "$archive"
    elif command -v wget >/dev/null 2>&1; then
      wget -O "$archive" "$url"
    else
      echo "curl or wget is required to download Node.js automatically."
      exit 1
    fi
    tar -xJf "$archive" -C "$LOCAL_NODE_ROOT"
    rm -f "$archive"
  fi

  NODE_BIN="$dist_dir/bin/node"
  NPM_BIN="$dist_dir/bin/npm"
}

find_system_node
if [ -z "$NODE_BIN" ] || [ "$(node_major "$NODE_BIN")" -lt 20 ] || [ -z "$NPM_BIN" ]; then
  if [ -n "$NODE_BIN" ]; then
    echo "System Node.js is missing npm or is older than 20: $("$NODE_BIN" -v 2>/dev/null || echo unknown)"
  else
    echo "Node.js was not found in PATH."
  fi
  install_local_node
fi

echo "Using Node.js: $("$NODE_BIN" -v) ($NODE_BIN)"

mkdir -p data

if [ ! -f .env ]; then
  echo ""
  echo ".env was not found. Defaults will be used. Copy .env.example to .env to customize."
  echo ""
fi

echo ""
echo "ModelPort is starting."
echo "Config file: ./.env"
echo ""
echo "Press Ctrl+C to stop."
echo ""

"$NPM_BIN" start
