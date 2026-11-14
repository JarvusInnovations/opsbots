#!/usr/bin/env bash
# opsbot-host bootstrap: a fresh Linux user up to a session that can start. No root.
#
#   curl -fsSL https://raw.githubusercontent.com/JarvusInnovations/opsbots/main/skills/opsbot-host/scripts/bootstrap.sh | bash
#   curl -fsSL …/bootstrap.sh | bash -s -- --dry-run
#   .agents/skills/opsbot-host/scripts/bootstrap.sh --tools "gh-axi agent-recall-axi"
#
# Installs, each only when missing: ~/.local/bin and the asdf shims on PATH (above .bashrc's
# interactive guard), asdf, node, the GitHub CLI, the AXI tools (with agent-recall-axi's session
# hook installed for the user), Claude Code, herdr with its
# agent skill (installed for the user, so every project has it), and the skills of the repo it
# is run in (skills-lock.json). Plain bash on purpose: it has to run
# before node exists. It never signs in to anything; the sign-ins are printed at the end.
#
#   --dry-run        print what would be installed and the commands, change nothing
#   --tools "a b"    npm packages to install globally instead of the default set; "none" for none
#   --node <version> node version (default: the repo's .tool-versions, else the latest 22)
#   --no-herdr       skip herdr and its skill
set -euo pipefail

DRY=0; HERDR=1; NODE=""; TOOLS="gh-axi gws-axi slack-axi gitsheets-axi agent-recall-axi chrome-devtools-axi"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --no-herdr) HERDR=0 ;;
    --tools) [ $# -ge 2 ] || { echo "error: --tools needs a value" >&2; exit 2; }; TOOLS="$2"; shift ;;
    --tools=*) TOOLS="${1#--tools=}" ;;
    --node) [ $# -ge 2 ] || { echo "error: --node needs a value" >&2; exit 2; }; NODE="$2"; shift ;;
    --node=*) NODE="${1#--node=}" ;;
    -h|--help) sed -n '2,19p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "error: unknown argument $1 (valid: --dry-run, --tools, --node, --no-herdr)" >&2; exit 2 ;;
  esac
  shift
done
[ "$TOOLS" = "none" ] && TOOLS=""
TOOLS="${TOOLS//,/ }"
for t in $TOOLS; do
  case "$t" in *[!a-z0-9@/._-]*|-*) echo "error: --tools takes npm package names; not one: $t" >&2; exit 2 ;; esac
done
[ "$(id -u)" != 0 ] || { echo "error: run this as the user who will use the tools, not as root" >&2; exit 2; }
for need in curl git tar; do
  command -v "$need" >/dev/null 2>&1 || { echo "error: $need is not installed, and installing it needs root. As root: apt install -y curl git tar" >&2; exit 2; }
done

BEGIN='# >>> opsbot-host: tools on PATH (exported before the interactive guard) >>>'
END='# <<< opsbot-host: tools on PATH <<<'
LINE='export PATH="$HOME/.local/bin:${ASDF_DATA_DIR:-$HOME/.asdf}/shims:$PATH"'
INSTALLED=0; PRESENT=0; WOULD=0

ok()   { PRESENT=$((PRESENT+1)); printf 'ok     %-18s %s\n' "$1" "$2"; }
did()  { INSTALLED=$((INSTALLED+1)); printf 'added  %-18s %s\n' "$1" "$2"; }
plan() { WOULD=$((WOULD+1)); printf 'would  %-18s %s\n' "$1" "$2"; }

# step <name> <probe command> <install commands>
step() {
  local name="$1" probe="$2" install="$3" v
  if v=$(bash -c "$probe" 2>/dev/null | tail -1) && [ -n "$v" ]; then ok "$name" "$v"; return 0; fi
  if [ "$DRY" = 1 ]; then plan "$name" "$install"; return 0; fi
  echo "…      $name" >&2
  if ! bash -c "set -e; $install" >&2; then
    echo "error: $name did not install. The steps before it are done; a rerun continues from here. By hand: $install" >&2
    exit 1
  fi
  hash -r
  v=$(bash -c "$probe" 2>/dev/null | tail -1) || true
  [ -n "$v" ] || { echo "error: $name installed but is not on PATH" >&2; exit 1; }
  did "$name" "$v"
}

# 1. PATH, in .bashrc above the interactive guard and in this process
RC="$HOME/.bashrc"
if [ -f "$RC" ] && grep -qF "$BEGIN" "$RC"; then ok "PATH" "~/.bashrc"
elif [ "$DRY" = 1 ]; then plan "PATH" "prepend to ~/.bashrc: $LINE"
else
  tmp=$(mktemp)
  { printf '%s\n%s\n%s\n\n' "$BEGIN" "$LINE" "$END"; [ -f "$RC" ] && cat "$RC"; } > "$tmp"
  cat "$tmp" > "$RC"; rm -f "$tmp"
  did "PATH" "~/.bashrc"
fi
export PATH="$HOME/.local/bin:${ASDF_DATA_DIR:-$HOME/.asdf}/shims:$PATH"

