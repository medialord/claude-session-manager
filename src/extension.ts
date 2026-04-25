import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const HOME = os.homedir();
const NAMES_FILE = path.join(HOME, '.claude', 'session-names.json');
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');

// ---- Claude binary detection ----

function findClaudeBinary(): string {
  // 1. Check VS Code settings
  const config = vscode.workspace.getConfiguration('claudeSessionManager');
  const configured = config.get<string>('claudePath');
  if (configured && fs.existsSync(configured)) {
    return configured;
  }

  // 2. Try `which claude`
  try {
    const result = execSync('which claude', { encoding: 'utf-8', timeout: 3000 }).trim();
    if (result && fs.existsSync(result)) {
      return result;
    }
  } catch { /* not in PATH */ }

  // 3. Check common installation paths
  const commonPaths = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(HOME, '.local/bin/claude'),
  ];
  for (const p of commonPaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // 4. Fallback — hope it's in VS Code's terminal PATH
  return 'claude';
}

interface SessionNames {
  [sessionId: string]: { name: string; title: string };
}

interface SessionInfo {
  sessionId: string;
  name?: string;
  title: string;
  mtime: number;
  isNamed: boolean;
}

// ---- Data layer ----

function getProjectsSubDir(): string {
  if (!fs.existsSync(PROJECTS_DIR)) { return ''; }
  const entries = fs.readdirSync(PROJECTS_DIR);
  for (const e of entries) {
    const full = path.join(PROJECTS_DIR, e);
    if (fs.statSync(full).isDirectory()) {
      const files = fs.readdirSync(full);
      if (files.some((f: string) => f.endsWith('.jsonl'))) {
        return full;
      }
    }
  }
  return '';
}

function loadNames(): SessionNames {
  try {
    return JSON.parse(fs.readFileSync(NAMES_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveNames(names: SessionNames): void {
  fs.writeFileSync(NAMES_FILE, JSON.stringify(names, null, 2), 'utf-8');
}

function extractTitle(sessionId: string, projDir: string): string {
  const jsonlPath = path.join(projDir, `${sessionId}.jsonl`);
  if (!fs.existsSync(jsonlPath)) { return '(unknown)'; }
  try {
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    const lines = content.split('\n');
    for (const line of lines) {
      if (!line.trim()) { continue; }
      const d = JSON.parse(line);
      if (d.type === 'user') {
        const msg = d.message?.content ?? '';
        if (Array.isArray(msg)) {
          for (const item of msg) {
            if (item.type === 'text') {
              const t = item.text.trim();
              if (t.includes('<local-command')) { continue; }
              return t.length > 120 ? t.slice(0, 120) + '\u2026' : t;
            }
          }
        } else if (typeof msg === 'string') {
          return msg.length > 120 ? msg.slice(0, 120) + '\u2026' : msg;
        }
        break;
      }
    }
    return '(empty)';
  } catch {
    return '(error)';
  }
}

function getAllSessions(): SessionInfo[] {
  const projDir = getProjectsSubDir();
  if (!projDir) { return []; }

  const names = loadNames();
  const sessions: SessionInfo[] = [];

  const files = fs.readdirSync(projDir);
  for (const f of files) {
    if (!f.endsWith('.jsonl')) { continue; }
    const sessionId = f.replace('.jsonl', '');
    const stat = fs.statSync(path.join(projDir, f));
    const named = names[sessionId];
    sessions.push({
      sessionId,
      name: named?.name,
      title: named?.title || extractTitle(sessionId, projDir),
      mtime: stat.mtimeMs,
      isNamed: !!named,
    });
  }

  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

// ---- Tree items ----

class SessionItem extends vscode.TreeItem {
  constructor(
    public readonly session: SessionInfo,
    collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    const label = session.name || session.title.slice(0, 60);
    super(label, collapsibleState);

    this.tooltip = `${session.name ? '\u2b50 ' + session.name + '\n\n' : ''}${session.title}\n\nID: ${session.sessionId}\nModified: ${new Date(session.mtime).toLocaleString()}`;
    this.description = new Date(session.mtime).toLocaleDateString();

    if (session.isNamed) {
      this.iconPath = new vscode.ThemeIcon('star-full', new vscode.ThemeColor('editorWarning.foreground'));
      this.contextValue = 'namedSession';
    } else {
      this.iconPath = new vscode.ThemeIcon('comment');
      this.contextValue = 'unnamedSession';
    }

    // Click directly opens terminal with resume command
    // Pass plain data object — VS Code serializes arguments, can't pass class instances
    this.command = {
      command: 'claude-sessions.resumeSession',
      title: 'Resume Session',
      arguments: [{
        sessionId: session.sessionId,
        name: session.name,
        title: session.title,
      }],
    };
  }
}

// ---- Tree data providers ----

class NamedSessionsProvider implements vscode.TreeDataProvider<SessionItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SessionItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void { this._onDidChangeTreeData.fire(undefined); }

  getTreeItem(element: SessionItem): vscode.TreeItem { return element; }

  getChildren(): SessionItem[] {
    const all = getAllSessions();
    const named = all.filter(s => s.isNamed);
    return named.map(s => new SessionItem(s, vscode.TreeItemCollapsibleState.None));
  }
}

class RecentSessionsProvider implements vscode.TreeDataProvider<SessionItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SessionItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void { this._onDidChangeTreeData.fire(undefined); }

  getTreeItem(element: SessionItem): vscode.TreeItem { return element; }

  getChildren(): SessionItem[] {
    const all = getAllSessions();
    const unnamed = all.filter(s => !s.isNamed).slice(0, 30);
    return unnamed.map(s => new SessionItem(s, vscode.TreeItemCollapsibleState.None));
  }
}

// ---- Commands ----

// Accept plain object — VS Code serializes TreeItem arguments
type SessionArg = { sessionId: string; name?: string; title: string };

async function cmdNameSession(arg?: SessionArg): Promise<void> {
  const all = getAllSessions();
  let targetId = arg?.sessionId;

  if (!targetId) {
    const unnamed = all.filter(s => !s.isNamed).slice(0, 20);
    if (unnamed.length === 0) {
      vscode.window.showInformationMessage('No unnamed sessions to name.');
      return;
    }
    const picks = unnamed.map(s => ({
      label: s.title.slice(0, 80),
      description: new Date(s.mtime).toLocaleString(),
      detail: s.sessionId.slice(0, 8) + '\u2026',
      sessionId: s.sessionId,
    }));
    const pick = await vscode.window.showQuickPick(picks, {
      placeHolder: 'Pick a session to name',
      matchOnDescription: true,
    });
    if (!pick) { return; }
    targetId = pick.sessionId;
  }

  const name = await vscode.window.showInputBox({
    prompt: 'Enter a name for this session',
    placeHolder: 'e.g. syncap-payment, deploy-script',
    validateInput: (v) => v.trim() ? undefined : 'Name cannot be empty',
  });
  if (!name) { return; }

  const names = loadNames();
  const title = extractTitle(targetId, getProjectsSubDir());
  names[targetId] = { name: name.trim(), title };
  saveNames(names);

  refreshAll();
  vscode.window.showInformationMessage(`Session named: ${name}`);
}

async function cmdRenameSession(arg: SessionArg): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: 'Rename this session',
    value: arg.name,
    validateInput: (v) => v.trim() ? undefined : 'Name cannot be empty',
  });
  if (!name) { return; }

  const names = loadNames();
  if (names[arg.sessionId]) {
    names[arg.sessionId].name = name.trim();
    saveNames(names);
    refreshAll();
    vscode.window.showInformationMessage(`Renamed to: ${name}`);
  }
}

