'use strict';
// Shared file-based protocol used by both the web server and the chat CLI.
//
// projects/<project>/
//   *.md                      the documents (the "current" text, what Claude edits)
//   .collab/base/<file>.md    last text the user has accepted (diff base for tracked changes)
//   .collab/requests/<id>.json  comments / edit requests sent from the app
//   .collab/watcher.json      heartbeat of the chat watcher script
//   .collab/conflicts/        user text that could not be saved because the file changed underneath

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJECTS = path.join(ROOT, 'projects');
const PORT = +process.env.MD_STUDIO_PORT || 4477;

const HEARTBEAT_MS = 3000;
const STALE_MS = 12000;
const WORKING_GRACE_MS = 3 * 60 * 1000;
const WORKING_MAX_MS = 60 * 60 * 1000;

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function checkName(n, what = 'name') {
  if (typeof n !== 'string' || !/^[\p{L}\p{N}_\- .]{1,80}$/u.test(n) || n.startsWith('.') || n.trim() !== n)
    throw httpErr(400, `Invalid ${what}: use letters, digits, spaces, "-", "_", "."`);
  return n;
}
function checkFile(f) {
  checkName(f, 'file name');
  if (!/\.(md|tex)$/.test(f)) throw httpErr(400, 'File name must end with .md or .tex');
  return f;
}

const projDir = (p) => path.join(PROJECTS, checkName(p, 'project name'));
const collabDir = (p) => path.join(projDir(p), '.collab');
const reqDir = (p) => path.join(collabDir(p), 'requests');
const watcherFile = (p) => path.join(collabDir(p), 'watcher.json');
const filePath = (p, f) => path.join(projDir(p), checkFile(f));
const basePath = (p, f) => path.join(collabDir(p), 'base', checkFile(f));

