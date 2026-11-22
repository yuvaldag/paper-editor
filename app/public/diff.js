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

  global.MDDiff = { buildSegments, resolve, myers };
})(typeof window !== 'undefined' ? window : globalThis);
