// handsfree — voice-controlled Claude Code server.
// Serves a mobile web UI over self-signed HTTPS and bridges speech-transcribed
// messages to the Claude Agent SDK over WebSocket.

import { createServer } from 'node:https';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { networkInterfaces, homedir, hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';

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
// Default working directory for new sessions only — each session remembers
// the directory it was started in (stored in the sessions registry).
const WORKDIR = path.resolve(process.argv[2] || process.env.WORKDIR || homedir());

// Expand a leading ~ and resolve a client-supplied directory.
function expandDir(dir) {
  if (!dir) return null;
  return path.resolve(dir.replace(/^~(?=$|\/)/, homedir()));
}

// App version - uses git SHA, computed at startup
const APP_VERSION = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: __dirname }).toString().trim();
  } catch { return 'unknown'; }
})();

// Verify APK is in sync with current git SHA
(() => {
  try {
    const indexHtml = readFileSync(path.join(__dirname, 'android/app/src/main/assets/public/index.html'), 'utf8');
    const match = indexHtml.match(/const APP_VERSION = '([^']+)'/);
    const apkVersion = match ? match[1] : null;
    if (apkVersion !== APP_VERSION) {
      // Warn loudly but keep serving — exiting here puts the supervisor into
      // a crash-loop and takes the whole service down over a stale APK.
      console.error(`\n[WARN] APK version mismatch (APK ${apkVersion || 'not found'}, git ${APP_VERSION}).`);
      console.error(`Run ./build-apk.sh to rebuild; the app will prompt users to update.\n`);
    }
  } catch (e) {
    // APK assets don't exist yet - that's fine for initial setup
    console.log('[WARN] Could not verify APK version:', e.message);
  }
})();

// Version advertised to clients for update prompts: the version embedded in
// the APK we actually serve. Comparing against git HEAD instead re-arms the
// update dialog on every commit made without a rebuild — the app would
// install the served APK and immediately be "outdated" again.
const SERVED_APK_VERSION = (() => {
  try {
    const html = readFileSync(path.join(__dirname, 'android/app/src/main/assets/public/index.html'), 'utf8');
    return html.match(/const APP_VERSION = '([^']+)'/)?.[1] ?? APP_VERSION;
  } catch { return APP_VERSION; }
})();
// Session registry lives in a hidden per-user directory (like Claude's own
// ~/.claude) rather than inside the checkout; migrate the old in-repo file.
const DATA_DIR = path.join(homedir(), '.handsfree');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
try {
  mkdirSync(DATA_DIR, { recursive: true });
  const legacy = path.join(__dirname, '.sessions.json');
  if (!existsSync(SESSIONS_FILE) && existsSync(legacy)) {
    copyFileSync(legacy, SESSIONS_FILE); // rename fails across filesystems
    unlinkSync(legacy);
  }
} catch (err) { console.error('Sessions migration failed:', err.message); }
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const USAGE_FILE = path.join(__dirname, '.usage.json');
// Local Whisper server (faster-whisper on GPU) - falls back to OpenAI if unavailable
const LOCAL_WHISPER_URL = process.env.WHISPER_URL || 'http://127.0.0.1:9876/transcribe';
// Local TTS server (Piper) - falls back to browser speech synthesis if unavailable
const LOCAL_TTS_URL = process.env.TTS_URL || 'http://127.0.0.1:9877/synthesize';

