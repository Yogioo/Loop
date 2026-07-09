/**
 * 极简测试：验证 grill-me 提示词注入 + pi RPC 能正常启动并响应。
 *
 * 使用方法：
 *   npx vitest run src/test/grill-me-prompt.test.mts
 *   或
 *   npx tsx src/test/grill-me-prompt.test.mts
 *
 * 测试内容：
 *   1. grill-me SKILL.md frontmatter 是否正确剥离
 *   2. pi --mode rpc --append-system-prompt 是否能正常启动
 *   3. Agent 是否按 grill-me 风格响应（追问式，而非直接写代码）
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { PiRpcManager } from '../pi-rpc.mts';
import { describe, it, expect, beforeAll } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(__dirname, '..', '..', 'skills', 'grill-me');

// ---------------------------------------------------------------------------
// 辅助函数：构建 grill-me 提示词（与 chat-server.mts 逻辑一致）
// ---------------------------------------------------------------------------

const stripFrontmatter = (content: string) =>
  content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();

function buildGrillMePrompt(): string {
  const raw = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf-8');
  return [
    stripFrontmatter(raw),
    '用户即将描述他要做的改动（例如：我打算加新功能/修复bug，等我整理一下语言发你）。',
    '请开始追问式访谈，一次只问一个问题。',
  ].join('\n\n');
}

function writeTemp(name: string, content: string): string {
  const tmp = path.join(os.tmpdir(), `loop-test-${name}-${Date.now()}.md`);
  fs.writeFileSync(tmp, content, 'utf-8');
  return tmp;
}

// ---------------------------------------------------------------------------
// 测试 1：frontmatter 剥离
// ---------------------------------------------------------------------------

describe('grill-me prompt injection', () => {
  it('应该正确剥离 YAML frontmatter', () => {
    const raw = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf-8');

    // 原始文件应该有 YAML frontmatter
    expect(raw).toContain('---');
    expect(raw).toContain('disable-model-invocation');

    const cleaned = stripFrontmatter(raw);

    // 剥离后不应该有 --- 和 frontmatter 字段
    expect(cleaned).not.toContain('---');
    expect(cleaned).not.toContain('disable-model-invocation');

    // 应该保留 grill-me 核心内容
    expect(cleaned).toContain('持续访谈');
    expect(cleaned).toContain('一次只问一个问题');
    expect(cleaned.length).toBeGreaterThan(100);

    console.log('[test] frontmatter 剥离成功，内容长度:', cleaned.length);
  });

  it('构建的完整提示词应包含 grill-me 内容 + 引导语', () => {
    const prompt = buildGrillMePrompt();

    expect(prompt).toContain('持续访谈');
    expect(prompt).toContain('一次只问一个问题');
    expect(prompt).toContain('用户即将描述他要做的改动');
    expect(prompt).toContain('追问式访谈');

    console.log('[test] 完整提示词长度:', prompt.length);
  });
});

// ---------------------------------------------------------------------------
// 测试 2：pi RPC 启动（需要 pi 已安装）
// ---------------------------------------------------------------------------

describe('pi RPC with grill-me prompt', () => {
  // 检查 pi 是否可用
  let piAvailable = false;
  beforeAll(() => {
    try {
      const which = process.platform === 'win32' ? 'where' : 'which';
      const { execSync } = require('node:child_process');
      execSync(`${which} pi`, { timeout: 5000 });
      piAvailable = true;
    } catch {
      console.warn('[test] pi 命令不可用，跳过 RPC 集成测试');
    }
  });

  it('pi 应该能带 --append-system-prompt 正常启动', { skip: !piAvailable, timeout: 15000 }, async () => {
    const promptPath = writeTemp('grill-me-test', buildGrillMePrompt());

    const manager = new PiRpcManager({
      command: process.platform === 'win32' ? 'pi.cmd' : 'pi',
      args: [
        '--mode', 'rpc',
        '--tools', 'read,bash',
        '--append-system-prompt', promptPath,
      ],
      maxSpawnAttempts: 1,
    });

    try {
      await manager.start();
      expect(manager.isRunning()).toBe(true);
      console.log('[test] ✅ pi RPC 启动成功');
    } finally {
      await manager.stop().catch(() => {});
    }
  });

  it('Agent 应该以追问式风格响应（而非直接编码）', { skip: !piAvailable, timeout: 180000 }, async () => {
    const promptPath = writeTemp('grill-me-test-2', buildGrillMePrompt());

    const manager = new PiRpcManager({
      command: process.platform === 'win32' ? 'pi.cmd' : 'pi',
      args: [
        '--mode', 'rpc',
        '--tools', 'read,bash',
        '--append-system-prompt', promptPath,
      ],
      maxSpawnAttempts: 1,
    });

    try {
      await manager.start();

      // 发送一个模糊的需求，Agent 应该追问细节而非直接动手
      const result = await manager.sendPrompt(
        '我想给网站加个搜索功能',
        120000,
      );

      const text = (result as any).text ?? '';
      console.log('[test] Agent 响应:', text.slice(0, 500));

      // grill-me 风格特征：应该包含问号（在提问）
      expect(text).toMatch(/\?/);
      // 不应该包含代码块（不直接编码）
      expect(text).not.toContain('```');
    } finally {
      await manager.stop().catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// 独立运行入口（非 vitest）
// ---------------------------------------------------------------------------

const isMain = process.argv[1]?.includes('grill-me-prompt.test');
if (isMain && !process.env.VITEST) {
  console.log('=== grill-me prompt injection 手动测试 ===\n');

  // 1. 剥离 frontmatter
  const prompt = buildGrillMePrompt();
  console.log('1. 完整提示词（前 500 字符）:');
  console.log(prompt.slice(0, 500));
  console.log('...\n');

  // 2. 写临时文件
  const tmpPath = writeTemp('manual-test', prompt);
  console.log('2. 临时文件:', tmpPath);
  console.log('   大小:', fs.statSync(tmpPath).size, 'bytes\n');

  console.log('3. 使用以下命令手动测试:');
  console.log(`   pi --mode rpc --tools read,bash --append-system-prompt "${tmpPath}"`);
  console.log('   然后输入 {"id":"1","type":"prompt","message":"我想加个功能"}');
  console.log('   观察 Agent 是否以追问式风格响应\n');
}
