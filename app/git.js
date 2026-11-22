'use strict';
// Git integration: every project folder can be its own repository, optionally synced with a remote "origin".
//
// Sync = commit local changes -> fetch -> merge origin/<branch> -> push.
// On a merge conflict the merge is left in progress with the *local* version in each conflicted file,
// a "merge" request is queued for Claude (who writes the merged text as tracked changes), and the
// user approves (commit + push) or cancels the merge in the app.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const L = require('./lib');

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes -o ConnectTimeout=20',
  GIT_MERGE_AUTOEDIT: 'no',
  LC_ALL: 'C',
};
const FALLBACK_ID = ['-c', 'user.name=Paper Editor', '-c', 'user.email=paper-editor@localhost'];

function git(dir, args, { allowFail = false, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'protocol.ext.allow=never', '-c', 'core.quotepath=off', ...args],
      { cwd: dir, env: GIT_ENV, timeout, maxBuffer: 50e6 },
      (err, stdout, stderr) => {
        const r = { code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout), err: String(stderr) };
        if (err && !allowFail) {
          const msg = (r.err || r.out || err.message).trim().split('\n').filter(Boolean).slice(-4).join('\n');
          const e = new Error(err.killed ? 'git timed out (network or authentication problem?)' : msg || 'git failed');
          e.status = 500;
          return reject(e);
        }
        resolve(r);
      }
    );
  });
}

const cfgFile = (p) => path.join(L.collabDir(p), 'git.json');
const readCfg = (p) => ({ auto: false, interval: 120, lastSync: null, lastError: null, conflict: null, paused: false, ...L.readJSON(cfgFile(p), {}) });
const writeCfg = (p, c) => L.atomicWrite(cfgFile(p), JSON.stringify(c, null, 2));
const updateCfg = (p, patch) => { const c = { ...readCfg(p), ...patch }; writeCfg(p, c); return c; };
const isRepo = (p) => fs.existsSync(path.join(L.projDir(p), '.git'));

function checkUrl(url) {
  url = String(url || '').trim();
  if (!url || url.startsWith('-') || /\s/.test(url) || /^ext::/i.test(url) || url.length > 500) throw L.httpErr(400, 'Invalid repository URL');
  return url;
}
// Keep protocol state and build output out of the repository without touching the repo's own files.
function ensureExclude(dir) {
  const f = path.join(dir, '.git', 'info', 'exclude');
  let t = L.readText(f) || '';
  let add = '';
  for (const line of ['.collab/', 'build/', '.DS_Store']) if (!t.split('\n').includes(line)) add += line + '\n';
  if (add) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, (t && !t.endsWith('\n') ? t + '\n' : t) + add);
  }
}
async function idArgs(dir) {
  const n = await git(dir, ['config', 'user.name'], { allowFail: true });
  const e = await git(dir, ['config', 'user.email'], { allowFail: true });
  return n.out.trim() && e.out.trim() ? [] : FALLBACK_ID;
}
async function currentBranch(dir) {
  const r = await git(dir, ['symbolic-ref', '--short', 'HEAD'], { allowFail: true });
  return r.out.trim() || 'main';
}
const hasCommits = async (dir) => (await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true })).code === 0;

// After git changed files on disk, treat them as accepted (they are not Claude's suggestions).
function acceptAll(p) {
  for (const f of L.listFiles(p)) {
    const cur = L.readText(path.join(L.projDir(p), f));
    if (cur != null) L.atomicWrite(path.join(L.collabDir(p), 'base', f), cur);
  }
}
function pendingReviews(p, files = null) {
  return L.listFiles(p).filter((f) => {
    if (files && !files.includes(f)) return false;
    const d = L.readDoc(p, f);
    return d.current !== d.base;
  });
}

