'use strict';
const $ = (s) => document.querySelector(s);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const enc = encodeURIComponent;

const S = {
  projects: [], project: null, files: [], file: null,
  doc: null,            // {current, base, hash, baseHash} as last loaded/saved
  requests: [], watch: { state: 'off' },
  raw: localStorage.getItem('mds-raw') === '1',
  dirty: false, saving: false, saveAgain: false, saveT: null,
  reviewing: false, segments: null, hunks: [], focusHunk: -1,
  sel: null, hotReq: null, lastReqJSON: '', replyTo: null,
  editMode: localStorage.getItem('mds-editmode') || 'edit', sentKey: '',
  pdfOpen: localStorage.getItem('mds-pdf') === '1', compiling: false, compileAgain: false, compileT: null, lastCompile: null,
};
const isTex = () => !!S.file && S.file.endsWith('.tex');

const ed = MDEditor.create($('#editorHost'), {
  onChange: onUserEdit,
  onResolve: (idx, accept) => resolveHunk(idx, accept),
  assetUrl: (f) => (S.project ? `${P()}/asset/${f.split('/').map(enc).join('/')}` : null),
  onBlocked: (why) => {
    const b = $('#modeBanner');
    b.classList.remove('flash');
    void b.offsetWidth;
    b.classList.add('flash');
    toast(why === 'instruct'
      ? 'Instruct mode only adds notes for Claude — switch to Edit to change or delete your text.'
      : 'That change would cut through a suggestion — accept or reject it first, or switch to Edit.', 5000);
  },
});

// ---------------- api ----------------
async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error || r.statusText);
    e.status = r.status;
    e.data = j;
    throw e;
  }
  return j;
}
const P = () => `/api/p/${enc(S.project)}`;
const F = () => `${P()}/file/${enc(S.file)}`;

let toastT;
function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), ms);
}

// ---------------- routing ----------------
function setHash() {
  const h = S.project ? `#/${enc(S.project)}${S.file ? '/' + enc(S.file) : ''}` : '#/';
  if (location.hash !== h) history.replaceState(null, '', h);
}
function readHash() {
  const [p, f] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  return { p: p || null, f: f || null };
}

async function openProject(p, f = null) {
  await flushSave();
  Object.assign(S, { project: p, file: f, doc: null, requests: [], lastReqJSON: '', replyTo: null, git: null });
  api('GET', `/api/p/${enc(p)}/git`).then((g) => { if (S.project === p) { S.git = g; renderGit(); renderMerge(); } }).catch(() => {});
  setHash();
  renderProjects();
  await refreshState();
}
async function openFile(f) {
  await flushSave();
  S.file = f;
  S.doc = null;
  S.lastCompile = null;
  setHash();
  renderFiles();
  await loadFile();
  renderTexControls();
  if (isTex() && S.pdfOpen) compile();
  S.lastReqJSON = '';
  renderRequests();
}

// ---------------- polling ----------------
async function poll() {
  try {
    S.projects = await api('GET', '/api/projects');
    $('#conn').textContent = '';
    renderProjects();
    if (S.project) await refreshState();
  } catch (e) {
    $('#conn').textContent = 'Server not reachable — run: node app/server.js';
  }
  setTimeout(poll, 1500);
}

async function refreshState() {
  if (!S.project) return renderEmpty();
  let st;
  try {
    st = await api('GET', `${P()}/state`);
  } catch (e) {
    if (e.status === 404) { S.project = null; S.file = null; setHash(); return renderEmpty(); }
    throw e;
  }
  S.files = st.files;
  S.watch = st.watch;
  S.requests = st.requests;
  if (st.git) S.git = st.git;
  renderEmpty();
  renderGit();
  renderMerge();
  renderFiles();
  renderWatch();
  renderRequests();
  if (S.doc) { renderHighlights(); renderMarks(); }
  notifyMessages();
  if (!S.file || !st.files.some((f) => f.name === S.file)) {
    if (st.files.length) return openFile(st.files[0].name);
    return;
  }
  const f = st.files.find((x) => x.name === S.file);
  if (!S.doc) return loadFile();
  if ((f.hash !== S.doc.hash || f.baseHash !== S.doc.baseHash) && !S.dirty && !S.saving) await loadFile();
}

async function loadFile() {
  if (!S.file) return;
  const d = await api('GET', F());
  const fresh = !S.doc;
  S.doc = d;
  const pending = d.current !== d.base;
  S.reviewing = pending;
  ed.setReview(null);
  ed.setMode(S.file.endsWith('.tex') ? 'tex' : 'md');
  ed.setDoc(d.current);
  if (fresh) ed.resetCursor();
  renderTexControls();
  ed.setReadOnly(pending);
  $('#reviewBar').hidden = !pending;
  if (pending) {
    hideCommentUI();
    S.segments = MDDiff.buildSegments(d.base, d.current);
    S.hunks = ed.setReview(S.segments);
    $('#changeCount').textContent = S.hunks.length;
  } else {
    S.segments = null;
    S.hunks = [];
  }
  renderHighlights();
  renderMarks();
  if (pending && !S.autoNoteFix) autoAcceptNoteRemovals();
}

// When Claude carries out an instruction it deletes the {>>…<<} note; that deletion needs no review.
// Drop every note that Claude removed from the accepted text, so only Claude's real edits remain to review.
async function autoAcceptNoteRemovals() {
  const cur = S.doc.current;
  const base = S.doc.base.replace(/\{>>[\s\S]*?<<\}/g, (m) => (cur.includes(m) ? m : ''));
  if (base === S.doc.base) return;
  S.autoNoteFix = true;
  try {
    await api('POST', `${F()}/resolve`, { base, current: S.doc.current, expectBase: S.doc.baseHash, expectCurrent: S.doc.hash });
    await loadFile();
  } catch {} finally { S.autoNoteFix = false; }
}