# 2. asdf
step asdf 'asdf --version' '
a=$(uname -m); case "$a" in x86_64) a=amd64;; aarch64|arm64) a=arm64;; esac
v=$(curl -fsSL https://api.github.com/repos/asdf-vm/asdf/releases/latest | sed -n "s/.*\"tag_name\": *\"\([^\"]*\)\".*/\1/p" | head -1)
[ -n "$v" ] || { echo "could not read the latest asdf release" >&2; exit 1; }
mkdir -p "$HOME/.local/bin"
curl -fsSL "https://github.com/asdf-vm/asdf/releases/download/$v/asdf-$v-linux-$a.tar.gz" | tar -xz -C "$HOME/.local/bin" asdf'

# 3. node: the flag, else the repo's pin, else the latest 22
if [ -z "$NODE" ] && [ -f .tool-versions ]; then NODE=$(sed -n 's/^nodejs  *\([^ ]*\).*/\1/p' .tool-versions | head -1); fi
NODE_EXPR="${NODE:-\$(asdf latest nodejs 22)}"
# a system node does not count: global npm installs under it need root, and the tools need 20 or later
step node 'case "$(command -v node)" in "$HOME"/*) node -e "process.exit(+process.versions.node.split(\".\")[0] >= 20 ? 0 : 1)" && node --version ;; esac' "
asdf plugin add nodejs >/dev/null 2>&1 || true
v=$NODE_EXPR
asdf install nodejs \"\$v\"
asdf set -u nodejs \"\$v\""

# 4. the GitHub CLI
step gh 'gh --version | head -1' '
asdf plugin add github-cli >/dev/null 2>&1 || true
v=$(asdf latest github-cli)
asdf install github-cli "$v"
asdf set -u github-cli "$v"'

# 5. the tools
for t in $TOOLS; do
  bin="${t##*/}"
  step "$t" "command -v $bin >/dev/null && $bin --version 2>/dev/null | head -1 | grep . || command -v $bin" "npm install -g $t && (asdf reshim nodejs 2>/dev/null || true)"
done

# 6. Claude Code, herdr
step claude 'claude --version' 'curl -fsSL https://claude.ai/install.sh | bash'
# Claude Code deletes session logs after 30 days unless told otherwise; a bot's or a person's
# history is the record agent-recall-axi reads, so keep it. Merged into the user's settings.
step keep-sessions 'node -e "const fs=require(\"fs\");let j={};try{j=JSON.parse(fs.readFileSync(process.env.HOME+\"/.claude/settings.json\",\"utf8\"))}catch{};process.exit(j.cleanupPeriodDays===36500?0:1)" && echo "cleanupPeriodDays 36500"' 'node -e "const fs=require(\"fs\"),p=process.env.HOME+\"/.claude/settings.json\";let j={};if(fs.existsSync(p))j=JSON.parse(fs.readFileSync(p,\"utf8\"));j.cleanupPeriodDays=36500;fs.mkdirSync(process.env.HOME+\"/.claude\",{recursive:true});fs.writeFileSync(p,JSON.stringify(j,null,2)+\"\\n\")"'
# agent-recall-axi's session hook, for every project this user opens: an agent starts each
# session with its past sessions in reach, and gets a resume pack after a compaction.
case " $TOOLS " in *" agent-recall-axi "*)
  step recall-hook 'grep -q agent-recall-axi "$HOME/.claude/settings.json" 2>/dev/null && echo "~/.claude/settings.json"' 'agent-recall-axi hook install --scope user --agent claude </dev/null'
;; esac
if [ "$HERDR" = 1 ]; then
  step herdr 'herdr --version' 'curl -fsSL https://herdr.dev/install.sh | sh'
  # the herdr skill, for every project this user opens: how an agent drives herdr. Only that
  # one skill: the repository also holds the herdr project's own maintenance skills.
  step herdr-skill '[ -d "$HOME/.agents/skills/herdr" ] && echo "~/.agents/skills/herdr"' 'npx -y skills add -g ogulcancelik/herdr --skill herdr -y </dev/null'
fi

# 7. the repo's skills
if [ -f skills-lock.json ]; then
  missing=$(sed -n 's/^    "\([^"]*\)": {$/\1/p' skills-lock.json | while read -r s; do [ -d ".agents/skills/$s" ] || [ -d ".claude/skills/$s" ] || echo "$s"; done)
  if [ -z "$missing" ]; then ok "skills" "skills-lock.json"
  elif [ "$DRY" = 1 ]; then plan "skills" "npx -y skills experimental_install  (missing: $(echo $missing))"
  else echo "…      skills" >&2; npx -y skills experimental_install >&2; did "skills" "skills-lock.json"
  fi
fi

echo
if [ "$DRY" = 1 ]; then echo "dry run: would install $WOULD, $PRESENT already present; nothing changed"
else
  echo "installed $INSTALLED, $PRESENT already present"
  echo
  echo "Next, by hand (sign-ins only a person can do). Open a new shell first, or: source ~/.bashrc"
  echo "  claude              # sign in once, then /exit"
  echo "  gh auth login"
  echo "  gws-axi auth setup  # if this user reads Google Workspace"
  echo "  slack-axi auth      # if this user reads or posts to Slack"
fi
