/**
 * PiRpcManager — manages a pi --mode rpc child process.
 *
 * Handles spawning, JSON Lines stdin/stdout protocol, auto-restart,
 * command queueing, and proper cleanup.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PiRpcManagerOptions {
  /** Path to the executable (default: 'pi') */
  command?: string;
  /** CLI arguments (default: ['--mode', 'rpc']) */
  args?: string[];
  /** Working directory for the process */
  cwd?: string;
  /** Environment variables to pass */
  env?: Record<string, string>;
  /** Delay before restarting a crashed process (ms, default: 2000) */
  restartDelay?: number;
  /** Maximum spawn attempts before giving up (default: 3) */
  maxSpawnAttempts?: number;
}

export interface RpcResponse {
  id?: string;
  type: 'response';
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface PromptResult {
  text: string;
  success: boolean;
  raw: RpcResponse;
}

/** Structured event emitted during streaming. */
export interface StreamEvent {
  /** Event type: text update, thinking/reasoning, tool call, or tool result */
  type: 'text' | 'thinking' | 'tool_call' | 'tool_result';
  /** Accumulated plain-text content (for type 'text') */
  text?: string;
  /** Tool name (for type 'tool_call' / 'tool_result') */
  toolName?: string;
  /** Tool input as JSON string (for type 'tool_call') */
  toolInput?: string;
  /** Tool result summary (for type 'tool_result') */
  toolResult?: string;
  /** Thinking/reasoning text (for type 'thinking') */
  thinking?: string;
}

export interface PiRpcEvents {
  started: [];
  stopped: [code: number | null, signal: string | null];
  unhandled: [event: Record<string, unknown>];
  error: [err: Error];
}

// ---------------------------------------------------------------------------
// Internal types for command queue
// ---------------------------------------------------------------------------

interface QueuedRequest {
  type: 'prompt' | 'command';
  cmdId: string;
  commandType: string;
  payload: Record<string, unknown>;
  textAccumulator: string;
  timer: ReturnType<typeof setTimeout> | null;
  resolve: (result: any) => void;
  reject: (err: Error) => void;
  timeout: number;
  /** Called on each content update with structured event */
  onUpdate?: (event: StreamEvent) => void;
  /** Track emitted tool_use IDs to avoid duplicates */
  emittedToolIds: Set<string>;
}

// ---------------------------------------------------------------------------
// PiRpcManager
// ---------------------------------------------------------------------------

export class PiRpcManager {
  private proc: ChildProcess | null = null;
  private readonly command: string;
  private readonly args: string[];
  private readonly cwd: string | undefined;
  private readonly env: Record<string, string> | undefined;
  private readonly restartDelay: number;
  private readonly maxSpawnAttempts: number;
  private _running = false;
  private _stopping = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private spawnAttempts = 0;

  // Buffered stdout line processing
  private lineBuffer = '';
  private readonly emitter = new EventEmitter();

  // Command queue (processed serially)
  private readonly queue: QueuedRequest[] = [];
  private processing = false;

