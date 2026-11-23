#!/usr/bin/env node
'use strict';
// Command-line side of the protocol, used by Claude chats. See CLAUDE.md.
//
//   node app/cli.js create <project>          create a project (and start the web server if needed)
//   node app/cli.js watch <project>           block silently until the app sends requests, then print them and exit
//   node app/cli.js done <project> <id> [note]  mark a request handled (note is shown to the user)
//   node app/cli.js message <project> "<text>" [--file f.md] [--quote "exact text"]
//                                             send the user a message (optionally pinned to a passage)
//   node app/cli.js create <project> --git <url>  create a project by cloning a git repository
//   node app/cli.js git <project> status|sync|init|connect <url>|auto on|off
//   node app/cli.js conflict <project> <file>  show base / local / remote versions of a conflicted file
//   node app/cli.js compile <project> <file.tex>  compile LaTeX to projects/<project>/build/<file>.pdf
//   node app/cli.js requests <project>        list open requests
//   node app/cli.js list                      list projects and their watch status
//   node app/cli.js serve                     start the web server in the background if it isn't running

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const L = require('./lib');
const Git = require('./git');

const CLI = `node "${path.join(__dirname, 'cli.js')}"`;
const URL_BASE = `http://localhost:${L.PORT}`;
const q = (s) => JSON.stringify(s);

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function ping() {
  return new Promise((resolve) => {
    const req = http.get(`${URL_BASE}/api/ping`, { timeout: 800 }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d.includes('paper-editor')));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}
async function ensureServer() {
  if (await ping()) return `Web app: ${URL_BASE} (already running)`;
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (await ping()) return `Web app: ${URL_BASE} (started)`;
  }
  return `Could not confirm the web server started; run: node "${path.join(__dirname, 'server.js')}"`;
}

function fmtRequest(r, i) {
  const lines = [];
  lines.push(`[${i + 1}] id=${r.id}  type=${r.type}  file=${r.file || '(project-wide)'}`);
  if (r.type === 'merge') {
    lines.push(`    ${r.text}`);
    lines.push(`    Conflicted files: ${(r.files || []).join(', ')}`);
    return lines.join('\n');
  }
  if (r.type === 'comment') {
    lines.push(`    Selected text${r.line ? ` (line ${r.line})` : ''}: ${q(r.quote)}`);
    if (r.prefix || r.suffix) lines.push(`    In context: ${q(`…${r.prefix || ''}⟦${r.quote}⟧${r.suffix || ''}…`)}`);
    lines.push(`    Comment: ${q(r.text)}`);
  } else {
    if (r.replyToText) lines.push(`    (Reply to your earlier message: ${q(r.replyToText)})`);
    lines.push(`    ${r.replyToText ? 'Reply' : 'Request'}: ${q(r.text)}`);
  }
  return lines.join('\n');
}

function printWork(p, reqs) {
  const dir = L.projDir(p);
  console.log(`Project ${q(p)} has ${reqs.length} new request(s) from the Paper Editor editor.`);
  console.log(`Project folder: ${dir}\n`);
  reqs.forEach((r, i) => console.log(fmtRequest(r, i) + '\n'));
  if (reqs.some((r) => r.type === 'merge'))
    console.log(`GIT MERGE CONFLICT — how to resolve it:
- For each conflicted file run:  ${CLI} conflict ${q(p)} <file>
  It prints the common ancestor, the LOCAL version (currently in the file) and the REMOTE version.
- Edit the file so it contains the merged text: keep the intent of both sides, combine edits to the same
  passage sensibly, and leave no <<<<<<< / >>>>>>> markers. Do NOT run git commands yourself.
- Your edits appear to the user as tracked changes; the user approves the merge in the app, which commits and pushes.
- If you cannot decide something, ask the user with the message command (below) instead of guessing.
`);
  console.log(`How to handle them:
1. Edit the .md / .tex file(s) in the project folder directly (read them first). Make focused edits; for a comment,
   change the selected text / its surroundings as the comment asks. Never edit anything inside .collab/.
   The user sees your edits as tracked changes (insertions/deletions) and accepts or rejects them in the app.
   If a comment is only a question, answer it in the done-note instead of editing.
   After editing a .tex file, check it still compiles:  ${CLI} compile ${q(p)} <file.tex>  (fix errors you caused).
2. Mark each request handled with a short note that is shown to the user under the comment:
   ${CLI} done ${q(p)} <id> "what you changed"
   To tell the user something unprompted (a question, a heads-up, a suggestion), send a message:
   ${CLI} message ${q(p)} "text" [--file f.md] [--quote "exact text in the file"]
3. Relaunch the watcher with run_in_background (do not poll or sleep):
   ${CLI} watch ${q(p)}`);
}

