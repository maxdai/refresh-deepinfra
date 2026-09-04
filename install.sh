#!/usr/bin/env bash
# install.sh — install /refresh-deepinfra into pi's user extension directory.
#
# Usage:
#   ./install.sh              # symlink this repo into ~/.pi/agent/extensions/refresh-deepinfra
#   ./install.sh --copy       # copy instead of symlink (no live updates from the repo)
#   ./install.sh --force      # replace an existing symlink that points elsewhere
#   ./install.sh --uninstall  # remove the installed extension
#
# The pi agent directory is $PI_CODING_AGENT_DIR if set, else ~/.pi/agent.
# After installing, run /reload (or restart pi) to pick up /refresh-deepinfra.

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
TARGET="$AGENT_DIR/extensions/refresh-deepinfra"

MODE="symlink"   # symlink | copy
FORCE=0
UNINSTALL=0

for arg in "$@"; do
  case "$arg" in
    --copy)      MODE="copy" ;;
    --force)     FORCE=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help)
      sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown option: $arg (see --help)" >&2
      exit 1
      ;;
  esac
done

# --- sanity checks -----------------------------------------------------------

if ! command -v node >/dev/null 2>&1; then
  echo "error: node not found in PATH (pi extensions need node >= 18)" >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "error: node >= 18 required (fetch API), found $(node --version)" >&2
  exit 1
fi

if [ ! -f "$SRC/index.ts" ] || [ ! -f "$SRC/jsonc/main.js" ]; then
  echo "error: $SRC does not look like the refresh-deepinfra repo (missing index.ts / jsonc/main.js)" >&2
  exit 1
fi

# --- uninstall ---------------------------------------------------------------

if [ "$UNINSTALL" -eq 1 ]; then
  if [ -L "$TARGET" ]; then
    rm "$TARGET"
    echo "removed symlink $TARGET"
    exit 0
  fi
  if [ -d "$TARGET" ]; then
    if [ "$FORCE" -eq 1 ]; then
      rm -rf "$TARGET"
      echo "removed directory $TARGET (--force)"
      exit 0
    fi
    echo "error: $TARGET is a real directory; re-run with --force to delete it" >&2
    exit 1
  fi
  echo "not installed ($TARGET not found)"
  exit 0
fi

# --- install -----------------------------------------------------------------

mkdir -p "$AGENT_DIR/extensions"

if [ -L "$TARGET" ]; then
  CURRENT="$(readlink "$TARGET" || true)"   # 裸 readlink:悬空软链(目标不存在)也能取到值
  if [ "$CURRENT" = "$SRC" ]; then
    echo "already installed: $TARGET -> $SRC"
    exit 0
  fi
  if [ "$FORCE" -eq 1 ]; then
    rm "$TARGET"
    echo "replaced symlink (was -> $CURRENT)"
  else
    echo "error: $TARGET is a symlink to $CURRENT (not this repo); use --force to replace" >&2
    exit 1
  fi
elif [ -d "$TARGET" ]; then
  BACKUP="${TARGET}.bak-$(date +%Y%m%d-%H%M%S)"
  mv "$TARGET" "$BACKUP"
  echo "moved existing directory to $BACKUP"
fi

if [ "$MODE" = "copy" ]; then
  mkdir -p "$TARGET"
  cp -R "$SRC/index.ts" "$SRC/jsonc" "$TARGET/"
  echo "copied extension files -> $TARGET"
else
  ln -s "$SRC" "$TARGET"
  echo "symlinked $TARGET -> $SRC"
fi

# --- smoke test --------------------------------------------------------------

if ! node -e "
  const { parseTree, findNodeAtLocation, getNodeValue } = require('$TARGET/jsonc/main.js');
  const tree = parseTree('{\"providers\":{\"deepinfra\":{\"models\":[{\"id\":\"smoke\"}]}}}', [], { allowTrailingComma: true, disallowComments: false });
  const m = getNodeValue(findNodeAtLocation(tree, ['providers', 'deepinfra', 'models']));
  if (m.length !== 1 || m[0].id !== 'smoke') process.exit(1);
"; then
  echo "error: smoke test failed (jsonc-parser not loadable at $TARGET), see stderr above" >&2
  exit 1
fi
echo "smoke test ok"

echo
echo "installed. open pi and run /reload, then use /refresh-deepinfra."