  constructor(options: PiRpcManagerOptions = {}) {
    // On Windows, npm-installed global commands are .cmd files
    const defaultCommand = process.platform === 'win32' ? 'pi.cmd' : 'pi';
    this.command = options.command ?? defaultCommand;
    this.args = options.args ?? ['--mode', 'rpc'];
    this.cwd = options.cwd;
    this.env = options.env;
    this.restartDelay = options.restartDelay ?? 2000;
    this.maxSpawnAttempts = options.maxSpawnAttempts ?? 3;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Start the pi RPC process. Resolves once the process is ready. */
  async start(): Promise<void> {
    if (this._running || this.proc) return;
    if (this._stopping) throw new Error('Cannot start while stopping');

    this.spawnAttempts = 0;
    await this.spawnWithRetry();
  }

  /** Gracefully stop the pi RPC process and cancel all pending requests. */
  async stop(): Promise<void> {
    this._stopping = true;
    this._running = false;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    // Reject all queued requests
    this.drainQueue(new Error('Shutting down'));

    if (this.proc) {
      const proc = this.proc;
      this.proc = null;

      if (!proc.killed) {
        try { proc.stdin?.end(); } catch { /* ignore */ }

        // Wait for graceful exit, then force kill
        await new Promise<void>((resolve) => {
          proc.on('exit', () => resolve());
          setTimeout(() => resolve(), 3000);
        });

        try {
          if (!proc.killed) proc.kill();
        } catch { /* ignore */ }
      }
    }
  }

  /** Whether the process is currently running. */
  isRunning(): boolean {
    return this._running && this.proc !== null && this.proc.exitCode === null;
  }

  // -----------------------------------------------------------------------
  // Stdin commands
  // -----------------------------------------------------------------------

  /**
   * Send a prompt to pi and wait for the full response text.
   * Streams structured events (text, thinking, tool_call, tool_result)
   * via onUpdate callback.
   */
  sendPrompt(
    message: string,
    timeout = 60000,
    onUpdate?: (event: StreamEvent) => void,
  ): Promise<PromptResult> {
    return new Promise<PromptResult>((resolve, reject) => {
      const cmdId = this.nextId();
      this.enqueue({
        type: 'prompt',
        cmdId,
        commandType: 'prompt',
        payload: { id: cmdId, type: 'prompt', message },
        textAccumulator: '',
        timer: this.createTimer(cmdId, timeout, reject),
        resolve: resolve as (result: any) => void,
        reject,
        timeout,
        onUpdate,
        emittedToolIds: new Set(),
      });
    });
  }

  /**
   * Send a raw RPC command (e.g., new_session, get_state).
   * Returns the response object.
   */
  sendCommand(type: string, payload?: Record<string, unknown>, timeout = 10000): Promise<RpcResponse> {
    return new Promise<RpcResponse>((resolve, reject) => {
      const cmdId = this.nextId();
      this.enqueue({
        type: 'command',
        cmdId,
        commandType: type,
        payload: { id: cmdId, type, ...payload },
        textAccumulator: '',
        timer: this.createTimer(cmdId, timeout, reject),
        resolve: resolve as (result: any) => void,
        reject,
        timeout,
        emittedToolIds: new Set(),
      });
    });
  }

  // -----------------------------------------------------------------------
  // Events
  // -----------------------------------------------------------------------

  /** Subscribe to lifecycle events. Returns an unsubscribe function. */
  on<E extends keyof PiRpcEvents>(event: E, listener: (...args: PiRpcEvents[E]) => void): () => void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return () => { this.emitter.off(event, listener as (...args: unknown[]) => void); };
  }

  // -----------------------------------------------------------------------
  // Internal — Command Queue
  // -----------------------------------------------------------------------

  private enqueue(request: QueuedRequest): void {
    this.queue.push(request);
    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const request = this.queue.shift()!;

      try {
        // Ensure process is running
        if (!this.isRunning()) {
          try {
            await this.start();
          } catch {
            request.reject(new Error('Pi RPC process unavailable'));
            continue;
          }
        }

        await this.executeRequest(request);
      } catch (err) {
        request.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }

    this.processing = false;
  }

