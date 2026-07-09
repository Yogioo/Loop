import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { PiRpcManager, type PromptResult, type StreamEvent } from '../pi-rpc.mts';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PI_PATH = path.resolve(__dirname, 'helpers', 'mock-pi-rpc.mjs');

describe('PiRpcManager', () => {
  let manager: PiRpcManager;

  afterEach(async () => {
    if (manager) {
      await manager.stop().catch(() => {});
    }
  });

  it('should start and stop successfully', async () => {
    manager = new PiRpcManager({
      command: 'node',
      args: [MOCK_PI_PATH],
    });
    await manager.start();
    expect(manager.isRunning()).toBe(true);
    await manager.stop();
    expect(manager.isRunning()).toBe(false);
  });

  it('should send a prompt and return the response text', async () => {
    manager = new PiRpcManager({
      command: 'node',
      args: [MOCK_PI_PATH],
      env: { MOCK_PI_RESPONSE: 'Hello from test!' },
    });
    await manager.start();

    const events: StreamEvent[] = [];
    const result = await manager.sendPrompt('Test message', 10000, (e) => events.push(e)) as PromptResult;
    expect(result.text).toBe('You said: Test message');
    expect(result.success).toBe(true);
    // Should have received text update events
    const textEvents = events.filter(e => e.type === 'text');
    expect(textEvents.length).toBeGreaterThan(0);
    expect(textEvents[textEvents.length - 1].text).toBe('You said: Test message');

    await manager.stop();
  });

  it('should handle new session command', async () => {
    manager = new PiRpcManager({
      command: 'node',
      args: [MOCK_PI_PATH],
    });
    await manager.start();

    const result = await manager.sendCommand('new_session');
    expect(result.success).toBe(true);

    await manager.stop();
  });

  it('should auto-restart on process crash', async () => {
    manager = new PiRpcManager({
      command: 'node',
      args: [MOCK_PI_PATH],
      restartDelay: 1000,
      env: { MOCK_PI_SHUTDOWN_AFTER: '1' },
    });
    await manager.start();
    expect(manager.isRunning()).toBe(true);

    // Send a prompt - the mock process will exit after handling it
    // The sendPrompt should reject because the process dies
    await manager.sendPrompt('Will crash').catch(() => {
      // Expected: process crashed, prompt failed
    });

    // Wait for auto-restart
    await new Promise((resolve) => setTimeout(resolve, 2500));

    // Should have restarted
    expect(manager.isRunning()).toBe(true);

    // Should be able to send another prompt after restart
    const result = await manager.sendPrompt('After restart') as PromptResult;
    expect(result.text).toContain('After restart');

    await manager.stop();
  });

  it('should handle queue of prompts in order', async () => {
    manager = new PiRpcManager({
      command: 'node',
      args: [MOCK_PI_PATH],
    });
    await manager.start();

    // Send all three, process in order (queue handles serialization)
    const results = await Promise.all([
      manager.sendPrompt('One').then((r) => (r as PromptResult).text),
      manager.sendPrompt('Two').then((r) => (r as PromptResult).text),
      manager.sendPrompt('Three').then((r) => (r as PromptResult).text),
    ]);

    expect(results[0]).toContain('One');
    expect(results[1]).toContain('Two');
    expect(results[2]).toContain('Three');

    await manager.stop();
  });

  it('should emit text events during streaming', async () => {
    manager = new PiRpcManager({
      command: 'node',
      args: [MOCK_PI_PATH],
    });
    await manager.start();

    const events: StreamEvent[] = [];
    const result = await manager.sendPrompt('Stream test', 10000, (e) => events.push(e)) as PromptResult;
    
    expect(result.success).toBe(true);
    expect(result.text).toContain('Stream test');
    // At minimum we should get a text event
    expect(events.some(e => e.type === 'text')).toBe(true);

    await manager.stop();
  });

  it('should reject command if process is stopped', async () => {
    manager = new PiRpcManager({
      command: 'node',
      args: ['-e', 'process.exit(1)'],
      restartDelay: 500,
      maxSpawnAttempts: 1,
    });

    // Attempt to start - should fail because process exits immediately
    await expect(manager.start()).rejects.toThrow();

    // Process is not running
    expect(manager.isRunning()).toBe(false);
  });

  it('should queue commands even if not started yet', async () => {
    manager = new PiRpcManager({
      command: 'node',
      args: [MOCK_PI_PATH],
    });
    // Don't start - queue will trigger start automatically
    const result = await manager.sendPrompt('Queue test') as PromptResult;
    expect(result.text).toContain('Queue test');

    await manager.stop();
  });
});
