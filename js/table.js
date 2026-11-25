'use strict';
/* 牌桌视图层（本机牌局与局域网客户端共用）：
 * - UIPrefs：可调尺寸（牌面/手牌/座位/筹码/牌桌高度/侧栏宽度）与特效开关，保存在本机
 * - TableView：按座位增量更新 DOM（不整块重建，动画才不会被打断）
 * - FX：发牌、翻牌、下注收池、派彩飞筹码、赢家高亮、轮到你的提示
 * - Squeeze：咪牌（拖动或点击慢慢掀开自己的底牌）
 * - Sound：WebAudio 合成的提示音/筹码声（无音频文件） */

const UI_DEFAULTS = {
  card: 1, hero: 1, seat: 1, chip: 1, table: 1, side: 400,
  hideSide: false, anim: true, squeeze: false, sound: true, bbUnit: false, chipViz: true,
};

const UIPrefs = {
  v: Object.assign({}, UI_DEFAULTS),
  load() {
    let o = {};
    try { o = JSON.parse(localStorage.getItem('thsim_ui') || '{}') || {}; } catch (e) { o = {}; }
    this.v = Object.assign({}, UI_DEFAULTS, o);
    this.apply();
  },
  save() { try { localStorage.setItem('thsim_ui', JSON.stringify(this.v)); } catch (e) { /* ignore */ } },
  set(k, val) { this.v[k] = val; this.save(); this.apply(); },
  reset() { this.v = Object.assign({}, UI_DEFAULTS); this.save(); this.apply(); },
  apply() {
    const v = this.v, r = document.documentElement.style;
    r.setProperty('--z-seat', v.seat);
    r.setProperty('--z-hole', (v.card / v.seat).toFixed(4));
    r.setProperty('--z-herohole', (v.hero / v.seat).toFixed(4));
    r.setProperty('--z-board', v.card);
    r.setProperty('--z-chip', v.chip);
    r.setProperty('--ui-table', v.table);
    r.setProperty('--ui-side', v.side + 'px');
    const b = document.body; if (!b) return;
    b.classList.toggle('no-anim', !v.anim);
    b.classList.toggle('hide-side', !!v.hideSide);
  },
};

/* 金额显示：筹码数或 BB */
function fmtAmt(n, bb) {
  if (UIPrefs.v.bbUnit && bb) {
    const x = n / bb;
    return (x >= 100 ? Math.round(x) : Math.round(x * 10) / 10) + ' BB';
  }
  return fmt(n);
}

/* ====================== 筹码可视化 ====================== */
// [面值, 颜色, 边纹颜色]
const CHIP_DENOMS = [
  [100000, '#d81b60', '#fff'], [25000, '#00838f', '#fff'], [5000, '#ef6c00', '#fff'], [1000, '#f9a825', '#5d4037'],
  [500, '#6a1b9a', '#fff'], [100, '#263238', '#fff'], [25, '#2e7d32', '#fff'], [5, '#c62828', '#fff'], [1, '#eceff1', '#607d8b'],
];
function chipColumns(amount, maxCols, maxPer) {
  const cols = []; let rest = Math.round(amount);
  for (const [d, c, e] of CHIP_DENOMS) {
    if (rest < d) continue;
    const k = Math.floor(rest / d); rest -= k * d;
    cols.push([c, e, Math.min(k, maxPer)]);
  }
  return cols.slice(0, maxCols);
}
function chipsHTML(amount, maxCols = 4, maxPer = 10) {
  if (!(amount > 0)) return '';
  return '<span class="chips">' + chipColumns(amount, maxCols, maxPer).map(([c, e, k]) => {
    let s = `<span class="ccol" style="--n:${k}">`;
    for (let j = 0; j < k; j++) s += `<i style="--c:${c};--e:${e};--j:${j}"></i>`;
    return s + '</span>';
  }).join('') + '</span>';
}

