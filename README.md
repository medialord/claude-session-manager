# Claude Session Manager

VS Code extension for managing [Claude Code](https://claude.ai/code) CLI sessions. Name your conversations and switch between them from a sidebar — no more `/resume` hunting.

![screenshot](resources/screenshot.png)

## Features

- **Named Sessions** — give your important conversations memorable names
- **Sidebar Panel** — see all sessions in the VS Code activity bar
- **One-click Resume** — click any session to open it in a VS Code terminal
- **Recent Sessions** — browse unnamed sessions and name the ones you need
- **Search** — type to filter sessions in the tree view

## Usage

1. Click the **Claude Sessions** icon in the activity bar (💬)
2. **Named Sessions** panel shows your saved sessions
3. **Recent Sessions** panel shows your latest unnamed sessions
4. Click a session to resume it in a new VS Code terminal
5. Right-click for more actions: rename, copy command, open file

### Naming a session

- Click the ✏️ icon in the Recent Sessions header to pick a session
- Or right-click any unnamed session → **Name This Session**

### Resume from terminal

The extension also works with the `cs` shell script. Install it:

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

The extension auto-detects `claude` from your PATH, Homebrew, or `/usr/local/bin`. Set this only if it can't find it.

## Requirements

- [Claude Code](https://claude.ai/code) CLI installed
- VS Code 1.85+

## Install

### From VSIX

```bash
code --install-extension claude-session-manager-1.0.0.vsix
```

### From source

```bash
git clone https://github.com/conglyu/claude-session-manager
cd claude-session-manager
npm install
npx tsc -p ./
npx @vscode/vsce package
code --install-extension claude-session-manager-*.vsix
```

## License

MIT
