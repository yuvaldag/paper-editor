// Live-preview editor for markdown and LaTeX (CodeMirror 6 + KaTeX).
// Build with ./build.sh -> app/public/vendor/editor.bundle.js (exposes window.MDEditor).
import { EditorState, StateField, StateEffect, Compartment, Prec, Annotation } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, keymap, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree, ensureSyntaxTree, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import katex from 'katex';

// Display-math environments recognised in both markdown and LaTeX files.
const MATH_ENVS = new Set([
  'equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*',
  'alignat', 'alignat*', 'flalign', 'flalign*', 'eqnarray', 'eqnarray*', 'displaymath', 'math',
]);

// ---------- mode (md | tex) ----------
const setModeEffect = StateEffect.define();
const modeField = StateField.define({
  create: () => 'md',
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setModeEffect)) return e.value;
    return v;
  },
});

// ---------- markdown extension: $inline$, $$display$$, \( \), \[ \], \begin{align}… ----------
const MathExt = {
  defineNodes: [{ name: 'InlineMath' }, { name: 'DisplayMath' }, { name: 'MathMark' }],
  parseInline: [
    {
      name: 'Math',
      before: 'Emphasis',
      parse(cx, next, pos) {
        const elt = (type, from, to, ol, cl) =>
          cx.addElement(cx.elt(type, from, to, [cx.elt('MathMark', from, from + ol), cx.elt('MathMark', to - cl, to)]));
        if (next === 92 /* \ */) {
          const c = cx.char(pos + 1);
          if (c === 98 /* b */) {
            const m = /^\\begin\{([a-zA-Z]+\*?)\}/.exec(cx.slice(pos, Math.min(cx.end, pos + 40)));
            if (!m || !MATH_ENVS.has(m[1])) return -1;
            const endTag = `\\end{${m[1]}}`;
            const e = cx.slice(pos, cx.end).indexOf(endTag);
            if (e < 0) return -1;
            return elt('DisplayMath', pos, pos + e + endTag.length, m[0].length, endTag.length);
          }
          if (c !== 40 && c !== 91) return -1;
          const close = c === 40 ? '\\)' : '\\]';
          const e = cx.slice(pos + 2, cx.end).indexOf(close);
          if (e <= 0) return -1;
          return elt(c === 40 ? 'InlineMath' : 'DisplayMath', pos, pos + 2 + e + 2, 2, 2);
        }
        if (next !== 36 /* $ */) return -1;
        if (cx.char(pos + 1) === 36) {
          const e = cx.slice(pos + 2, cx.end).indexOf('$$');
          if (e <= 0) return -1;
          return elt('DisplayMath', pos, pos + 2 + e + 2, 2, 2);
        }
        const first = cx.char(pos + 1);
        if (first === 32 || first === 10 || first === 9 || first < 0) return -1;
        let i = pos + 1;
        for (; i < cx.end; i++) {
          const c = cx.char(i);
          if (c === 10) return -1;
          if (c === 92) { i++; continue; }
          if (c === 36) break;
        }
        if (i >= cx.end || cx.char(i - 1) === 32) return -1;
        const nx = cx.char(i + 1);
        if (nx >= 48 && nx <= 57) return -1; // "$5 and $6" is money, not math
        return elt('InlineMath', pos, i + 1, 1, 1);
      },
    },
  ],
};

function getTree(state) {
  return ensureSyntaxTree(state, state.doc.length, 200) || syntaxTree(state);
}

// Turn a math source range into a render description.
function mathInfo(doc, from, to, open, close, display) {
  const text = doc.sliceString(from, to);
  const env = /^\\begin\{([a-zA-Z]+)(\*?)\}/.exec(text);
  const m = {
    from, to, open, close, display,
    inner: text.slice(open, text.length - close),
    env: env ? env[1] + env[2] : null,
    envBase: env ? env[1] : null,
    star: env ? env[2] === '*' : false,
  };
  m.tex = numberMath(m, null).tex;
  const lf = doc.lineAt(from), lt = doc.lineAt(to);
  m.block = display && doc.sliceString(lf.from, from).trim() === '' && doc.sliceString(to, lt.to).replace(/%.*/, '').trim() === '';
  m.bfrom = m.block ? lf.from : from;
  m.bto = m.block ? lt.to : to;
  return m;
}

// Split the body of an align-like environment into rows at top-level "\\".
function splitRows(s) {
  const rows = [];
  let depth = 0, envd = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      if (s.startsWith('\\begin{', i)) envd++;
      else if (s.startsWith('\\end{', i)) envd--;
      else if (s[i + 1] === '\\' && depth === 0 && envd === 0) {
        rows.push(s.slice(start, i));
        i += 2;
        if (s[i] === '[') { const c2 = s.indexOf(']', i); if (c2 > 0) i = c2 + 1; }
        start = i;
        i--;
        continue;
      }
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  rows.push(s.slice(start));
  return rows;
}

