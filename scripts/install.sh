#!/bin/bash
set -eu
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
link() {
  if [ -e "$2" ] && [ ! -L "$2" ]; then
    echo "Refusing to replace an existing file: $2" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$2")"
  ln -sfn "$1" "$2"
}
chmod +x "$project_dir/scripts/cli.mjs"
link "$project_dir/scripts/cli.mjs" "$HOME/.local/bin/tldraw-ipad"
link "$project_dir/skills/tldraw-ipad" "$HOME/.agents/skills/tldraw-ipad"
for skill_dir in "$HOME/.codex/skills" "$HOME/.claude/skills" "$HOME/.pi/agent/skills"; do
  link "$HOME/.agents/skills/tldraw-ipad" "$skill_dir/tldraw-ipad"
done
echo "Installed ~/.local/bin/tldraw-ipad and the shared tldraw-ipad skill."
echo "Keep ~/.local/bin on PATH. Start a new agent session to discover the skill."