/* ====================== 音效 ====================== */
const Sound = {
  ctx: null,
  muted() { return !UIPrefs.v.sound || location.hash.startsWith('#smoke'); },
  ac() {
    if (this.muted()) return null;
    try {
      if (!this.ctx) {
        const C = window.AudioContext || window.webkitAudioContext;
        if (!C) return null;
        this.ctx = new C();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    } catch (e) { return null; }
  },
  tone(f, t0, d, vol = 0.07, type = 'sine') {
    const c = this.ac(); if (!c) return;
    try {
      const o = c.createOscillator(), g = c.createGain(), t = c.currentTime + t0;
      o.type = type; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g); g.connect(c.destination);
      o.start(t); o.stop(t + d + 0.03);
    } catch (e) { /* ignore */ }
  },
  click(t0, vol = 0.22) {
    const c = this.ctx; if (!c) return;
    try {
      const len = Math.floor(c.sampleRate * 0.028);
      const buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
      const src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
      src.buffer = buf; f.type = 'bandpass'; f.frequency.value = 3000 + Math.random() * 1800; f.Q.value = 2.5; g.gain.value = vol;
      src.connect(f); f.connect(g); g.connect(c.destination);
      src.start(c.currentTime + t0);
    } catch (e) { /* ignore */ }
  },
  chips(n = 4) { if (!this.ac()) return; for (let k = 0; k < n; k++) this.click(k * 0.045 + Math.random() * 0.02); },
  ding() { this.tone(988, 0, 0.2); this.tone(1319, 0.12, 0.32); },
  win() { this.tone(660, 0, 0.16); this.tone(880, 0.1, 0.16); this.tone(1320, 0.2, 0.35); },
};
document.addEventListener('pointerdown', () => { if (Sound.ctx && Sound.ctx.state === 'suspended') Sound.ctx.resume(); });

/* ====================== 咪牌 ====================== */
const Squeeze = {
  revealed: null, hand: null, rev: [false, false], drag: null, logLine: null,
  reset() { this.revealed = null; this.hand = null; this.rev = [false, false]; this.drag = null; this.logLine = null; },
  active(handNo) { return !!UIPrefs.v.squeeze && handNo != null && this.revealed !== handNo; },
  html(hole, handNo) {
    if (this.hand !== handNo) { this.hand = handNo; this.rev = [false, false]; }
    return '<div class="sqz">' + hole.map((c, k) =>
      `<div class="sqz-card${this.rev[k] ? ' open' : ''}" data-k="${k}">${cardHTML(c)}<div class="card back sqz-cover"></div><div class="sqz-flap"></div></div>`).join('') +
      '<div class="sqz-tip">上滑 / 点击 咪牌</div></div>';
  },
  peel(el, f) {
    const cover = el.querySelector('.sqz-cover'), flap = el.querySelector('.sqz-flap');
    if (!cover) return;
    const clip = `inset(0 0 ${(f * 100).toFixed(1)}% 0)`;
    cover.style.clipPath = clip; cover.style.webkitClipPath = clip;
    const fh = Math.min(f, 1 - f);
    flap.style.bottom = (f * 100).toFixed(1) + '%';
    flap.style.height = (fh * 100).toFixed(1) + '%';
    flap.style.opacity = fh > 0.004 ? 1 : 0;
    const dir = el.dataset.k === '0' ? -1 : 1;
    el.style.transform = `rotate(${(dir * f * 5).toFixed(2)}deg) translateY(${(-f * 6).toFixed(1)}px)`;
  },
  animate(el, f0, f1, ms, ease, done) {
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      this.peel(el, f0 + (f1 - f0) * ease(t));
      if (t < 1) requestAnimationFrame(step); else if (done) done();
    };
    requestAnimationFrame(step);
  },
  // 点击：先慢后快地自动掀开（经典的“咪”）
  auto(el, f0) { this.animate(el, f0, 1, UIPrefs.v.anim ? 1300 : 1, (t) => Math.pow(t, 2.4), () => this.open(el)); },
  open(el) {
    if (el.classList.contains('open')) return;
    el.classList.add('open');
    el.style.transform = '';
    this.rev[+el.dataset.k] = true;
    Sound.click(0, 0.3);
    if (this.rev.every(Boolean)) setTimeout(() => this.finish(this.hand), 380);
  },
  finish(handNo) {
    if (handNo == null || this.revealed === handNo) return;
    this.revealed = handNo;
    if (this.logLine && typeof addLog === 'function') { addLog(this.logLine, 'hero'); }
    this.logLine = null;
    if (typeof rerenderTable === 'function') rerenderTable();
  },
  bind() {
    document.addEventListener('pointerdown', (e) => {
      const el = e.target.closest && e.target.closest('.sqz-card');
      if (!el || el.classList.contains('open') || this.drag) return;
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
      this.drag = { el, id: e.pointerId, y0: e.clientY, h: el.getBoundingClientRect().height || 70, f: 0, moved: false };
    });
    document.addEventListener('pointermove', (e) => {
      const d = this.drag; if (!d || e.pointerId !== d.id) return;
      const dy = d.y0 - e.clientY;
      if (Math.abs(dy) > 6) d.moved = true;
      d.f = Math.max(0, Math.min(1, dy / (d.h * 0.95)));
      this.peel(d.el, d.f);
    });
    const up = (e) => {
      const d = this.drag; if (!d || e.pointerId !== d.id) return;
      this.drag = null;
      if (!d.moved) this.auto(d.el, d.f);
      else if (d.f > 0.5) this.animate(d.el, d.f, 1, 140, (t) => t, () => this.open(d.el));
      else this.animate(d.el, d.f, 0, 180, (t) => 1 - Math.pow(1 - t, 2));
    };
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  },
};