// LaTeX-style numbering: returns KaTeX source with \tag{n} and the labels it defines.
// `next` hands out the next equation number (null = don't number).
const NONUM = /\\(nonumber|notag)(?![a-zA-Z])/;
function numberMath(m, next) {
  const labels = [];
  const lab = (s, n) => { for (const x of s.matchAll(/\\label\{([^}]*)\}/g)) labels.push([x[1], n]); };
  const clean = (s) => s.replace(/\\label\{[^}]*\}/g, '').replace(/\\(nonumber|notag)(?![a-zA-Z])/g, '');
  if (!m.env) return { tex: m.inner, labels };
  const b = m.envBase, numbered = !m.star && !!next;
  if (b === 'displaymath' || b === 'math') return { tex: clean(m.inner), labels };
  if (b === 'equation') {
    let t = clean(m.inner);
    if (numbered && !NONUM.test(m.inner) && !/\\tag\{/.test(m.inner)) {
      const n = next();
      lab(m.inner, n);
      t += ` \\tag{${n}}`;
    }
    return { tex: t, labels };
  }
  if (b === 'alignat') return { tex: `\\begin{alignat*}${clean(m.inner)}\\end{alignat*}`, labels };
  const target = b === 'gather' || b === 'multline' ? 'gather*' : 'align*';
  let rows = splitRows(m.inner);
  while (rows.length > 1 && !rows[rows.length - 1].trim()) rows.pop();
  rows = rows.map((r, i) => {
    let t = clean(r);
    if (numbered && !NONUM.test(r) && !/\\tag\{/.test(r) && (b !== 'multline' || i === rows.length - 1)) {
      const n = next();
      lab(r, n);
      t += ` \\tag{${n}}`;
    }
    return t;
  });
  return { tex: `\\begin{${target}}${rows.join('\\\\')}\\end{${target}}`, labels };
}

function findMathMd(state) {
  const out = [];
  getTree(state).iterate({
    enter(n) {
      if (n.name !== 'InlineMath' && n.name !== 'DisplayMath') return;
      const marks = n.node.getChildren('MathMark');
      const open = marks.length ? marks[0].to - marks[0].from : 1;
      const close = marks.length > 1 ? marks[marks.length - 1].to - marks[marks.length - 1].from : open;
      out.push(mathInfo(state.doc, n.from, n.to, open, close, n.name === 'DisplayMath'));
      return false;
    },
  });
  let eq = 0;
  for (const m of out) m.tex = numberMath(m, () => String(++eq)).tex;
  return out;
}

// ---------- LaTeX scanning ----------
const texCache = new WeakMap();
function scanTex(state) {
  const doc = state.doc;
  if (texCache.has(doc)) return texCache.get(doc);
  const text = doc.toString();
  const n = text.length;
  const math = [], comments = [];
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '\\') {
      const nx = text[i + 1];
      if (nx === 'b' && text.startsWith('\\begin{', i)) {
        const m = /^\\begin\{([a-zA-Z]+\*?)\}/.exec(text.slice(i, i + 40));
        if (m && MATH_ENVS.has(m[1])) {
          const endTag = `\\end{${m[1]}}`;
          const e = text.indexOf(endTag, i + m[0].length);
          if (e >= 0) {
            const to = e + endTag.length;
            math.push(mathInfo(doc, i, to, m[0].length, endTag.length, true));
            i = to;
            continue;
          }
        }
      }
      if (nx === '(' || nx === '[') {
        const close = nx === '(' ? '\\)' : '\\]';
        const e = text.indexOf(close, i + 2);
        if (e > i + 2) {
          math.push(mathInfo(doc, i, e + 2, 2, 2, nx === '['));
          i = e + 2;
          continue;
        }
      }
      i += 2;
      continue;
    }
    if (c === '%') {
      let e = text.indexOf('\n', i);
      if (e < 0) e = n;
      comments.push([i, e]);
      i = e;
      continue;
    }
    if (c === '$') {
      if (text[i + 1] === '$') {
        const e = text.indexOf('$$', i + 2);
        if (e > i + 2) {
          math.push(mathInfo(doc, i, e + 2, 2, 2, true));
          i = e + 2;
          continue;
        }
        i += 2;
        continue;
      }
      let j = i + 1;
      for (; j < n; j++) {
        const d = text[j];
        if (d === '\\') { j++; continue; }
        if (d === '$') break;
        if (d === '\n' && text[j + 1] === '\n') { j = n; break; }
      }
      if (j < n && j > i + 1) {
        math.push(mathInfo(doc, i, j + 1, 1, 1, false));
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  const res = { math, comments, text };
  texCache.set(doc, res);
  return res;
}

function findMath(state) {
  return state.field(modeField) === 'tex' ? texModel(state).math : findMathMd(state);
}

function renderTex(el, tex, display) {
  const clean = tex.replace(/\\label\{[^}]*\}/g, '').replace(/\\(nonumber|notag)(?![a-zA-Z])/g, '');
  try {
    katex.render(clean, el, { displayMode: display, throwOnError: false, strict: 'ignore', trust: false });
  } catch {
    el.textContent = tex;
  }
}

class MathWidget extends WidgetType {
  constructor(tex, display, block) {
    super();
    this.tex = tex;
    this.display = display;
    this.block = block;
  }
  eq(o) {
    return o.tex === this.tex && o.display === this.display && o.block === this.block;
  }
  toDOM(view) {
    const el = document.createElement(this.block ? 'div' : 'span');
    el.className = 'cm-math' + (this.block ? ' cm-math-block' : '');
    el.title = 'Click to edit · Enter to finish';
    renderTex(el, this.tex, this.display);
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (view.state.readOnly) return;
      let pos;
      try { pos = view.posAtDOM(el); } catch { return; }
      const ms = findMath(view.state);
      const m = ms.find((x) => x.bfrom === pos || x.from === pos) || ms.find((x) => pos >= x.bfrom && pos <= x.bto);
      if (!m) return;
      view.dispatch({ selection: { anchor: m.to - m.close }, scrollIntoView: true });
      view.focus();
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

class MathPreview extends WidgetType {
  constructor(tex, display, block) {
    super();
    this.tex = tex;
    this.display = display;
    this.block = block;
  }
  eq(o) {
    return o.tex === this.tex && o.display === this.display && o.block === this.block;
  }
  toDOM() {
    if (this.block) {
      const d = document.createElement('div');
      d.className = 'cm-math-preview';
      renderTex(d, this.tex, true);
      return d;
    }
    const wrap = document.createElement('span');
    wrap.className = 'cm-math-pop';
    const inner = document.createElement('span');
    inner.className = 'cm-math-pop-inner';
    renderTex(inner, this.tex, this.display);
    const hint = document.createElement('span');
    hint.className = 'cm-math-hint';
    hint.textContent = 'Enter ↵ to finish';
    inner.appendChild(hint);
    wrap.appendChild(inner);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

class TextWidget extends WidgetType {
  constructor(text, cls) { super(); this.text = text; this.cls = cls; }
  eq(o) { return o.text === this.text && o.cls === this.cls; }
  toDOM() {
    const s = document.createElement('span');
    s.className = this.cls;
    s.textContent = this.text;
    return s;
  }
}

// ---------- tracked changes (review) ----------
const setReviewEffect = StateEffect.define();
class DelWidget extends WidgetType {
  constructor(text) { super(); this.text = text; }
  eq(o) { return o.text === this.text; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-del';
    s.textContent = /^\s+$/.test(this.text) ? this.text.replace(/\n/g, '↵\n').replace(/ /g, '·') : this.text;
    return s;
  }
}
class HunkCtl extends WidgetType {
  constructor(idx, onResolve) { super(); this.idx = idx; this.onResolve = onResolve; }
  eq(o) { return o.idx === this.idx; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-hunkctl';
    s.dataset.h = this.idx;
    for (const [act, label, title] of [['accept', '✓', 'Accept this change'], ['reject', '✕', 'Reject this change']]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.dataset.act = act;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => this.onResolve(this.idx, act === 'accept'));
      s.appendChild(b);
    }
    return s;
  }
  ignoreEvent() { return true; }
}
const reviewField = StateField.define({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setReviewEffect)) return e.value;
    return v && tr.docChanged ? null : v;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => (v ? v.deco : Decoration.none)),
});

// ---------- comment / message highlights ----------
const setAnnotationsEffect = StateEffect.define();
const annotationsField = StateField.define({
  create: () => Decoration.none,
  update(v, tr) {
    v = v.map(tr.changes);
    for (const e of tr.effects)
      if (e.is(setAnnotationsEffect)) {
        const len = tr.state.doc.length;
        v = Decoration.set(
          e.value
            .filter((a) => a.from < a.to && a.to <= len)
            .map((a) => Decoration.mark({ class: 'cm-comment ' + (a.cls || '') }).range(a.from, a.to)),
          true
        );
      }
    return v;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------- live preview ----------
const hide = Decoration.replace({});

function previewContext(state) {
  const sel = state.selection.ranges;
  const review = state.field(reviewField, false);
  const changed = review ? review.ranges : [];
  const doc = state.doc;
  const ctx = {
    doc,
    touchesChange: (a, b) => changed.some(([x, y]) => a <= y && b >= x),
    selTouches: (a, b) => sel.some((r) => r.from <= b && r.to >= a),
    selInside: (a, b) => sel.some((r) => (r.empty ? r.from > a && r.from < b : r.from < b && r.to > a)),
  };
  ctx.lineActive = (pos) => {
    const l = doc.lineAt(pos);
    return ctx.selTouches(l.from, l.to);
  };
  return ctx;
}

function mathDecos(math, ctx, decos) {
  for (const m of math) {
    if (ctx.touchesChange(m.bfrom, m.bto)) continue;
    if (ctx.selInside(m.bfrom, m.bto)) {
      decos.push(Decoration.mark({ class: 'cm-math-src' }).range(m.from, m.to));
      if (m.block) decos.push(Decoration.widget({ widget: new MathPreview(m.tex, true, true), block: true, side: 1 }).range(m.bto));
      else decos.push(Decoration.widget({ widget: new MathPreview(m.tex, m.display, false), side: 1 }).range(m.to));
    } else if (m.block) {
      decos.push(Decoration.replace({ widget: new MathWidget(m.tex, true, true), block: true }).range(m.bfrom, m.bto));
    } else {
      decos.push(Decoration.replace({ widget: new MathWidget(m.tex, m.display, false) }).range(m.from, m.to));
    }
  }
}

function buildMdPreview(state) {
  const decos = [];
  const ctx = previewContext(state);
  const { doc, touchesChange, selTouches, lineActive } = ctx;
  mathDecos(findMathMd(state), ctx, decos);
  getTree(state).iterate({
    enter(n) {
      const name = n.name;
      if (name === 'InlineMath' || name === 'DisplayMath') return false;
      const hd = /^ATXHeading(\d)$/.exec(name);
      if (hd) {
        decos.push(Decoration.line({ class: `cm-h cm-h${hd[1]}` }).range(doc.lineAt(n.from).from));
        return;
      }
      if (name === 'HeaderMark') {
        if (lineActive(n.from) || touchesChange(n.from, n.to)) return;
        const parent = n.node.parent;
        if (!parent || !/^ATXHeading/.test(parent.name)) return;
        const end = doc.sliceString(n.to, n.to + 1) === ' ' ? n.to + 1 : n.to;
        if (end > n.from) decos.push(hide.range(n.from, end));
        return;
      }
      if (name === 'Blockquote' || name === 'FencedCode' || name === 'CodeBlock') {
        const cls = name === 'Blockquote' ? 'cm-quote' : 'cm-codeblock';
        for (let p = n.from; p <= n.to; ) {
          const l = doc.lineAt(p);
          decos.push(Decoration.line({ class: cls }).range(l.from));
          p = l.to + 1;
        }
        return name === 'Blockquote' ? undefined : false;
      }
      if (name === 'EmphasisMark' || name === 'CodeMark' || name === 'StrikethroughMark') {
        const parent = n.node.parent;
        if (!parent || parent.name === 'FencedCode') return;
        if (selTouches(parent.from, parent.to) || touchesChange(parent.from, parent.to)) return;
        decos.push(hide.range(n.from, n.to));
        return;
      }
      if (name === 'Link') {
        if (selTouches(n.from, n.to) || touchesChange(n.from, n.to)) return false;
        const node = n.node;
        const marks = node.getChildren('LinkMark');
        const url = node.getChild('URL');
        if (marks.length >= 2) {
          decos.push(hide.range(marks[0].from, marks[0].to));
          decos.push(hide.range(marks[1].from, url ? n.to : marks[1].to));
          decos.push(Decoration.mark({ class: 'cm-link-text' }).range(marks[0].to, marks[1].from));
        }
        return false;
      }
    },
  });
  return Decoration.set(decos, true);
}

const TEX_STYLES = { textbf: 'cm-tex-bf', emph: 'cm-tex-it', textit: 'cm-tex-it', texttt: 'cm-tex-tt', underline: 'cm-tex-ul', textsc: 'cm-tex-sc', textrm: '', textsf: 'cm-tex-sf' };

function matchBrace(text, open) {
  let depth = 0;
  const lim = Math.min(text.length, open + 20000);
  for (let i = open; i < lim; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

// ---------- LaTeX document model (numbering, labels, environments) ----------
const THM_DEFAULTS = {
  theorem: 'Theorem', lemma: 'Lemma', proposition: 'Proposition', corollary: 'Corollary', definition: 'Definition',
  remark: 'Remark', example: 'Example', conjecture: 'Conjecture', claim: 'Claim', exercise: 'Exercise', note: 'Note',
  problem: 'Problem', question: 'Question', notation: 'Notation', assumption: 'Assumption', fact: 'Fact', observation: 'Observation',
};
const THM_ITALIC = new Set(['Theorem', 'Lemma', 'Proposition', 'Corollary', 'Conjecture', 'Claim', 'Fact']);
const LIST_ENVS = new Set(['itemize', 'enumerate', 'description', 'thebibliography']);
const SIMPLE_ENVS = new Set(['abstract', 'center', 'quote', 'quotation', 'verse', 'flushleft', 'flushright']);
const SEC_LEVEL = { part: 0, chapter: 0, section: 1, subsection: 2, subsubsection: 3, paragraph: 4 };

const roman = (n) => {
  const v = [[10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let s = '';
  for (const [k, r] of v) while (n >= k) { s += r; n -= k; }
  return s;
};
const alpha = (n) => String.fromCharCode(96 + (((n - 1) % 26) + 1));
const enumLabel = (n, d) => [String(n), alpha(n), roman(n), alpha(n).toUpperCase()][(d - 1) % 4];
const enumMarker = (n, d) => [`${n}.`, `(${alpha(n)})`, `${roman(n)}.`, `${alpha(n).toUpperCase()}.`][(d - 1) % 4];
const today = () => new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
const escHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const LATEX_HTML = '<span class="cm-tex-logo">L<sup>a</sup>T<sub>e</sub>X</span>';
const TEX_HTML = '<span class="cm-tex-logo">T<sub>e</sub>X</span>';

// Small TeX-to-HTML converter for titles, authors, theorem names, description terms.
function texInline(s) {
  let out = '', last = 0, m;
  const re = /\$([^$]+)\$|\\(textbf|emph|textit|texttt|textsc|underline|mathrm)\{((?:[^{}]|\{[^{}]*\})*)\}|\\\\(?:\[[^\]]*\])?|\\and(?![a-zA-Z])|\\thanks\{(?:[^{}]|\{[^{}]*\})*\}|\\today(?![a-zA-Z])|\\LaTeX(?![a-zA-Z])|\\TeX(?![a-zA-Z])|---|--|``|''|~|\\[a-zA-Z]+\*?|[{}]/g;
  while ((m = re.exec(s))) {
    out += escHtml(s.slice(last, m.index));
    last = re.lastIndex;
    const t = m[0];
    if (m[1] != null) {
      try { out += katex.renderToString(m[1], { throwOnError: false }); } catch { out += escHtml(t); }
    } else if (m[2]) {
      const tag = { textbf: 'b', emph: 'i', textit: 'i', texttt: 'code', textsc: 'span', underline: 'u', mathrm: 'span' }[m[2]];
      out += `<${tag}>${texInline(m[3])}</${tag}>`;
    } else if (t.startsWith('\\\\')) out += '<br>';
    else if (t === '\\and') out += '</span><span class="cm-tex-author">';
    else if (t === '\\today') out += escHtml(today());
    else if (t === '\\LaTeX') out += LATEX_HTML;
    else if (t === '\\TeX') out += TEX_HTML;
    else if (t === '---') out += '—';
    else if (t === '--') out += '–';
    else if (t === '``') out += '“';
    else if (t === "''") out += '”';
    else if (t === '~') out += '&nbsp;';
  }
  return out + escHtml(s.slice(last));
}

const modelCache = new WeakMap();
function texModel(state) {
  const doc = state.doc;
  if (modelCache.has(doc)) return modelCache.get(doc);
  const { math, comments, text } = scanTex(state);
  const mask = new Uint8Array(text.length + 1);
  for (const m of math) mask.fill(1, m.from, m.to);
  for (const [a, b] of comments) mask.fill(1, a, b);
  const M = {
    math, comments, text, mask, sections: [], envs: [], items: [], labels: {}, labelRanges: [], footnotes: [],
    captions: [], cites: {}, meta: {}, metaPos: {}, thmDefs: {}, beginDoc: null, endDoc: null, maketitle: [],
  };
  for (const [k, v] of Object.entries(THM_DEFAULTS)) M.thmDefs[k] = { label: v, counter: k, numbered: true, within: null };
  for (const key of ['title', 'author', 'date']) {
    const r = new RegExp('\\\\' + key + '\\s*\\{', 'g');
    let mm;
    while ((mm = r.exec(text))) {
      if (mask[mm.index]) continue;
      const open = mm.index + mm[0].length - 1;
      const close = matchBrace(text, open);
      if (close > 0) { M.meta[key] = text.slice(open + 1, close); M.metaPos[key] = open + 1; break; }
    }
  }
  const thmRe = /\\newtheorem(\*?)\{([^}]*)\}(?:\[([^\]]*)\])?\{([^}]*)\}(?:\[([^\]]*)\])?/g;
  let tm;
  while ((tm = thmRe.exec(text)))
    if (!mask[tm.index]) {
      const shared = tm[3] && M.thmDefs[tm[3]];
      M.thmDefs[tm[2]] = { label: tm[4], counter: tm[3] || tm[2], numbered: tm[1] !== '*', within: shared ? shared.within : tm[5] || null };
    }
  let bibN = 0;
  const bibRe = /\\bibitem(?:\[[^\]]*\])?\{([^}]*)\}/g;
  while ((tm = bibRe.exec(text))) if (!mask[tm.index]) M.cites[tm[1]] = ++bibN;

  const events = math.map((m) => ({ pos: m.from, m }));
  const re = /\\(begin|end)\{([a-zA-Z]+\*?)\}|\\(part|chapter|section|subsection|subsubsection|paragraph)(\*?)\s*\{|\\item(?![a-zA-Z])|\\bibitem(?![a-zA-Z])|\\label\{([^}]*)\}|\\caption\{|\\footnote\{|\\maketitle(?![a-zA-Z])/g;
  let mm;
  while ((mm = re.exec(text))) if (!mask[mm.index]) events.push({ pos: mm.index, mm });
  events.sort((a, b) => a.pos - b.pos);

  const counters = {}, sec = [0, 0, 0, 0], stack = [];
  let eq = 0, fn = 0, fig = 0, tab = 0, lastTarget = null;
  const nextEq = () => String(++eq);
  const innermost = (pred) => { for (let i = stack.length - 1; i >= 0; i--) if (pred(stack[i])) return stack[i]; return null; };

  for (const ev of events) {
    if (ev.m) {
      const r = numberMath(ev.m, nextEq);
      ev.m.tex = r.tex;
      for (const [k, v] of r.labels) M.labels[k] = { num: v, kind: 'Equation', eq: true };
      continue;
    }
    const m = ev.mm, pos = ev.pos, s = m[0];
    if (m[1] === 'begin') {
      const name = m[2], base = name.replace('*', '');
      let end = pos + s.length, opt = null;
      if (text[end] === '[') {
        const c = matchBracket(text, end);
        if (c > 0) { opt = text.slice(end + 1, c); end = c + 1; }
      }
      if (base === 'thebibliography' && text[end] === '{') { const c = matchBrace(text, end); if (c > 0) end = c + 1; }
      if (base === 'document') M.beginDoc = { from: pos, to: end };
      const env = { name, base, beginFrom: pos, beginTo: end, opt };
      const def = M.thmDefs[base];
      if (LIST_ENVS.has(base)) {
        env.kind = 'list';
        env.listDepth = stack.filter((e) => e.kind === 'list').length + 1;
        env.count = 0;
      } else if (def) {
        env.kind = 'thm';
        env.label = def.label;
        env.italic = THM_ITALIC.has(def.label);
        if (def.numbered && !name.endsWith('*')) {
          counters[def.counter] = (counters[def.counter] || 0) + 1;
          const lvl = def.within ? SEC_LEVEL[def.within] : 0;
          env.number = (lvl ? sec.slice(0, lvl).join('.') + '.' : '') + counters[def.counter];
        }
        lastTarget = { num: env.number || '', kind: def.label };
      } else if (base === 'proof') env.kind = 'proof';
      else if (SIMPLE_ENVS.has(base)) env.kind = base;
      else if (base === 'figure' || base === 'table') env.kind = 'float';
      else if (base === 'document') env.kind = 'document';
      else env.kind = 'other';
      stack.push(env);
      continue;
    }
    if (m[1] === 'end') {
      const name = m[2];
      if (name === 'document') M.endDoc = { from: pos, to: pos + s.length };
      for (let i = stack.length - 1; i >= 0; i--)
        if (stack[i].name === name) {
          Object.assign(stack[i], { endFrom: pos, endTo: pos + s.length });
          M.envs.push(stack[i]);
          stack.length = i;
          break;
        }
      continue;
    }
    if (m[3]) {
      const open = pos + s.length - 1, close = matchBrace(text, open);
      if (close < 0) continue;
      const level = SEC_LEVEL[m[3]], star = m[4] === '*';
      let number = '';
      if (!star && level >= 1 && level <= 3) {
        sec[level - 1]++;
        for (let k = level; k < 4; k++) sec[k] = 0;
        for (const d of Object.values(M.thmDefs)) if (d.within && SEC_LEVEL[d.within] >= level) counters[d.counter] = 0;
        number = sec.slice(0, level).join('.');
      }
      M.sections.push({ from: pos, open, close, level, number });
      lastTarget = { num: number, kind: 'Section' };
      continue;
    }
    if (s === '\\item' || s === '\\bibitem') {
      const list = innermost((e) => e.kind === 'list');
      let end = pos + s.length, opt = null;
      if (text[end] === '[') {
        const c = matchBracket(text, end);
        if (c > 0) { opt = text.slice(end + 1, c); end = c + 1; }
      }
      let marker = '•', kind = 'bullet';
      const d = list ? list.listDepth : 1;
      if (s === '\\bibitem') {
        if (text[end] === '{') {
          const c = matchBrace(text, end);
          if (c > 0) { marker = `[${M.cites[text.slice(end + 1, c)] || '?'}]`; end = c + 1; }
        }
        kind = 'bib';
      } else if (list) {
        if (opt != null) { marker = opt; kind = list.base === 'description' ? 'desc' : 'custom'; }
        else if (list.base === 'enumerate') {
          list.count++;
          marker = enumMarker(list.count, d);
          kind = 'enum';
          lastTarget = { num: enumLabel(list.count, d), kind: 'item' };
        } else if (list.base === 'description') { marker = ''; kind = 'desc'; }
        else marker = ['•', '–', '∗', '·'][(d - 1) % 4];
      }
      if (text[end] === ' ') end++;
      M.items.push({ from: pos, to: end, marker, kind, depth: d });
      continue;
    }
    if (m[5] !== undefined) {
      if (lastTarget) M.labels[m[5]] = lastTarget;
      M.labelRanges.push([pos, pos + s.length]);
      continue;
    }
    if (s === '\\caption{') {
      const open = pos + s.length - 1, close = matchBrace(text, open);
      if (close < 0) continue;
      const fl = innermost((e) => e.kind === 'float');
      const isTab = fl && fl.base === 'table';
      const num = isTab ? ++tab : ++fig;
      const kind = isTab ? 'Table' : 'Figure';
      M.captions.push({ from: pos, open, close, label: `${kind} ${num}:` });
      lastTarget = { num: String(num), kind };
      continue;
    }
    if (s === '\\footnote{') {
      const open = pos + s.length - 1, close = matchBrace(text, open);
      if (close > 0) M.footnotes.push({ from: pos, open, close, num: ++fn });
      continue;
    }
    if (s === '\\maketitle') M.maketitle.push({ from: pos, to: pos + s.length });
  }
  for (const e of stack) M.envs.push(e);
  modelCache.set(doc, M);
  return M;
}
function matchBracket(text, open) {
  let depth = 0;
  for (let i = open; i < Math.min(text.length, open + 500); i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === ']' && depth === 0) return i;
  }
  return -1;
}

// ---------- widgets used by the LaTeX view ----------
class HtmlWidget extends WidgetType {
  constructor(html, cls, block = false, onClick = null) {
    super();
    this.html = html;
    this.cls = cls;
    this.block = block;
    this.onClick = onClick;
  }
  eq(o) { return o.html === this.html && o.cls === this.cls && o.block === this.block; }
  toDOM(view) {
    const el = document.createElement(this.block ? 'div' : 'span');
    el.className = this.cls;
    el.innerHTML = this.html;
    if (this.onClick) {
      el.style.cursor = 'pointer';
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (view.state.readOnly) return;
        this.onClick(view, el);
        view.focus();
      });
    }
    return el;
  }
  ignoreEvent() { return !!this.onClick; }
}
const editHere = (view, el) => {
  try { view.dispatch({ selection: { anchor: view.posAtDOM(el) }, scrollIntoView: true }); } catch {}
};
const editTitle = (view, el) => {
  const M = texModel(view.state);
  if (M.metaPos.title != null) view.dispatch({ selection: { anchor: M.metaPos.title }, scrollIntoView: true });
  else editHere(view, el);
};