function exists(p) {
  return fs.existsSync(projDir(p));
}
function requireProject(p) {
  if (!exists(p)) throw httpErr(404, `No project "${p}"`);
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
function readText(f) {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
function readJSON(f, def) {
  const t = readText(f);
  if (t == null) return def;
  try {
    return JSON.parse(t);
  } catch {
    return def;
  }
}
const hash = (s) => crypto.createHash('sha1').update(s ?? '').digest('hex').slice(0, 16);
const newId = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

// ---------- projects & files ----------
function listProjects() {
  fs.mkdirSync(PROJECTS, { recursive: true });
  return fs
    .readdirSync(PROJECTS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
}
function listFiles(p) {
  return fs
    .readdirSync(projDir(p))
    .filter((f) => /\.(md|tex)$/.test(f) && !f.startsWith('.'))
    .sort((a, b) => a.localeCompare(b));
}
function createProject(p) {
  const dir = projDir(p);
  const existed = fs.existsSync(dir);
  fs.mkdirSync(path.join(dir, '.collab', 'requests'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.collab', 'base'), { recursive: true });
  if (listFiles(p).length === 0) createFile(p, 'main.md', `# ${p}\n\n`);
  return !existed;
}
function createFile(p, f, content = '') {
  const fp = filePath(p, f);
  if (fs.existsSync(fp)) throw httpErr(409, `File "${f}" already exists`);
  atomicWrite(fp, content);
  atomicWrite(basePath(p, f), content);
}
// Rename a document together with its accepted-text copy and the comments that point at it.
function renameFile(p, from, to) {
  checkFile(from);
  checkFile(to);
  if (from === to) return;
  const src = filePath(p, from), dst = filePath(p, to);
  if (!fs.existsSync(src)) throw httpErr(404, `No file "${from}"`);
  if (fs.existsSync(dst) && from.toLowerCase() !== to.toLowerCase()) throw httpErr(409, `A file named "${to}" already exists`);
  fs.renameSync(src, dst);
  const b = basePath(p, from);
  if (fs.existsSync(b)) fs.renameSync(b, basePath(p, to));
  for (const r of listRequests(p)) if (r.file === from) { r.file = to; saveRequest(p, r); }
}
function readDoc(p, f) {
  const current = readText(filePath(p, f));
  if (current == null) throw httpErr(404, `No file "${f}"`);
  let base = readText(basePath(p, f));
  if (base == null) {
    // A file nobody has tracked yet (e.g. created outside the app): treat it as accepted.
    base = current;
    atomicWrite(basePath(p, f), base);
  }
  return { current, base };
}
function writeDoc(p, f, base, current) {
  atomicWrite(filePath(p, f), current);
  atomicWrite(basePath(p, f), base);
}
function saveConflict(p, f, content) {
  const rel = path.join('.collab', 'conflicts', `${f.replace(/\.(md|tex)$/, '')}-${new Date().toISOString().replace(/[:.]/g, '-')}${f.endsWith('.tex') ? '.tex' : '.md'}`);
  atomicWrite(path.join(projDir(p), rel), content);
  return path.join('projects', p, rel);
}

// ---------- requests ----------
function checkId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9]{4,40}$/.test(id)) throw httpErr(400, 'Bad request id');
  return id;
}
function listRequests(p) {
  let names;
  try {
    names = fs.readdirSync(reqDir(p));
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => readJSON(path.join(reqDir(p), n), null))
    .filter(Boolean)
    .sort((a, b) => a.created - b.created);
}
const getRequest = (p, id) => readJSON(path.join(reqDir(p), checkId(id) + '.json'), null);
const saveRequest = (p, r) => atomicWrite(path.join(reqDir(p), checkId(r.id) + '.json'), JSON.stringify(r, null, 2));
const deleteRequest = (p, id) => fs.rmSync(path.join(reqDir(p), checkId(id) + '.json'), { force: true });

// ---------- watcher status ----------
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}
function watchStatus(p) {
  const w = readJSON(watcherFile(p), null);
  if (!w) return { state: 'off' };
  const now = Date.now();
  if (w.state === 'watching') {
    if (now - w.heartbeat < STALE_MS && pidAlive(w.pid)) return { state: 'watching', since: w.since };
    return { state: 'off', lastSeen: w.heartbeat };
  }
  if (w.state === 'working') {
    const active = listRequests(p).some((r) => r.status === 'in_progress');
    const age = now - w.since;
    if ((active && age < WORKING_MAX_MS) || age < WORKING_GRACE_MS) return { state: 'working', since: w.since };
    return { state: 'off', lastSeen: w.since };
  }
  return { state: 'off', lastSeen: w.heartbeat };
}

// ---------- LaTeX -> PDF ----------
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/Library/TeX/texbin'];
function findCompiler() {
  const dirs = [...(process.env.PATH || '').split(':'), ...EXTRA_PATH].filter(Boolean);
  for (const name of ['tectonic', 'latexmk', 'pdflatex'])
    for (const d of dirs) {
      const f = path.join(d, name);
      if (fs.existsSync(f)) return { name, bin: f };
    }
  return null;
}
function parseTexOutput(text) {
  const out = [], seen = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    // tectonic: "error: paper.tex:12: msg" or, for \input files, "error: intro:2: msg"
    let m = /^(error|warning): (?:([^\s:]+):(\d+): )?(.*)$/.exec(line), kind, file, ln, msg;
    if (m) [, kind, file, ln, msg] = m;
    else if ((m = /^(?:\.\/)?([^\s:]+\.tex):(\d+): (.*)$/.exec(line))) [, file, ln, msg] = ['', m[1], m[2], m[3]], (kind = 'error');
    else continue;
    if (/warnings were issued|use --print|--keep-logs/.test(msg)) continue;
    const key = `${kind}|${ln}|${msg}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (file) file = file.replace(/^\.\//, '').replace(/^([^.]+)$/, '$1.tex');
    out.push({ kind, file: file || null, line: ln ? +ln : null, message: msg });
  }
  const generic = /something bad happened inside|unrecoverable error|halted on potentially-recoverable|its output follows/i;
  const specific = out.some((e) => e.kind === 'error' && !generic.test(e.message));
  return out
    .filter((e) => !(specific && generic.test(e.message)))
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'error' ? -1 : 1))
    .slice(0, 60);
}
const compiling = new Map();
// Which file to actually compile when `f` is opened. A file with its own \documentclass compiles itself;
// otherwise: a "% !TEX root = x.tex" comment, then the file that \input / \include s it, then main.tex.
const texCode = (s) => (s || '').replace(/(^|[^\\])%.*$/gm, '$1');
const texBase = (name) => name.trim().replace(/^\.\//, '').replace(/\.tex$/, '');
function resolveTexRoot(p, f) {
  const read = (name) => readText(filePath(p, name)) || '';
  const isRoot = (name) => /\\documentclass\b/.test(texCode(read(name)));
  if (isRoot(f)) return { root: f, reason: 'self' };
  const magic = /^\s*%\s*!\s*TEX\s+root\s*=\s*(.+?)\s*$/im.exec(read(f).split('\n').slice(0, 5).join('\n'));
  if (magic) {
    const name = texBase(magic[1]).replace(/^.*\//, '') + '.tex';
    if (listFiles(p).includes(name)) return { root: name, reason: 'magic' };
  }
  const texFiles = listFiles(p).filter((x) => x.endsWith('.tex'));
  const includers = (name) => {
    const want = texBase(name);
    return texFiles.filter((x) => x !== name && [...texCode(read(x)).matchAll(/\\(?:input|include|subfile)\s*\{([^}]*)\}/g)].some((m) => texBase(m[1]) === want));
  };
  // Walk up the chain of includes (intro.tex <- chapter1.tex <- main.tex) collecting every document
  // (a file with \documentclass) that pulls this file in. main.tex wins if it is one of them, else the nearest.
  const seen = new Set([f]);
  const roots = [];
  let level = [f];
  for (let depth = 0; depth < 6 && level.length; depth++) {
    const next = [];
    for (const name of level)
      for (const inc of includers(name)) {
        if (seen.has(inc)) continue;
        seen.add(inc);
        if (isRoot(inc)) roots.push(inc);
        else next.push(inc);
      }
    level = next;
  }
  if (roots.includes('main.tex')) return { root: 'main.tex', reason: 'included' };
  if (roots.length) return { root: roots[0], reason: 'included' };
  if (f !== 'main.tex' && texFiles.includes('main.tex')) return { root: 'main.tex', reason: 'main' };
  return { root: f, reason: 'self' };
}

function compileTex(p, f) {
  checkFile(f);
  if (!f.endsWith('.tex')) return Promise.resolve({ ok: false, errors: [{ kind: 'error', message: 'Only .tex files can be compiled' }] });
  const requested = f;
  const { root, reason } = resolveTexRoot(p, f);
  f = root;
  const key = p + '/' + f;
  if (compiling.has(key)) return compiling.get(key);
  const job = new Promise((resolve) => {
    const c = findCompiler();
    if (!c)
      return resolve({ ok: false, compiler: null, errors: [{ kind: 'error', message: 'No LaTeX compiler found. Install one, e.g.: brew install tectonic' }] });
    const dir = projDir(p);
    const out = path.join(dir, 'build');
    fs.mkdirSync(out, { recursive: true });
    const args =
      c.name === 'tectonic' ? ['-X', 'compile', '--outdir', out, '--keep-logs', f]
      : c.name === 'latexmk' ? ['-pdf', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', `-outdir=${out}`, f]
      : ['-interaction=nonstopmode', '-halt-on-error', '-file-line-error', `-output-directory=${out}`, f];
    const pdfName = f.replace(/\.tex$/, '.pdf');
    const pdfPath = path.join(out, pdfName);
    const before = fs.existsSync(pdfPath) ? fs.statSync(pdfPath).mtimeMs : 0;
    const started = Date.now();
    execFile(c.bin, args, { cwd: dir, timeout: 180000, maxBuffer: 20e6, env: { ...process.env, PATH: [...EXTRA_PATH, process.env.PATH].join(':') } }, (err, stdout, stderr) => {
      const output = `${stdout || ''}\n${stderr || ''}`;
      const errors = parseTexOutput(output);
      const exists = fs.existsSync(pdfPath);
      const fresh = exists && fs.statSync(pdfPath).mtimeMs > before;
      const ok = !err && fresh;
      if (!ok && !errors.some((e) => e.kind === 'error'))
        errors.unshift({ kind: 'error', line: null, message: err && err.killed ? 'Compilation timed out' : 'Compilation failed (see output)' });
      resolve({
        ok, compiler: c.name, ms: Date.now() - started, pdf: exists ? pdfName : null, stale: exists && !fresh,
        root: f, requested, rootReason: reason,
        pdfPath: exists ? path.join('projects', p, 'build', pdfName) : null, errors, output: output.slice(-8000),
      });
    });
  }).finally(() => compiling.delete(key));
  compiling.set(key, job);
  return job;
}

module.exports = {
  findCompiler, compileTex, resolveTexRoot,
  ROOT, PROJECTS, PORT, HEARTBEAT_MS, STALE_MS,
  httpErr, checkName, checkFile, projDir, collabDir, watcherFile, exists, requireProject,
  atomicWrite, readText, readJSON, hash, newId,
  listProjects, listFiles, createProject, createFile, renameFile, readDoc, writeDoc, saveConflict,
  listRequests, getRequest, saveRequest, deleteRequest,
  pidAlive, watchStatus,
};
