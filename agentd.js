// handsfree agentd — owns Claude Agent SDK turns, decoupled from the web
// server. The web server (server.js) can restart freely (deploys, UI changes)
// without killing an in-flight agent turn; events are buffered here while the
// web server is down and flushed when it reconnects.
//
// Restart contract: SIGHUP = drain (finish the current turn and queue, then
// exit 0 so the supervisor restarts us with new code). SIGTERM/SIGINT = die
// now, losing the in-flight turn.

import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
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
// Default working directory for new sessions only — each session remembers
// the directory it was started in (stored in the sessions registry).
const WORKDIR = path.resolve(process.argv[2] || process.env.WORKDIR || homedir());
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
  // A pre-migration agentd finishing its last turn during the rollout can
  // recreate the legacy file; it only holds that turn's preview update.
  else if (existsSync(legacy)) unlinkSync(legacy);
} catch (err) { console.error('Sessions migration failed:', err.message); }
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

function addOrUpdateSession(id, preview = '', lastResponse = '', cwd = '') {
  const sessions = loadSessions();
  const existing = sessions.find(s => s.id === id);
  if (existing) {
    existing.lastUsed = Date.now();
    if (preview) existing.preview = preview.slice(0, 300);
    if (lastResponse) existing.lastResponse = lastResponse.slice(0, 500);
    if (cwd && !existing.cwd) existing.cwd = cwd;
  } else {
    sessions.unshift({ id, lastUsed: Date.now(), preview: preview.slice(0, 300), lastResponse: lastResponse.slice(0, 500), cwd });
  }
  saveSessions(sessions.slice(0, 20));
}

// ---------------------------------------------------------------------------
// Linear: personal API key (from ~/.handsfree/linear.json) unlocks the
// official Linear MCP server in every session, whatever its cwd. Read per
// turn so rotating the key never needs a restart; absent file = no Linear.
// ---------------------------------------------------------------------------
function extraMcpServers() {
  try {
    const { api_key } = JSON.parse(readFileSync(path.join(DATA_DIR, 'linear.json'), 'utf8'));
    if (!api_key) return {};
    return {
      linear: {
        type: 'http',
        url: 'https://mcp.linear.app/mcp',
        headers: { Authorization: `Bearer ${api_key}` },
      },
    };
  } catch { return {}; }
}

// ---------------------------------------------------------------------------
// Session titles: after a session's first completed turn, ask a small model
// for a few-word description shown in the picker. Fire-and-forget — a failed
// or skipped title just leaves the preview text, and the next turn retries.
// ---------------------------------------------------------------------------
const titlesInFlight = new Set();

function maybeGenerateTitle(sessionId, userText, assistantText) {
  if (!sessionId || titlesInFlight.has(sessionId)) return;
  const session = loadSessions().find(s => s.id === sessionId);
  if (!session || session.title) return;
  titlesInFlight.add(sessionId);
  generateTitle(userText, assistantText)
    .then((title) => {
      if (!title) return;
      const sessions = loadSessions();
      const s = sessions.find(x => x.id === sessionId);
      if (!s || s.title) return; // deleted meanwhile, or titled elsewhere
      s.title = title;
      saveSessions(sessions);
      console.log(`Session ${sessionId} titled: "${title}"`);
      emit({ type: 'sessionsUpdated', sessions: loadSessions() });
    })
    .catch((err) => console.error('Title generation failed:', err.message || err))
    .finally(() => titlesInFlight.delete(sessionId));
}