let assetUrlFn = null;
class ImageWidget extends WidgetType {
  constructor(file, width) { super(); this.file = file; this.width = width; }
  eq(o) { return o.file === this.file && o.width === this.width; }
  toDOM() {
    const wrap = document.createElement('span');
    wrap.className = 'cm-tex-figure';
    const url = assetUrlFn ? assetUrlFn(this.file) : null;
    if (!url || /\.(pdf|eps|ps)$/i.test(this.file)) {
      wrap.innerHTML = `<span class="cm-tex-imgph">🖼 ${escHtml(this.file)}</span>`;
      return wrap;
    }
    const img = document.createElement('img');
    img.src = url;
    img.style.width = this.width;
    img.onerror = () => { wrap.innerHTML = `<span class="cm-tex-imgph">🖼 ${escHtml(this.file)}</span>`; };
    wrap.appendChild(img);
    return wrap;
  }
}

const HIDE_CMDS = new Set([
  'noindent', 'indent', 'par', 'centering', 'raggedright', 'raggedleft', 'medskip', 'bigskip', 'smallskip',
  'newpage', 'clearpage', 'cleardoublepage', 'pagebreak', 'linebreak', 'newline', 'hfill', 'vfill', 'protect',
  'vspace', 'hspace', 'bibliographystyle', 'setlength', 'addtolength', 'tableofcontents', 'qedhere', 'nocite',
]);
const ARG_COUNT = { vspace: 1, hspace: 1, bibliographystyle: 1, setlength: 2, addtolength: 2, nocite: 1 };
const SYMBOLS = { ldots: '…', dots: '…', textellipsis: '…', S: '§', P: '¶', copyright: '©', textbackslash: '\\', '&': '&', ss: 'ß', LaTeX: null, TeX: null, today: null };

