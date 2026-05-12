import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const HOME = os.homedir();
const NAMES_FILE = path.join(HOME, '.claude', 'session-names.json');
const CLAUDE_PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const CODEX_SESSIONS_DIR = path.join(HOME, '.codex', 'sessions');

type Tool = 'claude' | 'codex';

// ---- Binary detection ----

function findBinary(tool: Tool): string {
  const config = vscode.workspace.getConfiguration('claudeSessionManager');
  const configKey = tool === 'claude' ? 'claudePath' : 'codexPath';
  const configured = config.get<string>(configKey);
  if (configured && fs.existsSync(configured)) {
    return configured;
  }

  try {
    const result = execSync(`which ${tool}`, { encoding: 'utf-8', timeout: 3000 }).trim();
    if (result && fs.existsSync(result)) {
      return result;
    }
  } catch { /* not in PATH */ }

  const commonPaths = [
    `/opt/homebrew/bin/${tool}`,
    `/usr/local/bin/${tool}`,
    path.join(HOME, `.local/bin/${tool}`),
  ];
  for (const p of commonPaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  return tool;
}

interface SessionNameEntry { name: string; title: string; tool?: Tool }
interface SessionNames { [sessionId: string]: SessionNameEntry }

interface SessionInfo {
  sessionId: string;
  tool: Tool;
  name?: string;
  title: string;
  mtime: number;
  isNamed: boolean;
  filePath: string;
}

// ---- Data layer ----

function getClaudeProjectsSubDir(): string {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) { return ''; }
  const entries = fs.readdirSync(CLAUDE_PROJECTS_DIR);
  for (const e of entries) {
    const full = path.join(CLAUDE_PROJECTS_DIR, e);
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

function truncate(s: string, n = 120): string {
  return s.length > n ? s.slice(0, n) + '\u2026' : s;
}

function extractClaudeTitle(filePath: string): string {
  if (!fs.existsSync(filePath)) { return '(unknown)'; }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
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
              return truncate(t);
            }
          }
        } else if (typeof msg === 'string') {
          return truncate(msg);
        }
        break;
      }
    }
    return '(empty)';
  } catch {
    return '(error)';
  }
}

function extractCodexTitle(filePath: string): string {
  if (!fs.existsSync(filePath)) { return '(unknown)'; }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    for (const line of lines) {
      if (!line.trim()) { continue; }
      let d: any;
      try { d = JSON.parse(line); } catch { continue; }
      // Prefer event_msg user_message — that's the actual user-typed input
      if (d.type === 'event_msg' && d.payload?.type === 'user_message') {
        const t = String(d.payload.message ?? '').trim();
        if (!t) { continue; }
        // Skip auto-injected AGENTS.md / instructions
        if (t.startsWith('# AGENTS.md') || t.startsWith('<INSTRUCTIONS')) { continue; }
        return truncate(t);
      }
    }
    return '(empty)';
  } catch {
    return '(error)';
  }
}

function listCodexSessionFiles(): string[] {
  const results: string[] = [];
  if (!fs.existsSync(CODEX_SESSIONS_DIR)) { return results; }
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); }
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        results.push(full);
      }
    }
  };
  walk(CODEX_SESSIONS_DIR);
  return results;
}

function getCodexSessionId(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const firstNewline = content.indexOf('\n');
    const firstLine = firstNewline === -1 ? content : content.slice(0, firstNewline);
    const meta = JSON.parse(firstLine);
    if (meta.type === 'session_meta' && meta.payload?.id) {
      return String(meta.payload.id);
    }
  } catch { /* fallthrough */ }
  // Fallback: parse from filename: rollout-<ts>-<uuid>.jsonl
  const m = path.basename(filePath).match(/rollout-[\dT:\-.]+-([0-9a-f-]+)\.jsonl$/);
  return m ? m[1] : null;
}