// Prepend a short silence to a PCM WAV. Piper's audio starts speaking at
// sample zero, and phones swallow the first fraction of a second while the
// output path wakes up — users heard replies with the first words missing.
function padWavStart(buf, ms = 300) {
  try {
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' ||
        buf.toString('ascii', 8, 12) !== 'WAVE') return buf;
    const byteRate = buf.readUInt32LE(28);
    const blockAlign = buf.readUInt16LE(32) || 2;
    let off = 12; // walk chunks to find 'data'
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === 'data') {
        let silenceBytes = Math.floor((byteRate * ms) / 1000);
        silenceBytes -= silenceBytes % blockAlign;
        const out = Buffer.concat([
          buf.slice(0, off + 8),
          Buffer.alloc(silenceBytes),
          buf.slice(off + 8),
        ]);
        out.writeUInt32LE(size + silenceBytes, off + 4);
        out.writeUInt32LE(out.length - 8, 4);
        return out;
      }
      off += 8 + size + (size % 2);
    }
    return buf;
  } catch (err) {
    console.log('padWavStart failed, sending audio unpadded:', err.message);
    return buf;
  }
}

// Synthesize text to speech using local Piper server
async function synthesizeSpeech(text) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const res = await fetch(LOCAL_TTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`TTS server returned ${res.status}`);
    const audioBuffer = await res.arrayBuffer();
    const padded = padWavStart(Buffer.from(audioBuffer));
    return { audio: padded.toString('base64'), source: 'local' };
  } catch (err) {
    console.log('Local TTS unavailable:', err.message);
    return null; // Client will fall back to browser speech synthesis
  }
}

