/**
 * ChatServer — Express HTTP server with pi RPC bridge.
 *
 * Provides a browser-based chat UI that communicates with pi via stdin/stdout
 * JSON Lines RPC protocol.
 */

import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { PiRpcManager } from './pi-rpc.mts';
import { execSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

  // Create PiRpcManager
  const manager = new PiRpcManager({
    // On Windows, npm-installed global commands are .cmd files
    command: options.piCommand ?? (process.platform === 'win32' ? 'pi.cmd' : 'pi'),
    args: options.piArgs ?? ['--mode', 'rpc'],
    cwd: options.cwd,
    env: options.piEnv,
    restartDelay: 2000,
  });

  const toErrorMessage = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);

  // -----------------------------------------------------------------------
  // Routes
  // -----------------------------------------------------------------------

  // Serve the HTML chat page
  app.get('/', (_req, res) => {
    const htmlPath = path.resolve(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(htmlPath)) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.sendFile(htmlPath);
    } else {
      res.status(200).type('html').send(getInlineHtml());
    }
  });

  // Health check
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      piRunning: manager.isRunning(),
    });
  });

  // Handle chat messages
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

      const result = await manager.sendPrompt(message, 120000);
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.status(200).send(result.text);
    } catch (err) {
      res.status(500).json({ error: toErrorMessage(err) });
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
  #input-area { display: flex; gap: 8px; padding: 12px 24px; background: #16213e; border-top: 1px solid #0f3460; }
  #input { flex: 1; padding: 10px 14px; border: 1px solid #0f3460; border-radius: 6px; background: #1a1a2e; color: #e0e0e0; font-size: 14px; outline: none; }
  #input:focus { border-color: #4a90d9; }
  #send-btn { padding: 10px 20px; background: #4a90d9; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; }
  #send-btn:hover { background: #357abd; }
  #send-btn:disabled { background: #555; cursor: not-allowed; }
  #status { font-size: 12px; padding: 4px 24px; color: #888; }
</style>
</head>
<body>
<div id="header"><h1>Loop Chat</h1></div>
<div id="messages">
  <div class="message pi">Hi! I'm pi. How can I help you?</div>
</div>
<div id="input-area">
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

  async function send() {
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    addMessage(text, 'user');
    setLoading(true);

    try {
      const res = await fetch('/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: text }) });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        addMessage(err.error || 'Request failed', 'error');
      } else {
        const reply = await res.text();
        addMessage(reply || '(empty response)', 'pi');
      }
    } catch (err) {
      addMessage('Network error: ' + err.message, 'error');
    } finally {
      setLoading(false);
    }
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

// Only run as main when executed directly via tsx or node
const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith('chat-server.mts') ||
  process.argv[1].endsWith('chat-server.js')
);

if (isMain) {
  createChatServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