function getAllSessions(tool: Tool): SessionInfo[] {
  const names = loadNames();
  const sessions: SessionInfo[] = [];

  if (tool === 'claude') {
    const projDir = getClaudeProjectsSubDir();
    if (!projDir) { return []; }
    const files = fs.readdirSync(projDir);
    for (const f of files) {
      if (!f.endsWith('.jsonl')) { continue; }
      const sessionId = f.replace('.jsonl', '');
      const full = path.join(projDir, f);
      const stat = fs.statSync(full);
      const named = names[sessionId];
      // Treat legacy entries (no tool field) as claude
      const namedForTool = named && (named.tool ?? 'claude') === 'claude' ? named : undefined;
      sessions.push({
        sessionId,
        tool: 'claude',
        name: namedForTool?.name,
        title: namedForTool?.title || extractClaudeTitle(full),
        mtime: stat.mtimeMs,
        isNamed: !!namedForTool,
        filePath: full,
      });
    }
  } else {
    const files = listCodexSessionFiles();
    for (const full of files) {
      const sessionId = getCodexSessionId(full);
      if (!sessionId) { continue; }
      const stat = fs.statSync(full);
      const named = names[sessionId];
      const namedForTool = named && named.tool === 'codex' ? named : undefined;
      sessions.push({
        sessionId,
        tool: 'codex',
        name: namedForTool?.name,
        title: namedForTool?.title || extractCodexTitle(full),
        mtime: stat.mtimeMs,
        isNamed: !!namedForTool,
        filePath: full,
      });
    }
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

    const toolBadge = session.tool === 'claude' ? 'Claude' : 'Codex';
    this.tooltip = `${session.name ? '\u2b50 ' + session.name + '\n\n' : ''}${session.title}\n\nTool: ${toolBadge}\nID: ${session.sessionId}\nModified: ${new Date(session.mtime).toLocaleString()}`;
    this.description = new Date(session.mtime).toLocaleDateString();

    if (session.isNamed) {
      this.iconPath = new vscode.ThemeIcon('star-full', new vscode.ThemeColor('editorWarning.foreground'));
      this.contextValue = `named-${session.tool}`;
    } else {
      this.iconPath = new vscode.ThemeIcon(session.tool === 'claude' ? 'comment' : 'symbol-method');
      this.contextValue = `unnamed-${session.tool}`;
    }

    this.command = {
      command: 'claude-sessions.resumeSession',
      title: 'Resume Session',
      arguments: [{
        sessionId: session.sessionId,
        tool: session.tool,
        name: session.name,
        title: session.title,
      }],
    };
  }
}

// ---- Tree data provider (parameterized) ----

class SessionsProvider implements vscode.TreeDataProvider<SessionItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SessionItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly tool: Tool, private readonly mode: 'named' | 'recent') {}

  refresh(): void { this._onDidChangeTreeData.fire(undefined); }

  getTreeItem(element: SessionItem): vscode.TreeItem { return element; }

  getChildren(): SessionItem[] {
    const all = getAllSessions(this.tool);
    const filtered = this.mode === 'named'
      ? all.filter(s => s.isNamed)
      : all.filter(s => !s.isNamed).slice(0, 30);
    return filtered.map(s => new SessionItem(s, vscode.TreeItemCollapsibleState.None));
  }
}

// ---- Commands ----

type SessionArg = { sessionId: string; tool: Tool; name?: string; title: string };

async function cmdNameSession(arg?: SessionArg & { tool?: Tool }): Promise<void> {
  let tool: Tool = arg?.tool ?? 'claude';
  let targetId = arg?.sessionId;

  if (!targetId) {
    // Picker: ask which tool first if both have unnamed sessions
    const claudeUnnamed = getAllSessions('claude').filter(s => !s.isNamed);
    const codexUnnamed = getAllSessions('codex').filter(s => !s.isNamed);

    let unnamed: SessionInfo[];
    if (claudeUnnamed.length && codexUnnamed.length) {
      const toolPick = await vscode.window.showQuickPick(
        [
          { label: 'Claude', description: `${claudeUnnamed.length} unnamed sessions`, tool: 'claude' as Tool },
          { label: 'Codex', description: `${codexUnnamed.length} unnamed sessions`, tool: 'codex' as Tool },
        ],
        { placeHolder: 'Pick tool' },
      );
      if (!toolPick) { return; }
      tool = toolPick.tool;
      unnamed = (tool === 'claude' ? claudeUnnamed : codexUnnamed).slice(0, 20);
    } else if (claudeUnnamed.length) {
      tool = 'claude';
      unnamed = claudeUnnamed.slice(0, 20);
    } else if (codexUnnamed.length) {
      tool = 'codex';
      unnamed = codexUnnamed.slice(0, 20);
    } else {
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
      placeHolder: `Pick a ${tool} session to name`,
      matchOnDescription: true,
    });
    if (!pick) { return; }
    targetId = pick.sessionId;
  }

  const name = await vscode.window.showInputBox({
    prompt: `Enter a name for this ${tool} session`,
    placeHolder: 'e.g. syncap-payment, deploy-script',
    validateInput: (v) => v.trim() ? undefined : 'Name cannot be empty',
  });
  if (!name) { return; }

  const all = getAllSessions(tool);
  const target = all.find(s => s.sessionId === targetId);
  const title = target?.title ?? '';
  const names = loadNames();
  names[targetId] = { name: name.trim(), title, tool };
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
    names[arg.sessionId].tool = arg.tool;
    saveNames(names);
    refreshAll();
    vscode.window.showInformationMessage(`Renamed to: ${name}`);
  }
}

