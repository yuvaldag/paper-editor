'use strict';
// Local web server for Paper Editor. No dependencies: `node app/server.js`
const http = require('http');
const fs = require('fs');
const path = require('path');
const L = require('./lib');
const Git = require('./git');

const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      d += c;
      if (d.length > 20e6) {
        reject(L.httpErr(413, 'Too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(d ? JSON.parse(d) : {});
      } catch {
        reject(L.httpErr(400, 'Bad JSON'));
      }
    });
    req.on('error', reject);
  });
}
function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const fp = path.normalize(path.join(PUBLIC, rel));
  if (!fp.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(fp, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}
const TEX_TEMPLATE = `\\documentclass{article}
\\usepackage{amsmath, amssymb}

\\title{Untitled}
\\author{}

\\begin{document}
\\maketitle

\\section{Introduction}

\\end{document}
`;
const str = (v, max = 100000) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (Number.isFinite(v) ? v : null);

async function handleApi(req, res, parts) {
  const m = req.method;

  if (parts[1] === 'ping') return send(res, 200, { ok: true, app: 'paper-editor' });
  if (parts[1] === 'compiler') { const c = L.findCompiler(); return send(res, 200, { name: c ? c.name : null }); }

  if (parts[1] === 'projects' && parts.length === 2) {
    if (m === 'GET')
      return send(
        res,
        200,
        L.listProjects().map((p) => ({
          name: p,
          watch: L.watchStatus(p),
          open: L.listRequests(p).filter((r) => (r.type === 'message' ? r.status === 'unread' : r.status !== 'done')).length,
        }))
      );
    if (m === 'POST') {
      const b = await readBody(req);
      const name = L.checkName(str(b.name).trim(), 'project name');
      if (L.exists(name)) throw L.httpErr(409, `Project "${name}" already exists`);
      if (str(b.git).trim()) return send(res, 200, await Git.clone(name, str(b.git).trim()));
      L.createProject(name);
      if (b.initGit) await Git.init(name);
      return send(res, 200, { name });
    }
  }

  if (parts[1] === 'p' && parts[2]) {
    const p = parts[2];
    L.requireProject(p);
    const rest = parts.slice(3);

    if (rest[0] === 'state' && m === 'GET') {
      const files = L.listFiles(p).map((f) => {
        const d = L.readDoc(p, f);
        return { name: f, hash: L.hash(d.current), baseHash: L.hash(d.base), pending: d.current !== d.base };
      });
      return send(res, 200, { files, watch: L.watchStatus(p), requests: L.listRequests(p), git: Git.cachedStatus(p) });
    }

    if (rest[0] === 'git' && rest.length === 1) {
      if (m === 'GET') return send(res, 200, await Git.status(p));
      if (m === 'POST') {
        const b = await readBody(req);
        let r;
        switch (b.action) {
          case 'init': r = await Git.init(p); break;
          case 'connect': r = await Git.connect(p, str(b.url)); break;
          case 'sync': r = await Git.sync(p); break;
          case 'complete': r = await Git.completeMerge(p); break;
          case 'abort': r = await Git.abortMerge(p); break;
          case 'author': r = await Git.setAuthor(p, str(b.name), str(b.email)); break;
          case 'settings': {
            const patch = {};
            if (typeof b.auto === 'boolean') { patch.auto = b.auto; patch.paused = false; }
            if (Number.isFinite(b.interval)) patch.interval = Math.max(30, Math.min(3600, Math.round(b.interval)));
            Git.updateCfg(p, patch);
            r = { ok: true };
            break;
          }
          default: throw L.httpErr(400, 'Unknown git action');
        }
        return send(res, 200, { result: r, status: await Git.status(p) });
      }
    }

    // Built PDFs and images referenced by documents (read-only, inside the project folder only).
    if ((rest[0] === 'pdf' || rest[0] === 'asset') && rest.length >= 2 && m === 'GET') {
      const root = rest[0] === 'pdf' ? path.join(L.projDir(p), 'build') : L.projDir(p);
      let fp = path.normalize(path.join(root, ...rest.slice(1)));
      if (!fp.startsWith(root + path.sep) || fp.includes(`${path.sep}.collab`)) throw L.httpErr(403, 'forbidden');
      if (rest[0] === 'asset' && !path.extname(fp))
        fp = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf'].map((e) => fp + e).find((x) => fs.existsSync(x)) || fp;
      const type = MIME[path.extname(fp).toLowerCase()];
      if (!type || !fs.existsSync(fp)) throw L.httpErr(404, 'not found');
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      return fs.createReadStream(fp).pipe(res);
    }

    if (rest[0] === 'files' && rest.length === 1 && m === 'POST') {
      const b = await readBody(req);
      let f = str(b.name).trim();
      if (!/\.(md|tex)$/.test(f)) f += '.md';
      const content = str(b.content) || (f.endsWith('.tex') ? TEX_TEMPLATE : '');
      L.createFile(p, L.checkFile(f), content);
      return send(res, 200, { name: f });
    }

    if (rest[0] === 'file' && rest[1]) {
      const f = L.checkFile(rest[1]);
      if (rest.length === 2 && m === 'GET') {
        const d = L.readDoc(p, f);
        return send(res, 200, { ...d, hash: L.hash(d.current), baseHash: L.hash(d.base) });
      }
      // The user's own edits: not tracked, written to both current and base.
      if (rest[2] === 'save' && m === 'POST') {
        const b = await readBody(req);
        const content = str(b.content, 20e6);
        const d = L.readDoc(p, f);
        if (L.hash(d.current) !== b.expect || d.current !== d.base) {
          const conflictFile = L.saveConflict(p, f, content);
          return send(res, 409, { error: 'conflict', conflictFile });
        }
        L.writeDoc(p, f, content, content);
        Git.noteEdit(p);
        return send(res, 200, { hash: L.hash(content) });
      }
      if (rest[2] === 'compile' && m === 'POST') return send(res, 200, await L.compileTex(p, f));
      if (rest[2] === 'rename' && m === 'POST') {
        const b = await readBody(req);
        let name = str(b.name).trim();
        if (!/\.(md|tex)$/i.test(name)) name += f.endsWith('.tex') ? '.tex' : '.md';
        name = name.replace(/\.(md|tex)$/i, (x) => x.toLowerCase());
        L.renameFile(p, f, L.checkFile(name));
        Git.noteEdit(p);
        return send(res, 200, { name });
      }
      // Accept / reject Claude's tracked changes.
      if (rest[2] === 'resolve' && m === 'POST') {
        const b = await readBody(req);
        const d = L.readDoc(p, f);
        if (L.hash(d.current) !== b.expectCurrent || L.hash(d.base) !== b.expectBase)
          return send(res, 409, { error: 'The file changed meanwhile' });
        L.writeDoc(p, f, str(b.base, 20e6), str(b.current, 20e6));
        Git.noteEdit(p);
        return send(res, 200, { ok: true });
      }
    }

    if (rest[0] === 'requests') {
      if (rest.length === 1 && m === 'POST') {
        const b = await readBody(req);
        const r = {
          id: L.newId(),
          type: b.type === 'comment' ? 'comment' : 'request',
          file: b.file ? L.checkFile(b.file) : null,
          text: str(b.text, 20000).trim(),
          status: 'pending',
          created: Date.now(),
        };
        if (r.type === 'comment') {
          Object.assign(r, {
            quote: str(b.quote, 20000),
            start: num(b.start),
            end: num(b.end),
            line: num(b.line),
            prefix: str(b.prefix, 400),
            suffix: str(b.suffix, 400),
          });
          if (!r.quote) throw L.httpErr(400, 'A comment needs selected text');
        }
        if (!r.text) throw L.httpErr(400, 'Empty message');
        if (b.replyTo) {
          const m = L.getRequest(p, b.replyTo);
          if (m) {
            r.replyTo = m.id;
            r.replyToText = m.text;
            m.status = 'read';
            L.saveRequest(p, m);
          }
        }
        L.saveRequest(p, r);
        return send(res, 200, r);
      }
      if (rest.length === 2 && m === 'POST') {
        const b = await readBody(req);
        const r = L.getRequest(p, rest[1]);
        if (!r) throw L.httpErr(404, 'No such item');
        if (r.type !== 'message' || !['read', 'unread'].includes(b.status)) throw L.httpErr(400, 'Only messages can be marked read');
        r.status = b.status;
        L.saveRequest(p, r);
        return send(res, 200, r);
      }
      if (rest.length === 2 && m === 'DELETE') {
        L.deleteRequest(p, rest[1]);
        return send(res, 200, { ok: true });
      }
    }
  }
  send(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] === 'api') await handleApi(req, res, parts);
    else serveStatic(url.pathname, res);
  } catch (e) {
    if (!e.status) console.error(e);
    send(res, e.status || 500, { error: e.message });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`Port ${L.PORT} is already in use (Paper Editor is probably already running): http://localhost:${L.PORT}`);
    process.exit(0);
  }
  throw e;
});
server.listen(L.PORT, '127.0.0.1', () => {
  console.log(`Paper Editor running at http://localhost:${L.PORT}`);
  Git.startAutoSync();
});