async function cmdResumeSession(arg: SessionArg): Promise<void> {
  const claudePath = findClaudeBinary();
  const cmd = `${claudePath} --resume ${arg.sessionId}`;
  const label = arg.name || arg.title.slice(0, 40);
  const terminal = vscode.window.createTerminal(`Claude: ${label}`);
  terminal.show();
  terminal.sendText(cmd);
}

async function cmdCopyResumeCommand(arg: SessionArg): Promise<void> {
  const cmd = `claude --resume ${arg.sessionId}`;
  await vscode.env.clipboard.writeText(cmd);
  vscode.window.showInformationMessage(
    `Copied: claude --resume ${arg.sessionId.slice(0, 8)}...`
  );
}

async function cmdDeleteName(arg: SessionArg): Promise<void> {
  const name = arg.name || arg.sessionId;
  const confirm = await vscode.window.showWarningMessage(
    `Remove name "${name}"? (session data is preserved)`,
    { modal: true },
    'Remove Name',
  );
  if (confirm !== 'Remove Name') { return; }

  const names = loadNames();
  delete names[arg.sessionId];
  saveNames(names);
  refreshAll();
  vscode.window.showInformationMessage(`Removed name: ${name}`);
}

async function cmdOpenSession(arg: SessionArg): Promise<void> {
  const projDir = getProjectsSubDir();
  const jsonlPath = path.join(projDir, `${arg.sessionId}.jsonl`);
  if (fs.existsSync(jsonlPath)) {
    const doc = await vscode.workspace.openTextDocument(jsonlPath);
    await vscode.window.showTextDocument(doc);
  } else {
    vscode.window.showErrorMessage('Session file not found: ' + jsonlPath);
  }
}

// ---- Globals ----

let namedProvider: NamedSessionsProvider;
let recentProvider: RecentSessionsProvider;

function refreshAll(): void {
  namedProvider.refresh();
  recentProvider.refresh();
}

// ---- Activation ----

export function activate(context: vscode.ExtensionContext): void {
  namedProvider = new NamedSessionsProvider();
  recentProvider = new RecentSessionsProvider();

  vscode.window.registerTreeDataProvider('claudeSessionsNamed', namedProvider);
  vscode.window.registerTreeDataProvider('claudeSessionsRecent', recentProvider);

  context.subscriptions.push(
    vscode.commands.registerCommand('claude-sessions.refresh', refreshAll),
    vscode.commands.registerCommand('claude-sessions.nameSession', cmdNameSession),
    vscode.commands.registerCommand('claude-sessions.renameSession', cmdRenameSession),
    vscode.commands.registerCommand('claude-sessions.resumeSession', cmdResumeSession),
    vscode.commands.registerCommand('claude-sessions.copyResumeCommand', cmdCopyResumeCommand),
    vscode.commands.registerCommand('claude-sessions.deleteName', cmdDeleteName),
    vscode.commands.registerCommand('claude-sessions.openSessionFolder', cmdOpenSession),
  );
}

export function deactivate(): void {}
