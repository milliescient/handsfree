// handsfree — voice-controlled Claude Code server.
// Serves a mobile web UI over self-signed HTTPS and bridges speech-transcribed
// messages to the Claude Agent SDK over a token-protected WebSocket.

import { createServer } from 'node:https';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { query } from '@anthropic-ai/claude-agent-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env (KEY=value lines) so keys survive restarts; real env wins.
try {
  for (const line of readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}

// The server has been dying silently — log every exit path so we can see who
// or what terminated it.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    console.error(`[exit] received ${sig} at ${new Date().toISOString()}`);
    process.exit(128);
  });
}
process.on('exit', (code) => console.error(`[exit] process exiting with code ${code}`));
process.on('uncaughtException', (err) => {
  console.error('[exit] uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[exit] unhandled rejection:', err);
});

const PORT = Number(process.env.PORT || 8443);
const WORKDIR = path.resolve(process.argv[2] || process.env.WORKDIR || process.cwd());
const TOKEN = process.env.TOKEN || crypto.randomBytes(8).toString('hex');
const SESSIONS_FILE = path.join(__dirname, '.sessions.json');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const USAGE_FILE = path.join(__dirname, '.usage.json');

function loadUsage() {
  try {
    if (existsSync(USAGE_FILE)) {
      return JSON.parse(readFileSync(USAGE_FILE, 'utf8'));
    }
  } catch {}
  return { whisperSeconds: 0, transcriptions: 0 };
}

function saveUsage(usage) {
  try { writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2)); } catch {}
}

function addWhisperUsage(durationSeconds) {
  const usage = loadUsage();
  usage.whisperSeconds += durationSeconds;
  usage.transcriptions += 1;
  usage.lastUsed = Date.now();
  saveUsage(usage);
  return usage;
}

function loadSessions() {
  try {
    if (existsSync(SESSIONS_FILE)) {
      return JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'));
    }
  } catch {}
  return [];
}

function saveSessions(sessions) {
  try { writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2)); } catch {}
}

function addOrUpdateSession(id, preview = '') {
  const sessions = loadSessions();
  const existing = sessions.find(s => s.id === id);
  if (existing) {
    existing.lastUsed = Date.now();
    if (preview) existing.preview = preview.slice(0, 100);
  } else {
    sessions.unshift({ id, lastUsed: Date.now(), preview: preview.slice(0, 100) });
  }
  // Keep only last 20 sessions
  saveSessions(sessions.slice(0, 20));
}

function getMostRecentSessionId() {
  const sessions = loadSessions();
  return sessions.length > 0 ? sessions[0].id : null;
}

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

const server = createServer(loadOrCreateCert(), async (req, res) => {
  const url = new URL(req.url, 'https://x');
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(indexHtml);
  } else if (url.pathname === '/sessions' && req.method === 'GET') {
    if (url.searchParams.get('key') !== TOKEN) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(loadSessions()));
  } else if (url.pathname === '/usage' && req.method === 'GET') {
    if (url.searchParams.get('key') !== TOKEN) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    const usage = loadUsage();
    const minutes = (usage.whisperSeconds / 60).toFixed(2);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...usage, whisperMinutes: parseFloat(minutes) }));
  } else if (url.pathname === '/transcribe' && req.method === 'POST') {
    if (url.searchParams.get('key') !== TOKEN) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    if (!OPENAI_API_KEY) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'OPENAI_API_KEY not set' }));
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const audioBuffer = Buffer.concat(chunks);

      const contentType = (req.headers['content-type'] || 'audio/webm').split(';')[0].trim();
      const extMap = { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav' };
      const ext = extMap[contentType] || 'webm';

      // Calculate audio duration from WAV header (16kHz mono 16-bit)
      let durationSeconds = 0;
      if (contentType === 'audio/wav' && audioBuffer.length > 44) {
        const sampleRate = audioBuffer.readUInt32LE(24);
        const dataSize = audioBuffer.length - 44;
        const bytesPerSample = 2; // 16-bit
        durationSeconds = dataSize / (sampleRate * bytesPerSample);
      }

      const boundary = '----Boundary' + crypto.randomBytes(8).toString('hex');
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${ext}"\r\nContent-Type: ${contentType}\r\n\r\n`),
        audioBuffer,
        Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}--\r\n`),
      ]);

      const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      });
      const result = await whisperRes.json();

      // Track usage if we got a duration
      if (durationSeconds > 0) {
        const usage = addWhisperUsage(durationSeconds);
        console.log(`Whisper: ${durationSeconds.toFixed(1)}s, total: ${(usage.whisperSeconds/60).toFixed(2)} min`);
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
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
  let sessionId = null; // Will be set by client via 'session' message or on first turn
  let active = null; // in-flight Query object, for interrupt
  const pending = []; // utterances queued while a turn is running
  let lastUserMessage = '';

  send({ type: 'hello', workdir: WORKDIR, sessions: loadSessions() });

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
          addOrUpdateSession(sessionId, lastUserMessage);
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
    } else if (msg.type === 'session') {
      // Client wants to resume a specific session or start fresh (null)
      sessionId = msg.id || null;
      if (sessionId) {
        console.log('Client selected session:', sessionId);
        send({ type: 'status', text: 'Resuming session...' });
      } else {
        console.log('Client starting new session');
        send({ type: 'status', text: 'Starting new session...' });
      }
    } else if (msg.type === 'user' && typeof msg.text === 'string' && msg.text.trim()) {
      lastUserMessage = msg.text.trim();
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
