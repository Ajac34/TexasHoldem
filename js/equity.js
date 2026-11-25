'use strict';
/* 起手牌排名（169 类）与带范围的蒙特卡洛胜率计算 */

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const Preflop = (() => {
  const classes = [];
  const classIdx = new Int16Array(52 * 52).fill(-1);
  const pctTable = new Float32Array(52 * 52);
  let ready = false;

  for (let hi = 12; hi >= 0; hi--) {
    for (let lo = hi; lo >= 0; lo--) {
      if (hi === lo) classes.push({ key: RANK_CHARS[hi] + RANK_CHARS[lo], hi, lo, suited: false, pair: true, combos: 6 });
      else {
        classes.push({ key: RANK_CHARS[hi] + RANK_CHARS[lo] + 's', hi, lo, suited: true, pair: false, combos: 4 });
        classes.push({ key: RANK_CHARS[hi] + RANK_CHARS[lo] + 'o', hi, lo, suited: false, pair: false, combos: 12 });
      }
    }
  }
  const keyToClass = {};
  classes.forEach((c, i) => { keyToClass[c.key] = i; });

  for (let a = 0; a < 52; a++) {
    for (let b = 0; b < 52; b++) {
      if (a === b) continue;
      const ra = a >> 2, rb = b >> 2;
      const hi = Math.max(ra, rb), lo = Math.min(ra, rb);
      let key = RANK_CHARS[hi] + RANK_CHARS[lo];
      if (hi !== lo) key += ((a & 3) === (b & 3)) ? 's' : 'o';
      classIdx[a * 52 + b] = keyToClass[key];
    }
  }

  function vsRandom(hole, nOpp, iters, rng) {
    const used = new Uint8Array(52);
    const h = new Int32Array(7), o = new Int32Array(7);
    let win = 0;
    for (let it = 0; it < iters; it++) {
      used.fill(0); used[hole[0]] = 1; used[hole[1]] = 1;
      const draw = () => { let c; do { c = (rng() * 52) | 0; } while (used[c]); used[c] = 1; return c; };
      const opp = [];
      for (let k = 0; k < nOpp; k++) opp.push(draw(), draw());
      h[0] = hole[0]; h[1] = hole[1];
      for (let k = 0; k < 5; k++) h[2 + k] = draw();
      const hv = evaluate(h, 7);
      let best = 0, ties = 0, lose = false;
      for (let k = 0; k < nOpp; k++) {
        o[0] = opp[2 * k]; o[1] = opp[2 * k + 1];
        for (let j = 2; j < 7; j++) o[j] = h[j];
        const ov = evaluate(o, 7);
        if (ov > hv) { lose = true; break; }
        if (ov === hv) ties++;
        best = Math.max(best, ov);
      }
      if (!lose) win += 1 / (ties + 1);
    }
    return win / iters;
  }

  const CACHE_KEY = 'thsim_pf_scores_v2';
  function init() {
    if (ready) return;
    let scores = null;
    try {
      const s = localStorage.getItem(CACHE_KEY);
      if (s) { scores = JSON.parse(s); if (scores.length !== classes.length) scores = null; }
    } catch (e) { scores = null; }
    if (!scores) {
      const rng = mulberry32(20261122);
      scores = classes.map((c) => {
        const a = c.hi * 4;
        const b = c.lo * 4 + (c.suited ? 0 : 1);
        const e1 = vsRandom([a, b], 1, 900, rng);
        const e3 = vsRandom([a, b], 3, 700, rng);
        // 单挑胜率 + 多人底池可玩性（同花连张在多人底池更有价值）
        return e1 + 1.5 * e3;
      });
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(scores)); } catch (e) { /* ignore */ }
    }
    classes.forEach((c, i) => { c.score = scores[i]; });
    const order = classes.map((c, i) => i).sort((x, y) => classes[y].score - classes[x].score);
    let cum = 0;
    order.forEach((ci, rank) => {
      const c = classes[ci];
      c.rank = rank;
      c.pct = (cum + c.combos / 2) / 1326; // 区间中点
      cum += c.combos;
      c.topPct = cum / 1326;
    });
    for (let i = 0; i < 52 * 52; i++) if (classIdx[i] >= 0) pctTable[i] = classes[classIdx[i]].pct;
    ready = true;
  }

  return {
    init,
    classes,
    pct: (a, b) => pctTable[a * 52 + b],
    classOf: (a, b) => classes[classIdx[a * 52 + b]],
    keyOf: (a, b) => classes[classIdx[a * 52 + b]].key,
    rangeKeys(top) { return classes.filter((c) => c.pct <= top).map((c) => c.key); },
  };
})();

/* 带范围的胜率估计
 * opps: [{ range: 0..1 (起手牌前 x%), aggr: 本手翻后主动下注/加注次数, calls: 翻后跟注次数, bluffy: 0..1 }]
 */