/* ====================== 特效 ====================== */
const FX = {
  hand: null, bets: {}, wonHand: null, winners: new Set(), myTurn: false,
  reset() {
    this.hand = null; this.bets = {}; this.wonHand = null; this.winners = new Set(); this.myTurn = false;
    const l = $('fx'); if (l) l.innerHTML = '';
  },
  speedMul() { return S.speed === 'fast' ? 0.6 : S.speed === 'slow' ? 1.3 : 1; },
  rel(el) {
    const t = $('table').getBoundingClientRect(), r = el.getBoundingClientRect();
    return { x: r.left - t.left + r.width / 2, y: r.top - t.top + r.height / 2 };
  },
  pct(x, y) { const t = $('table'); return { x: (x / 100) * t.clientWidth, y: (y / 100) * t.clientHeight }; },

  sync(m) {
    const collected = [];
    let betUp = false;
    if (m.handNo !== this.hand) {
      this.hand = m.handNo; this.winners = new Set(); this.bets = {};
      $('fx').querySelectorAll('.win-banner').forEach((e) => e.remove());
    } else {
      const allZero = m.seats.every((s) => !s || !s.bet);
      if (allZero) for (const b of Object.values(this.bets)) collected.push(b);
      for (const s of m.seats) if (s && s.bet > ((this.bets[s.i] && this.bets[s.i].amt) || 0)) betUp = true;
    }
    this.bets = {};
    for (const s of m.seats) if (s && s.bet > 0) this.bets[s.i] = { amt: s.bet, i: s.i };
    const anim = UIPrefs.v.anim && !!Element.prototype.animate;
    if (collected.length) {
      if (anim) {
        const to = this.rel($('pot'));
        collected.forEach((b, k) => {
          const g = TableView.geo(b.i, m);
          this.fly(this.pct(g.bx, g.by), to, b.amt, k * 40, 380);
        });
      }
      Sound.chips(Math.min(6, 2 + collected.length));
    } else if (betUp && m.handNo != null) {
      Sound.chips(2);
    }
    if (m.won && m.won.length && this.wonHand !== m.handNo) {
      this.wonHand = m.handNo;
      const delay = collected.length && anim ? 430 : 60;
      setTimeout(() => { if (this.hand === m.handNo) this.award(m); }, delay * this.speedMul());
    }
    if (m.myTurn && !this.myTurn) this.turnAlert();
    this.myTurn = !!m.myTurn;
  },

  fly(from, to, amt, delay, dur) {
    const el = document.createElement('div');
    el.className = 'fly';
    el.innerHTML = chipsHTML(amt, 3, 6);
    if (!el.firstChild) return;
    el.style.left = from.x + 'px'; el.style.top = from.y + 'px';
    $('fx').appendChild(el);
    const mul = this.speedMul();
    const dx = to.x - from.x, dy = to.y - from.y;
    const a = el.firstChild.animate([
      { transform: 'translate(0,0) scale(1)', opacity: 1 },
      { transform: `translate(${dx}px,${dy}px) scale(.9)`, opacity: 1, offset: 0.86 },
      { transform: `translate(${dx}px,${dy}px) scale(.8)`, opacity: 0 },
    ], { duration: dur * mul, delay: delay * mul, easing: 'cubic-bezier(.35,.75,.35,1)', fill: 'both' });
    a.onfinish = () => el.remove();
    setTimeout(() => el.remove(), (dur + delay) * mul + 600);
  },

  award(m) {
    const anim = UIPrefs.v.anim && !!Element.prototype.animate;
    const potPt = this.rel($('pot'));
    m.won.forEach(([i, amt, desc], k) => {
      const e = TableView.els[i]; if (!e) return;
      this.winners.add(i);
      e.seat.classList.add('winner');
      if (anim) this.fly(potPt, this.rel(e.inner), amt, k * 160, 650);
      setTimeout(() => this.banner(e, amt, desc, m.bb), (anim ? 520 + k * 160 : 0) * this.speedMul());
    });
    if (m.won.some(([i]) => TableView.els[i] && TableView.els[i].me)) Sound.win(); else Sound.chips(5);
  },

  banner(e, amt, desc, bb) {
    if (!e.seat.isConnected) return;
    const p = this.rel(e.inner);
    const h = e.inner.getBoundingClientRect().height;
    const b = document.createElement('div');
    b.className = 'win-banner';
    b.innerHTML = `+${fmtAmt(amt, bb)}${desc ? `<small>${esc(desc)}</small>` : ''}`;
    b.style.left = p.x + 'px'; b.style.top = (p.y - h / 2) + 'px';
    $('fx').appendChild(b);
  },

  turnAlert() {
    const t = document.createElement('div');
    t.className = 'turn-toast';
    t.textContent = '轮到你了';
    $('fx').appendChild(t);
    setTimeout(() => t.remove(), 1500);
    Sound.ding();
    if (navigator.vibrate && !location.hash.startsWith('#smoke')) try { navigator.vibrate([70, 50, 70]); } catch (e) { /* ignore */ }
  },
};