// ---------------- suggestions / instructions (edit modes) ----------------
function setEditMode(mode) {
  S.editMode = mode;
  localStorage.setItem('mds-editmode', mode);
  ed.setEditMode(mode);
  document.querySelectorAll('#editMode button').forEach((b) => b.classList.toggle('on', b.dataset.em === mode));
  $('#editMode').dataset.mode = mode;
  const banner = $('#modeBanner');
  banner.hidden = mode === 'edit';
  banner.dataset.mode = mode;
  banner.querySelector('span').innerHTML = mode === 'suggest'
    ? '<b>Suggest mode</b> — what you add or delete is kept as a suggestion (blue / orange) to accept or reject later.'
    : mode === 'instruct'
      ? '<b>Instruct mode</b> — what you type becomes a note for Claude; your text itself is not changed.'
      : '';
}
$('#modeBanner').addEventListener('click', (e) => { if (e.target.dataset.em) { setEditMode('edit'); ed.focus(); } });
$('#editMode').addEventListener('click', (e) => {
  const m = e.target.dataset.em;
  if (!m) return;
  setEditMode(m);
  if (m === 'instruct') toast('Instruct: type where you want something done — your text becomes a note for Claude. Then click “Send to Claude”.', 6000);
  if (m === 'suggest') toast('Suggest: your additions show in blue and removals in orange, to accept or reject later.', 5000);
  ed.focus();
});
function sentInstructionTexts() {
  return S.requests
    .filter((r) => r.type === 'instructions' && r.file === S.file && r.status !== 'done')
    .flatMap((r) => (r.items || []).map((x) => x.text.trim()));
}
function renderMarks() {
  if (!S.doc) return;
  const marks = ed.getMarks();
  const sugs = marks.filter((m) => m.type !== 'note').length;
  $('#sugBar').hidden = !sugs || S.reviewing;
  $('#sugCount').textContent = sugs;
  const sent = sentInstructionTexts();
  const key = JSON.stringify(sent);
  if (key !== S.sentKey) { S.sentKey = key; ed.setSentNotes(sent); }
  const unsent = marks.filter((m) => m.type === 'note' && m.content.trim() && !sent.includes(m.content.trim()));
  const btn = $('#sendNotes');
  btn.hidden = !unsent.length;
  btn.textContent = `➤ Send ${unsent.length} instruction${unsent.length > 1 ? 's' : ''} to Claude`;
  $('#editMode').classList.toggle('disabled', S.reviewing);
}
$('#sugAccept').onclick = () => ed.resolveSuggestions(true);
$('#sugReject').onclick = () => ed.resolveSuggestions(false);
$('#sendNotes').onclick = async () => {
  await flushSave();
  const text = ed.getDoc();
  const sent = sentInstructionTexts();
  const notes = ed.getMarks().filter((m) => m.type === 'note' && m.content.trim() && !sent.includes(m.content.trim()));
  if (!notes.length) return;
  const clean = (s) => s.replace(/\{\+\+([\s\S]*?)\+\+\}|\{--([\s\S]*?)--\}|\{>>([\s\S]*?)<<\}/g, (_, a) => a ?? '');
  const items = notes.map((m) => ({
    text: m.content.trim(),
    line: lineOf(text, m.from),
    before: clean(text.slice(Math.max(0, m.from - 300), m.from)).slice(-160),
    after: clean(text.slice(m.to, m.to + 300)).slice(0, 160),
  }));
  try {
    await api('POST', `${P()}/requests`, {
      type: 'instructions', file: S.file, items,
      text: items.length === 1 ? items[0].text : `${items.length} instructions: ` + items.map((x) => `“${x.text}”`).join('; '),
    });
    toast(S.watch.state === 'off' ? 'Instructions saved. No chat is watching this project yet.' : 'Instructions sent to Claude.');
    await refreshState();
    renderMarks();
  } catch (e) { toast(e.message); }
};

// ---------------- rendering ----------------
function renderEmpty() {
  const none = !S.project;
  $('#empty').hidden = !none;
  $('#workspace').hidden = none;
  $('#filesTitle').hidden = none;
  $('#comments').style.visibility = none ? 'hidden' : 'visible';
  if (none) {
    $('#crumb').textContent = '';
    $('#watchBadge').hidden = true;
    $('#fileList').innerHTML = '';
    $('#reviewBar').hidden = true;
  }
}

function renderProjects() {
  $('#projectList').innerHTML = S.projects
    .map(
      (p) => `<li data-p="${esc(p.name)}" class="${p.name === S.project ? 'active' : ''}" title="${esc(watchText(p.watch, p.name).title)}">
        <span class="dot ${p.watch.state}"></span>${esc(p.name)}${p.open ? `<span class="count">${p.open}</span>` : ''}</li>`
    )
    .join('');
}
function renderFiles() {
  if (S.renaming) return;
  $('#fileList').innerHTML = S.files
    .map(
      (f) => `<li data-f="${esc(f.name)}" class="${f.name === S.file ? 'active' : ''}" title="Double-click to rename">${f.name.endsWith('.tex') ? '<span class="ftype">TeX</span>' : '📄'} ${esc(f.name)}${
        f.pending ? '<span class="pend" title="Has suggested changes to review">● changes</span>' : ''
      }</li>`
    )
    .join('');
}

