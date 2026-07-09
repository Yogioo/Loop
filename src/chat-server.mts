/**
 * ChatServer — Express HTTP server with pi RPC bridge.
 *
 * Provides a browser-based chat UI that communicates with pi via stdin/stdout
 * JSON Lines RPC protocol.
 */

import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { PiRpcManager } from './pi-rpc.mts';
import { execSync } from 'node:child_process';

// Injected by esbuild at build time (undefined in dev/tsx mode)
declare const __SKILL_GRILL_ME: string | undefined;
declare const __SKILL_TO_PRD: string | undefined;
declare const __SKILL_TO_ISSUES: string | undefined;

// ---------------------------------------------------------------------------
// Paths
// In CJS (SEA bundle), __dirname is a built-in global; in ESM (tsx) we compute it.
const __dirname: string = (() => {
  // @ts-expect-error — CJS global, only available in bundled build
  if (typeof __dirname !== 'undefined') return __dirname;
  return path.dirname(fileURLToPath(import.meta.url));
})();
const PUBLIC_DIR = path.resolve(__dirname, 'public');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatServerOptions {
  /** Port to listen on (default: 0 = random available port) */
  port?: number;
  /** Path to the pi executable (default: 'pi') */
  piCommand?: string;
  /** Additional arguments for the pi process */
  piArgs?: string[];
  /** Environment variables for the pi process */
  piEnv?: Record<string, string>;
  /** Whether to automatically open the browser (default: true) */
  autoOpen?: boolean;
  /** Working directory for the pi process */
  cwd?: string;
}

export interface ChatServerResult {
  server: http.Server;
  port: number;
  manager: PiRpcManager;
}

// ---------------------------------------------------------------------------
// ChatServer factory
// ---------------------------------------------------------------------------

/**
 * Create and start a chat server.
 *
 * Returns the HTTP server, port, and PiRpcManager for lifecycle management.
 */
export async function createChatServer(options: ChatServerOptions = {}): Promise<ChatServerResult> {
  const app = express();
  const port = options.port ?? 0;

  // Parse JSON bodies
  app.use(express.json());

  // Skills — embedded at build time; reads from disk in dev mode (tsx)
  // Write to temp files to avoid Windows command-line multi-line escaping issues
  const writeTempSkill = (name: string, content: string) => {
    const tmp = path.join(os.tmpdir(), `loop-skill-${name}-${Date.now()}.md`);
    fs.writeFileSync(tmp, content, 'utf-8');
    return tmp;
  };
  const getSkill = (name: string, embedded?: string) => {
    if (embedded) return writeTempSkill(name, embedded);
    const p = path.join(path.resolve(__dirname, '..', 'skills'), name, 'SKILL.md');
    if (fs.existsSync(p)) return p;
    return writeTempSkill(name, `skill ${name} not found`);
  };

  // Create PiRpcManager
  const manager = new PiRpcManager({
    // On Windows, npm-installed global commands are .cmd files
    command: options.piCommand ?? (process.platform === 'win32' ? 'pi.cmd' : 'pi'),
    args: options.piArgs ?? [
      '--mode', 'rpc',
      '--append-system-prompt', getSkill('grill-me', __SKILL_GRILL_ME),
      '--skill',             getSkill('to-prd',   __SKILL_TO_PRD),
      '--skill',             getSkill('to-issues', __SKILL_TO_ISSUES),
    ],
    cwd: options.cwd,
    env: options.piEnv,
    restartDelay: 2000,
  });

  const toErrorMessage = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);

  // -----------------------------------------------------------------------
  // Routes
  // -----------------------------------------------------------------------

  // Declare build-time embedded HTML (injected by esbuild in exe builds)
  // @ts-expect-error — only defined in bundled builds
  declare const __INDEX_HTML: string | undefined;

  // Serve the HTML chat page
  app.get('/', (_req, res) => {
    const htmlPath = path.resolve(PUBLIC_DIR, 'index.html');
    let html: string;
    if (fs.existsSync(htmlPath)) {
      html = fs.readFileSync(htmlPath, 'utf-8');
    } else if (typeof __INDEX_HTML !== 'undefined') {
      html = __INDEX_HTML;
    } else {
      html = getInlineHtml();
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  });

  // Health check
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      piRunning: manager.isRunning(),
    });
  });

  // Handle chat messages — streams response via SSE so the frontend
  // can show text as it arrives (like ChatGPT-style progressive output).
  app.post('/chat', async (req, res) => {
    try {
      const { message } = req.body;

      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        res.status(400).json({ error: 'Missing or empty "message" field' });
        return;
      }

      // Ensure pi process is running
      if (!manager.isRunning()) {
        try {
          await manager.start();
        } catch {
          res.status(503).json({ error: 'Pi RPC process unavailable' });
          return;
        }
      }

      // Switch to SSE streaming
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      const result = await manager.sendPrompt(message, 0, (text) => {
        res.write(`data: ${JSON.stringify({ type: 'update', text })}\n\n`);
      });

      res.write(`data: ${JSON.stringify({ type: 'done', text: result.text })}\n\n`);
      res.end();
    } catch (err) {
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ type: 'error', error: toErrorMessage(err) })}\n\n`);
        res.end();
      } else {
        res.status(500).json({ error: toErrorMessage(err) });
      }
    }
  });

  // New session endpoint
  app.post('/new-session', async (_req, res) => {
    try {
      const result = await manager.sendCommand('new_session');
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: toErrorMessage(err) });
    }
  });

  // -----------------------------------------------------------------------
  // Start
  // -----------------------------------------------------------------------

  // Start pi RPC process
  try {
    await manager.start();
  } catch (err) {
    // If pi isn't installed, we'll still serve the page but chat will fail
    console.warn('Failed to start pi RPC process:', toErrorMessage(err));
  }

  return new Promise<ChatServerResult>((resolve) => {
    const server = app.listen(port, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : 0;

      const url = `http://localhost:${actualPort}`;

      // Open browser
      if (options.autoOpen !== false) {
        openBrowser(url);
      }

      console.log(`Chat server running at ${url}`);
      if (!manager.isRunning()) {
        console.log('Note: pi RPC process not started. Chat endpoint will return errors until pi is available.');
      }

      resolve({ server, port: actualPort, manager });
    });
  });
}