/* ====================== 牌桌渲染 ======================
 * 视图模型 m：{ key, size, rot, seats:[{i,name,stack,bet,folded,allIn,inHand,out,place,la,pos,color,av,me,win,hole,tagHTML,hudTxt,extra,timer}],
 *              board, pot, potChips, button, handNo, toAct, won:[[seat, amount, desc]], myTurn, bb, spr } */
const TableView = {
  els: {}, size: 0, key: null, boardH: [], potH: null, dealer: null,

  /* soft：只重建 DOM（改设置时），保留咪牌/特效状态，不重放发牌动画 */
  reset(soft) {
    $('seats').innerHTML = '';
    $('board').innerHTML = '';
    $('pot').innerHTML = '';
    this.els = {}; this.boardH = []; this.potH = null; this.dealer = null;
    this.soft = !!soft;
    if (soft) return;
    this.size = 0; this.key = null;
    FX.reset(); Squeeze.reset();
    $('action-bar').classList.remove('my-turn');
  },

  geo(i, m) { return seatGeom((i - m.rot + m.size) % m.size, m.size); },

  mkSeat() {
    const seat = document.createElement('div');
    seat.className = 'seat';
    seat.innerHTML = '<div class="seat-in"><div class="hole"></div><div class="plate"></div></div><div class="mystack"></div>';
    const bet = document.createElement('div');
    bet.className = 'betchip hidden';
    $('seats').append(seat, bet);
    return { seat, inner: seat.firstChild, hole: seat.querySelector('.hole'), plate: seat.querySelector('.plate'), my: seat.querySelector('.mystack'), bet, h: {}, dealt: null };
  },

  set(e, k, el, html) { if (e.h[k] !== html) { e.h[k] = html; el.innerHTML = html; return true; } return false; },

  holeHTML(s, m) {
    if (!s.hole || !s.hole.length) return '';
    if (s.me && s.hole[0] >= 0 && Squeeze.active(m.handNo)) return Squeeze.html(s.hole, m.handNo);
    return s.hole.map((c) => (c < 0 ? backHTML('sm') : cardHTML(c, (s.me ? '' : 'sm') + (s.win ? ' win' : '')))).join('');
  },

  plateHTML(s, m) {
    const lc = s.la && s.la.startsWith('赢') ? 'win' : s.la === '弃牌' ? 'fold' : '';
    const lbl = s.la ? `<div class="act-lbl ${lc}">${esc(s.la)}</div>` : '';
    const stackTxt = s.out ? `淘汰${s.place ? ' · 第 ' + s.place + ' 名' : ''}` : `${fmtAmt(s.stack, m.bb)}${s.allIn && s.inHand && !s.folded ? ' 全下' : ''}`;
    let timer = '';
    if (s.timer && s.timer.rem > 0) {
      const w = Math.max(0, Math.min(100, (s.timer.rem / s.timer.total) * 100)).toFixed(1);
      timer = `<div class="tbar${s.timer.rem < 10000 ? ' low' : ''}"><i style="width:${w}%;animation-duration:${Math.round(s.timer.rem)}ms"></i></div>`;
    }
    return `<span class="color-dot" style="background:${s.color}"></span>${lbl}${avatarSVG(s.av, 50)}<div class="pinfo">` +
      `<div class="nm">${esc(s.name)}<span class="posl">${s.pos || ''}</span></div>` +
      `<div class="stk">${stackTxt} ${s.extra || ''}</div>${s.tagHTML || ''}<div class="hud">${s.hudTxt || ''}</div></div>${timer}`;
  },

  render(m) {
    if (m.size !== this.size || m.key !== this.key) { this.reset(); this.size = m.size; this.key = m.key; }
    // 摊牌/派彩时自动亮出还没咪开的牌
    if (m.won && Squeeze.active(m.handNo)) { Squeeze.revealed = m.handNo; Squeeze.logLine = null; }
    const T = $('table'), W = T.clientWidth, H = T.clientHeight;
    const seen = new Set();
    for (const s of m.seats) {
      if (!s) continue;
      seen.add(s.i);
      const e = this.els[s.i] || (this.els[s.i] = this.mkSeat());
      e.me = !!s.me;
      const g = this.geo(s.i, m);
      const cls = ['seat'];
      if (m.toAct === s.i) cls.push('acting');
      if (s.folded) cls.push('folded');
      if (s.me) cls.push('hero');
      if (s.out) cls.push('out');
      if (s.me && m.myTurn) cls.push('my-turn');
      if (FX.hand === m.handNo && FX.winners.has(s.i)) cls.push('winner');
      const cn = cls.join(' ');
      if (e.seat.className !== cn) e.seat.className = cn;
      const pos = `${g.x}%|${g.y}%`;
      if (e.h.pos !== pos) { e.h.pos = pos; e.seat.style.left = g.x + '%'; e.seat.style.top = g.y + '%'; }

      const hh = this.holeHTML(s, m);
      if (this.soft) e.dealt = m.handNo;
      const holeChanged = this.set(e, 'hole', e.hole, hh);
      if (holeChanged && e.dealt === m.handNo) e.hole.classList.remove('deal');
      if (holeChanged && hh && e.dealt !== m.handNo) {
        // 发牌动画：从牌桌中央飞到座位
        e.dealt = m.handNo;
        const z = s.me ? UIPrefs.v.hero : UIPrefs.v.card;
        e.hole.style.setProperty('--fx', (((50 - g.x) / 100) * W / z).toFixed(0) + 'px');
        e.hole.style.setProperty('--fy', (((50 - g.y) / 100) * H / z).toFixed(0) + 'px');
        e.hole.style.setProperty('--dd', (((s.i - m.button - 1 + m.size) % m.size) * 55) + 'ms');
        e.hole.classList.remove('deal'); void e.hole.offsetWidth; e.hole.classList.add('deal');
      }
      this.set(e, 'plate', e.plate, this.plateHTML(s, m));
      const my = s.me && UIPrefs.v.chipViz && s.stack > 0 && !s.out
        ? `${chipsHTML(s.stack, 5, 12)}<span class="ms-bb">${Math.round(s.stack / m.bb)} BB</span>` : '';
      this.set(e, 'my', e.my, my);

      const bh = s.bet > 0 ? `${UIPrefs.v.chipViz ? chipsHTML(s.bet, 3, 8) : ''}<span class="amt">${fmtAmt(s.bet, m.bb)}</span>` : '';
      if (this.set(e, 'bet', e.bet, bh)) e.bet.classList.toggle('hidden', !bh);
      const bpos = `${g.bx}%|${g.by}%`;
      if (e.h.bpos !== bpos) { e.h.bpos = bpos; e.bet.style.left = g.bx + '%'; e.bet.style.top = g.by + '%'; }
    }
    for (const k of Object.keys(this.els)) {
      if (!seen.has(+k)) { this.els[k].seat.remove(); this.els[k].bet.remove(); delete this.els[k]; }
    }
    // 庄家按钮（平滑移动）
    if (!this.dealer) { this.dealer = document.createElement('div'); this.dealer.className = 'dealer'; this.dealer.textContent = 'D'; $('seats').appendChild(this.dealer); }
    if (m.button >= 0 && m.seats[m.button]) {
      const g = this.geo(m.button, m);
      this.dealer.classList.remove('hidden');
      this.dealer.style.left = g.dx + '%'; this.dealer.style.top = g.dy + '%';
    } else this.dealer.classList.add('hidden');

    // 公共牌：逐张增量更新，新出现的牌做翻牌动画
    const B = $('board');
    if (B.childElementCount !== 5) { B.innerHTML = '<div class="bslot"></div>'.repeat(5); this.boardH = []; }
    let fresh = 0;
    for (let k = 0; k < 5; k++) {
      const c = m.board[k];
      const key = c == null ? 'x' : String(c);
      if (this.boardH[k] === key) continue;
      const wasEmpty = !this.soft && (this.boardH[k] === 'x' || this.boardH[k] == null);
      this.boardH[k] = key;
      B.children[k].innerHTML = cardHTML(c == null ? null : c, c != null && wasEmpty ? 'flip' : '');
      if (c != null && wasEmpty) B.children[k].firstChild.style.animationDelay = (fresh++ * 130) + 'ms';
    }

    // 底池：筹码堆 + 金额
    let ph = '';
    if (m.pot > 0) {
      ph = `<div class="pot-chips">${UIPrefs.v.chipViz ? chipsHTML(m.potChips || 0, 5, 9) : ''}</div>` +
        `<div class="pot-amt">底池 <b>${fmtAmt(m.pot, m.bb)}</b>${!UIPrefs.v.bbUnit && m.bb ? ` <small>${(m.pot / m.bb).toFixed(1)}BB</small>` : ''}` +
        `${m.spr != null ? ` <small class="spr">SPR ${m.spr.toFixed(1)}</small>` : ''}</div>`;
    }
    if (this.potH !== ph) { this.potH = ph; $('pot').innerHTML = ph; }

    $('action-bar').classList.toggle('my-turn', !!m.myTurn);
    if (this.soft) { this.soft = false; FX.myTurn = !!m.myTurn; return; }
    FX.sync(m);
  },
};