const Equity = (() => {
  const used = new Int32Array(52);
  let stamp = 1;
  const deck = new Int32Array(52);
  const hv = new Int32Array(7);
  const ov = new Int32Array(7);
  const oh = new Int32Array(20);
  const tmp = new Int32Array(7);

  function equity(hole, board, opps, iters = 400, rng = Math.random) {
    const n = opps.length;
    if (n === 0) return 1;
    let dn = 0;
    const dead = new Uint8Array(52);
    for (const c of hole) dead[c] = 1;
    for (const c of board) dead[c] = 1;
    for (let c = 0; c < 52; c++) if (!dead[c]) deck[dn++] = c;
    const bl = board.length;
    const need = 5 - bl;
    let total = 0;

    const pick = () => {
      let c;
      do { c = deck[(rng() * dn) | 0]; } while (used[c] === stamp);
      used[c] = stamp;
      return c;
    };

    for (let it = 0; it < iters; it++) {
      stamp++;
      for (let k = 0; k < n; k++) {
        const o = opps[k];
        let a = 0, b = 0;
        for (let tries = 0; tries < 40; tries++) {
          a = pick(); b = pick();
          let ok = tries >= 39;
          if (!ok && Preflop.pct(a, b) <= o.range) {
            ok = true;
            if (bl >= 3 && ((o.aggr || 0) > 0 || (o.calls || 0) > 0)) {
              tmp[0] = a; tmp[1] = b;
              for (let j = 0; j < bl; j++) tmp[2 + j] = board[j];
              const cat = evaluate(tmp, 2 + bl) >> 20;
              const draw = cat === 0 ? drawInfo([a, b], board) : null;
              const hasDraw = draw && (draw.flushDraw || draw.straightDraw === true);
              const bluffy = o.bluffy == null ? 0.3 : o.bluffy;
              let p = 1;
              if (cat === 0) {
                const base = hasDraw ? 0.65 : 0.12 + 0.45 * bluffy;
                p = Math.pow(base, o.aggr || 0) * Math.pow(hasDraw ? 0.9 : 0.45, o.calls || 0);
              } else if (cat === 1) {
                p = Math.pow(0.55 + 0.3 * bluffy, o.aggr || 0);
              }
              if (rng() > p) ok = false;
            }
          }
          if (ok) break;
          used[a] = stamp - 1; used[b] = stamp - 1; // 放回
        }
        oh[2 * k] = a; oh[2 * k + 1] = b;
      }
      for (let j = 0; j < bl; j++) hv[2 + j] = board[j];
      for (let j = bl; j < 5; j++) hv[2 + j] = pick();
      hv[0] = hole[0]; hv[1] = hole[1];
      const myVal = evaluate(hv, 7);
      let lose = false, ties = 0;
      for (let k = 0; k < n; k++) {
        ov[0] = oh[2 * k]; ov[1] = oh[2 * k + 1];
        for (let j = 2; j < 7; j++) ov[j] = hv[j];
        const v = evaluate(ov, 7);
        if (v > myVal) { lose = true; break; }
        if (v === myVal) ties++;
      }
      if (!lose) total += 1 / (ties + 1);
    }
    void need;
    return total / iters;
  }

  /* 对已知手牌的胜率（复盘的上帝视角） */
  function vsHands(hole, board, hands, iters = 3000, rng = Math.random) {
    const dead = new Uint8Array(52);
    for (const c of hole) dead[c] = 1;
    for (const c of board) dead[c] = 1;
    for (const h of hands) for (const c of h) dead[c] = 1;
    const live = [];
    for (let c = 0; c < 52; c++) if (!dead[c]) live.push(c);
    const need = 5 - board.length;
    const runs = need === 0 ? 1 : iters;
    const b = new Int32Array(7), o = new Int32Array(7);
    let total = 0;
    for (let it = 0; it < runs; it++) {
      for (let j = 0; j < board.length; j++) b[2 + j] = board[j];
      for (let k = 0; k < need; k++) {
        const idx = k + Math.floor(rng() * (live.length - k));
        const tmpc = live[k]; live[k] = live[idx]; live[idx] = tmpc;
        b[2 + board.length + k] = live[k];
      }
      b[0] = hole[0]; b[1] = hole[1];
      const mv = evaluate(b, 7);
      let lose = false, ties = 0;
      for (const h of hands) {
        o[0] = h[0]; o[1] = h[1];
        for (let j = 2; j < 7; j++) o[j] = b[j];
        const v = evaluate(o, 7);
        if (v > mv) { lose = true; break; }
        if (v === mv) ties++;
      }
      if (!lose) total += 1 / (ties + 1);
    }
    return total / runs;
  }

  return { equity, vsHands };
})();
