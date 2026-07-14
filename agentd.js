// handsfree agentd — owns Claude Agent SDK turns, decoupled from the web
// server. The web server (server.js) can restart freely (deploys, UI changes)
// without killing an in-flight agent turn; events are buffered here while the
// web server is down and flushed when it reconnects.
//
// Restart contract: SIGHUP = drain (finish the current turn and queue, then
// exit 0 so the supervisor restarts us with new code). SIGTERM/SIGINT = die
// now, losing the in-flight turn.

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
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

const PORT = Number(process.env.AGENTD_PORT || 9878);
const WORKDIR = path.resolve(process.argv[2] || process.env.WORKDIR || process.cwd());
const SESSIONS_FILE = path.join(__dirname, '.sessions.json');
const PID_FILE = path.join(__dirname, '.agentd.pid');

writeFileSync(PID_FILE, String(process.pid) + '\n');

// Exit diagnostics (same discipline as server.js) — SIGHUP is the graceful
// drain signal, handled separately below.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.error(`[exit] received ${sig} at ${new Date().toISOString()}`);
    process.exit(128);
  });
}
process.on('exit', (code) => {
  try { if (readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) unlinkSync(PID_FILE); } catch {}
  console.error(`[exit] agentd exiting with code ${code}`);
});
process.on('uncaughtException', (err) => {
  console.error('[exit] uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[exit] unhandled rejection:', err);
});

// ---------------------------------------------------------------------------
// Sessions registry (agentd owns writes that result from turns; server.js
// still reads the file and handles deletes).
// ---------------------------------------------------------------------------
function loadSessions() {
  try {
    if (existsSync(SESSIONS_FILE)) return JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'));
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
  saveSessions(sessions.slice(0, 20));
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

function toolSummary(block) {
  const input = block.input || {};
  const detail =
    input.command || input.description || input.file_path || input.pattern ||
    input.query || input.prompt || '';
  return `${block.name} ${String(detail).slice(0, 120)}`.trim();
}

// ---------------------------------------------------------------------------
// Event delivery: one web-server client at a time; buffer while it's away.
// ---------------------------------------------------------------------------
let webClient = null;
const outbox = []; // stringified events queued while the web server is down

function emit(evt) {
  const s = JSON.stringify(evt);
  if (webClient && webClient.readyState === 1) {
    webClient.send(s);
  } else {
    outbox.push(s);
    if (outbox.length > 500) outbox.shift(); // drop oldest, never grow unbounded
  }
}

// ---------------------------------------------------------------------------
// Turn runner: one turn at a time, queue while busy, drain on SIGHUP.
// ---------------------------------------------------------------------------
let active = null;      // in-flight Query object, for interrupt
let draining = false;   // SIGHUP received: exit once idle
const queue = [];       // jobs waiting for the active turn to finish

// The web server mirrors this queue to show queued bubbles on reload; it
// must never guess, so report the actual contents on every change.
function queueSnapshot() {
  return queue.map((j) => ({ text: j.text, sessionId: j.sessionId }));
}
function emitQueue() {
  emit({ type: 'queue', queue: queueSnapshot() });
}

// Two clients can hear the same utterance and submit slightly different
// transcriptions ("cute" vs "cued"), which slips past the server's exact-match
// dedup. Catch near-duplicates here by word overlap within a short window.
const recentJobs = []; // { words: Set, at: ms }
function jobWords(text) {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
  );
}
function isNearDuplicate(text) {
  const words = jobWords(text);
  if (!words.size) return false;
  const now = Date.now();
  for (const r of recentJobs) {
    if (now - r.at > 20000) continue;
    let inter = 0;
    for (const w of words) if (r.words.has(w)) inter++;
    const jaccard = inter / (words.size + r.words.size - inter);
    if (jaccard > 0.8) return true;
  }
  recentJobs.push({ words, at: now });
  while (recentJobs.length > 10) recentJobs.shift();
  return false;
}

process.on('SIGHUP', () => {
  console.log(`[drain] SIGHUP at ${new Date().toISOString()} — will restart when idle (active=${!!active}, queued=${queue.length})`);
  draining = true;
  if (!active) exitForRestart();
});

function exitForRestart() {
  console.log('[drain] idle — exiting so the supervisor restarts us with new code');
  process.exit(0);
}

async function runTurn(job) {
  let lastAssistantText = '';
  let sessionId = job.sessionId || null;
  const requested = sessionId;
  console.log(`runTurn: connId=${job.connId} resume=${requested || 'new session'} text="${job.text.slice(0, 60)}"`);
  active = query({
    prompt: job.text,
    options: {
      cwd: WORKDIR,
      model: 'claude-fable-5',
      ...(sessionId ? { resume: sessionId } : {}),
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: VOICE_SYSTEM_PROMPT },
    },
  });
  try {
    for await (const m of active) {
      if (m.type === 'system' && m.subtype === 'init') {
        if (requested && m.session_id !== requested) {
          console.warn(`Session mismatch! Requested ${requested} but got ${m.session_id}`);
        }
        sessionId = m.session_id;
        addOrUpdateSession(sessionId, job.text);
        emit({ type: 'sessionStarted', sessionId, connId: job.connId });
      } else if (m.type === 'assistant') {
        const blocks = m.message?.content ?? m.content ?? [];
        for (const block of blocks) {
          if (block.type === 'text' && block.text.trim()) {
            emit({ type: 'assistant', text: block.text, connId: job.connId });
            lastAssistantText = block.text;
          } else if (block.type === 'tool_use') {
            emit({ type: 'tool', text: toolSummary(block), connId: job.connId });
          }
        }
      } else if (m.type === 'result') {
        const errored = m.subtype && m.subtype !== 'success';
        if (sessionId && lastAssistantText) {
          addOrUpdateSession(sessionId, job.text, lastAssistantText);
        }
        emit({
          type: 'result',
          ok: !errored,
          text: m.result || (errored ? `Turn ended: ${m.subtype}` : ''),
          sessions: loadSessions(),
          sessionId,
          connId: job.connId,
        });
      }
    }
  } catch (err) {
    console.error('Turn error:', err);
    emit({ type: 'error', text: String(err.message || err), connId: job.connId });
  } finally {
    active = null;
    if (queue.length) {
      const next = queue.shift();
      emitQueue();
      runTurn(next);
    } else if (draining) exitForRestart();
  }
}

