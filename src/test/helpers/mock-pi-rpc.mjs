/**
 * Mock pi --mode rpc process for testing.
 *
 * Speaks the pi RPC JSON Lines protocol over stdin/stdout.
 * Usage: node src/test/helpers/mock-pi-rpc.mjs
 *
 * Protocol:
 *   stdin:  {"id":"1","type":"prompt","message":"Hello"}
 *   stdout: {"type":"agent_start"}
 *           {"type":"turn_start"}
 *           {"type":"message_start","message":{"role":"assistant","content":[]}}
 *           {"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"Hello!"}],"model":{}},"assistantMessageEvent":{"type":"text_start","contentIndex":0}}
 *           {"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Hello!"}]}}
 *           {"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"Hello!"}]},"toolResults":[]}
 *           {"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"Hello!"}]}]}
 *           {"id":"1","type":"response","command":"prompt","success":true}
 */

import { createInterface } from 'readline';

// Configuration from environment
const RESPONSE_TEXT = process.env.MOCK_PI_RESPONSE ?? 'Hello from mock pi!';

let requestCount = 0;
let shutdownTimer = null;

// Create readline interface for reading JSON lines from stdin
const rl = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

function output(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function handlePrompt(id, message) {
  // Simulate a response based on the message
  const reply = message ? `You said: ${message}` : RESPONSE_TEXT;

  // Build mock assistant message
  const assistantMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: reply }],
  };

  const events = [
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    {
      type: 'message_update',
      message: assistantMessage,
      assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial: assistantMessage },
    },
    { type: 'message_end', message: assistantMessage },
    { type: 'turn_end', message: assistantMessage, toolResults: [] },
    { type: 'agent_end', messages: [assistantMessage] },
    { id, type: 'response', command: 'prompt', success: true },
  ];

  for (const event of events) {
    output(event);
  }
}

function handleNewSession(id) {
  output({
    id,
    type: 'response',
    command: 'new_session',
    success: true,
    data: { cancelled: false },
  });
}

function handleGetState(id) {
  output({
    id,
    type: 'response',
    command: 'get_state',
    success: true,
    data: {
      isStreaming: false,
      isCompacting: false,
      messageCount: requestCount,
      pendingMessageCount: 0,
    },
  });
}

function emitError(id, command, errorMessage) {
  output({ id, type: 'response', command, success: false, error: errorMessage });
}

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let cmd;
  try {
    cmd = JSON.parse(trimmed);
  } catch {
    emitError(undefined, 'parse', `Failed to parse: ${trimmed}`);
    return;
  }

  requestCount++;

  switch (cmd.type) {
    case 'prompt':
      handlePrompt(cmd.id, cmd.message);
      break;
    case 'new_session':
      handleNewSession(cmd.id);
      break;
    case 'get_state':
      handleGetState(cmd.id);
      break;
    default:
      emitError(cmd.id, cmd.type, `Unknown command: ${cmd.type}`);
  }

  // Auto shutdown after N requests
  const shutdownAfter = parseInt(process.env.MOCK_PI_SHUTDOWN_AFTER ?? '0', 10);
  if (shutdownAfter > 0 && requestCount >= shutdownAfter) {
    shutdownTimer = setTimeout(() => process.exit(0), 100);
  }
});

rl.on('close', () => {
  if (shutdownTimer) clearTimeout(shutdownTimer);
  process.exit(0);
});

// Signal readiness on stdout
output({ type: '_ready' });
