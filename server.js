// handsfree — voice-controlled Claude Code server.
// Serves a mobile web UI over self-signed HTTPS and bridges speech-transcribed
// messages to the Claude Agent SDK over WebSocket.

import { createServer } from 'node:https';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
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
const SESSIONS_FILE = path.join(__dirname, '.sessions.json');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const USAGE_FILE = path.join(__dirname, '.usage.json');
// Local Whisper server (faster-whisper on GPU) - falls back to OpenAI if unavailable
const LOCAL_WHISPER_URL = process.env.WHISPER_URL || 'http://127.0.0.1:9876/transcribe';
// Local TTS server (Piper) - falls back to browser speech synthesis if unavailable
const LOCAL_TTS_URL = process.env.TTS_URL || 'http://127.0.0.1:9877/synthesize';

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
    return { audio: Buffer.from(audioBuffer).toString('base64'), source: 'local' };
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

function addOrUpdateSession(id, preview = '', lastResponse = '') {
  const sessions = loadSessions();
  const existing = sessions.find(s => s.id === id);
  if (existing) {
    existing.lastUsed = Date.now();
    if (preview) existing.preview = preview.slice(0, 300);
    if (lastResponse) existing.lastResponse = lastResponse.slice(0, 500);
  } else {
    sessions.unshift({ id, lastUsed: Date.now(), preview: preview.slice(0, 300), lastResponse: lastResponse.slice(0, 500) });
  }
  // Keep only last 20 sessions
  saveSessions(sessions.slice(0, 20));
}

function getMostRecentSessionId() {
  const sessions = loadSessions();
  return sessions.length > 0 ? sessions[0].id : null;
}

// Load conversation history from SDK session file
function loadSessionHistory(sessionId, maxMessages = 20) {
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  const projectPath = WORKDIR.replace(/\//g, '-');
  const sessionFile = path.join(homeDir, '.claude', 'projects', projectPath, `${sessionId}.jsonl`);

  const messages = [];
  try {
    if (!existsSync(sessionFile)) return messages;
    const lines = readFileSync(sessionFile, 'utf8').split('\n').filter(l => l.trim());

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'user' && entry.message?.content) {
          // User message - extract text
          const text = entry.message.content
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n');
          if (text.trim()) {
            messages.push({ role: 'user', text: text.slice(0, 500) });
          }
        } else if (entry.type === 'assistant' && entry.message?.content) {
          // Assistant message - extract text only (skip tool calls)
          const text = entry.message.content
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n');
          if (text.trim()) {
            messages.push({ role: 'assistant', text: text.slice(0, 1000) });
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
    res.end(JSON.stringify({ version: APP_VERSION }));
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
// WebSocket: one Claude session per connection, messages queued while busy.
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server, maxPayload: 50 * 1024 * 1024 }); // 50MB max for audio

wss.on('connection', (ws) => {
  console.log('New WebSocket connection');
  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
  let sessionId = null; // Will be set by client via 'session' message or on first turn
  let sessionChosen = false; // Track whether user has explicitly chosen a session

  // Heartbeat to keep connection alive
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
  let active = null; // in-flight Query object, for interrupt
  const pending = []; // utterances queued while a turn is running
  let lastUserMessage = '';

  send({ type: 'hello', workdir: WORKDIR, sessions: loadSessions(), version: APP_VERSION });

  function toolSummary(block) {
    const input = block.input || {};
    const detail =
      input.command || input.description || input.file_path || input.pattern ||
      input.query || input.prompt || '';
    return `${block.name} ${String(detail).slice(0, 120)}`.trim();
  }

  async function runTurn(text) {
    let lastAssistantText = '';
    const requestedSessionId = sessionId; // Remember what we asked for
    console.log(`runTurn: requested resume=${requestedSessionId || 'new session'}`);
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
          console.log(`SDK init: got session_id=${m.session_id}, requested=${requestedSessionId}`);
          if (requestedSessionId && m.session_id !== requestedSessionId) {
            console.warn(`Session mismatch! Requested ${requestedSessionId} but got ${m.session_id}`);
          }
          sessionId = m.session_id;
          addOrUpdateSession(sessionId, lastUserMessage);
        } else if (m.type === 'assistant') {
          const blocks = m.message?.content ?? m.content ?? [];
          for (const block of blocks) {
            if (block.type === 'text' && block.text.trim()) {
              // Try to synthesize speech for this text
              const tts = await synthesizeSpeech(block.text);
              if (tts) {
                send({ type: 'assistant', text: block.text, audio: tts.audio });
              } else {
                send({ type: 'assistant', text: block.text });
              }
              lastAssistantText = block.text; // Track last response
            } else if (block.type === 'tool_use') {
              send({ type: 'tool', text: toolSummary(block) });
            }
          }
        } else if (m.type === 'result') {
          const errored = m.subtype && m.subtype !== 'success';
          // Update session with last response
          console.log(`Result: sessionId=${sessionId}, lastAssistantText length=${lastAssistantText.length}, preview="${lastAssistantText.slice(0,50)}"`);
          if (sessionId && lastAssistantText) {
            addOrUpdateSession(sessionId, lastUserMessage, lastAssistantText);
          }
          send({
            type: 'result',
            ok: !errored,
            text: m.result || (errored ? `Turn ended: ${m.subtype}` : ''),
            sessions: loadSessions(), // Send updated sessions list
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
      const newSessionId = msg.id || null;
      const sameSession = (newSessionId === sessionId && sessionChosen);
      sessionId = newSessionId;
      sessionChosen = true;
      if (sessionId) {
        console.log('Client selected session:', sessionId);
        // Only send history if it's a new session selection, not a reconnect
        if (!sameSession) {
          const history = loadSessionHistory(sessionId);
          console.log(`Loaded ${history.length} messages from session history`);
          send({ type: 'history', messages: history });
        } else {
          console.log('Same session, skipping history reload');
        }
      } else {
        console.log('Client starting new session');
        send({ type: 'status', text: 'Starting new session...' });
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
      lastUserMessage = msg.text.trim();
      console.log(`Received user message, current sessionId=${sessionId}, sessionChosen=${sessionChosen}`);
      if (!sessionChosen) {
        console.warn('User message received before session was chosen, ignoring');
        send({ type: 'error', text: 'Please select a session first' });
        return;
      }
      if (active) {
        pending.push(msg.text);
        send({ type: 'status', text: 'queued — still working on the last request' });
      } else {
        runTurn(msg.text);
      }
    } else if (msg.type === 'vad_debug') {
      // Log VAD debug info for analyzing false triggers
      console.log(`[VAD] energy=${msg.energy.toFixed(4)} max=${msg.maxSample.toFixed(4)} samples=${msg.samples} playback=${msg.duringPlayback}`);
    } else if (msg.type === 'vad_rejected') {
      // Log when VAD rejected audio as too quiet
      console.log(`[VAD REJECTED] energy=${msg.energy.toFixed(4)} threshold=${msg.threshold} playback=${msg.duringPlayback}`);
    } else if (msg.type === 'barge_in') {
      // Log when barge-in is triggered
      console.log(`[BARGE-IN] energy=${msg.energy.toFixed(4)} playback=${msg.duringPlayback}`);
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
    pending.length = 0;
    if (active) active.interrupt().catch(() => {});
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