  private async executeRequest(request: QueuedRequest): Promise<void> {
    return new Promise<void>((resolveExec) => {
      // Set as current active request for line handling
      const handler = (line: Record<string, unknown>) => {
        const type = line.type as string | undefined;

        if (type === 'message_update') {
          this.processMessageUpdate(line, request);
          return;
        }

        if (type === 'response') {
          const response = line as unknown as RpcResponse;
          // Match by id or command type
          if (response.id === request.cmdId || response.command === request.commandType) {
            if (!response.success) {
              // Command rejected — fail immediately
              cleanup();
              if (request.timer) clearTimeout(request.timer);
              request.reject(new Error(response.error ?? `Command ${response.command} failed`));
              resolveExec();
              return;
            }

            // For prompts, the response only means "accepted" — the real
            // work streams via message_update/agent_end. Don't resolve yet.
            if (request.type !== 'prompt') {
              cleanup();
              if (request.timer) clearTimeout(request.timer);
              (request.resolve as (r: RpcResponse) => void)(response);
              resolveExec();
            }
          }
          return;
        }

        // agent_end signals stream completion for prompts
        if (type === 'agent_end' && request.type === 'prompt') {
          cleanup();
          if (request.timer) clearTimeout(request.timer);
          (request.resolve as (r: PromptResult) => void)({
            text: request.textAccumulator || '',
            success: true,
            raw: { type: 'response', command: request.commandType, success: true } as RpcResponse,
          });
          resolveExec();
          return;
        }
      };

      const cleanup = () => {
        this.emitter.off('unhandled', handler);
      };

      this.emitter.on('unhandled', handler);

      // Write the command to stdin
      try {
        this.writeLine(request.payload);
      } catch (err) {
        cleanup();
        request.reject(err instanceof Error ? err : new Error(String(err)));
        resolveExec();
        return;
      }
    });
  }

  /**
   * Process a message_update event.
   * Extracts text, thinking, and tool_use blocks and emits structured
   * StreamEvents via the onUpdate callback.
   */
  private processMessageUpdate(
    obj: Record<string, unknown>,
    request: QueuedRequest,
  ): void {
    const message = obj.message as Record<string, unknown> | undefined;
    if (!message?.content) return;

    const content = message.content as Array<Record<string, unknown>>;
    let newFullText = '';
    const events: StreamEvent[] = [];

    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        newFullText += block.text;
      } else if (block.type === 'tool_use') {
        const toolId = block.id as string | undefined;
        // Only emit each tool_use once (id stabilises after first appearance)
        if (toolId && !request.emittedToolIds.has(toolId)) {
          request.emittedToolIds.add(toolId);
          events.push({
            type: 'tool_call',
            toolName: block.name as string | undefined ?? 'unknown',
            toolInput: JSON.stringify(block.input ?? {}),
          });
        }
      } else if (block.type === 'tool_result') {
        events.push({
          type: 'tool_result',
          toolName: 'unknown',
          toolResult: 'completed',
        });
      } else if (block.type === 'thinking' && typeof block.text === 'string') {
        events.push({ type: 'thinking', thinking: block.text });
      }
    }

    // Emit text update if accumulated text grew
    if (newFullText.length > request.textAccumulator.length) {
      request.textAccumulator = newFullText;
      events.unshift({ type: 'text', text: newFullText });
    }