// Transcribe audio using local Whisper server, falling back to OpenAI API
async function transcribeAudio(audioBuffer, contentType = 'audio/wav') {
  // Calculate duration from WAV header (16kHz mono 16-bit)
  let durationSeconds = 0;
  if (contentType === 'audio/wav' && audioBuffer.length > 44) {
    const sampleRate = audioBuffer.readUInt32LE(24);
    const dataSize = audioBuffer.length - 44;
    durationSeconds = dataSize / (sampleRate * 2);
  }

  // Try local Whisper server first
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const localRes = await fetch(LOCAL_WHISPER_URL, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: audioBuffer,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const result = await localRes.json();
    if (result.text !== undefined) {
      console.log('Local Whisper:', result.text ? result.text.slice(0, 50) : '(empty)');
      if (durationSeconds > 0) {
        const usage = addWhisperUsage(durationSeconds);
        console.log(`Transcribed ${durationSeconds.toFixed(1)}s, total: ${(usage.whisperSeconds/60).toFixed(2)} min`);
      }
      return { text: result.text, source: 'local' };
    }
    if (result.error) throw new Error(result.error);
  } catch (err) {
    console.log('Local Whisper unavailable:', err.message, '- trying OpenAI');
  }

  // Fall back to OpenAI API
  if (!OPENAI_API_KEY) {
    throw new Error('Local Whisper unavailable and OPENAI_API_KEY not set');
  }

  const extMap = { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav' };
  const ext = extMap[contentType] || 'wav';
  const boundary = '----Boundary' + randomBytes(8).toString('hex');
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${ext}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    audioBuffer,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}--\r\n`),
  ]);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
    signal: controller.signal,
  });
  clearTimeout(timeout);
  const result = await whisperRes.json();
  console.log('OpenAI Whisper:', result.text ? result.text.slice(0, 50) : result.error);

  if (durationSeconds > 0) {
    const usage = addWhisperUsage(durationSeconds);
    console.log(`Transcribed ${durationSeconds.toFixed(1)}s, total: ${(usage.whisperSeconds/60).toFixed(2)} min`);
  }

  if (result.error) throw new Error(result.error.message || result.error);
  return { text: result.text || '', source: 'openai' };
}

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

// Load conversation history from SDK session file. Includes tool-use entries
// formatted the same way agentd streams them live, so a reloaded chat looks
// exactly like it did when the app was closed.
function loadSessionHistory(sessionId, maxMessages = 200) {
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  // SDK session files live under a per-directory project path, so use the
  // directory this session was started in, not the server default.
  const session = loadSessions().find(s => s.id === sessionId);
  const cwd = (session && session.cwd) || WORKDIR;
  const projectPath = cwd.replace(/\//g, '-');
  const sessionFile = path.join(homeDir, '.claude', 'projects', projectPath, `${sessionId}.jsonl`);

  const messages = [];
  try {
    if (!existsSync(sessionFile)) return messages;
    const lines = readFileSync(sessionFile, 'utf8').split('\n').filter(l => l.trim());

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'user' && entry.message?.content && !entry.isMeta) {
          // User message - extract text (content may be a plain string)
          const content = entry.message.content;
          const text = typeof content === 'string'
            ? content
            : content.filter(b => b.type === 'text').map(b => b.text).join('\n');
          if (text.trim()) {
            messages.push({ role: 'user', text });
          }
        } else if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
          // Assistant blocks in order: text and tool calls interleaved, one
          // entry per block — matching how agentd emits them live.
          for (const b of entry.message.content) {
            if (b.type === 'text' && b.text.trim()) {
              messages.push({ role: 'assistant', text: b.text });
            } else if (b.type === 'tool_use') {
              const input = b.input || {};
              const detail =
                input.command || input.description || input.file_path ||
                input.pattern || input.query || input.prompt || '';
              messages.push({ role: 'tool', text: `${b.name} ${String(detail).slice(0, 120)}`.trim() });
            }
          }
        }
      } catch {}
    }
  } catch (err) {
    console.error('Error loading session history:', err.message);
  }

  // Return last N messages
  return messages.slice(-maxMessages);
}

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
const server = createServer(loadOrCreateCert(), async (req, res) => {
  const url = new URL(req.url, 'https://x');
  if (url.pathname === '/' || url.pathname === '/index.html') {
    // Re-read HTML on each request so we pick up changes during dev
    const indexHtml = readFileSync(path.join(__dirname, 'public', 'index.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(indexHtml);
  } else if (url.pathname === '/handsfree.apk') {
    const apkPath = path.join(__dirname, 'public', 'handsfree.apk');
    if (existsSync(apkPath)) {
      res.writeHead(200, { 'content-type': 'application/vnd.android.package-archive', 'content-disposition': 'attachment; filename="handsfree.apk"' });
      res.end(readFileSync(apkPath));
    } else {
      res.writeHead(404).end('APK not found');
    }
  } else if (url.pathname === '/sessions' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(loadSessions()));
  } else if (url.pathname === '/version' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ version: SERVED_APK_VERSION }));
  } else if (url.pathname === '/usage' && req.method === 'GET') {
    const usage = loadUsage();
    const minutes = (usage.whisperSeconds / 60).toFixed(2);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...usage, whisperMinutes: parseFloat(minutes) }));
  } else if (url.pathname === '/transcribe' && req.method === 'POST') {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const audioBuffer = Buffer.concat(chunks);
      const contentType = (req.headers['content-type'] || 'audio/wav').split(';')[0].trim();

      const result = await transcribeAudio(audioBuffer, contentType);
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
// agentd link: turns run in a separate process (agentd.js) so this server can
// restart freely — deploys, UI changes, even the agent restarting the web
// layer — without killing an in-flight turn. Events stream back over a
// loopback WebSocket and are relayed to every connected phone.
// ---------------------------------------------------------------------------
const AGENTD_URL = process.env.AGENTD_URL || 'ws://127.0.0.1:9878';
let agentWs = null;
const agentOutbox = []; // messages queued while agentd is down/restarting
let agentBusy = false;  // best-effort: a turn is in flight
const conns = new Map(); // connId -> per-phone-connection state
let nextConnId = 1;
let lastUserKey = null; // dedup identical user messages from parallel clients
let lastUserAt = 0;

// Mirror of agentd's job queue so a client that reloads mid-turn can still
// render its queued-but-not-started messages. Fed entirely by agentd (ready
// and queue events) — guessing at it here drifted out of sync and showed
// messages both in history and as stale queued bubbles.
let pendingQueue = []; // [{ text, sessionId }]

function sendToAgent(obj) {
  const s = JSON.stringify(obj);
  if (agentWs && agentWs.readyState === WebSocket.OPEN) agentWs.send(s);
  else agentOutbox.push(s);
}

function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(s);
}

// Push the authoritative queue to every client so each can reconcile its
// queued bubbles — a message another client unqueued, a dedup drop, or a
// turn handoff all stop looking "queued" everywhere, not just where it
// happened.
function broadcastQueue() {
  for (const conn of conns.values()) {
    if (!conn.sessionChosen) continue;
    const queued = pendingQueue
      .filter((q) => q.sessionId === conn.sessionId)
      .map((q) => q.text);
    conn.send({ type: 'queue', queued });
  }
}

// Relay chain keeps event order: TTS synthesis awaits inline, and later
// events (tool, result) must not overtake an assistant message mid-synthesis.
let relayChain = Promise.resolve();

async function handleAgentEvent(evt) {
  if (evt.type === 'ready') {
    agentBusy = !!evt.busy;
    pendingQueue = evt.queue || [];
    console.log(`agentd ready (busy=${evt.busy}, queued=${evt.queued}, draining=${evt.draining})`);
    broadcastQueue();
  } else if (evt.type === 'queue') {
    pendingQueue = evt.queue || [];
    broadcastQueue();
  } else if (evt.type === 'sessionStarted') {
    const conn = conns.get(evt.connId);
    if (conn) conn.sessionId = evt.sessionId;
  } else if (evt.type === 'dropped') {
    // agentd rejected a near-duplicate; only the submitting client has a
    // bubble for this exact transcription, so target it.
    const conn = conns.get(evt.connId);
    if (conn && conn.send) conn.send({ type: 'dropped', text: evt.text, busy: !!evt.busy });
  } else if (evt.type === 'assistant') {
    console.log('Synthesizing speech for:', evt.text.slice(0, 50));
    const tts = await synthesizeSpeech(evt.text);
    console.log('TTS result:', tts ? `got audio ${tts.audio.length} bytes` : 'no audio (client falls back)');
    broadcast(tts ? { type: 'assistant', text: evt.text, audio: tts.audio } : { type: 'assistant', text: evt.text });
  } else if (evt.type === 'tool') {
    broadcast({ type: 'tool', text: evt.text });
  } else if (evt.type === 'status') {
    // Statuses about one client's own action (interrupted, queued) target
    // that client; anything untargeted is for everyone.
    const conn = evt.connId != null ? conns.get(evt.connId) : null;
    if (conn) conn.send({ type: 'status', text: evt.text });
    else broadcast({ type: 'status', text: evt.text });
  } else if (evt.type === 'result') {
    // A finished turn hands off to the next queued job (if any) — agentd's
    // follow-up queue event updates the mirror itself.
    agentBusy = pendingQueue.length > 0;
    broadcast({ type: 'result', ok: evt.ok, text: evt.text, sessions: evt.sessions });
  } else if (evt.type === 'error') {
    agentBusy = false;
    broadcast({ type: 'error', text: evt.text });
  }
}

function connectAgentd() {
  agentWs = new WebSocket(AGENTD_URL);
  agentWs.on('open', () => {
    console.log('Connected to agentd');
    while (agentOutbox.length) agentWs.send(agentOutbox.shift());
  });
  agentWs.on('message', (data) => {
    let evt;
    try { evt = JSON.parse(data); } catch { return; }
    relayChain = relayChain.then(() => handleAgentEvent(evt)).catch((e) => console.error('relay error:', e));
  });
  agentWs.on('close', () => {
    console.log('agentd link down, retrying in 1s');
    setTimeout(connectAgentd, 1000);
  });
  agentWs.on('error', () => { /* close handler reconnects */ });
}
connectAgentd();

// ---------------------------------------------------------------------------
// WebSocket: phone connections. Session choice lives here; turns run in agentd.
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server, maxPayload: 50 * 1024 * 1024 }); // 50MB max for audio

wss.on('connection', (ws, req) => {
  console.log(`New WebSocket connection from ${req.socket.remoteAddress} UA=${req.headers['user-agent'] || 'unknown'}`);
  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
  const connId = nextConnId++;
  const conn = { sessionId: null, sessionChosen: false, cwd: null, send };
  conns.set(connId, conn);

  // Heartbeat to keep connection alive
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });

  // busy lets a phone that reconnects mid-turn know work is still in flight
  send({ type: 'hello', workdir: WORKDIR, hostname: hostname(), sessions: loadSessions(), version: SERVED_APK_VERSION, busy: agentBusy });

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'interrupt') {
      // Scope the interrupt to this client's session (falling back to the
      // connection for a brand-new session with no id yet) so stopping one
      // session never kills another session's turn or queued messages.
      sendToAgent({ type: 'interrupt', sessionId: conn.sessionId, connId });
    } else if (msg.type === 'unqueue' && typeof msg.text === 'string') {
      // User removed a queued message before its turn started. agentd owns
      // the queue; it will emit a fresh queue snapshot after removal.
      console.log('Unqueue request:', msg.text.slice(0, 50));
      sendToAgent({ type: 'unqueue', text: msg.text, sessionId: conn.sessionId });
    } else if (msg.type === 'session') {
      // Client wants to resume a specific session or start fresh (null)
      conn.sessionId = msg.id || null;
      conn.sessionChosen = true;
      // For new sessions the client may pick a working directory; validate it
      // here so a typo'd path fails loudly instead of confusing the SDK.
      conn.cwd = null;
      if (!conn.sessionId && msg.cwd) {
        const dir = expandDir(msg.cwd);
        if (existsSync(dir)) {
          conn.cwd = dir;
        } else {
          send({ type: 'status', text: `Directory not found: ${dir} — using ${WORKDIR}` });
        }
      }
      if (conn.sessionId) {
        console.log('Client selected session:', conn.sessionId);
        // Always send history on explicit selection: the client clears its
        // log expecting it, and the history handler is idempotent.
        const history = loadSessionHistory(conn.sessionId);
        // A queued message whose turn just started can briefly be in both the
        // session file and the queue mirror — don't show it twice.
        const recentUsers = new Set(
          history.slice(-30).filter(m => m.role === 'user').map(m => m.text)
        );
        const queued = pendingQueue
          .filter(q => q.sessionId === conn.sessionId && !recentUsers.has(q.text))
          .map(q => q.text);
        console.log(`Loaded ${history.length} messages from session history (${queued.length} queued)`);
        // Tag with the session so the client can drop a response that arrives
        // after the user has already switched to a different session.
        send({ type: 'history', sessionId: conn.sessionId, messages: history, queued });
      } else {
        // No status message here: the client already shows "Started new
        // session in <dir>" when the user picks one, and this branch also
        // runs on every reconnect re-assert, where a message would be noise.
        console.log('Client starting new session');
      }
    } else if (msg.type === 'deleteSession' && msg.id) {
      // Delete a session from the sessions file
      const sessions = loadSessions();
      const updated = sessions.filter(s => s.id !== msg.id);
      saveSessions(updated);
      console.log('Deleted session:', msg.id);
      // Send updated sessions list back to client
      send({ type: 'sessionsUpdated', sessions: updated });
    } else if (msg.type === 'user' && typeof msg.text === 'string' && msg.text.trim()) {
      console.log(`Received user message, sessionId=${conn.sessionId}, sessionChosen=${conn.sessionChosen}`);
      if (!conn.sessionChosen) {
        console.warn('User message received before session was chosen, ignoring');
        send({ type: 'error', text: 'Please select a session first' });
        return;
      }
      // Deduplicate: with several clients connected (phone + browser tab),
      // each one hears the user and submits the same transcription.
      const text = msg.text.trim();
      const dedupKey = `${conn.sessionId}\n${text}`;
      if (dedupKey === lastUserKey && Date.now() - lastUserAt < 10000) {
        console.log('Dropping duplicate user message (multiple clients):', text.slice(0, 50));
        // Only tell the submitter — the client whose copy was accepted has a
        // bubble with the same text that really is queued or running.
        send({ type: 'dropped', text, busy: agentBusy });
        return;
      }
      lastUserKey = dedupKey;
      lastUserAt = Date.now();
      agentBusy = true;
      if (!agentWs || agentWs.readyState !== WebSocket.OPEN) {
        send({ type: 'status', text: 'agent is restarting — your message is queued' });
      }
      sendToAgent({ type: 'user', text, sessionId: conn.sessionId, cwd: conn.cwd, connId });
    } else if (msg.type === 'vad_debug') {
      // Log VAD debug info for analyzing false triggers
      console.log(`[VAD] energy=${msg.energy.toFixed(4)} max=${msg.maxSample.toFixed(4)} samples=${msg.samples} playback=${msg.duringPlayback}`);
    } else if (msg.type === 'vad_rejected') {
      // Log when VAD rejected audio as too quiet
      console.log(`[VAD REJECTED] energy=${msg.energy.toFixed(4)} threshold=${msg.threshold} playback=${msg.duringPlayback}`);
    } else if (msg.type === 'barge_in') {
      // Log when barge-in is triggered
      console.log(`[BARGE-IN] energy=${msg.energy.toFixed(4)} playback=${msg.duringPlayback}${msg.early ? ' early' : ''}`);
    } else if (msg.type === 'debug') {
      console.log(`[DEBUG] ${msg.msg}`);
    } else if (msg.type === 'transcribe' && msg.audio) {
      // Handle transcription over WebSocket (for Android where fetch to self-signed cert fails)
      console.log('Received transcribe request, audio length:', msg.audio.length);
      try {
        const audioBuffer = Buffer.from(msg.audio, 'base64');
        // Calculate audio energy from 16-bit PCM samples (skip 44-byte WAV header)
        let energy = 0, maxSample = 0;
        for (let i = 44; i < audioBuffer.length - 1; i += 2) {
          const sample = audioBuffer.readInt16LE(i) / 32768.0;
          energy += sample * sample;
          if (Math.abs(sample) > maxSample) maxSample = Math.abs(sample);
        }
        const numSamples = (audioBuffer.length - 44) / 2;
        energy = Math.sqrt(energy / numSamples);
        console.log(`[AUDIO] energy=${energy.toFixed(4)} max=${maxSample.toFixed(4)} samples=${numSamples} size=${audioBuffer.length}`);

        // Reject silent audio on server side as backup
        if (energy < 0.005) {
          console.log('[AUDIO] Rejecting silent audio (energy < 0.005)');
          send({ type: 'transcription', text: '' });
          return;
        }

        const result = await transcribeAudio(audioBuffer, 'audio/wav');
        console.log('Sending transcription response to client');
        send({ type: 'transcription', text: result.text || '' });
      } catch (err) {
        console.error('Transcription error:', err.message);
        send({ type: 'transcription', error: err.message });
      }
    } else {
      console.log('Unknown message type:', msg.type);
    }
  });

  ws.on('close', () => {
    // Turns keep running in agentd when the phone drops — reconnect and the
    // event stream resumes. Only an explicit interrupt stops work.
    conns.delete(connId);
  });
});

// ---------------------------------------------------------------------------
// Heartbeat interval to detect and close dead connections
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('Terminating dead WebSocket connection');
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

server.listen(PORT, () => {
  console.log(`\nhandsfree — voice interface for Claude Code`);
  console.log(`Working directory for the agent: ${WORKDIR}\n`);
  console.log(`Open on this machine:  https://localhost:${PORT}/`);
  for (const addr of lanAddresses()) {
    console.log(`Open on your phone:    https://${addr}:${PORT}/`);
  }
  console.log(`\n(The certificate is self-signed — tap through the browser warning once.)`);
});