async function cmdResumeSession(arg: SessionArg): Promise<void> {
  const tool: Tool = arg.tool ?? 'claude';
  const bin = findBinary(tool);
  const cmd = tool === 'claude'
    ? `${bin} --resume ${arg.sessionId}`
    : `${bin} resume ${arg.sessionId}`;
  const label = arg.name || arg.title.slice(0, 40);
  const prefix = tool === 'claude' ? 'Claude' : 'Codex';
  const terminal = vscode.window.createTerminal(`${prefix}: ${label}`);
  terminal.show();
  terminal.sendText(cmd);
}

async function cmdCopyResumeCommand(arg: SessionArg): Promise<void> {
  const tool: Tool = arg.tool ?? 'claude';
  const cmd = tool === 'claude'
    ? `claude --resume ${arg.sessionId}`
    : `codex resume ${arg.sessionId}`;
  await vscode.env.clipboard.writeText(cmd);
  vscode.window.showInformationMessage(
    `Copied: ${cmd.slice(0, 40)}...`
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
  const tool: Tool = arg.tool ?? 'claude';
  const all = getAllSessions(tool);
  const target = all.find(s => s.sessionId === arg.sessionId);
  if (target && fs.existsSync(target.filePath)) {
    const doc = await vscode.workspace.openTextDocument(target.filePath);
    await vscode.window.showTextDocument(doc);
  } else {
    vscode.window.showErrorMessage(`Session file not found for ${tool}: ${arg.sessionId}`);
  }
}

// ---- Globals ----

let providers: SessionsProvider[] = [];

function refreshAll(): void {
  for (const p of providers) { p.refresh(); }
}

// ---- Activation ----

export function activate(context: vscode.ExtensionContext): void {
  const claudeNamed = new SessionsProvider('claude', 'named');
  const claudeRecent = new SessionsProvider('claude', 'recent');
  const codexNamed = new SessionsProvider('codex', 'named');
  const codexRecent = new SessionsProvider('codex', 'recent');
  providers = [claudeNamed, claudeRecent, codexNamed, codexRecent];

  vscode.window.registerTreeDataProvider('claudeSessionsNamed', claudeNamed);
  vscode.window.registerTreeDataProvider('claudeSessionsRecent', claudeRecent);
  vscode.window.registerTreeDataProvider('codexSessionsNamed', codexNamed);
  vscode.window.registerTreeDataProvider('codexSessionsRecent', codexRecent);

  context.subscriptions.push(
    vscode.commands.registerCommand('claude-sessions.refresh', refreshAll),
    vscode.commands.registerCommand('claude-sessions.nameSession', cmdNameSession),
    vscode.commands.registerCommand('claude-sessions.nameSessionCodex', () => cmdNameSession({ tool: 'codex' } as any)),
    vscode.commands.registerCommand('claude-sessions.renameSession', cmdRenameSession),
    vscode.commands.registerCommand('claude-sessions.resumeSession', cmdResumeSession),
    vscode.commands.registerCommand('claude-sessions.copyResumeCommand', cmdCopyResumeCommand),
    vscode.commands.registerCommand('claude-sessions.deleteName', cmdDeleteName),
    vscode.commands.registerCommand('claude-sessions.openSessionFolder', cmdOpenSession),
  );
}

export function deactivate(): void {}