// ---------------------------------------------------------------------------
// Browser opening
// ---------------------------------------------------------------------------

function openBrowser(url: string): void {
  const platform = process.platform;
  try {
    if (platform === 'win32') {
      execSync(`start "" "${url}"`, { timeout: 5000, windowsHide: true });
    } else if (platform === 'darwin') {
      execSync(`open "${url}"`, { timeout: 5000 });
    } else {
      execSync(`xdg-open "${url}"`, { timeout: 5000 });
    }
  } catch {
    // Browser opening is a nice-to-have, not critical
  }
}

// ---------------------------------------------------------------------------
// Fallback inline HTML
// ---------------------------------------------------------------------------

function getInlineHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Loop Chat</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #e0e0e0; display: flex; flex-direction: column; height: 100vh; }
  #header { background: #16213e; padding: 16px 24px; border-bottom: 1px solid #0f3460; }
  #header h1 { font-size: 18px; font-weight: 600; }
  #messages { flex: 1; overflow-y: auto; padding: 16px 24px; display: flex; flex-direction: column; gap: 12px; }
  .message { padding: 10px 14px; border-radius: 8px; max-width: 80%; line-height: 1.5; white-space: pre-wrap; }
  .message.user { background: #0f3460; align-self: flex-end; }
  .message.pi { background: #16213e; align-self: flex-start; border: 1px solid #0f3460; }
  .message.error { background: #3d0000; align-self: flex-start; border: 1px solid #6b0000; color: #ff6b6b; }
  .message.pi.streaming::after { content: ' ▌'; animation: blink 1s step-end infinite; }
  .message.pi.streaming.done::after { content: none; }
  @keyframes blink { 50% { opacity: 0; } }
  #input-area { display: flex; gap: 8px; padding: 12px 24px; background: #16213e; border-top: 1px solid #0f3460; }
  #input { flex: 1; padding: 10px 14px; border: 1px solid #0f3460; border-radius: 6px; background: #1a1a2e; color: #e0e0e0; font-size: 14px; outline: none; }
  #input:focus { border-color: #4a90d9; }
  #send-btn { padding: 10px 20px; background: #4a90d9; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; }
  #send-btn:hover { background: #357abd; }
  #send-btn:disabled { background: #555; cursor: not-allowed; }
  .skill-btn { padding: 8px 14px; background: transparent; color: #888; border: 1px solid #444; border-radius: 6px; cursor: pointer; font-size: 12px; white-space: nowrap; }
  .skill-btn:hover { color: #e0e0e0; border-color: #4a90d9; }
  .skill-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  #status { font-size: 12px; padding: 4px 24px; color: #888; }
</style>
</head>
<body>
<div id="header"><h1>Loop Chat</h1></div>
<div id="messages"></div>
<div id="input-area">
  <button class="skill-btn" onclick="sendSkill('to-prd')" title="生成 PRD">📋 PRD</button>
  <button class="skill-btn" onclick="sendSkill('to-issues')" title="拆成 Issues">📝 Issues</button>
  <input type="text" id="input" placeholder="Type your message..." autofocus>
  <button id="send-btn" onclick="send()">Send</button>
</div>
<div id="status">Ready</div>
<script>
  const input = document.getElementById('input');
  const messages = document.getElementById('messages');
  const sendBtn = document.getElementById('send-btn');
  const status = document.getElementById('status');

  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

  function sendSkill(name) { if (!loading) sendMessage('/skill:' + name); }

  function send() {
    const text = input.value.trim();
    if (!text || loading) return;
    input.value = '';
    sendMessage(text);
  }

  async function sendMessage(text) {
    addMessage(text, 'user');
    setLoading(true);

    const bubble = document.createElement('div');
    bubble.className = 'message pi streaming';
    bubble.textContent = 'Thinking...';
    messages.appendChild(bubble);
    messages.scrollTop = messages.scrollHeight;

    let fullText = '';
    let firstUpdate = true;

    try {
      const res = await fetch('/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: text }) });
      if (!res.ok) { bubble.remove(); setLoading(false); return; }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'update') {
              if (firstUpdate) { firstUpdate = false; bubble.textContent = ''; }
              bubble.textContent = data.text;
              messages.scrollTop = messages.scrollHeight;
              fullText = data.text;
            } else if (data.type === 'done') { fullText = data.text || fullText; }
            else if (data.type === 'error') { bubble.remove(); addMessage(data.error, 'error'); setLoading(false); return; }
          } catch { /* skip */ }
        }
      }

      bubble.textContent = fullText || bubble.textContent;
      bubble.classList.add('done');
    } catch (err) { if (bubble.parentNode) { bubble.remove(); addMessage('Network error: ' + err.message, 'error'); } }
    finally { setLoading(false); }
  }

  function addMessage(text, cls) {
    const div = document.createElement('div');
    div.className = 'message ' + cls;
    div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }

  function setLoading(loading) {
    sendBtn.disabled = loading;
    sendBtn.textContent = loading ? 'Sending...' : 'Send';
    status.textContent = loading ? 'Waiting for pi...' : 'Ready';
  }
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main entry point (when run directly)
// ---------------------------------------------------------------------------

// Only run as main when executed directly (tsx / node / SEA exe).
// In CJS/SEA context, import.meta is unavailable so we use a fallback.
const isCjs = typeof __dirname !== 'undefined' && typeof require !== 'undefined';
const isMain = isCjs || (process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith('chat-server.mts') ||
  process.argv[1].endsWith('chat-server.js')
));

if (isMain) {
  // 解析目标目录：--target <dir> / 拖拽的文件夹 / 当前目录
  const args = process.argv.slice(2);
  const targetIdx = args.indexOf('--target');
  const barePath = args.find(a => !a.startsWith('-') && fs.existsSync(a) && fs.statSync(a).isDirectory());
  let cwd: string | undefined;
  if (targetIdx !== -1) {
    cwd = path.resolve(args[targetIdx + 1] ?? '.');
  } else if (barePath) {
    cwd = path.resolve(barePath);
  } else {
    cwd = process.cwd();
  }

  console.log(`Target directory: ${cwd}`);

  createChatServer({ cwd }).catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