// ---------------------------------------------------------------------------
// Loopback-only WebSocket server for the web server to connect to.
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });

wss.on('connection', (ws) => {
  console.log('Web server connected');
  if (webClient && webClient.readyState === 1) webClient.close();
  webClient = ws;

  ws.send(JSON.stringify({ type: 'ready', busy: !!active, queued: queue.length, queue: queueSnapshot(), draining }));
  while (outbox.length) ws.send(outbox.shift());

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'user' && typeof msg.text === 'string' && msg.text.trim()) {
      if (draining) {
        // Still accept it — it runs after the restart? No: we exit when idle.
        // Run it now; drain waits for the whole queue to empty.
        console.log('[drain] accepting message during drain; restart happens after the queue empties');
      }
      if (isNearDuplicate(msg.text.trim())) {
        console.log(`Dropping near-duplicate transcription: "${msg.text.trim().slice(0, 60)}"`);
        return;
      }
      const job = { text: msg.text.trim(), sessionId: msg.sessionId || null, connId: msg.connId };
      if (active) {
        queue.push(job);
        emitQueue();
        emit({ type: 'status', text: 'queued — still working on the last request', connId: job.connId });
      } else {
        runTurn(job);
      }
    } else if (msg.type === 'interrupt') {
      queue.length = 0;
      emitQueue();
      if (active) {
        try { await active.interrupt(); } catch { /* turn may have just ended */ }
      }
      emit({ type: 'status', text: 'interrupted' });
    }
  });

  ws.on('close', () => {
    if (webClient === ws) webClient = null;
    // Turns keep running — that is the whole point of this process.
  });
  ws.on('error', (err) => console.error('WS error:', err.message));
});

console.log(`agentd — Claude turn runner`);
console.log(`Working directory for the agent: ${WORKDIR}`);
console.log(`Listening on ws://127.0.0.1:${PORT} (pid ${process.pid})`);