async function generateTitle(userText, assistantText) {
  const prompt =
    'Give this conversation a title of at most five words that says what it is about. ' +
    'Reply with the title only — no quotes, no trailing punctuation.\n\n' +
    `User: ${String(userText).slice(0, 500)}\n\n` +
    `Assistant: ${String(assistantText).slice(0, 500)}`;
  // Run in DATA_DIR so the one-shot helper session picks up no project
  // context (CLAUDE.md, settings) from the user's working directory.
  const q = query({
    prompt,
    options: {
      cwd: DATA_DIR,
      model: 'haiku',
      maxTurns: 1,
      allowedTools: [],
      systemPrompt: 'You write short, plain titles for conversations.',
    },
  });
  let text = '';
  for await (const m of q) {
    if (m.type === 'result' && m.subtype === 'success' && m.result) text = m.result;
  }
  // One plain line, safe to drop into the picker's innerHTML.
  return text.split('\n')[0].replace(/["'`<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
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
let activeJob = null;   // the job behind `active`, for interrupt targeting
let activeSessionId = null; // resolved session of the active turn (set on init)
let draining = false;   // SIGHUP received: exit once idle
const queue = [];       // jobs waiting for the active turn to finish

// The web server mirrors this queue to show queued bubbles on reload; it
// must never guess, so report the actual contents on every change.
function queueSnapshot() {
  return queue.map((j) => ({ text: j.text, sessionId: j.sessionId }));
}
function emitQueue() {
  persistQueue();
  emit({ type: 'queue', queue: queueSnapshot() });
}

// Queued jobs survive hard restarts (a crash, the service takeover): every
// queue change is mirrored to disk and reloaded on startup. Only jobs that
// haven't started are persisted — replaying a half-finished turn would redo
// its work, and a job that crashes agentd would crash-loop it.
const QUEUE_FILE = path.join(DATA_DIR, 'queue.json');
function persistQueue() {
  try {
    if (queue.length) writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
    else if (existsSync(QUEUE_FILE)) unlinkSync(QUEUE_FILE);
  } catch (err) { console.error('Could not persist queue:', err.message); }
}
try {
  if (existsSync(QUEUE_FILE)) {
    for (const j of JSON.parse(readFileSync(QUEUE_FILE, 'utf8'))) {
      if (j && typeof j.text === 'string' && j.text.trim()) {
        // connIds are stale after a restart (and could collide with a new
        // connection's id), so restored jobs carry none.
        queue.push({ text: j.text, sessionId: j.sessionId || null, cwd: j.cwd || null, connId: null });
      }
    }
    if (queue.length) console.log(`Restored ${queue.length} queued job(s) from a previous run`);
  }
} catch (err) { console.error('Could not restore queued jobs:', err.message); }

// Two clients can hear the same utterance and submit slightly different
// transcriptions ("cute" vs "cued"), which slips past the server's exact-match
// dedup. Catch near-duplicates here by word overlap within a short window.
// The window must stay tight: twins of one utterance arrive within a second
// or two, but a user deliberately queuing similar messages ("queuing another"
// / "queuing yet another") needs several seconds just to say the second one —
// a 20s window ate those legitimate messages.
const recentJobs = []; // { words: Set, norm: string, at: ms }
function normText(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function jobWords(text) {
  return new Set(normText(text).split(' ').filter(Boolean));
}
// Word overlap misses short utterances where one word changed ("cued and
// running" vs "cute and running" scores 0.71); character-level edit distance
// catches those.
function charSimilarity(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}
function isNearDuplicate(text) {
  const norm = normText(text);
  const words = jobWords(text);
  if (!words.size) return false;
  const now = Date.now();
  for (const r of recentJobs) {
    if (now - r.at > 3000) continue;
    let inter = 0;
    for (const w of words) if (r.words.has(w)) inter++;
    const jaccard = inter / (words.size + r.words.size - inter);
    if (jaccard > 0.8 || charSimilarity(norm, r.norm) > 0.85) return true;
  }
  recentJobs.push({ words, norm, at: now });
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
  // Never spawn a turn without real text — Claude Code exits nonzero on an
  // empty prompt, which surfaces as a crash. Skip the job and keep the queue
  // moving instead.
  if (!job || typeof job.text !== 'string' || !job.text.trim()) {
    console.warn(`Skipping job with empty text (connId=${job && job.connId})`);
    if (queue.length) {
      const next = queue.shift();
      emitQueue();
      runTurn(next);
    } else if (draining) exitForRestart();
    return;
  }
  let lastAssistantText = '';
  let sessionId = job.sessionId || null;
  const requested = sessionId;
  // Resumed sessions run in the directory they were started in; new sessions
  // use the directory the client chose, falling back to the server default.
  const saved = sessionId ? loadSessions().find(s => s.id === sessionId) : null;
  const cwd = (saved && saved.cwd) || job.cwd || WORKDIR;
  console.log(`runTurn: connId=${job.connId} resume=${requested || 'new session'} cwd=${cwd} text="${job.text.slice(0, 60)}"`);
  activeJob = job;
  activeSessionId = sessionId;
  // Keep a short tail of the Claude Code subprocess's stderr so a crash
  // ("process exited with code 1") leaves its reason in our log.
  const stderrTail = [];
  active = query({
    prompt: job.text,
    options: {
      cwd,
      model: 'claude-fable-5',
      ...(sessionId ? { resume: sessionId } : {}),
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      // Load persistent memory (~/.claude/CLAUDE.md and any project
      // CLAUDE.md) — the SDK skips filesystem settings by default, which
      // made the agent forget things users told it to remember.
      settingSources: ['user', 'project'],
      mcpServers: extraMcpServers(),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: VOICE_SYSTEM_PROMPT },
      stderr: (data) => {
        const line = String(data).trimEnd();
        if (!line) return;
        stderrTail.push(line);
        while (stderrTail.length > 40) stderrTail.shift();
      },
    },
  });
  try {
    for await (const m of active) {
      if (m.type === 'system' && m.subtype === 'init') {
        if (requested && m.session_id !== requested) {
          console.warn(`Session mismatch! Requested ${requested} but got ${m.session_id}`);
        }
        sessionId = m.session_id;
        activeSessionId = sessionId;
        addOrUpdateSession(sessionId, job.text, '', cwd);
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
          maybeGenerateTitle(sessionId, job.text, lastAssistantText);
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
    if (stderrTail.length) {
      console.error('[claude stderr tail]\n' + stderrTail.join('\n'));
    }
    emit({ type: 'error', text: String(err.message || err), connId: job.connId });
  } finally {
    active = null;
    activeJob = null;
    activeSessionId = null;
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
        // Tell the submitting client, or its queued bubble waits forever for
        // a turn that will never come.
        emit({ type: 'dropped', text: msg.text.trim(), connId: msg.connId, busy: !!active });
        return;
      }
      const job = { text: msg.text.trim(), sessionId: msg.sessionId || null, cwd: msg.cwd || null, connId: msg.connId };
      if (active) {
        queue.push(job);
        // Log arrivals: without this the queue is invisible in the log until
        // the job runs, so a pre-deploy "is anything queued?" check can't work.
        console.log(`Queued (${queue.length} waiting): "${job.text.slice(0, 60)}"`);
        emitQueue();
        emit({ type: 'status', text: 'queued — still working on the last request', connId: job.connId });
      } else {
        runTurn(job);
      }
    } else if (msg.type === 'unqueue' && typeof msg.text === 'string') {
      // User changed their mind about a queued message; drop the first match.
      const i = queue.findIndex(
        (j) => j.text === msg.text && (!msg.sessionId || j.sessionId === msg.sessionId)
      );
      if (i !== -1) {
        queue.splice(i, 1);
        emitQueue();
        console.log(`Unqueued: "${msg.text.slice(0, 60)}"`);
      } else {
        console.log(`Unqueue miss (not in queue): "${msg.text.slice(0, 60)}"`);
      }
    } else if (msg.type === 'interrupt') {
      // Interrupts are scoped to the requesting session so other sessions'
      // turns and queued jobs keep running. Session ids can be briefly
      // unknown (a new session before its init event), so also match by the
      // connection that submitted the job. A bare interrupt (no ids, e.g.
      // from an older web server during a rolling restart) stops everything.
      const targeted = msg.sessionId != null || msg.connId != null;
      const matches = (sid, cid) =>
        !targeted ||
        (msg.sessionId != null ? sid === msg.sessionId : cid === msg.connId);
      const before = queue.length;
      for (let i = queue.length - 1; i >= 0; i--) {
        if (matches(queue[i].sessionId, queue[i].connId)) queue.splice(i, 1);
      }
      if (queue.length !== before) emitQueue();
      const hitActive = active && matches(activeSessionId, activeJob && activeJob.connId);
      if (hitActive) {
        try { await active.interrupt(); } catch { /* turn may have just ended */ }
      }
      if (hitActive || queue.length !== before) {
        emit({ type: 'status', text: 'interrupted', connId: msg.connId });
      } else {
        console.log(`Interrupt for session ${msg.sessionId || '(new)'} matched nothing (active=${activeSessionId || 'none'})`);
      }
    }
  });

  ws.on('close', () => {
    if (webClient === ws) webClient = null;
    // Turns keep running — that is the whole point of this process.
  });
  ws.on('error', (err) => console.error('WS error:', err.message));
});

console.log(`agentd — Claude turn runner`);
console.log(`Default working directory for new sessions: ${WORKDIR}`);
console.log(`Listening on ws://127.0.0.1:${PORT} (pid ${process.pid})`);

// Resume jobs restored from the persisted queue of a previous run.
if (queue.length) {
  const next = queue.shift();
  emitQueue();
  runTurn(next);
}
