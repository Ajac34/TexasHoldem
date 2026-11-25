'use strict';
/* 牌与牌型评估
 * 牌用 0..51 的整数表示：rank = c >> 2 (0=2 ... 12=A)，suit = c & 3
 * evaluate() 返回可直接比较大小的整数：category << 20 | 踢脚信息
 */
const RANK_CHARS = '23456789TJQKA';
const RANK_LABELS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUIT_SYMBOLS = ['♠', '♥', '♦', '♣'];
const HAND_CATEGORY_NAMES = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];

const Cards = {
  rank: (c) => c >> 2,
  suit: (c) => c & 3,
  isRed: (c) => (c & 3) === 1 || (c & 3) === 2,
  label: (c) => RANK_LABELS[c >> 2] + SUIT_SYMBOLS[c & 3],
  newDeck() {
    const d = new Array(52);
    for (let i = 0; i < 52; i++) d[i] = i;
    return d;
  },
  shuffle(a, rng = Math.random) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  },
  parse(str) { // 例如 "As" "Td"
    const r = RANK_CHARS.indexOf(str[0].toUpperCase());
    const s = 'shdc'.indexOf(str[1].toLowerCase());
    return r * 4 + s;
  },
};

function straightHigh(mask) {
  const m = (mask << 1) | ((mask >> 12) & 1); // bit0 = A 作为 1
  for (let hi = 13; hi >= 4; hi--) {
    if (((m >> (hi - 4)) & 31) === 31) return hi - 1;
  }
  return -1;
}

function packTop(mask, n, shift) {
  let v = 0;
  for (let r = 12; r >= 0 && n > 0; r--) {
    if (mask & (1 << r)) { v |= r << shift; shift -= 4; n--; }
  }
  return v;
}

const _rc = new Int8Array(13);
const _sm = new Int32Array(4);
const _sc = new Int8Array(4);

function evaluate(cards, n = cards.length) {
  _rc.fill(0); _sm.fill(0); _sc.fill(0);
  let rankMask = 0;
  for (let i = 0; i < n; i++) {
    const c = cards[i], r = c >> 2, s = c & 3;
    _rc[r]++; _sm[s] |= 1 << r; _sc[s]++; rankMask |= 1 << r;
  }
  let flushMask = 0;
  for (let s = 0; s < 4; s++) if (_sc[s] >= 5) flushMask = _sm[s];
  if (flushMask) {
    const sf = straightHigh(flushMask);
    if (sf >= 0) return (8 << 20) | (sf << 16);
  }
  let quad = -1, t1 = -1, t2 = -1, p1 = -1, p2 = -1;
  for (let r = 12; r >= 0; r--) {
    const k = _rc[r];
    if (k === 4) quad = r;
    else if (k === 3) { if (t1 < 0) t1 = r; else if (t2 < 0) t2 = r; }
    else if (k === 2) { if (p1 < 0) p1 = r; else if (p2 < 0) p2 = r; }
  }
  if (quad >= 0) return (7 << 20) | (quad << 16) | packTop(rankMask & ~(1 << quad), 1, 12);
  if (t1 >= 0 && (t2 >= 0 || p1 >= 0)) return (6 << 20) | (t1 << 16) | (Math.max(t2, p1) << 12);
  if (flushMask) return (5 << 20) | packTop(flushMask, 5, 16);
  const st = straightHigh(rankMask);
  if (st >= 0) return (4 << 20) | (st << 16);
  if (t1 >= 0) return (3 << 20) | (t1 << 16) | packTop(rankMask & ~(1 << t1), 2, 12);
  if (p1 >= 0 && p2 >= 0) {
    return (2 << 20) | (p1 << 16) | (p2 << 12) | packTop(rankMask & ~(1 << p1) & ~(1 << p2), 1, 8);
  }
  if (p1 >= 0) return (1 << 20) | (p1 << 16) | packTop(rankMask & ~(1 << p1), 3, 12);
  return packTop(rankMask, 5, 16);
}

function handCategory(v) { return v >> 20; }

function describeHand(v) {
  const cat = v >> 20;
  const r1 = (v >> 16) & 15, r2 = (v >> 12) & 15;
  const L = RANK_LABELS;
  switch (cat) {
    case 0: return `高牌 ${L[r1]}`;
    case 1: return `一对 ${L[r1]}`;
    case 2: return `两对 ${L[r1]} 和 ${L[r2]}`;
    case 3: return `三条 ${L[r1]}`;
    case 4: return `顺子 ${L[r1]} 高`;
    case 5: return `同花 ${L[r1]} 高`;
    case 6: return `葫芦 ${L[r1]} 带 ${L[r2]}`;
    case 7: return `四条 ${L[r1]}`;
    case 8: return r1 === 12 ? '皇家同花顺' : `同花顺 ${L[r1]} 高`;
  }
  return '';
}

/* 听牌检测（用于半诈唬）：同花听牌 / 两头顺听牌 */
function drawInfo(hole, board) {
  if (board.length < 3 || board.length >= 5) return { flushDraw: false, straightDraw: false };
  const all = hole.concat(board);
  const sc = [0, 0, 0, 0];
  for (const c of all) sc[c & 3]++;
  let flushDraw = false;
  for (let s = 0; s < 4; s++) {
    if (sc[s] === 4 && hole.some((c) => (c & 3) === s)) flushDraw = true;
  }
  let mask = 0;
  for (const c of all) mask |= 1 << (c >> 2);
  let straightDraw = false;
  if (straightHigh(mask) < 0) {
    const m = (mask << 1) | ((mask >> 12) & 1);
    for (let lo = 0; lo <= 10; lo++) {
      // 4 张连续（两头）
      if (((m >> lo) & 15) === 15 && lo >= 1 && lo <= 9) { straightDraw = true; break; }
    }
    if (!straightDraw) {
      // 卡顺：5 格窗口中有 4 张
      for (let lo = 0; lo <= 9; lo++) {
        const w = (m >> lo) & 31;
        let cnt = 0; for (let k = 0; k < 5; k++) if (w & (1 << k)) cnt++;
        if (cnt === 4) { straightDraw = 'gutshot'; break; }
      }
    }
  }
  return { flushDraw, straightDraw };
}
