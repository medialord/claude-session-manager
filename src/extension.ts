import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const HOME = os.homedir();
const NAMES_FILE = path.join(HOME, '.claude', 'session-names.json');
const CLAUDE_PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const CODEX_SESSIONS_DIR = path.join(HOME, '.codex', 'sessions');
const NAMED_BACKUP_DIR = path.join(HOME, '.claude', 'named-sessions-backup');
const ACTIVE_TOOL_KEY = 'claudeSessionManager.activeTool';
const BACKUP_INTERVAL_MS = 5 * 60 * 1000; // periodic re-backup every 5 minutes

type Tool = 'claude' | 'codex';

const TOOL_CYCLE: Tool[] = ['claude', 'codex'];
const TOOL_LABEL: Record<Tool, string> = {
  claude: 'Claude',
  codex: 'Codex',
};

const TOOL_ITEM_ICON: Record<Tool, string> = {
  claude: 'comment',
  codex: 'symbol-method',
};

// ---- Binary detection (cross-platform) ----

const IS_WINDOWS = process.platform === 'win32';

function findBinary(tool: Tool): string {
  const config = vscode.workspace.getConfiguration('claudeSessionManager');
  const configKey = tool === 'claude' ? 'claudePath' : 'codexPath';
  const configured = config.get<string>(configKey);
  if (configured && fs.existsSync(configured)) {
    return configured;
  }

  // Use `where` on Windows, `which` on Unix. `where` may print multiple lines.
  try {
    const lookup = IS_WINDOWS ? `where ${tool}` : `which ${tool}`;
    const result = execSync(lookup, { encoding: 'utf-8', timeout: 3000 })
      .split(/\r?\n/)[0]
      .trim();
    if (result && fs.existsSync(result)) {
      return result;
    }
  } catch { /* not in PATH */ }

  // Fallback: platform-specific well-known install paths
  const commonPaths = IS_WINDOWS
    ? [
        path.join(process.env['APPDATA'] || '', 'npm', `${tool}.cmd`),
        path.join(process.env['LOCALAPPDATA'] || '', 'Programs', tool, `${tool}.exe`),
        path.join(process.env['ProgramFiles'] || 'C:\\Program Files', tool, `${tool}.exe`),
      ]
    : [
        `/opt/homebrew/bin/${tool}`,
        `/usr/local/bin/${tool}`,
        path.join(HOME, `.local/bin/${tool}`),
      ];
  for (const p of commonPaths) {
    if (p && fs.existsSync(p)) {
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
  cwd?: string; // original working directory of the session
  isTemplateOnly?: boolean; // slash-command auto-run with no human input
}

// ---- Data layer ----

function getClaudeProjectsSubDirs(): string[] {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) { return []; }
  const entries = fs.readdirSync(CLAUDE_PROJECTS_DIR);
  const dirs: string[] = [];
  for (const e of entries) {
    const full = path.join(CLAUDE_PROJECTS_DIR, e);
    try {
      if (fs.statSync(full).isDirectory()) {
        const files = fs.readdirSync(full);
        if (files.some((f: string) => f.endsWith('.jsonl'))) {
          dirs.push(full);
        }
      }
    } catch { /* skip inaccessible */ }
  }
  return dirs;
}

// Extract original cwd from a Claude JSONL — first line carrying a `cwd` field.
function extractClaudeCwd(filePath: string): string | undefined {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    for (const line of lines) {
      if (!line.trim() || !line.includes('"cwd"')) { continue; }
      try {
        const d = JSON.parse(line);
        if (typeof d.cwd === 'string' && d.cwd) { return d.cwd; }
      } catch { /* keep scanning */ }
    }
  } catch { /* fall through */ }
  return undefined;
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

// Text patterns for messages that are pure XML metadata wrappers (not real
// content). We skip these completely and keep scanning.
const METADATA_PATTERNS: RegExp[] = [
  /^<command-/i,
  /^<local-command-/i,
  /^Caveat: The messages below were/i,
];

// Slash-command auto-expanded prompts. Sessions that ONLY contain these
// (plus metadata) are pure automated runs — no human ever typed anything.
// Hide them from Recent so the list stays useful.
const AUTO_TEMPLATE_PATTERNS: RegExp[] = [
  /^Analyze this codebase for security vulnerabilities/i,
  /^Analyze this codebase for performance optimizations/i,
  /^Analyze test coverage and identify gaps/i,
  /^Analyze this codebase/i,
  /^Analyze test coverage/i,
  /^Complete a security review/i,
  /^Review a pull request/i,
  /^Initialize a new CLAUDE\.md/i,
  /^Please analyze this codebase/i,
];

function isAutoTemplate(t: string): boolean {
  return AUTO_TEMPLATE_PATTERNS.some((p) => p.test(t.trim()));
}

// True if every user message in the file is either metadata or a slash-command
// auto-template — i.e. nobody actually typed anything.
function isTemplateOnlyClaudeSession(filePath: string): boolean {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    for (const line of lines) {
      if (!line.trim()) { continue; }
      let d: any;
      try { d = JSON.parse(line); } catch { continue; }
      if (d.type !== 'user') { continue; }
      const msg = d.message?.content ?? '';
      let text = '';
      if (Array.isArray(msg)) {
        for (const item of msg) {
          if (item?.type === 'text' && typeof item.text === 'string') {
            text = item.text.trim();
            break;
          }
        }
      } else if (typeof msg === 'string') {
        text = msg.trim();
      }
      if (!text) { continue; }
      if (isPureMetadata(text)) { continue; }
      if (isAutoTemplate(text)) { continue; }
      // Found a real human-typed message
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Grab only the first non-empty line, drop trailing colons/dashes so slash
// command headers like "Analyze this codebase for security vulnerabilities:"
// don't cost extra characters in the sidebar.
function firstMeaningfulLine(t: string): string {
  const trimmed = t.trim();
  const firstLine = trimmed.split(/\r?\n/).find((l) => l.trim().length > 0) ?? trimmed;
  return firstLine.trim().replace(/[:\-\s]+$/, '');
}

function isPureMetadata(t: string): boolean {
  const trimmed = t.trim();
  if (!trimmed) { return true; }
  return METADATA_PATTERNS.some((p) => p.test(trimmed));
}

function extractClaudeTitle(filePath: string): string {
  if (!fs.existsSync(filePath)) { return '(unknown)'; }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    // Collect up to 5 non-metadata, non-auto-template user messages, then pick
    // the best title from them. Short greetings like "hi" / "Poptale" get
    // improved by later, meatier lines that describe what the session is about.
    const candidates: string[] = [];
    for (const line of lines) {
      if (!line.trim()) { continue; }
      let d: any;
      try { d = JSON.parse(line); } catch { continue; }
      if (d.type !== 'user') { continue; }
      const msg = d.message?.content ?? '';
      let text = '';
      if (Array.isArray(msg)) {
        for (const item of msg) {
          if (item?.type === 'text' && typeof item.text === 'string') {
            text = item.text.trim();
            break;
          }
        }
      } else if (typeof msg === 'string') {
        text = msg.trim();
      }
      if (!text) { continue; }
      if (isPureMetadata(text)) { continue; }
      if (isAutoTemplate(text)) { continue; }
      candidates.push(firstMeaningfulLine(text));
      if (candidates.length >= 5) { break; }
    }
    if (candidates.length === 0) { return '(empty)'; }
    // Prefer the first candidate that is descriptive (≥ 8 chars). Otherwise
    // use the longest of the first 5 so a "hi" opener falls through to a real
    // question that arrived a few turns later.
    const meaty = candidates.find((c) => c.length >= 8);
    const chosen = meaty ?? candidates.reduce((a, b) => (b.length > a.length ? b : a));
    return truncate(chosen);
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
      if (d.type === 'event_msg' && d.payload?.type === 'user_message') {
        const t = String(d.payload.message ?? '').trim();
        if (!t) { continue; }
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

function getCodexSessionMeta(filePath: string): { sessionId: string | null; cwd?: string } {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const firstNewline = content.indexOf('\n');
    const firstLine = firstNewline === -1 ? content : content.slice(0, firstNewline);
    const meta = JSON.parse(firstLine);
    if (meta.type === 'session_meta' && meta.payload?.id) {
      return {
        sessionId: String(meta.payload.id),
        cwd: typeof meta.payload.cwd === 'string' ? meta.payload.cwd : undefined,
      };
    }
  } catch { /* fallthrough */ }
  const m = path.basename(filePath).match(/rollout-[\dT:\-.]+-([0-9a-f-]+)\.jsonl$/);
  return { sessionId: m ? m[1] : null };
}

function getAllSessions(tool: Tool): SessionInfo[] {
  const names = loadNames();
  const sessions: SessionInfo[] = [];

  if (tool === 'claude') {
    const projDirs = getClaudeProjectsSubDirs();
    if (projDirs.length === 0) { return []; }
    for (const projDir of projDirs) {
      const files = fs.readdirSync(projDir);
      for (const f of files) {
        if (!f.endsWith('.jsonl')) { continue; }
        const sessionId = f.replace('.jsonl', '');
        const full = path.join(projDir, f);
        const stat = fs.statSync(full);
        const named = names[sessionId];
        const namedForTool = named && (named.tool ?? 'claude') === 'claude' ? named : undefined;
        sessions.push({
          sessionId,
          tool: 'claude',
          name: namedForTool?.name,
          title: namedForTool?.title || extractClaudeTitle(full),
          mtime: stat.mtimeMs,
          isNamed: !!namedForTool,
          filePath: full,
          cwd: extractClaudeCwd(full),
          isTemplateOnly: !namedForTool && isTemplateOnlyClaudeSession(full),
        });
      }
    }
  } else {
    const files = listCodexSessionFiles();
    for (const full of files) {
      const meta = getCodexSessionMeta(full);
      if (!meta.sessionId) { continue; }
      const stat = fs.statSync(full);
      const named = names[meta.sessionId];
      const namedForTool = named && named.tool === 'codex' ? named : undefined;
      sessions.push({
        sessionId: meta.sessionId,
        tool: 'codex',
        name: namedForTool?.name,
        title: namedForTool?.title || extractCodexTitle(full),
        mtime: stat.mtimeMs,
        isNamed: !!namedForTool,
        filePath: full,
        cwd: meta.cwd,
      });
    }
  }

  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

// ---- Named-session backup / restore ----

function copyFileIfChanged(src: string, dest: string): 'copied' | 'skipped' | 'error' {
  try {
    const srcStat = fs.statSync(src);
    if (fs.existsSync(dest)) {
      const destStat = fs.statSync(dest);
      if (destStat.mtimeMs >= srcStat.mtimeMs && destStat.size === srcStat.size) {
        return 'skipped';
      }
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    fs.utimesSync(dest, srcStat.atime, srcStat.mtime);
    return 'copied';
  } catch {
    return 'error';
  }
}

function copyDirRecursive(src: string, dest: string): void {
  if (!fs.existsSync(src)) { return; }
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) {
      copyDirRecursive(s, d);
    } else if (e.isFile()) {
      copyFileIfChanged(s, d);
    }
  }
}

// Mirror every named (starred) session's JSONL — plus its tool-results
// sidecar dir — into ~/.claude/named-sessions-backup/<project-dir>/.
// Survives Claude's periodic archival/strip passes.
function backupNamedSessions(): { copied: number; skipped: number; errors: number } {
  let copied = 0, skipped = 0, errors = 0;
  const stats = { copied, skipped, errors };
  try {
    fs.mkdirSync(NAMED_BACKUP_DIR, { recursive: true });
    const names = loadNames();
    const namedIds = new Set(Object.keys(names));
    if (namedIds.size === 0) { return stats; }

    // Claude
    for (const projDir of getClaudeProjectsSubDirs()) {
      const projName = path.basename(projDir);
      for (const f of fs.readdirSync(projDir)) {
        if (!f.endsWith('.jsonl')) { continue; }
        const sid = f.replace('.jsonl', '');
        const entry = names[sid];
        if (!entry || (entry.tool ?? 'claude') !== 'claude') { continue; }
        const src = path.join(projDir, f);
        const dest = path.join(NAMED_BACKUP_DIR, 'claude', projName, f);
        const result = copyFileIfChanged(src, dest);
        if (result === 'copied') { stats.copied++; }
        else if (result === 'skipped') { stats.skipped++; }
        else { stats.errors++; }
        // Mirror tool-results sidecar dir if present
        const trSrc = path.join(projDir, sid, 'tool-results');
        if (fs.existsSync(trSrc)) {
          const trDest = path.join(NAMED_BACKUP_DIR, 'claude', projName, sid, 'tool-results');
          copyDirRecursive(trSrc, trDest);
        }
      }
    }

    // Codex
    if (fs.existsSync(CODEX_SESSIONS_DIR)) {
      for (const full of listCodexSessionFiles()) {
        const meta = getCodexSessionMeta(full);
        if (!meta.sessionId) { continue; }
        const entry = names[meta.sessionId];
        if (!entry || entry.tool !== 'codex') { continue; }
        // Mirror date-bucketed structure: YYYY/MM/DD/rollout-*.jsonl
        const rel = path.relative(CODEX_SESSIONS_DIR, full);
        const dest = path.join(NAMED_BACKUP_DIR, 'codex', rel);
        const result = copyFileIfChanged(full, dest);
        if (result === 'copied') { stats.copied++; }
        else if (result === 'skipped') { stats.skipped++; }
        else { stats.errors++; }
      }
    }
  } catch { /* swallow — backup must not break the extension */ }
  return stats;
}

// Look in the backup for any named session that's missing from the live store
// and copy it back. Returns the list of restored session IDs.
function restoreMissingNamedSessions(): { restored: string[]; alreadyLive: number; backupMissing: string[] } {
  const restored: string[] = [];
  const backupMissing: string[] = [];
  let alreadyLive = 0;
  const names = loadNames();

  // Build set of live session IDs across the two stores
  const liveClaude = new Set<string>();
  for (const projDir of getClaudeProjectsSubDirs()) {
    try {
      for (const f of fs.readdirSync(projDir)) {
        if (f.endsWith('.jsonl')) { liveClaude.add(f.replace('.jsonl', '')); }
      }
    } catch { /* ignore */ }
  }
  const liveCodex = new Set<string>();
  if (fs.existsSync(CODEX_SESSIONS_DIR)) {
    for (const full of listCodexSessionFiles()) {
      const sid = getCodexSessionMeta(full).sessionId;
      if (sid) { liveCodex.add(sid); }
    }
  }

  for (const [sid, entry] of Object.entries(names)) {
    const tool: Tool = (entry.tool ?? 'claude') as Tool;
    const isLive = tool === 'claude' ? liveClaude.has(sid) : liveCodex.has(sid);
    if (isLive) { alreadyLive++; continue; }

    if (tool === 'claude') {
      // Search the claude backup tree for <id>.jsonl
      const claudeBackupRoot = path.join(NAMED_BACKUP_DIR, 'claude');
      if (!fs.existsSync(claudeBackupRoot)) { backupMissing.push(sid); continue; }
      let foundSrc: string | undefined;
      let foundProjName: string | undefined;
      for (const projName of fs.readdirSync(claudeBackupRoot)) {
        const candidate = path.join(claudeBackupRoot, projName, `${sid}.jsonl`);
        if (fs.existsSync(candidate)) {
          foundSrc = candidate;
          foundProjName = projName;
          break;
        }
      }
      if (!foundSrc || !foundProjName) { backupMissing.push(sid); continue; }
      const destDir = path.join(CLAUDE_PROJECTS_DIR, foundProjName);
      const destFile = path.join(destDir, `${sid}.jsonl`);
      try {
        fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(foundSrc, destFile);
        // Tool-results sidecar
        const trSrc = path.join(path.dirname(foundSrc), sid, 'tool-results');
        if (fs.existsSync(trSrc)) {
          copyDirRecursive(trSrc, path.join(destDir, sid, 'tool-results'));
        }
        restored.push(sid);
      } catch { backupMissing.push(sid); }
    } else {
      // Codex: search backup tree for rollout-*<id>*.jsonl
      const codexBackupRoot = path.join(NAMED_BACKUP_DIR, 'codex');
      if (!fs.existsSync(codexBackupRoot)) { backupMissing.push(sid); continue; }
      let foundSrc: string | undefined;
      let foundRel: string | undefined;
      const walk = (dir: string): void => {
        if (foundSrc) { return; }
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (foundSrc) { return; }
          const full = path.join(dir, e.name);
          if (e.isDirectory()) { walk(full); }
          else if (e.isFile() && e.name.includes(sid) && e.name.endsWith('.jsonl')) {
            foundSrc = full;
            foundRel = path.relative(codexBackupRoot, full);
          }
        }
      };
      try { walk(codexBackupRoot); } catch { /* ignore */ }
      if (!foundSrc || !foundRel) { backupMissing.push(sid); continue; }
      const destFile = path.join(CODEX_SESSIONS_DIR, foundRel);
      try {
        fs.mkdirSync(path.dirname(destFile), { recursive: true });
        fs.copyFileSync(foundSrc, destFile);
        restored.push(sid);
      } catch { backupMissing.push(sid); }
    }
  }

  return { restored, alreadyLive, backupMissing };
}

// ---- Tree items ----

class SessionItem extends vscode.TreeItem {
  constructor(
    public readonly session: SessionInfo,
    collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    const label = session.name || session.title.slice(0, 60);
    super(label, collapsibleState);

    const toolBadge = TOOL_LABEL[session.tool];
    this.tooltip = `${session.name ? '\u2b50 ' + session.name + '\n\n' : ''}${session.title}\n\nTool: ${toolBadge}\nID: ${session.sessionId}\nModified: ${new Date(session.mtime).toLocaleString()}`;
    this.description = new Date(session.mtime).toLocaleDateString();

    if (session.isNamed) {
      this.iconPath = new vscode.ThemeIcon('star-full', new vscode.ThemeColor('editorWarning.foreground'));
      this.contextValue = `named-${session.tool}`;
    } else {
      this.iconPath = new vscode.ThemeIcon(TOOL_ITEM_ICON[session.tool]);
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
        cwd: session.cwd,
      }],
    };
  }
}

// ---- Tree data provider ----

class SessionsProvider implements vscode.TreeDataProvider<SessionItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SessionItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly mode: 'named' | 'recent') {}

  refresh(): void { this._onDidChangeTreeData.fire(undefined); }

  getTreeItem(element: SessionItem): vscode.TreeItem { return element; }

  getChildren(): SessionItem[] {
    const all = getAllSessions(activeTool);
    const filtered = this.mode === 'named'
      ? all.filter(s => s.isNamed)
      : all.filter(s => !s.isNamed && !s.isTemplateOnly).slice(0, 30);
    return filtered.map(s => new SessionItem(s, vscode.TreeItemCollapsibleState.None));
  }
}

