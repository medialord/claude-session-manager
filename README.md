# Claude Session Manager

VS Code extension for managing [Claude Code](https://claude.ai/code) and [Codex CLI](https://github.com/openai/codex) sessions. Name your conversations, switch tools, and resume from a sidebar — no more `/resume` hunting.

## Features

- **Named Sessions** — star important conversations with memorable names
- **Two Tools, One Sidebar** — toggle between Claude and Codex from the same panel
- **One-click Resume** — click any session to open it in a VS Code terminal
- **Auto Mode (Claude)** — 🚀 button on each Claude session resumes with `--dangerously-skip-permissions` (no more permission prompts)
- **Recent Sessions** — browse unnamed sessions and name the ones you need
- **Inline Actions** — Resume / Auto-Resume / Remove buttons on hover

## Usage

1. Click the **AI Sessions** icon in the activity bar (💬)
2. **Named** panel shows your starred sessions
3. **Recent** panel shows your latest unnamed sessions
4. Click a session to resume normally, or click 🚀 for Auto Mode (Claude only)
5. Right-click for more actions: rename, copy command, open file

### Switching between Claude and Codex

Click the **⇄ Switch Tool** button at the top of the Named panel. The list flips to show the other tool's sessions. The active tool is remembered across VS Code restarts.

### Naming a session

- Click the ✏️ icon in the Recent panel header to pick a session
- Or right-click any unnamed session → **Name This Session**

Names are stored per-tool — a session named in Claude doesn't show under Codex.

### Auto Mode (skip permission prompts)

Each Claude session row has a 🚀 button. Clicking it opens a terminal with:

```bash
claude --dangerously-skip-permissions --resume <session-id>
```

This bypasses all permission confirmations (file edits, bash commands, etc.). Use only when you trust the task — Claude can execute destructive commands without asking.

### Resume from terminal

The extension also works with the `cs` shell script:

```bash
# Add to ~/.zshrc
alias cs="$HOME/.claude/scripts/cs.sh"

# Commands
cs list              # List named sessions
cs name <name>       # Name current session
cs resume <name>     # Print resume command
```

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeSessionManager.claudePath` | auto-detected | Path to `claude` CLI binary |
| `claudeSessionManager.codexPath` | auto-detected | Path to `codex` CLI binary |

The extension auto-detects both binaries from your PATH, Homebrew, or `/usr/local/bin`. Set these only if detection fails.

## Requirements

- [Claude Code](https://claude.ai/code) CLI installed (required)
- [Codex CLI](https://github.com/openai/codex) installed (optional, for Codex support)
- VS Code 1.85+

## Install

### From VSIX

```bash
code --install-extension claude-session-manager-1.3.1.vsix
```

### From source

```bash
git clone https://github.com/medialord/claude-session-manager
cd claude-session-manager
npm install
npx tsc -p ./
npx @vscode/vsce package
code --install-extension claude-session-manager-*.vsix
```

## License

MIT