function buildTexPreview(state) {
  const M = texModel(state);
  const ctx = previewContext(state);
  const { doc, touchesChange, selTouches, lineActive } = ctx;
  const text = M.text;
  const decos = [];
  const claimed = [];
  const free = (a, b) => !claimed.some(([x, y]) => a < y && b > x);
  const replace = (a, b, spec = {}) => {
    if (b < a || !free(a, b) || touchesChange(a, b)) return false;
    claimed.push([a, b]);
    decos.push(Decoration.replace(spec).range(a, b));
    return true;
  };
  const lineDeco = new Map(); // line.from -> Set of classes
  const lineClass = (pos, cls) => {
    const f = doc.lineAt(pos).from;
    if (!lineDeco.has(f)) lineDeco.set(f, new Set());
    lineDeco.get(f).add(cls);
  };
  const eachLine = (from, to, fn) => {
    if (to < from) return;
    for (let p = from; p <= to; ) {
      const l = doc.lineAt(p);
      fn(l);
      p = l.to + 1;
    }
  };
  const aloneOnLine = (from, to) => {
    const l = doc.lineAt(from);
    return doc.sliceString(l.from, from).trim() === '' && to <= l.to &&
      doc.sliceString(to, l.to).replace(/%.*/, '').replace(/\\label\{[^}]*\}/g, '').trim() === '';
  };
  const hideToken = (from, to, widget = null) => {
    if (lineActive(from)) {
      decos.push(Decoration.mark({ class: 'cm-tex-env' }).range(from, to));
      return false;
    }
    const l = doc.lineAt(from);
    if (aloneOnLine(from, to)) return replace(l.from, l.to, widget ? { widget, block: true } : { block: true });
    return replace(from, to, widget ? { widget } : {});
  };
  const nextLine = (pos) => (pos < doc.length ? doc.lineAt(Math.min(doc.length, doc.lineAt(pos).to + 1)) : null);

  // 1. math (rendered / editable)
  mathDecos(M.math, ctx, decos);
  for (const m of M.math) claimed.push([m.bfrom, m.bto]);

  // 2. preamble and the end of the document
  let bodyFrom = 0, bodyTo = doc.length;
  if (M.beginDoc) {
    const bl = doc.lineAt(M.beginDoc.from);
    bodyFrom = Math.min(doc.length, bl.to + 1);
    if (selTouches(0, bl.to) || touchesChange(0, bl.to)) eachLine(0, bl.to, (l) => lineClass(l.from, 'cm-tex-preamble'));
    else {
      const cls = /\\documentclass(?:\[[^\]]*\])?\{([^}]*)\}/.exec(text.slice(0, bl.from));
      const pk = (text.slice(0, bl.from).match(/\\usepackage/g) || []).length;
      const label = `⚙ Preamble — ${cls ? escHtml(cls[1]) : 'document'}${pk ? ` · ${pk} package line${pk > 1 ? 's' : ''}` : ''} <span>click to edit</span>`;
      replace(0, bl.to, { widget: new HtmlWidget(label, 'cm-tex-preamble-chip', true, editHere), block: true });
    }
  }
  if (M.endDoc) {
    const el = doc.lineAt(M.endDoc.from);
    bodyTo = el.from;
    if (selTouches(el.from, doc.length) || touchesChange(el.from, doc.length)) eachLine(el.from, doc.length, (l) => lineClass(l.from, 'cm-tex-preamble'));
    else replace(el.from, doc.length, { block: true });
  }
  const inBody = (p) => p >= bodyFrom && p < bodyTo;

  // 3. title block
  for (const mt of M.maketitle) {
    if (!inBody(mt.from)) continue;
    const md = M.meta;
    const html =
      (md.title != null ? `<div class="cm-tex-title">${texInline(md.title)}</div>` : '') +
      (md.author != null ? `<div class="cm-tex-authors"><span class="cm-tex-author">${texInline(md.author)}</span></div>` : '') +
      `<div class="cm-tex-date">${md.date != null ? texInline(md.date) : escHtml(today())}</div>`;
    hideToken(mt.from, mt.to, new HtmlWidget(html, 'cm-tex-titleblock', true, editTitle));
  }

  // 4. sections
  const headingLines = new Set();
  for (const s of M.sections) {
    if (!inBody(s.from)) continue;
    lineClass(s.from, `cm-h cm-texh${Math.max(1, s.level)}`);
    headingLines.add(doc.lineAt(s.from).number);
    if (lineActive(s.from) || touchesChange(s.from, s.close + 1)) {
      decos.push(Decoration.mark({ class: 'cm-tex-cmd' }).range(s.from, s.open + 1));
      continue;
    }
    replace(s.from, s.open + 1, s.number ? { widget: new HtmlWidget(s.number, 'cm-tex-secnum') } : {});
    replace(s.close, s.close + 1);
  }

  // 5. environments
  const listDepth = new Map(); // line number -> depth
  const envLines = new Set(); // lines that are not ordinary paragraphs
  for (const env of M.envs) {
    if (env.kind === 'document' || env.endFrom == null || !inBody(env.beginFrom)) continue;
    const bLine = doc.lineAt(env.beginFrom), eLine = doc.lineAt(env.endFrom);
    const innerFrom = bLine.to + 1, innerTo = eLine.from - 1;
    envLines.add(bLine.number);
    envLines.add(eLine.number);
    const inner = (fn) => eachLine(innerFrom, innerTo, fn);
    if (env.kind === 'list') {
      const title = env.base === 'thebibliography' ? new HtmlWidget('References', 'cm-tex-refs-title', true, editHere) : null;
      hideToken(env.beginFrom, env.beginTo, title);
      hideToken(env.endFrom, env.endTo);
      inner((l) => { listDepth.set(l.number, Math.max(listDepth.get(l.number) || 0, env.listDepth)); envLines.add(l.number); });
    } else if (env.kind === 'thm' || env.kind === 'proof') {
      const head = env.kind === 'proof'
        ? `<i>${env.opt != null ? texInline(env.opt) : 'Proof'}.</i> `
        : `<b>${escHtml(env.label)}${env.number ? ' ' + env.number : ''}</b>${env.opt != null ? ` (${texInline(env.opt)})` : ''}<b>.</b> `;
      const w = new HtmlWidget(head, 'cm-tex-thmhead');
      if (lineActive(env.beginFrom)) decos.push(Decoration.mark({ class: 'cm-tex-env' }).range(env.beginFrom, env.beginTo));
      else if (aloneOnLine(env.beginFrom, env.beginTo)) {
        if (replace(bLine.from, bLine.to, { block: true })) {
          let l = nextLine(bLine.from);
          while (l && l.from < eLine.from && !l.text.trim()) l = nextLine(l.from);
          if (l && l.from < eLine.from) decos.push(Decoration.widget({ widget: w, side: -1 }).range(l.from));
        }
      } else replace(env.beginFrom, env.beginTo, { widget: w });
      inner((l) => { lineClass(l.from, env.italic ? 'cm-tex-thm cm-tex-it' : 'cm-tex-thm'); envLines.add(l.number); });
      if (env.kind === 'proof' && !lineActive(env.endFrom)) {
        let l = doc.lineAt(Math.max(0, eLine.from - 1));
        while (l.from > bLine.to && !l.text.trim()) l = doc.lineAt(Math.max(0, l.from - 1));
        decos.push(Decoration.widget({ widget: new HtmlWidget('∎', 'cm-tex-qed'), side: 1 }).range(l.to));
      }
      hideToken(env.endFrom, env.endTo);
    } else if (env.kind === 'abstract') {
      hideToken(env.beginFrom, env.beginTo, new HtmlWidget('Abstract', 'cm-tex-abstract-title', true, editHere));
      hideToken(env.endFrom, env.endTo);
      inner((l) => { lineClass(l.from, 'cm-tex-abstract'); envLines.add(l.number); });
    } else if (SIMPLE_ENVS.has(env.kind) || env.kind === 'float') {
      hideToken(env.beginFrom, env.beginTo);
      hideToken(env.endFrom, env.endTo);
      inner((l) => { lineClass(l.from, env.kind === 'float' ? 'cm-tex-center' : `cm-tex-${env.kind}`); envLines.add(l.number); });
    } else {
      decos.push(Decoration.mark({ class: 'cm-tex-env' }).range(env.beginFrom, env.beginTo));
      decos.push(Decoration.mark({ class: 'cm-tex-env' }).range(env.endFrom, env.endTo));
    }
  }
  for (const [ln, d] of listDepth) lineClass(doc.line(ln).from, `cm-tex-li cm-tex-d${Math.min(d, 4)}`);

  // 6. list items
  for (const it of M.items) {
    if (!inBody(it.from)) continue;
    lineClass(it.from, it.kind === 'desc' ? 'cm-tex-descitem' : 'cm-tex-item');
    if (lineActive(it.from)) { decos.push(Decoration.mark({ class: 'cm-tex-cmd' }).range(it.from, it.to)); continue; }
    const html = it.kind === 'desc' ? `<b>${texInline(it.marker)}</b>` : escHtml(it.marker);
    replace(it.from, it.to, { widget: new HtmlWidget(html, `cm-tex-marker cm-tex-m-${it.kind}`) });
  }

  // 7. captions, footnotes, labels
  for (const c of M.captions) {
    lineClass(c.from, 'cm-tex-caption');
    if (selTouches(c.from, c.close + 1)) continue;
    replace(c.from, c.open + 1, { widget: new HtmlWidget(`<b>${c.label}</b> `, 'cm-tex-caplabel') });
    replace(c.close, c.close + 1);
  }
  for (const f of M.footnotes) {
    decos.push(Decoration.mark({ class: 'cm-tex-fn' }).range(f.open + 1, f.close));
    if (selTouches(f.from, f.close + 1)) continue;
    replace(f.from, f.open + 1, { widget: new HtmlWidget(`<sup>${f.num}</sup>`, 'cm-tex-fnmark') });
    replace(f.close, f.close + 1);
  }
  for (const [a, b] of M.labelRanges) {
    if (selTouches(a, b)) { decos.push(Decoration.mark({ class: 'cm-tex-cmd' }).range(a, b)); continue; }
    if (aloneOnLine(a, b) && !lineActive(a)) { const l = doc.lineAt(a); replace(l.from, l.to, { block: true }); }
    else replace(a, b);
  }

  // 8. comments
  for (const [a, b] of M.comments) {
    if (!inBody(a)) continue;
    decos.push(Decoration.mark({ class: 'cm-tex-comment' }).range(a, b));
    if (aloneOnLine(a, b)) lineClass(a, 'cm-tex-commentline');
  }

  // 9. inline commands, refs, cites, symbols
  const re = /\\([a-zA-Z]+)(\*?)/g;
  re.lastIndex = bodyFrom;
  let m;
  while ((m = re.exec(text)) && m.index < bodyTo) {
    const from = m.index, name = m[1];
    let cmdEnd = from + m[0].length;
    if (M.mask[from] || !free(from, cmdEnd)) continue;
    if (from > 0 && text[from - 1] === '\\' && text[from - 2] !== '\\') continue;
    const sty = TEX_STYLES[name];
    if (sty && text[cmdEnd] === '{') {
      const close = matchBrace(text, cmdEnd);
      if (close > cmdEnd) {
        decos.push(Decoration.mark({ class: sty }).range(cmdEnd + 1, close));
        if (!selTouches(from, close + 1) && replace(from, cmdEnd + 1)) replace(close, close + 1);
        else decos.push(Decoration.mark({ class: 'cm-tex-cmd' }).range(from, cmdEnd));
        continue;
      }
    }
    const argEnd = (n) => {
      let e = cmdEnd;
      if (text[e] === '[') { const c = matchBracket(text, e); if (c > 0) e = c + 1; }
      for (let k = 0; k < n; k++) {
        if (text[e] !== '{') return -1;
        const c = matchBrace(text, e);
        if (c < 0) return -1;
        e = c + 1;
      }
      return e;
    };
    if (/^(cite|citep|citet|parencite|textcite)$/.test(name)) {
      const e = argEnd(1);
      if (e > 0) {
        const keys = text.slice(text.lastIndexOf('{', e - 1) + 1, e - 1).split(',').map((k) => k.trim()).filter(Boolean);
        const html = `[${keys.map((k) => escHtml(String(M.cites[k] || k))).join(', ')}]`;
        if (!selTouches(from, e)) replace(from, e, { widget: new HtmlWidget(html, 'cm-tex-cite') });
        else decos.push(Decoration.mark({ class: 'cm-tex-cmd' }).range(from, e));
        re.lastIndex = e;
        continue;
      }
    }
    if (/^(ref|eqref|autoref|cref|Cref|pageref|nameref)$/.test(name)) {
      const e = argEnd(1);
      if (e > 0) {
        const key = text.slice(cmdEnd + 1, e - 1).trim();
        const L = M.labels[key];
        const num = L ? L.num : '??';
        let label = num;
        if (name === 'eqref') label = `(${num})`;
        else if (/^(autoref|cref|Cref)$/.test(name) && L) label = L.eq ? `(${num})` : `${L.kind} ${num}`;
        if (!selTouches(from, e)) replace(from, e, { widget: new HtmlWidget(escHtml(label), L ? 'cm-tex-ref' : 'cm-tex-ref cm-tex-bad') });
        else decos.push(Decoration.mark({ class: 'cm-tex-cmd' }).range(from, e));
        re.lastIndex = e;
        continue;
      }
    }
    if (name === 'includegraphics') {
      let e = cmdEnd, opts = '';
      if (text[e] === '[') { const c = matchBracket(text, e); if (c > 0) { opts = text.slice(e + 1, c); e = c + 1; } }
      if (text[e] === '{') {
        const c = matchBrace(text, e);
        if (c > 0) {
          const file = text.slice(e + 1, c).trim();
          const wm = /width\s*=\s*([\d.]+)\s*\\(textwidth|linewidth|columnwidth)/.exec(opts);
          const width = wm ? `${Math.min(100, parseFloat(wm[1]) * 100)}%` : 'auto';
          if (!lineActive(from)) replace(from, c + 1, { widget: new ImageWidget(file, width) });
          re.lastIndex = c + 1;
          continue;
        }
      }
    }
    if (name in SYMBOLS && !selTouches(from, cmdEnd)) {
      let html = SYMBOLS[name];
      if (name === 'LaTeX') html = LATEX_HTML;
      else if (name === 'TeX') html = TEX_HTML;
      else if (name === 'today') html = escHtml(today());
      let e = cmdEnd;
      if (text.startsWith('{}', e)) e += 2;
      replace(from, e, { widget: new HtmlWidget(html, 'cm-tex-sym') });
      continue;
    }
    if (HIDE_CMDS.has(name)) {
      const e = ARG_COUNT[name] ? argEnd(ARG_COUNT[name]) : cmdEnd;
      if (e > 0 && !lineActive(from)) {
        const end = text[e] === ' ' ? e + 1 : e;
        if (aloneOnLine(from, e)) { const l = doc.lineAt(from); replace(l.from, l.to, { block: true }); }
        else replace(from, end);
        re.lastIndex = e;
        continue;
      }
    }
    if (/^(begin|end|item|bibitem|label|caption|footnote|maketitle|section|subsection|subsubsection|paragraph|chapter|part)$/.test(name)) continue;
    decos.push(Decoration.mark({ class: 'cm-tex-cmd' }).range(from, cmdEnd));
  }

  // 10. typographic ligatures and forced line breaks
  const lig = /---|--|``|''|~|\\\\/g;
  lig.lastIndex = bodyFrom;
  while ((m = lig.exec(text)) && m.index < bodyTo) {
    const a = m.index, b = a + m[0].length;
    if (M.mask[a] || (selTouches(a, b) && m[0] !== '~') || (a > 0 && text[a - 1] === '\\')) continue;
    if (m[0] === '\\\\') { decos.push(Decoration.mark({ class: 'cm-tex-cmd' }).range(a, b)); continue; }
    const ch = { '---': '—', '--': '–', '``': '“', "''": '”', '~': '&nbsp;' }[m[0]];
    replace(a, b, { widget: new HtmlWidget(ch, 'cm-tex-sym') });
  }

  // 11. paragraphs: first-line indent like LaTeX, compact blank lines
  if (bodyFrom < bodyTo) {
    let prevBlank = true, prevSpecial = true;
    eachLine(bodyFrom, Math.max(bodyFrom, bodyTo - 1), (l) => {
      const t = l.text.trim();
      if (!t) {
        lineClass(l.from, 'cm-tex-blank');
        prevBlank = true;
        return;
      }
      const special = headingLines.has(l.number) || envLines.has(l.number) || /^(%|\\(begin|end|item|maketitle|label|\[)|\$\$)/.test(t) ||
        M.math.some((x) => x.block && x.bfrom <= l.from && x.bto >= l.to);
      if (!special && prevBlank && !prevSpecial) lineClass(l.from, 'cm-tex-indent');
      prevBlank = false;
      prevSpecial = special && !/^%/.test(t) ? headingLines.has(l.number) || /^\\(begin|maketitle)/.test(t) : false;
    });
  }

  for (const [from, set] of lineDeco) decos.push(Decoration.line({ class: [...set].join(' ') }).range(from));
  return Decoration.set(decos, true);
}