function watchText(w, name) {
  if (w.state === 'watching') return { label: 'Watched by Claude', title: 'A Claude chat is watching this project and will act on new comments.' };
  if (w.state === 'working') return { label: 'Claude is working…', title: 'A Claude chat picked up your requests and is working on them.' };
  return {
    label: 'Not watched',
    title: `No chat is watching. In a Claude chat opened in this folder, say: “watch project ${name}”. Requests you send are kept until a chat starts watching.`,
  };
}
function renderWatch() {
  const b = $('#watchBadge');
  const t = watchText(S.watch, S.project);
  b.hidden = false;
  b.className = 'badge ' + S.watch.state;
  b.innerHTML = `<span class="dot ${S.watch.state}"></span>${t.label}`;
  b.title = t.title;
  $('#crumb').innerHTML = `${esc(S.project)} <span>/ ${esc(S.file || '')}</span>`;
}

function setRaw(raw) {
  S.raw = raw;
  localStorage.setItem('mds-raw', raw ? '1' : '0');
  ed.setRaw(raw);
  $('#rawToggle').classList.toggle('on', raw);
  $('#rawToggle').textContent = raw ? 'Hide source' : 'Show source';
}
$('#rawToggle').onclick = () => setRaw(!S.raw);

// --- comment / message highlights inside the editor ---
function anchor(r, text) {
  if (!r.quote) return null;
  let best = -1, bd = Infinity, i = text.indexOf(r.quote);
  while (i !== -1) {
    const d = Math.abs(i - (r.start || 0));
    if (d < bd) { bd = d; best = i; }
    i = text.indexOf(r.quote, i + 1);
  }
  return best < 0 ? null : { start: best, end: best + r.quote.length };
}
const isClosed = (r) => r.status === 'done' || r.status === 'read';
function renderHighlights() {
  if (S.reviewing) return ed.setAnnotations([]);
  const text = ed.getDoc();
  const list = [];
  for (const r of S.requests) {
    if (!r.quote || r.file !== S.file) continue;
    if (r.type === 'message' ? r.status !== 'unread' : r.status === 'done') continue;
    const a = anchor(r, text);
    if (a) list.push({ from: a.start, to: a.end, cls: (r.type === 'message' ? 'msg' : r.status) + (r.id === S.hotReq ? ' hot' : '') });
  }
  ed.setAnnotations(list);
}

// --- requests panel ---
function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
}
const STATUS = { pending: 'Sent', in_progress: 'Claude working', done: 'Done', unread: 'New', read: 'Read' };
function renderRequests() {
  const showDone = $('#showDone').checked;
  const list = S.requests
    .filter((r) => !r.file || r.file === S.file)
    .filter((r) => showDone || !isClosed(r) || Date.now() - (r.doneAt || r.created || 0) < 10 * 60 * 1000)
    .slice()
    .reverse();
  const text = S.doc ? ed.getDoc() : '';
  const key = JSON.stringify([list, S.hotReq, showDone, text.length, S.replyTo]);
  if (key === S.lastReqJSON) return;
  S.lastReqJSON = key;
  $('#requestList').innerHTML = list.length
    ? list.map((r) => cardHTML(r, text)).join('')
    : `<div class="empty-note">Select text in the editor and click <b>💬 Comment</b>, or write a request below. Claude's messages to you show up here too.${
        S.watch.state === 'off' ? '<br><br>No chat is watching this project yet — requests are queued until one does.' : ''
      }</div>`;
}
function cardHTML(r, text) {
  const detached = r.quote && !isClosed(r) && !anchor(r, text);
  const quote = r.quote
    ? `<div class="q${detached ? ' detached' : ''}" data-jump="${r.id}" title="${detached ? 'Text no longer found' : 'Show in editor'}">${esc(r.quote)}</div>`
    : '';
  if (r.type === 'message')
    return `<div class="req msg ${r.status}" data-id="${r.id}">
      <div class="head"><span class="pill msg">Claude</span>${r.status === 'unread' ? '<span class="pill unread">New</span>' : ''}
        ${ago(r.created)}${r.file ? '' : ' · whole project'}
        <button class="x" data-del="${r.id}" title="Delete">✕</button></div>
      ${quote}
      <div class="t">${esc(r.text)}</div>
      ${S.replyTo === r.id
        ? `<div class="replybox"><textarea rows="2" placeholder="Reply to Claude… (⌘↵ to send)"></textarea>
           <div class="cf-actions"><button class="ghost" data-cancelreply="1">Cancel</button><button class="primary" data-sendreply="${r.id}">Send reply</button></div></div>`
        : `<div class="msg-actions"><button data-reply="${r.id}">Reply</button>${
            r.status === 'unread' ? `<button class="ghost" data-read="${r.id}">✓ Got it</button>` : ''
          }</div>`}
    </div>`;
  return `<div class="req ${r.status}" data-id="${r.id}">
    <div class="head"><span class="pill ${r.status}">${STATUS[r.status] || r.status}</span>
      ${r.type === 'comment' ? 'Comment' : r.replyTo ? 'Your reply' : 'Request'} · ${ago(r.created)}${r.file ? '' : ' · whole project'}
      <button class="x" data-del="${r.id}" title="Delete">✕</button></div>
    ${quote}
    <div class="t">${esc(r.text)}</div>
    ${r.reply ? `<div class="reply"><b>Claude:</b> ${esc(r.reply)}</div>` : ''}
  </div>`;
}