/* 当前牌局重绘（本机或联机客户端） */
function rerenderTable() {
  if (typeof S === 'undefined') return;
  if (S.game) {
    render();
    if (S.heroResolve && S.heroCtx && S.game.hero) computeHint(S.game.hero, S.heroCtx, S.runId);
  } else if (S.net === 'client' && typeof NetClient !== 'undefined') NetClient.render();
}

/* ====================== 界面设置面板 ====================== */
const UIPanel = {
  sliders: [
    ['card', '公共牌 / 对手牌', 0.6, 1.6, 0.05, '%'],
    ['hero', '我的手牌', 0.6, 2, 0.05, '%'],
    ['seat', '座位信息框', 0.6, 1.5, 0.05, '%'],
    ['chip', '筹码', 0.6, 1.8, 0.05, '%'],
    ['table', '牌桌高度', 0.7, 1.5, 0.05, '%'],
    ['side', '侧栏宽度（电脑）', 260, 640, 10, 'px'],
  ],
  checks: [
    ['anim', '动画特效（发牌、收池、派彩飞筹码）'],
    ['squeeze', '咪牌：底牌先盖着，上滑或点击慢慢掀开'],
    ['sound', '音效（轮到你、筹码声）'],
    ['chipViz', '筹码可视化（下注 / 底池 / 我的筹码堆）'],
    ['bbUnit', '金额以 BB 显示'],
    ['hideSide', '隐藏侧栏（牌桌更大）'],
  ],
  open() {
    let p = $('ui-panel');
    if (!p) { p = document.createElement('div'); p.id = 'ui-panel'; document.body.appendChild(p); }
    const v = UIPrefs.v;
    const val = (k, u) => (u === '%' ? Math.round(v[k] * 100) + '%' : v[k] + 'px');
    p.innerHTML = '<div class="uip-head"><b>界面设置</b><button id="uip-close">完成</button></div>' +
      this.sliders.map(([k, l, a, b, st, u]) => `<label class="uip-row"><span>${l}</span><input type="range" data-k="${k}" min="${a}" max="${b}" step="${st}" value="${v[k]}"><em id="uip-v-${k}">${val(k, u)}</em></label>`).join('') +
      this.checks.map(([k, l]) => `<label class="chk uip-chk"><input type="checkbox" data-c="${k}" ${v[k] ? 'checked' : ''}> ${l}</label>`).join('') +
      '<div class="uip-foot"><button id="uip-reset">恢复默认</button></div>';
    p.classList.remove('hidden');
    p.querySelectorAll('input[type=range]').forEach((inp) => inp.addEventListener('input', () => {
      const k = inp.dataset.k, row = this.sliders.find((r) => r[0] === k);
      UIPrefs.set(k, +inp.value);
      $('uip-v-' + k).textContent = val(k, row[5]);
      this.refresh();
    }));
    p.querySelectorAll('input[type=checkbox]').forEach((inp) => inp.addEventListener('change', () => {
      UIPrefs.set(inp.dataset.c, inp.checked);
      if (inp.dataset.c === 'squeeze' && !inp.checked) Squeeze.finish(Squeeze.hand);
      this.refresh(true);
    }));
    $('uip-close').addEventListener('click', () => this.close());
    $('uip-reset').addEventListener('click', () => { UIPrefs.reset(); this.open(); this.refresh(true); });
  },
  close() { const p = $('ui-panel'); if (p) p.classList.add('hidden'); },
  refresh(full) {
    if ($('game').classList.contains('hidden')) return;
    if (full) TableView.reset(true);
    rerenderTable();
  },
};

/* 初始化：读取设置、绑定咪牌手势与设置按钮 */
UIPrefs.load();
Squeeze.bind();
window.addEventListener('DOMContentLoaded', () => {
  UIPrefs.apply();
  for (const id of ['btn-ui', 'lobby-ui-btn']) { const b = $(id); if (b) b.addEventListener('click', () => UIPanel.open()); }
});