function buildPreview(state) {
  return state.field(modeField) === 'tex' ? buildTexPreview(state) : buildMdPreview(state);
}
const previewField = StateField.define({
  create: buildPreview,
  update(v, tr) {
    if (
      tr.docChanged || tr.selection || tr.reconfigured ||
      tr.effects.some((e) => e.is(setReviewEffect) || e.is(setModeEffect)) ||
      syntaxTree(tr.startState) !== syntaxTree(tr.state)
    )
      return buildPreview(tr.state);
    return v;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Enter / Escape inside an equation: leave it (it renders again). Shift+Enter: newline inside it.
function leaveMath(view) {
  const r = view.state.selection.main;
  if (!r.empty) return false;
  const m = findMath(view.state).find((x) => r.head > x.from && r.head < x.to);
  if (!m) return false;
  if (m.block) {
    if (m.bto < view.state.doc.length) view.dispatch({ selection: { anchor: m.bto + 1 }, scrollIntoView: true });
    else view.dispatch({ changes: { from: m.bto, insert: '\n' }, selection: { anchor: m.bto + 1 }, scrollIntoView: true });
  } else view.dispatch({ selection: { anchor: m.to }, scrollIntoView: true });
  return true;
}
const mathKeys = Prec.highest(
  keymap.of([
    { key: 'Enter', run: leaveMath },
    { key: 'Escape', run: leaveMath },
    {
      key: 'Shift-Enter',
      run(view) {
        const h = view.state.selection.main.head;
        if (!findMath(view.state).some((x) => h > x.from && h < x.to)) return false;
        view.dispatch(view.state.replaceSelection('\n'));
        return true;
      },
    },
    {
      key: 'ArrowLeft',
      run(view) {
        const r = view.state.selection.main;
        if (!r.empty) return false;
        const m = findMath(view.state).find((x) => r.head === x.to && !x.block);
        if (!m) return false;
        view.dispatch({ selection: { anchor: m.to - m.close } });
        return true;
      },
    },
    {
      key: 'ArrowRight',
      run(view) {
        const r = view.state.selection.main;
        if (!r.empty) return false;
        const m = findMath(view.state).find((x) => r.head === x.from && !x.block);
        if (!m) return false;
        view.dispatch({ selection: { anchor: m.from + m.open } });
        return true;
      },
    },
  ])
);

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.75em', fontWeight: '700' },
  { tag: t.heading2, fontSize: '1.4em', fontWeight: '700' },
  { tag: t.heading3, fontSize: '1.2em', fontWeight: '700' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.url, color: 'var(--muted)' },
  { tag: t.monospace, fontFamily: 'var(--mono)', fontSize: '0.88em' },
  { tag: t.processingInstruction, color: 'var(--muted)' },
  { tag: t.quote, color: 'var(--muted)' },
  { tag: t.contentSeparator, color: 'var(--muted)' },
]);

const remote = Annotation.define();
const mdLanguage = [markdown({ base: markdownLanguage, extensions: [MathExt] }), syntaxHighlighting(highlight)];

function create(parent, { onChange, onSelection, onResolve, assetUrl } = {}) {
  assetUrlFn = assetUrl || null;
  const previewConf = new Compartment();
  const roConf = new Compartment();
  const langConf = new Compartment();
  const livePreview = [previewField, mathKeys];
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: '',
      extensions: [
        modeField,
        history(),
        drawSelection(),
        EditorView.lineWrapping,
        langConf.of(mdLanguage),
        reviewField,
        annotationsField,
        previewConf.of(livePreview),
        roConf.of([]),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !u.transactions.some((tr) => tr.annotation(remote)) && onChange) onChange();
          if (u.selectionSet && onSelection) onSelection();
        }),
      ],
    }),
  });

  const api = {
    view,
    getDoc: () => view.state.doc.toString(),
    // 'md' or 'tex'
    setMode(mode) {
      if (view.state.field(modeField) === mode) return;
      view.dispatch({
        effects: [setModeEffect.of(mode), langConf.reconfigure(mode === 'tex' ? [] : mdLanguage)],
      });
      view.dom.classList.toggle('cm-tex-mode', mode === 'tex');
    },
    setDoc(text) {
      const cur = view.state.doc.toString();
      if (cur === text) return;
      let a = 0;
      while (a < cur.length && a < text.length && cur[a] === text[a]) a++;
      let b = 0;
      while (b < cur.length - a && b < text.length - a && cur[cur.length - 1 - b] === text[text.length - 1 - b]) b++;
      view.dispatch({ changes: { from: a, to: cur.length - b, insert: text.slice(a, text.length - b) }, annotations: remote.of(true) });
    },
    // Put the cursor at the start of the body (after \begin{document} in LaTeX files).
    resetCursor() {
      let pos = 0;
      if (view.state.field(modeField) === 'tex') {
        const t = view.state.doc.toString();
        const i = t.indexOf('\\end{document}');
        if (i > 0) pos = Math.max(0, view.state.doc.lineAt(i).from - 1);
      }
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(0, { y: 'start' }) });
    },
    setReadOnly(ro) {
      view.dispatch({ effects: roConf.reconfigure(ro ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []) });
    },
    setRaw(raw) {
      view.dispatch({ effects: previewConf.reconfigure(raw ? [] : livePreview) });
    },
    // segments from MDDiff.buildSegments(base, current); the doc must already equal `current`.
    setReview(segments) {
      if (!segments) {
        if (view.state.field(reviewField)) view.dispatch({ effects: setReviewEffect.of(null) });
        return [];
      }
      const d = [], ranges = [], positions = [];
      let pos = 0;
      segments.forEach((s, i) => {
        if (s.eq != null) { pos += s.eq.length; return; }
        positions.push({ idx: i, pos });
        if (s.del) d.push(Decoration.widget({ widget: new DelWidget(s.del), side: -1 }).range(pos));
        if (s.ins) d.push(Decoration.mark({ class: 'cm-ins' }).range(pos, pos + s.ins.length));
        ranges.push([pos, pos + s.ins.length]);
        pos += s.ins.length;
        d.push(Decoration.widget({ widget: new HunkCtl(i, (idx, acc) => onResolve && onResolve(idx, acc)), side: 1 }).range(pos));
      });
      view.dispatch({ effects: setReviewEffect.of({ deco: Decoration.set(d, true), ranges }) });
      return positions;
    },
    setAnnotations(list) {
      view.dispatch({ effects: setAnnotationsEffect.of(list) });
    },
    getSelection() {
      const r = view.state.selection.main;
      return { from: r.from, to: r.to };
    },
    select(from, to = from) {
      view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
    },
    scrollTo(pos) {
      view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    },
    coordsAt: (pos) => view.coordsAtPos(pos),
    focus: () => view.focus(),
  };
  return api;
}

window.MDEditor = { create };
