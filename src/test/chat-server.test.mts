import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createChatServer } from '../chat-server.mts';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PI_PATH = path.resolve(__dirname, 'helpers', 'mock-pi-rpc.mjs');

async function fetchText(url: string, options?: RequestInit): Promise<{ status: number; body: string; headers: Headers }> {
  const res = await fetch(url, options);
  const body = await res.text();
  return { status: res.status, body, headers: res.headers };
}

describe('ChatServer', () => {
  let server: http.Server;
  let port: number;
  let baseUrl: string;

  beforeAll(async () => {
    const result = await createChatServer({
      piCommand: 'node',
      piArgs: [MOCK_PI_PATH],
      piEnv: { MOCK_PI_RESPONSE: 'Server test response!' },
      autoOpen: false,
    });
    server = result.server;
    port = result.port;
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('GET / should return HTML page', async () => {
    const { status, body, headers } = await fetchText(baseUrl + '/');
    expect(status).toBe(200);
    expect(headers.get('content-type')).toContain('text/html');
    expect(body).toContain('<!DOCTYPE html>');
    expect(body).toContain('input');
    expect(body).toContain('button');
  });

  it('POST /chat should return pi response', async () => {
    const { status, body } = await fetchText(baseUrl + '/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Hello server' }),
    });
    expect(status).toBe(200);
    expect(body).toContain('You said: Hello server');
  });

  it('POST /chat should return 400 for missing message', async () => {
    const { status } = await fetchText(baseUrl + '/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(status).toBe(400);
  });

  it('POST /chat should return 400 for empty message', async () => {
    const { status } = await fetchText(baseUrl + '/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '' }),
    });
    expect(status).toBe(400);
  });

  it('POST /chat should return 400 for non-JSON body', async () => {
    const { status } = await fetchText(baseUrl + '/chat', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'not json',
    });
    expect(status).toBe(400);
  });

  it('GET /health should return ok with piRunning field', async () => {
    const { status, body } = await fetchText(baseUrl + '/health');
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(data.status).toBe('ok');
    expect(data.piRunning).toBe(true);
  });

  it('should support sending a new_session command', async () => {
    const { status, body } = await fetchText(baseUrl + '/new-session', {
      method: 'POST',
    });
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(data.success).toBe(true);
  });
});