// ---------------- saving the user's edits ----------------
function onUserEdit() {
  if (S.reviewing || !S.doc) return;
  S.dirty = true;
  $('#saveState').textContent = 'Unsaved…';
  clearTimeout(S.saveT);
  S.saveT = setTimeout(save, 600);
  renderHighlights();
  renderMarks();
}
async function save() {
  if (!S.doc || !S.dirty) return;
  if (S.saving) { S.saveAgain = true; return; }
  S.saving = true;
  const content = ed.getDoc();
  $('#saveState').textContent = 'Saving…';
  try {
    const r = await api('POST', `${F()}/save`, { content, expect: S.doc.hash });
    Object.assign(S.doc, { current: content, base: content, hash: r.hash, baseHash: r.hash });
    if (ed.getDoc() === content) { S.dirty = false; $('#saveState').textContent = 'Saved'; }
    else S.saveAgain = true;
    scheduleCompile();
  } catch (e) {
    if (e.status === 409) {
      S.dirty = false;
      toast(`The file was changed by Claude while you typed. Your version was kept in ${e.data.conflictFile}`, 9000);
      $('#saveState').textContent = '';
      await loadFile();
    } else {
      $('#saveState').textContent = 'Save failed';
      toast(e.message);
    }
  } finally {
    S.saving = false;
    if (S.saveAgain) { S.saveAgain = false; if (S.dirty) save(); }
  }
}
async function flushSave() {
  clearTimeout(S.saveT);
  if (S.dirty) await save();
  while (S.saving) await new Promise((r) => setTimeout(r, 50));
}

// ---------------- review: accept / reject ----------------
async function resolveHunk(idx, accept) {
  if (!S.segments) return;
  const out = MDDiff.resolve(S.segments, idx, accept);
  const base = accept ? out : S.doc.base;
  const current = accept ? S.doc.current : out;
  try {
    await api('POST', `${F()}/resolve`, { base, current, expectBase: S.doc.baseHash, expectCurrent: S.doc.hash });
  } catch (e) {
    toast(e.status === 409 ? 'Claude changed the file meanwhile — refreshed, please review again.' : e.message);
  }
  await loadFile();
  scheduleCompile();
}
$('#acceptAll').onclick = () => resolveHunk(-1, true);
$('#rejectAll').onclick = () => resolveHunk(-1, false);
function moveFocus(dir) {
  if (!S.hunks.length) return;
  let pos = S.hunks.findIndex((h) => h.idx === S.focusHunk);
  pos = pos < 0 ? (dir > 0 ? 0 : S.hunks.length - 1) : (pos + dir + S.hunks.length) % S.hunks.length;
  S.focusHunk = S.hunks[pos].idx;
  ed.scrollTo(S.hunks[pos].pos);
  setTimeout(() => {
    document.querySelectorAll('.cm-hunkctl.focus').forEach((x) => x.classList.remove('focus'));
    const el = document.querySelector(`.cm-hunkctl[data-h="${S.focusHunk}"]`);
    if (el) el.classList.add('focus');
  }, 60);
}
$('#nextChange').onclick = () => moveFocus(1);
$('#prevChange').onclick = () => moveFocus(-1);

// ---------------- comments on selected text ----------------
const pop = $('#commentPop'), form = $('#commentForm');
let lastMouse = { x: 200, y: 200 };
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

function captureSelection() {
  if (S.reviewing) return null;
  const { from, to } = ed.getSelection();
  const text = ed.getDoc();
  if (to - from < 1 || !text.slice(from, to).trim()) return null;
  return { start: from, end: to, quote: text.slice(from, to) };
}
function showPop(sel, x, y) {
  S.sel = sel;
  pop.style.left = Math.min(x + 8, innerWidth - 130) + 'px';
  pop.style.top = Math.max(y - 42, 8) + 'px';
  pop.hidden = false;
}
function hideCommentUI() {
  pop.hidden = true;
  form.hidden = true;
}
document.addEventListener('mousemove', (e) => (lastMouse = { x: e.clientX, y: e.clientY }));
$('#editorHost').addEventListener('mouseup', (e) => setTimeout(() => {
  const sel = captureSelection();
  if (sel) showPop(sel, e.clientX, e.clientY); else pop.hidden = true;
}, 0));
$('#editorHost').addEventListener('keyup', (e) => {
  if (!e.shiftKey) return;
  const sel = captureSelection();
  if (!sel) return (pop.hidden = true);
  const c = ed.coordsAt(sel.end);
  showPop(sel, c ? c.left : lastMouse.x, c ? c.top : lastMouse.y);
});
document.addEventListener('mousedown', (e) => {
  if (!pop.contains(e.target) && !form.contains(e.target)) pop.hidden = true;
});
pop.addEventListener('mousedown', (e) => e.preventDefault());
$('#commentBtn').onclick = () => openCommentForm();
$('#editorHost').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyM') {
    const sel = captureSelection();
    if (sel) { e.preventDefault(); S.sel = sel; openCommentForm(); }
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); flushSave(); }
});
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'b' && isTex()) { e.preventDefault(); compile(); }
});