    // Fire all events through the callback
    if (request.onUpdate) {
      for (const event of events) {
        request.onUpdate(event);
      }
    }
  }

  /** Drain all queued requests with an error */
  private drainQueue(err: Error): void {
    while (this.queue.length > 0) {
      const req = this.queue.shift()!;
      if (req.timer) clearTimeout(req.timer);
      req.reject(err);
    }
  }

  // -----------------------------------------------------------------------
  // Internal — Process Management
  // -----------------------------------------------------------------------

  private async spawnWithRetry(): Promise<void> {
    while (this.spawnAttempts < this.maxSpawnAttempts && !this._stopping) {
      this.spawnAttempts++;
      try {
        await this.spawn();
        this.spawnAttempts = 0;
        return;
      } catch (err) {
        this.emitter.emit('error', err instanceof Error ? err : new Error(String(err)));
        if (this.spawnAttempts >= this.maxSpawnAttempts || this._stopping) {
          throw err;
        }
        // Wait before retry
        await new Promise((r) => setTimeout(r, this.restartDelay));
      }
    }
  }

  private async spawn(): Promise<void> {
    if (this._stopping) throw new Error('Stopping');

    // On Windows, .cmd/.bat files cannot be spawned directly — they must
    // be executed through cmd.exe. Node v24+ enforces this (spawn EINVAL).
    const isWindowsCmd = process.platform === 'win32' &&
      (this.command.toLowerCase().endsWith('.cmd') || this.command.toLowerCase().endsWith('.bat'));
    const spawnCommand = isWindowsCmd ? (process.env.ComSpec || 'cmd.exe') : this.command;
    const spawnArgs = isWindowsCmd
      ? ['/d', '/s', '/c', `${this.command} ${this.args.join(' ')}`]
      : this.args;

    const proc = spawn(spawnCommand, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      windowsHide: true,
    });

    this.proc = proc;

    // Process stdout
    proc.stdout!.setEncoding('utf-8');
    proc.stdout!.on('data', (data: string) => {
      this.lineBuffer += data;
      this.processLines();
    });

    // Process stderr (just log for debugging)
    proc.stderr!.setEncoding('utf-8');
    proc.stderr!.on('data', (data: string) => {
      process.stderr.write(`[pi stderr] ${data}`);
    });

    // Wait for the process to become ready (stay alive for 500ms)
    await new Promise<void>((resolve, reject) => {
      const exitHandler = (code: number | null) => {
        cleanup();
        this._running = false;
        this.proc = null;
        reject(new Error(`Process exited with code ${code} immediately after spawn`));
      };

      const errorHandler = (err: Error) => {
        cleanup();
        this._running = false;
        this.proc = null;
        reject(err);
      };

      const cleanup = () => {
        proc.off('exit', exitHandler);
        proc.off('error', errorHandler);
      };

      proc.on('exit', exitHandler);
      proc.on('error', errorHandler);

      // Check after a short delay
      setTimeout(() => {
        cleanup();
        if (proc.exitCode === null) {
          this._running = true;

          // Attach permanent handlers
          proc.on('exit', (code, signal) => {
            if (this.proc === proc) {
              this._running = false;
              this.proc = null;
              this.drainQueue(new Error(`Process exited with code ${code ?? signal ?? 'unknown'}`));
              this.emitter.emit('stopped', code, signal);

              if (!this._stopping) {
                this.scheduleRestart();
              }
            }
          });

          proc.on('error', (err) => {
            this.emitter.emit('error', err);
          });

          this.emitter.emit('started');
          resolve();
        }
        // If process already exited, the exit handler above will reject
      }, 500);
    });
  }

  private scheduleRestart(): void {
    if (this._stopping || this.restartTimer) return;

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this._stopping) {
        this.spawnAttempts = 0;
        this.spawnWithRetry().catch((err) => {
          this.emitter.emit('error', err instanceof Error ? err : new Error(String(err)));
        });
      }
    }, this.restartDelay);
  }

  // -----------------------------------------------------------------------
  // Internal — Line Processing
  // -----------------------------------------------------------------------

  private processLines(): void {
    const lines = this.lineBuffer.split('\n');
    this.lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const obj = JSON.parse(trimmed);
        this.handleLine(obj);
      } catch {
        // Skip invalid JSON
      }
    }
  }

  private handleLine(obj: Record<string, unknown>): void {
    const type = obj.type as string | undefined;

    // Forward events that serialised request handlers process
    if (type === 'response' || type === 'message_update' || type === 'agent_end') {
      this.emitter.emit('unhandled', obj);
      return;
    }

    // Known event types we ignore
    if (
      type === 'agent_start' ||
      type === 'turn_start' ||
      type === 'turn_end' ||
      type === 'message_start' ||
      type === 'message_end' ||
      type === '_ready'
    ) {
      return;
    }
  }

  // -----------------------------------------------------------------------
  // Internal — Helpers
  // -----------------------------------------------------------------------

  private writeLine(obj: unknown): void {
    if (!this.proc?.stdin?.writable) {
      throw new Error('Pi RPC process not running');
    }
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  private createTimer(cmdId: string, timeout: number, reject: (err: Error) => void): ReturnType<typeof setTimeout> | null {
    if (timeout <= 0) return null;
    return setTimeout(() => {
      // Remove from queue if still pending
      const idx = this.queue.findIndex((r) => r.cmdId === cmdId);
      if (idx !== -1) {
        this.queue.splice(idx, 1);
      }
      reject(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);
  }

  private idCounter = 0;
  private nextId(): string {
    return `req_${++this.idCounter}_${Date.now()}`;
  }
}