function watch(p) {
  L.requireProject(p);
  const wf = L.watcherFile(p);
  const since = Date.now();
  const startPpid = process.ppid;
  const write = (state) =>
    L.atomicWrite(wf, JSON.stringify({ pid: process.pid, state, since: state === 'working' ? Date.now() : since, heartbeat: Date.now() }));
  write('watching');
  let lastBeat = Date.now();

  const stop = () => {
    const w = L.readJSON(wf, null);
    if (w && w.pid === process.pid) write('off');
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('SIGHUP', stop);

  setInterval(() => {
    const w = L.readJSON(wf, null);
    if (w && w.pid !== process.pid && w.state === 'watching' && L.pidAlive(w.pid)) {
      console.log(`Another watcher (pid ${w.pid}) took over project ${q(p)}. This one stopped; nothing to do.`);
      process.exit(0);
    }
    if (process.ppid !== startPpid) stop(); // the chat that started us is gone
    const pending = L.listRequests(p).filter((r) => r.status === 'pending');
    if (pending.length) {
      // Let a quick burst of comments arrive together.
      const newest = Math.max(...pending.map((r) => r.created));
      if (Date.now() - newest >= 2500) {
        for (const r of pending) {
          r.status = 'in_progress';
          r.startedAt = Date.now();
          L.saveRequest(p, r);
        }
        write('working');
        printWork(p, pending);
        process.exit(0);
      }
    }
    if (Date.now() - lastBeat >= L.HEARTBEAT_MS) {
      write('watching');
      lastBeat = Date.now();
    }
  }, 1000);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'create': {
      const p = args[0] || die('Usage: create <project> [--git <url>]');
      L.checkName(p, 'project name');
      const gi = args.indexOf('--git');
      if (gi > 0) {
        if (!args[gi + 1]) die('Usage: create <project> --git <url>');
        await Git.clone(p, args[gi + 1]);
        console.log(`Cloned ${args[gi + 1]} into project ${q(p)} at ${L.projDir(p)}`);
        console.log(await ensureServer());
        console.log(`Now watch it: run with run_in_background ->  ${CLI} watch ${q(p)}`);
        break;
      }
      const created = L.createProject(p);
      console.log(created ? `Created project ${q(p)} at ${L.projDir(p)}` : `Project ${q(p)} already exists at ${L.projDir(p)}`);
      console.log(await ensureServer());
      console.log(`Now watch it: run with run_in_background ->  ${CLI} watch ${q(p)}`);
      break;
    }
    case 'watch': {
      const p = args[0] || die('Usage: watch <project>');
      if (!L.exists(p)) die(`No project ${q(p)}. Existing: ${L.listProjects().join(', ') || '(none)'}. Create with: ${CLI} create ${q(p)}`);
      await ensureServer();
      watch(p);
      break;
    }
    case 'done': {
      const [p, id, ...note] = args;
      if (!p || !id) die('Usage: done <project> <id> [note]');
      L.requireProject(p);
      const r = L.getRequest(p, id);
      if (!r) console.log(`Request ${id} not found (the user may have deleted it). Nothing to do.`);
      else {
        r.status = 'done';
        r.reply = note.join(' ').trim();
        r.doneAt = Date.now();
        L.saveRequest(p, r);
        console.log(`Marked ${id} done.`);
      }
      const left = L.listRequests(p).filter((x) => x.status === 'in_progress');
      if (left.length) console.log(`Still in progress: ${left.map((x) => x.id).join(', ')}`);
      else console.log(`All done. Relaunch the watcher with run_in_background: ${CLI} watch ${q(p)}`);
      break;
    }
    case 'message': {
      const opts = {};
      const pos = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--file' || args[i] === '--quote') opts[args[i].slice(2)] = args[++i];
        else pos.push(args[i]);
      }
      const [p, ...words] = pos;
      const text = words.join(' ').trim();
      if (!p || !text) die('Usage: message <project> "<text>" [--file f.md] [--quote "exact text"]');
      L.requireProject(p);
      const r = { id: L.newId(), type: 'message', from: 'claude', file: opts.file ? L.checkFile(opts.file) : null, text, status: 'unread', created: Date.now() };
      if (opts.quote) {
        const file = r.file || L.listFiles(p)[0];
        const content = L.readText(path.join(L.projDir(p), file)) || '';
        const at = content.indexOf(opts.quote);
        if (at < 0) die(`--quote text not found in ${file}; it must match the file exactly.`);
        Object.assign(r, { file, quote: opts.quote, start: at, end: at + opts.quote.length });
      }
      L.saveRequest(p, r);
      console.log(`Message sent to the user (id=${r.id}). If they reply, the watcher will wake you with it.`);
      break;
    }
    case 'git': {
      const [p, action, arg] = args;
      if (!p || !action) die('Usage: git <project> status|sync|init|connect <url>|auto on|off');
      L.requireProject(p);
      let r;
      if (action === 'init') r = await Git.init(p);
      else if (action === 'connect') r = await Git.connect(p, arg);
      else if (action === 'sync') r = await Git.sync(p);
      else if (action === 'auto') { Git.updateCfg(p, { auto: arg === 'on', paused: false }); r = { auto: arg === 'on' }; }
      else if (action !== 'status') die('Unknown git action');
      if (r) console.log(JSON.stringify(r, null, 2));
      const s = await Git.status(p);
      if (!s.enabled) console.log('Not a git repository. Use: git <project> init   or   git <project> connect <url>');
      else console.log(`branch ${s.branch}${s.remote ? `, remote ${s.remote}` : ', no remote'}; ${s.changed} uncommitted change(s); ahead ${s.ahead}, behind ${s.behind}; auto-sync ${s.auto ? 'on' : 'off'}${s.conflict ? `; MERGE CONFLICT in ${s.conflict.files.join(', ')}` : ''}${s.lastError ? `; last error: ${s.lastError}` : ''}`);
      break;
    }
    case 'conflict': {
      const [p, f] = args;
      if (!p || !f) die('Usage: conflict <project> <file>');
      L.requireProject(p);
      const v = await Git.conflictVersions(p, f);
      if (v.ours == null && v.theirs == null) die(`${f} is not in conflict.`);
      const show = (title, t) => console.log(`===== ${title} =====\n${t == null ? '(file does not exist on this side)' : t}\n`);
      show('COMMON ANCESTOR', v.base);
      show('LOCAL (this computer — currently in the file)', v.ours);
      show('REMOTE (origin)', v.theirs);
      console.log(`Write the merged result into ${L.projDir(p)}/${f}`);
      break;
    }
    case 'compile': {
      const [p, f] = args;
      if (!p || !f) die('Usage: compile <project> <file.tex>');
      L.requireProject(p);
      const r = await L.compileTex(p, f);
      if (r.root && r.root !== f) console.log(`${f} is part of ${r.root} — compiling ${r.root}.`);
      if (r.ok) console.log(`Compiled OK with ${r.compiler} in ${(r.ms / 1000).toFixed(1)}s -> ${r.pdfPath}`);
      else console.log(`Compilation FAILED${r.compiler ? ` (${r.compiler})` : ''}.`);
      for (const e of r.errors) console.log(`  ${e.kind}${e.line ? ` ${e.file ? e.file + ' ' : ''}line ${e.line}` : ''}: ${e.message}`);
      if (!r.ok && r.output) console.log('--- compiler output (tail) ---\n' + r.output.slice(-2500));
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'requests': {
      const p = args[0] || die('Usage: requests <project>');
      L.requireProject(p);
      const open = L.listRequests(p).filter((r) => r.type !== 'message' && r.status !== 'done');
      if (!open.length) console.log('No open requests.');
      open.forEach((r, i) => console.log(`${fmtRequest(r, i)}\n    status: ${r.status}\n`));
      break;
    }
    case 'list': {
      const ps = L.listProjects();
      if (!ps.length) console.log('No projects yet.');
      for (const p of ps) {
        const open = L.listRequests(p).filter((r) => (r.type === 'message' ? r.status === 'unread' : r.status !== 'done')).length;
        console.log(`${p}  [${L.watchStatus(p).state}]  files: ${L.listFiles(p).join(', ')}  open requests: ${open}`);
      }
      break;
    }
    case 'serve':
      console.log(await ensureServer());
      break;
    default:
      console.log(`Usage:
  ${CLI} create <project>
  ${CLI} watch <project>          (run in background; exits when there is work)
  ${CLI} done <project> <id> [note]
  ${CLI} requests <project>
  ${CLI} list
  ${CLI} serve`);
  }
}

main().catch((e) => die(e.message));