// ---------- status (cached; git is too slow to run on every poll) ----------
const cache = new Map();
const running = new Map();
async function status(p) {
  const dir = L.projDir(p);
  const cfg = readCfg(p);
  if (!isRepo(p)) {
    const s = { enabled: false };
    cache.set(p, { at: Date.now(), s });
    return s;
  }
  const branch = await currentBranch(dir);
  const remote = (await git(dir, ['remote', 'get-url', 'origin'], { allowFail: true })).out.trim() || null;
  const changed = (await git(dir, ['status', '--porcelain'], { allowFail: true })).out.split('\n').filter((l) => l && !l.startsWith('??  .collab')).length;
  let ahead = 0, behind = 0, upstream = false;
  if (remote) {
    const r = await git(dir, ['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`], { allowFail: true });
    if (r.code === 0) {
      upstream = true;
      [ahead, behind] = r.out.trim().split(/\s+/).map(Number);
    }
  }
  const name = (await git(dir, ['config', 'user.name'], { allowFail: true })).out.trim();
  const email = (await git(dir, ['config', 'user.email'], { allowFail: true })).out.trim();
  const s = {
    enabled: true, branch, remote, changed, ahead, behind, upstream,
    merging: fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD')),
    auto: cfg.auto, interval: cfg.interval, paused: cfg.paused, lastSync: cfg.lastSync, lastError: cfg.lastError,
    conflict: cfg.conflict, syncing: running.has(p), author: name && email ? { name, email } : null,
  };
  cache.set(p, { at: Date.now(), s });
  return s;
}
function cachedStatus(p) {
  const c = cache.get(p);
  if (!c || Date.now() - c.at > 10000) {
    const fresh = status(p).catch(() => null);
    if (!c) return null;
    fresh.then(() => {});
  }
  const s = c ? { ...c.s } : null;
  if (s && s.enabled) {
    const cfg = readCfg(p);
    Object.assign(s, { syncing: running.has(p), conflict: cfg.conflict, lastSync: cfg.lastSync, lastError: cfg.lastError, auto: cfg.auto, paused: cfg.paused });
  }
  return s;
}

// ---------- operations ----------
function exclusive(p, fn) {
  if (running.has(p)) return running.get(p);
  const job = (async () => fn())().finally(() => {
    running.delete(p);
    status(p).catch(() => {});
  });
  running.set(p, job);
  return job;
}

async function init(p) {
  return exclusive(p, async () => {
    const dir = L.projDir(p);
    if (!isRepo(p)) await git(dir, ['init', '-b', 'main']);
    ensureExclude(dir);
    await git(dir, ['add', '-A']);
    if ((await git(dir, ['diff', '--cached', '--name-only'])).out.trim() || !(await hasCommits(dir)))
      await git(dir, [...(await idArgs(dir)), 'commit', '--allow-empty', '-m', 'Initial commit (Paper Editor)']);
    return { ok: true };
  });
}

async function connect(p, url) {
  url = checkUrl(url);
  if (!isRepo(p)) await init(p);
  return exclusive(p, async () => {
    const dir = L.projDir(p);
    const has = (await git(dir, ['remote'], { allowFail: true })).out.split('\n').includes('origin');
    await git(dir, has ? ['remote', 'set-url', 'origin', url] : ['remote', 'add', 'origin', url]);
    const head = await git(dir, ['ls-remote', '--symref', 'origin', 'HEAD'], { timeout: 60000 });
    const m = /ref: refs\/heads\/(\S+)\s+HEAD/.exec(head.out);
    if (m && m[1] !== (await currentBranch(dir))) await git(dir, ['branch', '-M', m[1]]);
    updateCfg(p, { paused: false, lastError: null });
    return { ok: true, remoteBranch: m ? m[1] : null };
  }).then(async (r) => ({ ...r, sync: await sync(p, { firstConnect: true }) }));
}

async function clone(name, url) {
  url = checkUrl(url);
  L.checkName(name, 'project name');
  if (L.exists(name)) throw L.httpErr(409, `Project "${name}" already exists`);
  fs.mkdirSync(L.PROJECTS, { recursive: true });
  await git(L.PROJECTS, ['clone', '--', url, name], { timeout: 300000 });
  L.createProject(name);
  ensureExclude(L.projDir(name));
  acceptAll(name);
  updateCfg(name, { lastSync: Date.now() });
  return { name };
}

async function setAuthor(p, name, email) {
  const dir = L.projDir(p);
  name = String(name || '').trim();
  email = String(email || '').trim();
  if (!name || !email || /[\n\r]/.test(name + email)) throw L.httpErr(400, 'Name and email are required');
  await git(dir, ['config', 'user.name', name]);
  await git(dir, ['config', 'user.email', email]);
  return status(p);
}

async function sync(p, { firstConnect = false } = {}) {
  return exclusive(p, async () => {
    const dir = L.projDir(p);
    const cfg = readCfg(p);
    try {
      if (!isRepo(p)) throw L.httpErr(400, 'This project is not a git repository yet');
      if (cfg.conflict || fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD')))
        return { state: 'conflict', message: 'A merge is waiting for approval' };
      const pending = pendingReviews(p);
      if (pending.length) return { state: 'blocked', message: `Accept or reject Claude's suggestions in ${pending.join(', ')} first` };
      ensureExclude(dir);
      const id = await idArgs(dir);
      await git(dir, ['add', '-A']);
      const staged = (await git(dir, ['diff', '--cached', '--name-only'])).out.split('\n').filter(Boolean);
      if (staged.length) {
        const names = staged.slice(0, 4).join(', ') + (staged.length > 4 ? ` and ${staged.length - 4} more` : '');
        await git(dir, [...id, 'commit', '-m', `Update ${names}`]);
      }
      const remote = (await git(dir, ['remote', 'get-url', 'origin'], { allowFail: true })).out.trim();
      if (!remote) {
        updateCfg(p, { lastSync: Date.now(), lastError: null });
        return { state: 'ok', committed: staged.length, message: staged.length ? 'Committed locally (no remote)' : 'Nothing to commit' };
      }
      const branch = await currentBranch(dir);
      await git(dir, ['fetch', 'origin'], { timeout: 120000 });
      const remoteRef = `origin/${branch}`;
      const remoteExists = (await git(dir, ['rev-parse', '--verify', '--quiet', remoteRef], { allowFail: true })).code === 0;
      let merged = false;
      if (remoteExists) {
        const behind = +(await git(dir, ['rev-list', '--count', `HEAD..${remoteRef}`])).out.trim();
        if (behind > 0) {
          const args = [...id, 'merge', '--no-edit', remoteRef];
          if (firstConnect) args.push('--allow-unrelated-histories');
          const r = await git(dir, args, { allowFail: true });
          if (r.code !== 0) {
            const files = (await git(dir, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true })).out.split('\n').filter(Boolean);
            if (!files.length) {
              await git(dir, ['merge', '--abort'], { allowFail: true });
              throw new Error((r.err || r.out).trim().split('\n').slice(-3).join('\n') || 'Merge failed');
            }
            return await startConflict(p, dir, branch, files);
          }
          merged = true;
          acceptAll(p);
        }
      }
      const ahead = remoteExists ? +(await git(dir, ['rev-list', '--count', `${remoteRef}..HEAD`])).out.trim() : 1;
      if (ahead > 0 && (await hasCommits(dir))) await git(dir, ['push', '-u', 'origin', `HEAD:${branch}`], { timeout: 120000 });
      updateCfg(p, { lastSync: Date.now(), lastError: null, paused: false });
      return { state: 'ok', committed: staged.length, merged, pushed: ahead > 0 };
    } catch (e) {
      updateCfg(p, { lastError: e.message });
      return { state: 'error', message: e.message };
    }
  });
}

async function startConflict(p, dir, branch, files) {
  const remoteHead = (await git(dir, ['rev-parse', '--short', `origin/${branch}`])).out.trim();
  for (const f of files) {
    // Show the local side in the editor; Claude's merged text then appears as tracked changes against it.
    const ours = await git(dir, ['show', `:2:${f}`], { allowFail: true });
    const theirs = await git(dir, ['show', `:3:${f}`], { allowFail: true });
    const content = ours.code === 0 ? ours.out : theirs.code === 0 ? theirs.out : null;
    if (content != null) fs.writeFileSync(path.join(dir, f), content);
  }
  acceptAll(p);
  const r = {
    id: L.newId(), type: 'merge', file: null, status: 'pending', created: Date.now(), files, branch, remoteHead,
    text: `Git merge conflict while syncing with origin/${branch} (remote commit ${remoteHead}) in: ${files.join(', ')}`,
  };
  L.saveRequest(p, r);
  updateCfg(p, { conflict: { requestId: r.id, files, branch, remoteHead, since: Date.now() }, lastError: null });
  return { state: 'conflict', files, message: `Merge conflict in ${files.join(', ')}` };
}

// The user approved the merged result: commit the merge and push.
async function completeMerge(p) {
  const cfg = readCfg(p);
  if (!cfg.conflict) throw L.httpErr(400, 'There is no merge waiting for approval');
  const pending = pendingReviews(p, cfg.conflict.files);
  if (pending.length) throw L.httpErr(409, `Accept or reject the suggested changes in ${pending.join(', ')} first`);
  const dir = L.projDir(p);
  const bad = cfg.conflict.files.filter((f) => /^(<<<<<<<|>>>>>>>) /m.test(L.readText(path.join(dir, f)) || ''));
  if (bad.length) throw L.httpErr(409, `Conflict markers are still in ${bad.join(', ')}`);
  await exclusive(p, async () => {
    await git(dir, ['add', '-A']);
    await git(dir, [...(await idArgs(dir)), 'commit', '--no-edit']);
  });
  const req = L.getRequest(p, cfg.conflict.requestId);
  if (req && req.status !== 'done') { req.status = 'done'; req.doneAt = Date.now(); req.reply = req.reply || 'Merge approved by the user.'; L.saveRequest(p, req); }
  updateCfg(p, { conflict: null });
  return sync(p);
}

async function abortMerge(p) {
  const cfg = readCfg(p);
  const dir = L.projDir(p);
  await exclusive(p, async () => {
    await git(dir, ['merge', '--abort'], { allowFail: true });
    acceptAll(p);
  });
  if (cfg.conflict) {
    const req = L.getRequest(p, cfg.conflict.requestId);
    if (req) { req.status = 'done'; req.doneAt = Date.now(); req.reply = (req.reply ? req.reply + ' ' : '') + '(Merge cancelled by the user.)'; L.saveRequest(p, req); }
  }
  // Pause auto-sync, otherwise the next run would hit the same conflict again.
  updateCfg(p, { conflict: null, paused: true });
  return status(p);
}

// Three versions of a conflicted file, for Claude.
async function conflictVersions(p, f) {
  const dir = L.projDir(p);
  const show = async (n) => { const r = await git(dir, ['show', `:${n}:${f}`], { allowFail: true }); return r.code === 0 ? r.out : null; };
  return { base: await show(1), ours: await show(2), theirs: await show(3) };
}

// ---------- automatic sync (runs inside the web server, no Claude involved) ----------
const lastEdit = new Map();
const lastAttempt = new Map();
function noteEdit(p) { lastEdit.set(p, Date.now()); }
function startAutoSync() {
  setInterval(() => {
    let projects;
    try { projects = L.listProjects(); } catch { return; }
    for (const p of projects) {
      try {
        if (!isRepo(p) || running.has(p)) continue;
        const cfg = readCfg(p);
        if (!cfg.auto || cfg.paused || cfg.conflict) continue;
        const now = Date.now();
        const edited = lastEdit.get(p) || 0;
        if (now - edited < 8000) continue; // let the user finish typing
        const due = now - (lastAttempt.get(p) || 0) > cfg.interval * 1000;
        const editedSince = edited > (lastAttempt.get(p) || 0) && now - edited > 20000;
        if (!due && !editedSince) continue;
        lastAttempt.set(p, now);
        sync(p).catch(() => {});
      } catch {}
    }
  }, 5000);
}

module.exports = { status, cachedStatus, init, connect, clone, sync, setAuthor, completeMerge, abortMerge, conflictVersions, noteEdit, startAutoSync, readCfg, updateCfg, isRepo };