// ---- Globals ----

let activeTool: Tool = 'claude';
let namedProvider: SessionsProvider;
let recentProvider: SessionsProvider;
let namedView: vscode.TreeView<SessionItem>;
let recentView: vscode.TreeView<SessionItem>;
let extContext: vscode.ExtensionContext;

function refreshAll(): void {
  namedProvider.refresh();
  recentProvider.refresh();
}

function updateViewTitles(): void {
  const label = TOOL_LABEL[activeTool];
  if (namedView) { namedView.title = `${label} · Named`; }
  if (recentView) { recentView.title = `${label} · Recent`; }
}

async function setActiveTool(tool: Tool): Promise<void> {
  activeTool = tool;
  await extContext.globalState.update(ACTIVE_TOOL_KEY, tool);
  await vscode.commands.executeCommand('setContext', 'claudeSessionManager.activeTool', tool);
  updateViewTitles();
  refreshAll();
}

// ---- Commands ----

type SessionArg = { sessionId: string; tool: Tool; name?: string; title: string; cwd?: string };

// Normalize: inline buttons/menu pass the TreeItem; tree-item click passes the
// plain SessionArg we set in command.arguments. Both paths must resolve here.
function toSessionArg(arg: any): SessionArg | undefined {
  if (!arg) { return undefined; }
  if (typeof arg.sessionId === 'string') { return arg as SessionArg; }
  if (arg.session && typeof arg.session.sessionId === 'string') {
    return {
      sessionId: arg.session.sessionId,
      tool: arg.session.tool,
      name: arg.session.name,
      title: arg.session.title,
      cwd: arg.session.cwd,
    };
  }
  return undefined;
}