// ---------------- LaTeX: compile to PDF ----------------
function renderTexControls() {
  const tex = isTex();
  $('#texControls').hidden = !tex;
  $('#pdfToggle').classList.toggle('on', S.pdfOpen);
  $('#pdfPane').hidden = !(tex && S.pdfOpen);
  $('#workspace').classList.toggle('with-pdf', tex && S.pdfOpen);
  if (!tex) $('#texErrors').hidden = true;
}
$('#pdfToggle').onclick = () => {
  S.pdfOpen = !S.pdfOpen;
  localStorage.setItem('mds-pdf', S.pdfOpen ? '1' : '0');
  renderTexControls();
  if (S.pdfOpen && !(S.lastCompile && S.lastCompile.pdf)) compile();
};
$('#compileBtn').onclick = () => compile();
function scheduleCompile() {
  if (!isTex() || !S.pdfOpen) return;
  clearTimeout(S.compileT);
  S.compileT = setTimeout(compile, 1200);
}
async function compile() {
  if (!isTex()) return;
  if (S.compiling) { S.compileAgain = true; return; }
  await flushSave();
  S.compiling = true;
  const file = S.file;
  $('#compileState').textContent = 'Compiling…';
  $('#compileState').className = 'busy';
  try {
    const r = await api('POST', `${F()}/compile`);
    if (S.file !== file) return;
    S.lastCompile = r;
    const nErr = r.errors.filter((e) => e.kind === 'error').length;
    const nWarn = r.errors.length - nErr;
    $('#compileState').className = r.ok ? 'ok' : 'bad';
    $('#compileState').textContent = r.ok
      ? `${r.root && r.root !== file ? `${esc(r.root)} · ` : ''}PDF ready · ${(r.ms / 1000).toFixed(1)}s${nWarn ? ` · ${nWarn} warning${nWarn > 1 ? 's' : ''}` : ''}${S.reviewing ? ' · includes unreviewed changes' : ''}`
      : `${r.root && r.root !== file ? `${esc(r.root)} · ` : ''}${nErr || 1} error${nErr > 1 ? 's' : ''}${r.stale ? ' · showing last good PDF' : ''}`;
    $('#compileState').title = r.root && r.root !== file ? `${file} is part of ${r.root}, so ${r.root} was compiled` : '';
    renderTexErrors(r);
    if (r.pdf) {
      const url = `${P()}/pdf/${enc(r.pdf)}?t=${Date.now()}`;
      $('#pdfFrame').src = url;
      $('#pdfEmpty').hidden = true;
      $('#compileState').dataset.url = url;
    }
  } catch (e) {
    $('#compileState').className = 'bad';
    $('#compileState').textContent = 'Compile failed';
    toast(e.message);
  } finally {
    S.compiling = false;
    if (S.compileAgain) { S.compileAgain = false; compile(); }
  }
}
function renderTexErrors(r) {
  const box = $('#texErrors');
  const list = r.errors.filter((e) => e.kind === 'error' || !r.ok || box.dataset.showWarnings === '1');
  if (!r.errors.length || (r.ok && !list.length)) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<div class="te-head"><b>${r.ok ? 'Warnings' : 'LaTeX errors'}</b>
      <button class="ghost" data-act="output">Show output</button><button class="ghost" data-act="close">✕</button></div>` +
    r.errors.map((e) => {
      const ef = e.file ? e.file.replace(/^\.\//, '') : r.root || S.file;
      const here = ef === S.file;
      const target = e.line ? (here ? `data-line="${e.line}"` : S.files.some((x) => x.name === ef) ? `data-file="${esc(ef)}" data-line="${e.line}"` : '') : '';
      const where = e.line ? `<span class="te-line">${here ? '' : esc(ef) + ' '}line ${e.line}</span>` : '';
      return `<div class="te-row ${e.kind}" ${target}><span class="te-kind">${e.kind}</span>${where}<span>${esc(e.message)}</span></div>`;
    }).join('') +
    `<pre class="te-output" hidden>${esc(r.output || '')}</pre>`;
}
$('#texErrors').addEventListener('click', (e) => {
  const act = e.target.dataset.act;
  if (act === 'close') return ($('#texErrors').hidden = true);
  if (act === 'output') { const o = $('#texErrors .te-output'); o.hidden = !o.hidden; return; }
  const row = e.target.closest('[data-line]');
  if (row && row.dataset.file && row.dataset.file !== S.file) {
    const line = +row.dataset.line;
    openFile(row.dataset.file).then(() => {
      const doc = ed.view.state.doc;
      const n = Math.min(doc.lines, line);
      ed.select(doc.line(n).from, doc.line(n).to);
      ed.focus();
    });
    return;
  }
  if (row) {
    const doc = ed.view.state.doc;
    const n = Math.min(doc.lines, +row.dataset.line);
    ed.select(doc.line(n).from, doc.line(n).to);
    ed.focus();
  }
});
$('#compileState').addEventListener('click', () => {
  const u = $('#compileState').dataset.url;
  if (u) window.open(u, '_blank');
});
function openCommentForm() {
  if (!S.sel) return;
  pop.hidden = true;
  form.querySelector('.cf-quote').textContent = S.sel.quote;
  form.style.left = Math.min(lastMouse.x, innerWidth - 340) + 'px';
  form.style.top = Math.min(lastMouse.y, innerHeight - 200) + 'px';
  form.hidden = false;
  const ta = form.querySelector('textarea');
  ta.value = '';
  ta.focus();
}
form.addEventListener('click', (e) => {
  const act = e.target.dataset.act;
  if (act === 'cancel') hideCommentUI();
  if (act === 'send') sendComment();
});
form.querySelector('textarea').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendComment();
  if (e.key === 'Escape') hideCommentUI();
});
async function sendComment() {
  const text = form.querySelector('textarea').value.trim();
  if (!text || !S.sel) return;
  await flushSave();
  const src = ed.getDoc(), { start, end, quote } = S.sel;
  try {
    await api('POST', `${P()}/requests`, {
      type: 'comment', file: S.file, text, quote, start, end, line: lineOf(src, start),
      prefix: src.slice(Math.max(0, start - 200), start), suffix: src.slice(end, end + 200),
    });
    hideCommentUI();
    S.sel = null;
    toast(S.watch.state === 'off' ? 'Comment saved. No chat is watching this project yet.' : 'Comment sent to Claude.');
    refreshState();
  } catch (e) {
    toast(e.message);
  }
}

async function sendAsk() {
  const ta = $('#askText');
  const text = ta.value.trim();
  if (!text || !S.project) return;
  await flushSave();
  try {
    await api('POST', `${P()}/requests`, { type: 'request', file: S.file, text });
    ta.value = '';
    toast(S.watch.state === 'off' ? 'Request saved. No chat is watching this project yet.' : 'Request sent to Claude.');
    refreshState();
  } catch (e) {
    toast(e.message);
  }
}
$('#askSend').onclick = sendAsk;
$('#askText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendAsk();
});

// ---------------- requests panel interactions ----------------
$('#requestList').addEventListener('click', async (e) => {
  const t = e.target;
  if (t.dataset.del) {
    await api('DELETE', `${P()}/requests/${t.dataset.del}`).catch((x) => toast(x.message));
    return refreshState();
  }
  if (t.dataset.read) {
    await api('POST', `${P()}/requests/${t.dataset.read}`, { status: 'read' }).catch((x) => toast(x.message));
    return refreshState();
  }
  if (t.dataset.reply) {
    S.replyTo = t.dataset.reply;
    renderRequests();
    const ta = document.querySelector('.replybox textarea');
    if (ta) ta.focus();
    return;
  }
  if (t.dataset.cancelreply) { S.replyTo = null; return renderRequests(); }
  if (t.dataset.sendreply) return sendReply();
  const j = t.closest('[data-jump]');
  if (j && !S.reviewing) {
    const r = S.requests.find((x) => x.id === j.dataset.jump);
    const a = r && anchor(r, ed.getDoc());
    if (!a) return;
    ed.select(a.start, a.end);
    ed.focus();
  }
});
$('#requestList').addEventListener('mouseover', (e) => {
  const c = e.target.closest('.req');
  const id = c ? c.dataset.id : null;
  if (id !== S.hotReq) { S.hotReq = id; renderHighlights(); }
});
$('#requestList').addEventListener('keydown', (e) => {
  if (e.target.closest('.replybox') && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendReply();
});
$('#showDone').onchange = renderRequests;

async function sendReply() {
  const ta = document.querySelector('.replybox textarea');
  const text = ta && ta.value.trim();
  const m = S.requests.find((r) => r.id === S.replyTo);
  if (!text || !m) return;
  try {
    await api('POST', `${P()}/requests`, { type: 'request', file: m.file || S.file, text, replyTo: m.id });
    S.replyTo = null;
    toast(S.watch.state === 'off' ? 'Reply saved. No chat is watching this project yet.' : 'Reply sent to Claude.');
    refreshState();
  } catch (x) {
    toast(x.message);
  }
}

// Let the user know when Claude sends a new message.
const seenMsgs = new Set();
let msgsPrimed = false;
function notifyMessages() {
  const unread = S.requests.filter((r) => r.type === 'message' && r.status === 'unread');
  const fresh = unread.filter((r) => !seenMsgs.has(r.id));
  fresh.forEach((r) => seenMsgs.add(r.id));
  if (msgsPrimed && fresh.length) toast(`💬 Claude: ${fresh[fresh.length - 1].text.slice(0, 140)}`, 7000);
  msgsPrimed = true;
  document.title = unread.length ? `(${unread.length}) Paper Editor` : 'Paper Editor';
}

// ---------------- figures: paste or drop images / PDFs into the editor ----------------
const FIG_TYPE = /^image\/(png|jpe?g|gif|webp|svg\+xml)$|^application\/pdf$/;
const figFiles = (list) => [...(list || [])].filter((f) => FIG_TYPE.test(f.type));
async function addFigures(files, pos) {
  if (!S.doc) return;
  if (S.reviewing) return toast('Review Claude\'s suggested changes before adding figures.');
  if (S.editMode === 'instruct') return toast('Switch to Edit or Suggest to add figures.');
  const snippets = [];
  for (const f of files) {
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'application/pdf': 'pdf' }[f.type];
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
    const name = f.name && !/^image\.\w+$/.test(f.name) ? f.name : `figure-${stamp}.${ext}`;
    try {
      const r = await fetch(`${P()}/upload?name=${enc(name)}`, { method: 'POST', body: f });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Upload failed');
      snippets.push(isTex()
        ? `\\begin{figure}[ht]\n  \\centering\n  \\includegraphics[width=0.8\\textwidth]{${j.path}}\n  \\caption{}\n\\end{figure}`
        : `![](${j.path})`);
    } catch (e) { toast(e.message, 6000); }
  }
  if (!snippets.length) return;
  const v = ed.view;
  const at = pos != null ? pos : v.state.selection.main.head;
  const line = v.state.doc.lineAt(at);
  const insert = (at === line.from ? '' : '\n\n') + snippets.join('\n\n') + (at === line.to ? '\n' : '\n\n');
  v.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length }, userEvent: 'input.paste', scrollIntoView: true });
  v.focus();
  toast(`Added ${snippets.length} figure${snippets.length > 1 ? 's' : ''} to figures/.`);
}
$('#editorHost').addEventListener('paste', (e) => {
  const files = figFiles(e.clipboardData && e.clipboardData.files);
  if (!files.length) return;
  e.preventDefault();
  e.stopPropagation();
  addFigures(files);
}, true);
$('#editorHost').addEventListener('dragover', (e) => {
  if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
}, true);
$('#editorHost').addEventListener('drop', (e) => {
  const files = figFiles(e.dataTransfer && e.dataTransfer.files);
  if (!files.length) return;
  e.preventDefault();
  e.stopPropagation();
  addFigures(files, ed.view.posAtCoords({ x: e.clientX, y: e.clientY }));
}, true);

// ---------------- sidebar ----------------
$('#projectList').onclick = (e) => {
  const li = e.target.closest('li');
  if (li && li.dataset.p !== S.project) openProject(li.dataset.p);
};
$('#fileList').onclick = (e) => {
  const li = e.target.closest('li');
  if (li && !S.renaming && li.dataset.f !== S.file) openFile(li.dataset.f);
};
// Double-click a file to rename it in place (Enter saves, Esc cancels).
$('#fileList').addEventListener('dblclick', (e) => {
  const li = e.target.closest('li');
  if (!li || S.renaming) return;
  const old = li.dataset.f;
  S.renaming = old;
  li.innerHTML = `<input class="rename" spellcheck="false" value="${esc(old)}">`;
  const input = li.querySelector('input');
  input.focus();
  input.setSelectionRange(0, old.replace(/\.(md|tex)$/, '').length);
  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    const name = input.value.trim();
    if (save && name && name !== old) {
      try {
        if (old === S.file) await flushSave();
        const r = await api('POST', `${P()}/file/${enc(old)}/rename`, { name });
        if (old === S.file) { S.file = r.name; setHash(); }
        toast(`Renamed to ${r.name}`);
      } catch (x) {
        toast(x.message, 6000);
      }
    }
    S.renaming = null;
    S.lastReqJSON = '';
    await refreshState();
    renderFiles();
    renderWatch();
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
    if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (ev) => ev.stopPropagation());
});
// ---------------- new project dialog ----------------
const projDlg = $('#projDlg');
const showRows = (dlg, key, on) => dlg.querySelectorAll(`[data-show="${key}"]`).forEach((x) => (x.hidden = !on));
$('#newProject').onclick = () => {
  projDlg.querySelector('form').reset();
  showRows(projDlg, 'clone', false);
  projDlg.showModal();
};
projDlg.addEventListener('change', () => showRows(projDlg, 'clone', projDlg.querySelector('[name=mode]:checked').value === 'clone'));
projDlg.addEventListener('close', async () => {
  if (projDlg.returnValue !== 'ok') return;
  const fd = new FormData(projDlg.querySelector('form'));
  const name = String(fd.get('name') || '').trim(), mode = fd.get('mode'), url = String(fd.get('url') || '').trim();
  if (!name) return;
  if (mode === 'clone' && !url) return toast('Enter the repository URL to clone.');
  if (mode === 'clone') toast('Cloning…', 60000);
  try {
    const r = await api('POST', '/api/projects', { name, git: mode === 'clone' ? url : undefined, initGit: mode === 'local' });
    toast(mode === 'clone' ? 'Repository cloned.' : 'Project created.');
    S.projects = await api('GET', '/api/projects');
    openProject(r.name);
  } catch (e) { toast(e.message, 8000); }
});

// ---------------- git ----------------
function shortRemote(u) {
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^:/]+)[:/](.+?)(?:\.git)?$/i.exec(u);
  return m ? `${m[1].replace(/^www\./, '')}/${m[2]}` : u;
}
function renderGit() {
  const g = S.git, el = $('#gitPanel');
  $('#gitTitle').hidden = !S.project;
  if (!S.project) { el.innerHTML = ''; return; }
  if (!g) { el.innerHTML = '<div class="git-line muted">Checking…</div>'; return; }
  if (!g.enabled) {
    el.innerHTML = `<div class="git-line muted">Not under version control.</div>
      <div class="git-actions"><button data-git="init">Create local repo</button><button data-git="settings">Connect remote…</button></div>`;
    return;
  }
  let st;
  if (g.syncing) st = '<span class="busy">⟳ Syncing…</span>';
  else if (g.conflict) st = '<span class="bad">⚠ Merge conflict</span>';
  else if (g.lastError) st = '<span class="bad">✕ Last sync failed</span>';
  else if (g.changed) st = `${g.changed} change${g.changed > 1 ? 's' : ''} not synced`;
  else st = g.lastSync ? `<span class="good">✓ Synced ${ago(g.lastSync)}</span>` : 'Not synced yet';
  const ab = g.upstream && (g.ahead || g.behind) ? ` · ↑${g.ahead} ↓${g.behind}` : '';
  el.innerHTML = `<div class="git-line" title="${esc(g.remote || '')}">⎇ <b>${esc(g.branch)}</b> · ${g.remote ? esc(shortRemote(g.remote)) : '<span class="muted">no remote</span>'}</div>
    <div class="git-line">${st}${ab}</div>
    ${g.lastError && !g.syncing ? `<div class="git-err">${esc(g.lastError)}</div>` : ''}
    <div class="git-actions"><button data-git="sync" ${g.syncing || g.conflict ? 'disabled' : ''}>${g.remote ? 'Sync now' : 'Commit now'}</button>
      ${g.remote ? `<label class="small"><input type="checkbox" data-git="auto" ${g.auto ? 'checked' : ''}> Auto-sync</label>` : ''}</div>
    ${g.auto && g.paused ? '<div class="git-line muted">Auto-sync paused after a cancelled merge. Click Sync to resume.</div>' : ''}
    ${!g.author ? '<div class="git-line muted">Commits use a placeholder author — set yours in ⚙.</div>' : ''}`;
}
async function gitAction(action, body = {}) {
  const r = await api('POST', `${P()}/git`, { action, ...body });
  S.git = r.status;
  renderGit();
  renderMerge();
  return r.result;
}
async function runSync() {
  await flushSave();
  if (S.git) { S.git.syncing = true; renderGit(); }
  try {
    const r = await gitAction('sync');
    if (r.state === 'ok') toast(r.merged ? 'Synced — pulled remote changes.' : r.pushed ? 'Synced — pushed your changes.' : r.message || 'Already in sync.');
    else toast(r.message || r.state, 8000);
  } catch (e) { toast(e.message, 8000); }
  refreshState();
}
$('#gitPanel').addEventListener('click', async (e) => {
  const a = e.target.dataset.git;
  if (!a || a === 'auto') return;
  if (a === 'sync') return runSync();
  if (a === 'settings') return openGitDlg();
  if (a === 'init') {
    try { await gitAction('init'); toast('Local repository created.'); } catch (x) { toast(x.message, 8000); }
  }
});
$('#gitPanel').addEventListener('change', async (e) => {
  if (e.target.dataset.git !== 'auto') return;
  try {
    await gitAction('settings', { auto: e.target.checked });
    toast(e.target.checked ? 'Auto-sync on. Claude is only called for merge conflicts.' : 'Auto-sync off.');
  } catch (x) { toast(x.message); }
});

const gitDlg = $('#gitDlg');
function openGitDlg() {
  const g = S.git || {};
  const f = gitDlg.querySelector('form');
  gitDlg.querySelector('.dlg-proj').textContent = S.project;
  f.url.value = g.remote || '';
  f.interval.value = String(g.interval || 120);
  f.authorName.value = (g.author && g.author.name) || '';
  f.authorEmail.value = (g.author && g.author.email) || '';
  showRows(gitDlg, 'norepo', !g.enabled);
  gitDlg.showModal();
}
$('#gitSettingsBtn').onclick = openGitDlg;
gitDlg.addEventListener('click', async (e) => {
  const act = e.target.dataset.act;
  if (!act) return;
  const f = gitDlg.querySelector('form');
  const btn = e.target;
  btn.disabled = true;
  try {
    if (act === 'init') { await gitAction('init'); toast('Local repository created.'); showRows(gitDlg, 'norepo', false); }
    if (act === 'connect') {
      if (!f.url.value.trim()) return toast('Enter a repository URL.');
      toast('Connecting…', 60000);
      const r = await gitAction('connect', { url: f.url.value.trim() });
      const s = r.sync || {};
      toast(s.state === 'conflict' ? 'Connected — the remote conflicts with local files; Claude will merge them.' : s.state === 'error' ? `Connected, but sync failed: ${s.message}` : 'Connected and synced.', 8000);
      showRows(gitDlg, 'norepo', false);
    }
    if (act === 'author') { await gitAction('author', { name: f.authorName.value, email: f.authorEmail.value }); toast('Author saved for this project.'); }
  } catch (x) { toast(x.message, 8000); }
  finally { btn.disabled = false; refreshState(); }
});
gitDlg.querySelector('[name=interval]').addEventListener('change', (e) => gitAction('settings', { interval: +e.target.value }).catch((x) => toast(x.message)));

function renderMerge() {
  const bar = $('#mergeBar');
  const c = S.git && S.git.conflict;
  if (!c) { bar.hidden = true; return; }
  const req = S.requests.find((r) => r.id === c.requestId);
  const claudeDone = req && req.status === 'done';
  const pend = S.files.filter((f) => c.files.includes(f.name) && f.pending).map((f) => f.name);
  let msg;
  if (!claudeDone)
    msg = req && req.status === 'in_progress' ? 'Claude is merging the two versions…'
      : S.watch.state === 'off' ? `Waiting for Claude — no chat is watching (ask a chat to “watch project ${esc(S.project)}”), or edit the files yourself.`
      : 'Waiting for Claude to pick it up…';
  else if (pend.length) msg = `Claude proposed the merged text — review the suggested changes in ${pend.map(esc).join(', ')}, then approve.`;
  else msg = 'The merged text is ready. Approve to commit the merge and push it.';
  bar.innerHTML = `<span>⚠ <b>Merge conflict</b> with origin/${esc(c.branch)} in ${c.files.map((f) => `<a data-open="${esc(f)}">${esc(f)}</a>`).join(', ')}. ${msg}</span>
    <div class="spacer"></div>
    <button class="danger" data-merge="abort">Cancel merge</button>
    <button class="primary" data-merge="complete" ${pend.length ? 'disabled title="Review the suggested changes first"' : ''}>Approve merge</button>`;
  bar.hidden = false;
}
$('#mergeBar').addEventListener('click', async (e) => {
  const open = e.target.dataset.open;
  if (open && S.files.some((f) => f.name === open)) return openFile(open);
  const act = e.target.dataset.merge;
  if (!act) return;
  const c = S.git.conflict;
  const req = S.requests.find((r) => r.id === c.requestId);
  if (act === 'complete' && !(req && req.status === 'done') && !confirm('Claude has not finished merging. Approve the files as they are now?')) return;
  if (act === 'abort' && !confirm('Cancel the merge? Your local version is kept, the remote changes are not merged, and auto-sync pauses until you sync again.')) return;
  try {
    const r = await gitAction(act);
    if (act === 'complete') toast(r && r.state === 'ok' ? 'Merge approved, committed and pushed.' : `Merge committed. ${r && r.message ? r.message : ''}`, 6000);
    else toast('Merge cancelled.');
  } catch (x) { toast(x.message, 8000); }
  refreshState();
});
$('#newFile').onclick = async () => {
  if (!S.project) return;
  const name = prompt('New file name — end it with .md for markdown or .tex for LaTeX:', 'notes.md');
  if (!name) return;
  try {
    const r = await api('POST', `${P()}/files`, { name: name.trim() });
    await refreshState();
    openFile(r.name);
  } catch (e) { toast(e.message); }
};
window.addEventListener('beforeunload', (e) => {
  if (S.dirty) { save(); e.preventDefault(); }
});
setInterval(() => { if (S.requests.length) { S.lastReqJSON = ''; renderRequests(); } }, 30000);

// ---------------- boot ----------------
(async function boot() {
  setRaw(S.raw);
  setEditMode(S.editMode);
  renderTexControls();
  const { p, f } = readHash();
  try { S.projects = await api('GET', '/api/projects'); } catch {}
  renderProjects();
  const proj = p && S.projects.some((x) => x.name === p) ? p : S.projects[0] && S.projects[0].name;
  if (proj) await openProject(proj, f);
  else renderEmpty();
  poll();
})();
