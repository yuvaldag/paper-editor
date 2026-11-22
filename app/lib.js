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
    let m = /^(error|warning): (?:(.+?\.tex):(\d+): )?(.*)$/.exec(line), kind, file, ln, msg;
    if (m) [, kind, file, ln, msg] = m;
    else if ((m = /^(?:\.\/)?([^\s:]+\.tex):(\d+): (.*)$/.exec(line))) [, file, ln, msg] = ['', m[1], m[2], m[3]], (kind = 'error');
    else continue;
    if (/warnings were issued|use --print|--keep-logs/.test(msg)) continue;
    const key = `${kind}|${ln}|${msg}`;
    if (seen.has(key)) continue;
    seen.add(key);
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
function compileTex(p, f) {
  checkFile(f);
  if (!f.endsWith('.tex')) return Promise.resolve({ ok: false, errors: [{ kind: 'error', message: 'Only .tex files can be compiled' }] });
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
        pdfPath: exists ? path.join('projects', p, 'build', pdfName) : null, errors, output: output.slice(-8000),
      });
    });
  }).finally(() => compiling.delete(key));
  compiling.set(key, job);
  return job;
}

module.exports = {
  findCompiler, compileTex,
  ROOT, PROJECTS, PORT, HEARTBEAT_MS, STALE_MS,
  httpErr, checkName, checkFile, projDir, collabDir, watcherFile, exists, requireProject,
  atomicWrite, readText, readJSON, hash, newId,
  listProjects, listFiles, createProject, createFile, readDoc, writeDoc, saveConflict,
  listRequests, getRequest, saveRequest, deleteRequest,
  pidAlive, watchStatus,
};
