// Line-then-word Myers diff, grouped into accept/reject-able hunks.
(function (global) {
  'use strict';

  function myersCore(a, b, limit) {
    const n = a.length, m = b.length, max = n + m;
    if (max === 0) return [];
    const off = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace = [];
    for (let d = 0; d <= max; d++) {
      if (d > limit) return null;
      trace.push(v.slice(off - d - 1, off + d + 2));
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && a[x] === b[y]) { x++; y++; }
        v[off + k] = x;
        if (x >= n && y >= m) return backtrack(a, b, trace, n, m);
      }
    }
    return null;
  }

  function backtrack(a, b, trace, n, m) {
    const ops = [];
    let x = n, y = m;
    for (let d = trace.length - 1; d >= 0; d--) {
      const snap = trace[d];
      const g = (k) => snap[k + d + 1];
      const k = x - y;
      const prevK = k === -d || (k !== d && g(k - 1) < g(k + 1)) ? k + 1 : k - 1;
      const prevX = g(prevK), prevY = prevX - prevK;
      while (x > prevX && y > prevY) { ops.push({ t: 'eq', v: a[x - 1] }); x--; y--; }
      if (d > 0) {
        if (x === prevX) ops.push({ t: 'ins', v: b[y - 1] });
        else ops.push({ t: 'del', v: a[x - 1] });
      }
      x = prevX; y = prevY;
    }
    return ops.reverse();
  }

  function myers(a, b, limit = 3000) {
    const n = a.length, m = b.length;
    let pre = 0;
    while (pre < n && pre < m && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;
    const A = a.slice(pre, n - suf), B = b.slice(pre, m - suf);
    const ops = [];
    for (let i = 0; i < pre; i++) ops.push({ t: 'eq', v: a[i] });
    const mid = myersCore(A, B, limit);
    if (mid) ops.push(...mid);
    else {
      A.forEach((v) => ops.push({ t: 'del', v }));
      B.forEach((v) => ops.push({ t: 'ins', v }));
    }
    for (let i = n - suf; i < n; i++) ops.push({ t: 'eq', v: a[i] });
    return ops;
  }

  const splitLines = (s) => s.match(/[^\n]*\n|[^\n]+/g) || [];
  const tokenize = (s) => s.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || [];

  function diffOps(a, b) {
    const lo = myers(splitLines(a), splitLines(b));
    const ops = [];
    let i = 0;
    while (i < lo.length) {
      if (lo[i].t === 'eq') { ops.push({ t: 'eq', s: lo[i].v }); i++; continue; }
      let d = '', n = '';
      while (i < lo.length && lo[i].t !== 'eq') {
        if (lo[i].t === 'del') d += lo[i].v; else n += lo[i].v;
        i++;
      }
      if (d && n) for (const o of myers(tokenize(d), tokenize(n))) ops.push({ t: o.t, s: o.v });
      else ops.push(d ? { t: 'del', s: d } : { t: 'ins', s: n });
    }
    return ops;
  }

  // Segments: {eq: string} | {del: string, ins: string}
  function buildSegments(base, current) {
    const raw = [];
    for (const o of diffOps(base, current)) {
      const last = raw[raw.length - 1];
      if (o.t === 'eq') {
        if (last && last.eq != null) last.eq += o.s;
        else raw.push({ eq: o.s });
      } else {
        let h = last && last.eq == null ? last : null;
        if (!h) { h = { del: '', ins: '' }; raw.push(h); }
        h[o.t] += o.s;
      }
    }
    // Merge hunks separated only by a tiny unchanged gap, so a rewritten phrase is one change.
    const small = (s) => (s.length <= 3 && !s.includes('\n')) || /^[ \t]+$/.test(s);
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const s = raw[i], prev = out[out.length - 1], next = raw[i + 1];
      if (s.eq != null && prev && prev.eq == null && next && next.eq == null && small(s.eq)) {
        prev.del += s.eq + next.del;
        prev.ins += s.eq + next.ins;
        i++;
        continue;
      }
      out.push(s.eq != null ? { eq: s.eq } : { del: s.del, ins: s.ins });
    }
    return out;
  }

  // Apply a decision on hunk `idx` (or all hunks if idx === -1).
  // accept -> new base; reject -> new current.
  function resolve(segments, idx, accept) {
    let out = '';
    segments.forEach((s, j) => {
      if (s.eq != null) out += s.eq;
      else if (j === idx || idx === -1) out += accept ? s.ins : s.del;
      else out += accept ? s.del : s.ins;
    });
    return out;
  }

  // Three-way merge: apply the changes ancestor→mine onto theirs.
  // Insertions are never lost; a replacement that overlaps a change on their side counts as a conflict and
  // keeps their version.
  function merge3(ancestor, mine, theirs) {
    if (mine === ancestor || mine === theirs) return { text: theirs, conflicts: 0 };
    if (theirs === ancestor) return { text: mine, conflicts: 0 };
    const hunks = (a, b) => {
      const out = [];
      let x = 0, y = 0;
      for (const s of buildSegments(a, b)) {
        if (s.eq != null) { x += s.eq.length; y += s.eq.length; continue; }
        out.push({ aFrom: x, aTo: x + s.del.length, bFrom: y, bTo: y + s.ins.length, ins: s.ins });
        x += s.del.length;
        y += s.ins.length;
      }
      return out;
    };
    const their = hunks(ancestor, theirs);
    // Position in the ancestor -> position in theirs (null when inside text they deleted / replaced).
    const map = (p, after) => {
      let shift = 0;
      for (const h of their) {
        if (h.aTo < p || (h.aTo === p && h.aFrom < p)) { shift += (h.bTo - h.bFrom) - (h.aTo - h.aFrom); continue; }
        if (h.aFrom === p && h.aTo === p) return after ? h.bTo : h.bFrom;
        if (h.aFrom < p && p < h.aTo) return null;
        break;
      }
      return p + shift;
    };
    const edits = [];
    let conflicts = 0;
    for (const m of hunks(ancestor, mine)) {
      if (m.aFrom === m.aTo) {
        // pure insertion (e.g. a note being typed): always kept
        let at = map(m.aFrom, false);
        if (at == null) { const h = their.find((x) => x.aFrom < m.aFrom && m.aFrom < x.aTo); at = h.bTo; }
        edits.push({ from: at, to: at, text: m.ins });
        continue;
      }
      const clash = their.some((h) => (h.aFrom < m.aTo && h.aTo > m.aFrom) || (h.aFrom === h.aTo && m.aFrom < h.aFrom && h.aFrom < m.aTo));
      // keep their insertions that touch the edges of my replacement: map my start after them, my end before them
      const from = map(m.aFrom, true), to = map(m.aTo, false);
      if (clash || from == null || to == null) { conflicts++; continue; }
      edits.push({ from, to, text: m.ins });
    }
    let text = theirs;
    for (const e of edits.sort((x, y) => y.from - x.from)) text = text.slice(0, e.from) + e.text + text.slice(e.to);
    return { text, conflicts };
  }

  global.MDDiff = { buildSegments, resolve, myers, merge3 };
})(typeof window !== 'undefined' ? window : globalThis);