function shellQuote(s: string): string {
  if (IS_WINDOWS) {
    // Windows: wrap in double quotes and escape embedded ones
    return `"${s.replace(/"/g, '""')}"`;
  }
  // POSIX: single-quote, escape embedded single quotes
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function prefixCd(cwd: string | undefined, cmd: string): string {
  if (!cwd) { return cmd; }
  // Terminal is spawned with cwd already set, but the prefix is belt-and-
  // suspenders. On Windows use `;` (works in PowerShell 5.1+); on Unix `&&`.
  const sep = IS_WINDOWS ? ';' : '&&';
  return `cd ${shellQuote(cwd)} ${sep} ${cmd}`;
}

async function cmdNameSession(rawArg?: any): Promise<void> {
  const arg = toSessionArg(rawArg);
  const tool: Tool = arg?.tool ?? activeTool;
  let targetId = arg?.sessionId;

  if (!targetId) {
    const unnamed = getAllSessions(tool).filter(s => !s.isNamed).slice(0, 20);
    if (unnamed.length === 0) {
      vscode.window.showInformationMessage(`No unnamed ${tool} sessions to name.`);
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

  const target = getAllSessions(tool).find(s => s.sessionId === targetId);
  const title = target?.title ?? '';
  const names = loadNames();
  names[targetId] = { name: name.trim(), title, tool };
  saveNames(names);

  refreshAll();
  // New favorite — back it up right now so a future archive can't lose it
  backupNamedSessions();
  vscode.window.showInformationMessage(`Session named: ${name}`);
}

async function cmdRenameSession(rawArg: any): Promise<void> {
  const arg = toSessionArg(rawArg);
  if (!arg) { return; }
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

function buildResumeCommand(tool: Tool, bin: string, sessionId: string, auto = false): string {
  if (tool === 'codex') { return `${bin} resume ${sessionId}`; }
  if (auto) { return `${bin} --dangerously-skip-permissions --resume ${sessionId}`; }
  return `${bin} --resume ${sessionId}`;
}

function openResumeTerminal(arg: SessionArg, auto: boolean): void {
  const tool: Tool = arg.tool ?? 'claude';
  const bin = findBinary(tool);
  const cmd = prefixCd(arg.cwd, buildResumeCommand(tool, bin, arg.sessionId, auto));
  const labelText = arg.name || arg.title.slice(0, 40);
  const prefix = auto ? 'Auto' : TOOL_LABEL[tool];
  const terminal = vscode.window.createTerminal({
    name: `${prefix}: ${labelText}`,
    cwd: arg.cwd,
  });
  terminal.show();
  terminal.sendText(cmd);
}

async function cmdResumeSession(rawArg: any): Promise<void> {
  const arg = toSessionArg(rawArg);
  if (!arg) { return; }
  openResumeTerminal(arg, false);
}

async function cmdResumeSessionAuto(rawArg: any): Promise<void> {
  const arg = toSessionArg(rawArg);
  if (!arg) { return; }
  if (arg.tool === 'codex') {
    vscode.window.showWarningMessage('Auto mode only applies to Claude sessions.');
    return;
  }
  openResumeTerminal(arg, true);
}

async function cmdResumeSessionHappy(rawArg: any): Promise<void> {
  const arg = toSessionArg(rawArg);
  if (!arg) { return; }
  const tool: Tool = arg.tool ?? 'claude';

  // For named sessions, pass an initial prompt that asks the agent to set the
  // Happy chat title via the mcp__happy__change_title tool. Costs one short
  // turn, but our name shows up in the mobile client.
  let titlePrompt = '';
  if (arg.name) {
    // Escape double quotes and backslashes for safe embedding in the shell arg
    const safeName = arg.name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    titlePrompt = ` "Set this chat title to \\"${safeName}\\" by calling mcp__happy__change_title with title=\\"${safeName}\\". Reply with one line confirming the title was set."`;
  }

  const baseCmd = tool === 'claude'
    ? `happy claude --resume ${arg.sessionId}${titlePrompt}`
    : `happy codex resume ${arg.sessionId}${titlePrompt}`;
  const cmd = prefixCd(arg.cwd, baseCmd);
  const labelText = arg.name || arg.title.slice(0, 40);
  const terminal = vscode.window.createTerminal({
    name: `Happy ${TOOL_LABEL[tool]}: ${labelText}`,
    cwd: arg.cwd,
  });
  terminal.show();
  terminal.sendText(cmd);
}

async function cmdCopyResumeCommand(rawArg: any): Promise<void> {
  const arg = toSessionArg(rawArg);
  if (!arg) { return; }
  const tool: Tool = arg.tool ?? 'claude';
  const binName = tool === 'codex' ? 'codex' : 'claude';
  const cmd = buildResumeCommand(tool, binName, arg.sessionId, false);
  await vscode.env.clipboard.writeText(cmd);
  vscode.window.showInformationMessage(`Copied: ${cmd.slice(0, 80)}`);
}

async function cmdDeleteName(rawArg: any): Promise<void> {
  const arg = toSessionArg(rawArg);
  if (!arg) {
    vscode.window.showErrorMessage('Cannot identify session to remove.');
    return;
  }
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

async function cmdOpenSession(rawArg: any): Promise<void> {
  const arg = toSessionArg(rawArg);
  if (!arg) { return; }
  const tool: Tool = arg.tool ?? 'claude';
  const target = getAllSessions(tool).find(s => s.sessionId === arg.sessionId);
  if (target && fs.existsSync(target.filePath)) {
    const doc = await vscode.workspace.openTextDocument(target.filePath);
    await vscode.window.showTextDocument(doc);
  } else {
    vscode.window.showErrorMessage(`Session file not found for ${tool}: ${arg.sessionId}`);
  }
}

async function cmdBackupNamedSessions(): Promise<void> {
  const r = backupNamedSessions();
  vscode.window.showInformationMessage(
    `Named sessions backed up: ${r.copied} new/changed, ${r.skipped} unchanged${r.errors ? `, ${r.errors} errors` : ''}.`,
  );
}

async function cmdRestoreMissingNamed(): Promise<void> {
  const r = restoreMissingNamedSessions();
  const parts: string[] = [];
  if (r.restored.length) { parts.push(`Restored ${r.restored.length}`); }
  if (r.alreadyLive) { parts.push(`${r.alreadyLive} already live`); }
  if (r.backupMissing.length) { parts.push(`${r.backupMissing.length} not in backup`); }
  vscode.window.showInformationMessage(`Restore done: ${parts.join(' · ') || 'nothing to do'}.`);
  refreshAll();
}

async function cmdSwitchTool(): Promise<void> {
  const idx = TOOL_CYCLE.indexOf(activeTool);
  const next = TOOL_CYCLE[(idx + 1) % TOOL_CYCLE.length];
  await setActiveTool(next);
  vscode.window.setStatusBarMessage(`Switched to ${TOOL_LABEL[next]}`, 2000);
}

// ---- Activation ----

export function activate(context: vscode.ExtensionContext): void {
  extContext = context;
  const stored = context.globalState.get<Tool>(ACTIVE_TOOL_KEY);
  activeTool = TOOL_CYCLE.includes(stored as Tool) ? (stored as Tool) : 'claude';

  namedProvider = new SessionsProvider('named');
  recentProvider = new SessionsProvider('recent');

  namedView = vscode.window.createTreeView('claudeSessionsNamed', { treeDataProvider: namedProvider });
  recentView = vscode.window.createTreeView('claudeSessionsRecent', { treeDataProvider: recentProvider });

  updateViewTitles();
  vscode.commands.executeCommand('setContext', 'claudeSessionManager.activeTool', activeTool);

  context.subscriptions.push(
    namedView,
    recentView,
    vscode.commands.registerCommand('claude-sessions.refresh', refreshAll),
    vscode.commands.registerCommand('claude-sessions.nameSession', cmdNameSession),
    vscode.commands.registerCommand('claude-sessions.renameSession', cmdRenameSession),
    vscode.commands.registerCommand('claude-sessions.resumeSession', cmdResumeSession),
    vscode.commands.registerCommand('claude-sessions.resumeSessionAuto', cmdResumeSessionAuto),
    vscode.commands.registerCommand('claude-sessions.resumeSessionHappy', cmdResumeSessionHappy),
    vscode.commands.registerCommand('claude-sessions.copyResumeCommand', cmdCopyResumeCommand),
    vscode.commands.registerCommand('claude-sessions.deleteName', cmdDeleteName),
    vscode.commands.registerCommand('claude-sessions.openSessionFolder', cmdOpenSession),
    vscode.commands.registerCommand('claude-sessions.switchTool', cmdSwitchTool),
    vscode.commands.registerCommand('claude-sessions.backupNamed', cmdBackupNamedSessions),
    vscode.commands.registerCommand('claude-sessions.restoreMissing', cmdRestoreMissingNamed),
  );

  // Auto-backup on activation, then every BACKUP_INTERVAL_MS.
  // Run the first pass async so activation isn't blocked.
  setTimeout(() => { backupNamedSessions(); }, 2000);
  const interval = setInterval(() => { backupNamedSessions(); }, BACKUP_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(interval) });
}

export function deactivate(): void {}
