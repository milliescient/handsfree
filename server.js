// handsfree — voice-controlled Claude Code server.
// Serves a mobile web UI over self-signed HTTPS and bridges speech-transcribed
// messages to the Claude Agent SDK over a token-protected WebSocket.

import { createServer } from 'node:https';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { query } from '@anthropic-ai/claude-agent-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8443);
const WORKDIR = path.resolve(process.argv[2] || process.env.WORKDIR || process.cwd());
const TOKEN = process.env.TOKEN || crypto.randomBytes(8).toString('hex');

const VOICE_SYSTEM_PROMPT = `
You are operating through a hands-free voice interface. The user speaks their
requests aloud, and every piece of text you output is read to them through
text-to-speech.

While you work: before each tool call or batch of tool calls, narrate what you
are about to do as one short spoken phrase of under 15 words — like "Running
the tests now" or "Found the bug, fixing the server file." These are read
aloud as live progress updates, so always include one; never chain tool calls
silently.

When the task is done: give a fuller final summary — a short spoken paragraph
of roughly 3 to 6 sentences covering what you did, what you found, and
anything the user should know or decide next.

Everywhere: stay conversational and use plain words. No code blocks, markdown
formatting, bullet lists, or long file paths — text-to-speech mangles them;
describe things in words instead. Work autonomously: never ask for
confirmation mid-task, just do the work and summarize the outcome.`.trim();

// ---------------------------------------------------------------------------
// Self-signed cert (browsers require a secure context for microphone access,
// so plain HTTP only works on localhost — the phone needs HTTPS).
// ---------------------------------------------------------------------------
function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

function loadOrCreateCert() {
  const dir = path.join(__dirname, 'certs');
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  if (!existsSync(keyPath) || !existsSync(certPath)) {
    mkdirSync(dir, { recursive: true });
    const sans = ['DNS:localhost', 'IP:127.0.0.1', ...lanAddresses().map((a) => `IP:${a}`)];
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-days', '3650', '-subj', '/CN=handsfree.local',
      '-addext', `subjectAltName=${sans.join(',')}`,
    ], { stdio: 'ignore' });
    console.log('Generated self-signed certificate in certs/');
  }
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

// ---------------------------------------------------------------------------
// HTTP: serve the single-page UI.
// ---------------------------------------------------------------------------
const indexHtml = readFileSync(path.join(__dirname, 'public', 'index.html'));

const server = createServer(loadOrCreateCert(), (req, res) => {
  const url = new URL(req.url, 'https://x');
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(indexHtml);
  } else {
    res.writeHead(404).end('not found');
  }
});

// ---------------------------------------------------------------------------
// WebSocket: one Claude session per connection, messages queued while busy.
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'https://x');
  if (url.searchParams.get('key') !== TOKEN) {
    ws.close(4001, 'bad token');
    return;
  }

  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
  let sessionId = null;
  let active = null; // in-flight Query object, for interrupt
  const pending = []; // utterances queued while a turn is running

  send({ type: 'hello', workdir: WORKDIR });

  function toolSummary(block) {
    const input = block.input || {};
    const detail =
      input.command || input.description || input.file_path || input.pattern ||
      input.query || input.prompt || '';
    return `${block.name} ${String(detail).slice(0, 120)}`.trim();
  }

  async function runTurn(text) {
    active = query({
      prompt: text,
      options: {
        cwd: WORKDIR,
        ...(sessionId ? { resume: sessionId } : {}),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: VOICE_SYSTEM_PROMPT },
      },
    });
    try {
      for await (const m of active) {
        if (m.type === 'system' && m.subtype === 'init') {
          sessionId = m.session_id;
        } else if (m.type === 'assistant') {
          const blocks = m.message?.content ?? m.content ?? [];
          for (const block of blocks) {
            if (block.type === 'text' && block.text.trim()) {
              send({ type: 'assistant', text: block.text });
            } else if (block.type === 'tool_use') {
              send({ type: 'tool', text: toolSummary(block) });
            }
          }
        } else if (m.type === 'result') {
          const errored = m.subtype && m.subtype !== 'success';
          send({
            type: 'result',
            ok: !errored,
            text: m.result || (errored ? `Turn ended: ${m.subtype}` : ''),
          });
        }
      }
    } catch (err) {
      send({ type: 'error', text: String(err.message || err) });
    } finally {
      active = null;
      if (pending.length && ws.readyState === ws.OPEN) runTurn(pending.shift());
    }
  }

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'interrupt') {
      pending.length = 0;
      if (active) {
        try { await active.interrupt(); } catch { /* turn may have just ended */ }
      }
      send({ type: 'status', text: 'interrupted' });
    } else if (msg.type === 'user' && typeof msg.text === 'string' && msg.text.trim()) {
      if (active) {
        pending.push(msg.text);
        send({ type: 'status', text: 'queued — still working on the last request' });
      } else {
        runTurn(msg.text);
      }
    }
  });

  ws.on('close', () => {
    pending.length = 0;
    if (active) active.interrupt().catch(() => {});
  });
});

// ---------------------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`\nhandsfree — voice interface for Claude Code`);
  console.log(`Working directory for the agent: ${WORKDIR}\n`);
  console.log(`Open on this machine:  https://localhost:${PORT}/?key=${TOKEN}`);
  for (const addr of lanAddresses()) {
    console.log(`Open on your phone:    https://${addr}:${PORT}/?key=${TOKEN}`);
  }
  console.log(`\n(The certificate is self-signed — tap through the browser warning once.)`);
});
