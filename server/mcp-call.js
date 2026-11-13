#!/usr/bin/env node
/**
 * @req REQ-302 — 手动测试 MCP 的小客户端（不依赖任何 MCP 宿主）。
 *
 * 用法（token 默认读 D:\work\pke-secrets\sync-token.txt）：
 *   node server/mcp-call.js tools
 *   node server/mcp-call.js search "实验" --limit 5
 *   node server/mcp-call.js read <noteId>
 *   node server/mcp-call.js tags
 *   node server/mcp-call.js draft "写一篇同步说明" --sources <id1>,<id2>
 *   node server/mcp-call.js write "标题" "正文" --confirm
 *   node server/mcp-call.js relate <sourceId> <targetId> --confirm
 *   node server/mcp-call.js audit --limit 20
 *
 * 可选：--url <syncUrl>、--token-file <path>；token 只从 env/文件读，不回显。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_URL = 'https://pke.example-tailnet.ts.net';
const DEFAULT_TOKEN_FILE = 'D:\\work\\pke-secrets\\sync-token.txt';

function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  process.argv.splice(index, value && !value.startsWith('--') ? 2 : 1);
  return value && !value.startsWith('--') ? value : true;
}

const url = String(flag('url') || process.env.PKE_SYNC_URL || DEFAULT_URL).replace(/\/+$/, '');
const tokenFile = String(flag('token-file') || DEFAULT_TOKEN_FILE);
const token = (process.env.PKE_TOKEN || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8') : '')).trim();
const confirmed = Boolean(flag('confirm'));
const limit = Number(flag('limit')) || undefined;
const sources = String(flag('sources') || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const command = process.argv[2] || '';
const rest = process.argv.slice(3).filter((item) => !item.startsWith('--'));

if (!token) {
  console.error(`缺少 token：设置 PKE_TOKEN，或把 token 写进 ${tokenFile}`);
  process.exit(2);
}

function audit() {
  return fetch(`${url}/api/v1/audit-logs?limit=${limit || 20}`, {
    headers: { Authorization: `Bearer ${token}` }
  }).then(async (response) => {
    if (!response.ok) throw new Error(`审计接口返回 ${response.status}`);
    return response.json();
  });
}

function callTool(name, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'mcp-server.js')], {
      env: { ...process.env, PKE_SYNC_URL: url, PKE_TOKEN: token, PKE_MCP_DEVICE: 'mcp-cli' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let buffer = '';
    const responses = new Map();
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('MCP 超时（20 秒）'));
    }, 20000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          if (message.id !== undefined) responses.set(message.id, message);
        } catch {
          /* ignore */
        }
      }
      if (responses.has(2)) {
        clearTimeout(timer);
        child.kill();
        const message = responses.get(2);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('error', reject);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })}\n`
    );
  });
}

function printResult(result) {
  if (!result) return;
  if (result.isError) {
    console.log(`错误：${result.content?.[0]?.text || 'unknown'}`);
    process.exitCode = 1;
    return;
  }
  console.log(result.content?.[0]?.text || JSON.stringify(result, null, 2));
}

async function main() {
  switch (command) {
    case 'tools': {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(__dirname, 'mcp-server.js')], {
          env: { ...process.env, PKE_SYNC_URL: url, PKE_TOKEN: token },
          stdio: ['pipe', 'pipe', 'pipe']
        });
        let buffer = '';
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('MCP 超时'));
        }, 10000);
        child.stdout.on('data', (chunk) => {
          buffer += chunk;
          let index;
          while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (!line) continue;
            try {
              const message = JSON.parse(line);
              if (message.id === 2) {
                clearTimeout(timer);
                child.kill();
                resolve(message.result);
              }
            } catch {
              /* ignore */
            }
          }
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
      });
      for (const tool of result.tools || []) console.log(`- ${tool.name}: ${tool.description}`);
      break;
    }
    case 'search':
      printResult(await callTool('search_notes', { query: rest[0] || '', limit }));
      break;
    case 'read':
      printResult(await callTool('read_note', { id: rest[0] || '' }));
      break;
    case 'tags':
      printResult(await callTool('list_tags', {}));
      break;
    case 'draft':
      printResult(await callTool('draft_note', { intent: rest[0] || '', sourceIds: sources }));
      break;
    case 'write':
      if (!confirmed) {
        console.error('写入需要 --confirm（人工批准）；未发送。');
        process.exitCode = 2;
        return;
      }
      printResult(await callTool('write_note', { title: rest[0] || '', body: rest[1] || '', confirm: true }));
      break;
    case 'relate':
      if (!confirmed) {
        console.error('关系写入需要 --confirm（人工批准）；未发送。');
        process.exitCode = 2;
        return;
      }
      printResult(
        await callTool('create_relation', {
          sourceId: rest[0] || '',
          targetId: rest[1] || '',
          confirm: true
        })
      );
      break;
    case 'audit': {
      const data = await audit();
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    default:
      console.log('用法：node server/mcp-call.js <tools|search|read|tags|draft|write|relate|audit> ...');
      console.log('示例：node server/mcp-call.js search 实验');
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`失败：${error.message || error}`);
  process.exit(1);
});
