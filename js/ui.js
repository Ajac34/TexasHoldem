'use strict';
/* 界面：大厅（风格地图编辑）、牌桌渲染、玩家操作、侧栏（地图/HUD/记录/赛况）、校准测试 */

const $ = (id) => document.getElementById(id);
const SPEEDS = { fast: 160, normal: 650, slow: 1150 };
const ARCH_COLORS = { 紧凶: '#4fa3e0', '紧凶(极紧)': '#4fa3e0', 松凶: '#ef8a50', 疯子: '#ef5350', 紧弱: '#9aa7b4', 岩石: '#b0bec5', 松弱: '#7bd88f', 跟注站: '#66bb6a' };

const S = {
  mode: 'cash', size: 6, pool: 'online_micro',
  styles: [],
  game: null, runId: 0,
  paused: false, pauseResolve: null,
  heroResolve: null, heroCtx: null, nextResolve: null,
  reveal: false, hint: true, speed: 'normal', auto: true,
  watchAfterBust: false, pendingRebuy: false,
  renderQueued: false, dragIdx: -1,
};

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmt(n) { return Math.round(n).toLocaleString('en-US'); }
function styleColor(x, y) { return ARCH_COLORS[classifyStyle(x, y)] || '#ccc'; }

/* ====================== 风格地图 ====================== */
const MAP = { x0: 46, x1: 376, y0: 30, y1: 360 };
function mapXY(x, y) { return [MAP.x0 + x * (MAP.x1 - MAP.x0), MAP.y1 - y * (MAP.y1 - MAP.y0)]; }
function invXY(px, py) { return [clamp01((px - MAP.x0) / (MAP.x1 - MAP.x0)), clamp01((MAP.y1 - py) / (MAP.y1 - MAP.y0))]; }

function mapBase(size) {
  const [xm, ym] = mapXY(0.45, 0.5);
  const W = MAP.x1 - MAP.x0, H = MAP.y1 - MAP.y0;
  const sizeMul = size >= 8 ? 0.78 : 1;
  const vp = (x) => Math.round((0.10 + 0.55 * x) * sizeMul * 100) + '%';
  let s = '';
  s += `<rect x="${MAP.x0}" y="${MAP.y0}" width="${xm - MAP.x0}" height="${ym - MAP.y0}" fill="rgba(79,163,224,.10)"/>`;
  s += `<rect x="${xm}" y="${MAP.y0}" width="${MAP.x1 - xm}" height="${ym - MAP.y0}" fill="rgba(239,83,80,.10)"/>`;
  s += `<rect x="${MAP.x0}" y="${ym}" width="${xm - MAP.x0}" height="${MAP.y1 - ym}" fill="rgba(150,160,170,.10)"/>`;
  s += `<rect x="${xm}" y="${ym}" width="${MAP.x1 - xm}" height="${MAP.y1 - ym}" fill="rgba(102,187,106,.10)"/>`;
  s += `<rect x="${MAP.x0}" y="${MAP.y0}" width="${W}" height="${H}" fill="none" stroke="#3a4a5a"/>`;
  s += `<line x1="${xm}" y1="${MAP.y0}" x2="${xm}" y2="${MAP.y1}" stroke="#3a4a5a" stroke-dasharray="4 4"/>`;
  s += `<line x1="${MAP.x0}" y1="${ym}" x2="${MAP.x1}" y2="${ym}" stroke="#3a4a5a" stroke-dasharray="4 4"/>`;
  const lbl = (x, y, t, anchor = 'start') => `<text x="${x}" y="${y}" fill="#8b9bab" font-size="13" text-anchor="${anchor}" opacity=".8">${t}</text>`;
  s += lbl(MAP.x0 + 6, MAP.y0 + 16, '紧凶 TAG');
  s += lbl(MAP.x1 - 6, MAP.y0 + 16, '松凶 LAG / 疯子', 'end');
  s += lbl(MAP.x0 + 6, MAP.y1 - 8, '紧弱 / 岩石');
  s += lbl(MAP.x1 - 6, MAP.y1 - 8, '松弱 / 跟注站', 'end');
  s += `<text x="${(MAP.x0 + MAP.x1) / 2}" y="392" fill="#c9d4df" font-size="12.5" text-anchor="middle">紧 ←  入池率 VPIP  → 松</text>`;
  for (const x of [0, 0.5, 1]) {
    const [px] = mapXY(x, 0);
    s += `<text x="${px}" y="376" fill="#8b9bab" font-size="11" text-anchor="middle">${vp(x)}</text>`;
  }
  s += `<text transform="translate(16 ${(MAP.y0 + MAP.y1) / 2}) rotate(-90)" fill="#c9d4df" font-size="12.5" text-anchor="middle">弱(被动) ←  攻击性  → 凶</text>`;
  return s;
}

function svgPoint(svg, e) {
  const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}

/* ====================== 大厅 ====================== */
function rerollStyles() {
  S.styles = [];
  for (let i = 0; i < 8; i++) S.styles.push(samplePoolStyle(S.pool));
}

function renderLobbyMap() {
  const svg = $('lobby-map');
  let s = mapBase(S.size);
  for (let i = 0; i < S.size - 1; i++) {
    const st = S.styles[i];
    const [px, py] = mapXY(st.x, st.y);
    const col = SEAT_COLORS[(i + 1) % SEAT_COLORS.length];
    s += `<g class="dot" data-idx="${i}"><circle cx="${px}" cy="${py}" r="13" fill="${col}" stroke="#111" stroke-width="2"/>` +
      `<text x="${px}" y="${py + 4.5}" font-size="12" font-weight="700" text-anchor="middle" fill="#111" pointer-events="none">${i + 1}</text></g>`;
  }
  svg.innerHTML = s;
}

function renderSeatList() {
  const tb = $('seat-list');
  let h = '<tr><td>座位</td><td>预设类型</td><td>判定风格</td><td>目标 VPIP / PFR</td></tr>';
  for (let i = 0; i < S.size - 1; i++) {
    const st = S.styles[i];
    const P = deriveParams(st.x, st.y, S.size);
    const col = SEAT_COLORS[(i + 1) % SEAT_COLORS.length];
    const opts = ['<option value="">自定义</option>'].concat(Object.entries(ARCHETYPES).map(([k, a]) =>
      `<option value="${k}" ${st.arch === k ? 'selected' : ''}>${a.name} ${a.en}</option>`)).join('');
    h += `<tr><td><span class="swatch" style="background:${col}"></span>${i + 1} 号</td>` +
      `<td><select data-seat="${i}">${opts}</select></td>` +
      `<td style="color:${styleColor(st.x, st.y)}">${classifyStyle(st.x, st.y)}</td>` +
      `<td>${Math.round(P.vpip * 100)}% / ${Math.round(P.pfr * 100)}%</td></tr>`;
  }
  tb.innerHTML = h;
  tb.querySelectorAll('select').forEach((sel) => sel.addEventListener('change', () => {
    const i = +sel.dataset.seat, k = sel.value;
    if (k) { const a = ARCHETYPES[k]; S.styles[i] = { x: a.x, y: a.y, arch: k }; }
    renderLobbyMap(); renderSeatList();
  }));
}

function updateModeUI() {
  document.querySelectorAll('#mode-seg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === S.mode));
  $('cash-opts').classList.toggle('hidden', S.mode !== 'cash');
  $('tour-opts').classList.toggle('hidden', S.mode !== 'tournament');
  $('mode-note').textContent = S.mode === 'cash'
    ? '现金桌模型：深筹码、按筹码期望值决策；有抽水、补码、玩家来来去去。用 bb/100 衡量你的胜率。'
    : '锦标赛模型：盲注递增、有前注；AI 会随筹码深度切换到推/弃，并在泡沫期受 ICM 压力影响（紧弱玩家缩手、大筹码凶玩家施压）。';
}

function initLobby() {
  const poolSel = $('opt-pool');
  poolSel.innerHTML = Object.entries(POOLS).map(([k, p]) => `<option value="${k}">${p.name}</option>`).join('');
  poolSel.value = S.pool;
  const poolNote = () => { $('pool-note').textContent = POOLS[S.pool].desc; };
  poolNote();
  poolSel.addEventListener('change', () => { S.pool = poolSel.value; poolNote(); rerollStyles(); renderLobbyMap(); renderSeatList(); });
  $('opt-size').addEventListener('change', (e) => { S.size = +e.target.value; renderLobbyMap(); renderSeatList(); });
  document.querySelectorAll('#mode-seg button').forEach((b) => b.addEventListener('click', () => { S.mode = b.dataset.mode; updateModeUI(); }));
  $('reroll-btn').addEventListener('click', () => { rerollStyles(); renderLobbyMap(); renderSeatList(); });
  $('start-btn').addEventListener('click', () => startGame());
  $('calib-btn').addEventListener('click', runCalibration);

  const svg = $('lobby-map');
  svg.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('.dot'); if (!g) return;
    S.dragIdx = +g.dataset.idx; svg.setPointerCapture(e.pointerId); e.preventDefault();
  });
  svg.addEventListener('pointermove', (e) => {
    if (S.dragIdx < 0) return;
    const p = svgPoint(svg, e);
    const [x, y] = invXY(p.x, p.y);
    S.styles[S.dragIdx] = { x, y, arch: null };
    renderLobbyMap();
  });
  const end = () => { if (S.dragIdx >= 0) { S.dragIdx = -1; renderSeatList(); } };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);

  rerollStyles(); updateModeUI(); renderLobbyMap(); renderSeatList();
}

function buildConfig() {
  const [sb, bb] = $('opt-blinds').value.split('/').map(Number);
  return {
    mode: S.mode, size: S.size, styles: S.styles.slice(0, S.size - 1).map((s) => ({ ...s })),
    observer: $('opt-observer').checked, pool: S.pool, dynamicPool: $('opt-dynamic').checked,
    cash: { sb, bb, buyinBB: +$('opt-buyin').value, rakePct: +$('opt-rake').value, rakeCapBB: 3 },
    tour: { startStack: +$('opt-tstack').value, handsPerLevel: +$('opt-tlevel').value, buyin: 100 },
  };
}

/* ====================== 开始游戏 ====================== */
function makeIO(myRun) {
  return {
    update: () => { if (myRun === S.runId) scheduleRender(); },
    log: (msg, cls) => { if (myRun === S.runId) addLog(msg, cls); },
    sleep: (ms) => new Promise((res) => setTimeout(() => { if (myRun === S.runId) res(); }, ms)),
    aiDelay: () => {
      const base = SPEEDS[S.speed];
      const h = S.game && S.game.hero;
      if (h && (!h.inHand || h.folded)) return base * 0.35;
      if (!h && S.watchAfterBust) return base * 0.2;
      return base;
    },
    heroAction: (p, ctx) => heroAction(p, ctx, myRun),
    onHandEnd: () => {},
  };
}

/* cfg 由自由练习或职业生涯构建；career = null | { kind:'cash', stake } | { kind:'tour', tour } */
function startGame(cfg = buildConfig(), career = null) {
  S.runId++;
  const myRun = S.runId;
  cfg.io = makeIO(myRun);
  S.net = cfg.net || null;
  if (cfg.net === 'host') NetHost.attach(cfg.io, myRun);
  S.game = new Game(cfg);
  if (cfg.net === 'host') NetHost.seatAll(S.game);
  S.career = career;
  S.reveal = $('opt-reveal').checked; S.hint = $('opt-hint').checked; S.speed = $('opt-speed').value;
  S.paused = false; S.watchAfterBust = false; S.pendingRebuy = false; S.auto = true; S.leaving = false; S.handActive = false;
  $('tg-reveal').checked = S.reveal; $('tg-hint').checked = S.hint; $('tg-speed').value = S.speed; $('tg-auto').checked = true;
  $('btn-pause').textContent = '暂停';
  $('btn-lobby').textContent = cfg.mode === 'tournament' ? '退赛 / 离开' : '离桌';
  $('log').innerHTML = '';
  TableView.reset();
  $('tab-tour-btn').classList.toggle('hidden', cfg.mode !== 'tournament');
  $('lobby').classList.add('hidden');
  $('review').classList.add('hidden');
  $('game').classList.remove('hidden');
  selectTab('map');
  addLog(cfg.mode === 'cash'
    ? `${cfg.title || '现金桌'}：盲注 ${cfg.cash.sb}/${cfg.cash.bb}，你带入 ${fmt(S.game.hero ? S.game.hero.stack : 0)}`
    : `${cfg.title || '锦标赛'}：${cfg.size} 人 SNG，起始筹码 ${cfg.tour.startStack}，每 ${cfg.tour.handsPerLevel} 手升盲，奖励前 ${payoutStructure(cfg.size).length} 名`, 'sys');
  updateMarkBtn();
  render();
  gameLoop(myRun);
}

function gotoLobby() {
  S.runId++;
  if (S.net === 'host' && typeof NetHost !== 'undefined') NetHost.stop();
  S.heroResolve = null; S.nextResolve = null;
  if (S.pauseResolve) { const r = S.pauseResolve; S.pauseResolve = null; r(); }
  hideModal();
  $('game').classList.add('hidden');
  $('review').classList.add('hidden');
  $('lobby').classList.remove('hidden');
  if (typeof Lobby !== 'undefined') Lobby.refresh();
}

/* 职业模式：每手结束后同步资金/统计，防止刷新页面“逃单” */
function careerAfterHand() {
  const g = S.game, h = g.hero;
  if (!S.career || !h || !Career.p) return;
  Career.p.hands++;
  Career.p.heroStats = h.stats.toJSON();
  if (S.career.kind === 'cash' && Career.p.activeSeat) {
    Career.p.activeSeat.stack = h.stack;
    Career.p.activeSeat.invested = h.invested;
  }
  Career.save();
}

function settleTournament() {
  const g = S.game, h = g.table.players.find((p) => p.isHero);
  if (!S.career || S.career.kind !== 'tour' || !Career.p.activeTour || !h || h.place == null) return;
  const t = S.career.tour, cost = t.buyin + t.fee, prize = Math.round(h.prize || 0);
  Career.p.bankroll += prize;
  Career.p.activeTour = null;
  Career.p.tourResults.unshift({ ts: Date.now(), name: t.name, place: h.place, size: g.table.size, prize, cost });
  Career.addHistory('tour', `${t.name} 第 ${h.place}/${g.table.size} 名`, prize - cost);
}

function finishSession() {
  const g = S.game, h = g && g.hero;
  if (g) g.syncAll();
  if (S.career && Career.p) {
    if (S.career.kind === 'cash' && h && Career.p.activeSeat) {
      Career.p.bankroll += h.stack;
      Career.p.activeSeat = null;
      Career.p.heroStats = h.stats.toJSON();
      Career.addHistory('cash', `${g.cfg.title}，${g.handsPlayed} 手${h.buyIns > 1 ? `，买入 ${h.buyIns} 次` : ''}`, h.stack - h.invested);
    } else if (S.career.kind === 'tour' && Career.p.activeTour) {
      const t = S.career.tour;
      Career.p.activeTour = null;
      Career.addHistory('tour', `${t.name} 中途退赛`, -(t.buyin + t.fee));
    }
  }
  S.career = null; S.leaving = false;
  gotoLobby();
}

async function requestLeave() {
  if (S.net === 'client') { NetClient.leave(); return; }
  const g = S.game, h = g && g.hero;
  if (!h || !S.career) { finishSession(); return; }
  if (g.mode === 'tournament') {
    if (h.stack > 0 && !g.finished) {
      const c = await showModal(`<h3>确定退赛？</h3><p>锦标赛中途离开将<b class="neg">失去全部报名费</b>（${fmt(S.career.tour.buyin + S.career.tour.fee)}），不会获得任何奖金。</p>`,
        [{ label: '继续比赛', value: 'stay', primary: true }, { label: '退赛', value: 'leave' }]);
      if (c !== 'leave') return;
    }
    finishSession();
    return;
  }
  const busy = S.handActive && h.inHand && !h.folded;
  if (!busy) { finishSession(); return; }
  if (S.heroResolve) { S.leaving = true; heroDo('fold'); finishSession(); return; }
  S.leaving = true;
  addLog('你将在本手结束后离桌（轮到你时自动弃牌）', 'sys');
}

async function heroBustCash(myRun) {
  const g = S.game, hero = g.hero, bb = g.table.bb;
  if (!S.career) {
    const c = await showModal(`<h3>你输光了筹码</h3><p>本场共买入 ${hero.buyIns} 次，当前盈亏 <b class="neg">${fmt(hero.stack - hero.invested)}</b>。</p>`,
      [{ label: '返回大厅', value: 'lobby' }, { label: `补码 ${g.cfg.cash.buyinBB}BB`, value: 'rebuy', primary: true }]);
    if (c === 'lobby') return false;
    g.heroRebuy(); return true;
  }
  const minB = bb * MIN_BUYIN_BB;
  const can = Career.p.bankroll >= minB;
  const amt = Math.min(bb * MAX_BUYIN_BB, Math.floor(Career.p.bankroll / bb) * bb);
  const brm = Career.brm(bb * 100, 'cash');
  const c = await showModal(`<h3>你输光了桌上的筹码</h3><p>本场已买入 ${hero.buyIns} 次，本场亏损 <b class="neg">${fmt(hero.invested)}</b>。</p>` +
    `<p>剩余资金：<b>${fmt(Career.p.bankroll)}</b>（${brm.n.toFixed(1)} 个满买入，<span class="brm ${brm.level}">${brm.text}</span>）</p>` +
    (can ? '<p class="note">止损也是资金管理的一部分：连续输掉多个买入时，离桌或降级往往是更好的选择。</p>' : '<p class="neg">资金不足以再次买入这个级别。</p>'),
    [{ label: '离桌', value: 'lobby' }].concat(can ? [{ label: `再买入 ${fmt(amt)}`, value: 'rebuy', primary: true }] : []));
  if (myRun !== S.runId) return false;
  if (c !== 'rebuy') return false;
  Career.p.bankroll -= amt;
  g.heroRebuy(amt);
  careerAfterHand();
  Career.save();
  return true;
}

async function gameLoop(myRun) {
  const g = S.game;
  const io = g.table.io;
  while (myRun === S.runId) {
    if (S.paused) {
      await new Promise((r) => { S.pauseResolve = r; });
      if (myRun !== S.runId) return;
    }
    if (S.net === 'host') NetHost.beforeHand(g);
    g.beforeHand();
    const hero = g.hero;
    if (g.mode === 'cash' && hero) {
      if (S.pendingRebuy) {
        let add = g.startStack - hero.stack;
        if (S.career) add = Math.min(add, Math.floor(Career.p.bankroll / g.table.bb) * g.table.bb);
        if (add > 0) { if (S.career) Career.p.bankroll -= add; g.heroRebuy(add); careerAfterHand(); }
        S.pendingRebuy = false;
      }
      if (hero.stack === 0) {
        const ok = await heroBustCash(myRun);
        if (myRun !== S.runId) return;
        if (!ok) { finishSession(); return; }
      }
    }
    S.handActive = true;
    S.markNext = false;
    const ok = await g.table.playHand();
    S.handActive = false;
    if (myRun !== S.runId) return;
    if (!ok) break;
    const st = g.afterHand(g.table.hand);
    careerAfterHand();
    updateMarkBtn();
    render();
    if (S.leaving) { finishSession(); return; }
    if (st.heroBusted && g.mode === 'tournament') settleTournament();
    if (st.over) { settleTournament(); await showTourResult(myRun); return; }
    if (st.heroBusted && g.mode === 'tournament' && !S.watchAfterBust) {
      const h = g.table.players.find((p) => p.isHero);
      const c = await showModal(`<h3>你被淘汰了</h3><p>名次：<b>第 ${h.place} 名</b>（共 ${g.table.size} 人）` +
        `${h.prize ? `，奖金 <b class="pos">${fmt(h.prize)}</b>（买入 ${g.buyin}）` : '，未进入奖励圈'}。</p>`,
        [{ label: '返回大厅', value: 'lobby' }, { label: '快进观看剩余比赛', value: 'watch', primary: true }]);
      if (myRun !== S.runId) return;
      if (c === 'lobby') { finishSession(); return; }
      S.watchAfterBust = true;
    }
    const showdown = g.table.hand.showdownPlayers.length > 0;
    const heroIn = g.hero && g.hero.stack > 0;
    if (S.auto || !heroIn) {
      const mul = S.speed === 'fast' ? 0.5 : S.speed === 'slow' ? 1.5 : 1;
      await io.sleep((S.watchAfterBust ? 300 : (showdown ? 2600 : 1300)) * mul);
    } else {
      $('next-controls').classList.remove('hidden');
      await new Promise((r) => { S.nextResolve = r; });
      $('next-controls').classList.add('hidden');
    }
  }
}

/* 标记手牌：手牌进行中 → 标记当前手；两手之间 → 标记上一手 */
function toggleMark() {
  const g = S.game; if (!g || !g.hero) return;
  if (S.handActive && g.table.hand) {
    g.table.hand.marked = !g.table.hand.marked;
    addLog(g.table.hand.marked ? '★ 已标记本手，结束后可在“牌局复盘”中分析' : '已取消标记', 'sys');
  } else {
    const rec = g.recentHands[0];
    if (!rec) return;
    rec.marked = !rec.marked;
    if (rec.marked) HandStore.add(rec); else HandStore.remove(rec.id);
    addLog(rec.marked ? `★ 已标记第 ${rec.no} 手` : `已取消标记第 ${rec.no} 手`, 'sys');
  }
  updateMarkBtn();
}
function updateMarkBtn() {
  const g = S.game; const b = $('btn-mark'); if (!g) return;
  b.classList.toggle('hidden', !g.hero);
  const marked = S.handActive && g.table.hand ? !!g.table.hand.marked : !!(g.recentHands[0] && g.recentHands[0].marked);
  b.textContent = marked ? '★ 已标记' : (S.handActive ? '☆ 标记本手' : '☆ 标记上一手');
  b.classList.toggle('primary', marked);
}

/* ====================== 玩家操作 ====================== */
function heroAction(p, ctx, myRun) {
  if (S.leaving) return Promise.resolve({ type: 'fold' });
  return new Promise((res) => {
    S.heroCtx = ctx;
    S.heroResolve = (a) => {
      if (myRun !== S.runId) return;
      S.heroResolve = null;
      $('action-controls').classList.add('hidden');
      $('hint').textContent = '';
      res(a);
    };
    showControls(p, ctx);
    computeHint(p, ctx, myRun);
  });
}

function presetAmounts(t, ctx) {
  const list = [];
  const limpers = t.hand.actions.filter((a) => a.street === 'preflop' && a.type === 'call' && a.facing === 0).length;
  if (t.street === 'preflop' && t.hand.preflopRaises === 0) {
    for (const m of [2, 2.5, 3, 4]) list.push([`${m}BB`, m * t.bb + limpers * t.bb]);
  } else if (t.street === 'preflop') {
    for (const m of [2.5, 3, 4]) list.push([`${m}倍`, t.currentBet * m]);
  } else {
    for (const [l, f] of [['1/3', 1 / 3], ['1/2', 0.5], ['2/3', 2 / 3], ['3/4', 0.75], ['底池', 1]]) {
      list.push([l + '池', t.currentBet + f * (ctx.pot + ctx.toCall)]);
    }
  }
  list.push(['全下', ctx.maxTo]);
  return list.map(([l, v]) => [l, Math.min(ctx.maxTo, Math.max(ctx.minRaiseTo, t.roundChips(v)))]);
}

function showControls(p, ctx) {
  const t = S.game.table;
  $('action-controls').classList.remove('hidden');
  $('btn-fold').classList.toggle('hidden', ctx.toCall === 0);
  $('btn-call').innerHTML = (ctx.toCall === 0 ? '过牌' : `跟注 ${fmt(ctx.toCall)}${ctx.toCall >= p.stack ? '（全下）' : ''}`) + ' <kbd>C</kbd>';
  const canRaise = ctx.canRaise && p.stack > ctx.toCall;
  $('btn-raise').classList.toggle('hidden', !canRaise);
  document.querySelector('.raise-row').classList.toggle('hidden', !canRaise);
  $('presets').classList.toggle('hidden', !canRaise);
  if (canRaise) {
    const sl = $('raise-slider'), num = $('raise-amt');
    sl.min = num.min = ctx.minRaiseTo; sl.max = num.max = ctx.maxTo; sl.step = num.step = t.chipUnit;
    const presets = presetAmounts(t, ctx);
    const def = t.street === 'preflop' ? presets[t.hand.preflopRaises === 0 ? 1 : 1][1] : presets[2][1];
    setRaise(def);
    $('presets').innerHTML = presets.map(([l, v]) => `<button data-v="${v}">${l}</button>`).join('');
    $('presets').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setRaise(+b.dataset.v)));
  }
  const pos = t.positionOf(p);
  $('action-status').innerHTML = `轮到你行动（${pos.label}）· 底池 <b>${fmt(ctx.pot)}</b>` +
    (ctx.toCall > 0 ? ` · 需跟注 <b>${fmt(ctx.toCall)}</b> · 底池赔率 <b>${Math.round(ctx.toCall / (ctx.pot + ctx.toCall) * 100)}%</b>` : '');
}

function setRaise(v) {
  const ctx = S.heroCtx; if (!ctx) return;
  v = Math.min(ctx.maxTo, Math.max(ctx.minRaiseTo, Math.round(v)));
  $('raise-slider').value = v; $('raise-amt').value = v;
  const word = v >= ctx.maxTo ? '全下' : (ctx.currentBet === 0 ? '下注' : '加注到');
  $('btn-raise').innerHTML = `${word} ${fmt(v)} <kbd>R</kbd>`;
}

function heroDo(kind) {
  if (!S.heroResolve) return;
  const ctx = S.heroCtx;
  if (kind === 'fold') S.heroResolve(ctx.toCall === 0 ? { type: 'check' } : { type: 'fold' });
  else if (kind === 'call') S.heroResolve({ type: ctx.toCall === 0 ? 'check' : 'call' });
  else if (kind === 'raise') {
    if ($('btn-raise').classList.contains('hidden')) return;
    S.heroResolve({ type: 'raise', amount: +$('raise-amt').value });
  }
}

function computeHint(p, ctx, myRun) {
  const el = $('hint'); el.textContent = '';
  if (!S.hint) return;
  setTimeout(() => {
    if (myRun !== S.runId || !S.heroResolve) return;
    const t = S.game.table;
    if (Squeeze.active(t.handNo)) { el.textContent = '咪牌中…看完底牌再显示提示'; return; }
    const parts = [];
    if (t.street === 'preflop') {
      const cls = Preflop.classOf(p.hole[0], p.hole[1]);
      parts.push(`起手牌 ${cls.key}：约前 ${Math.max(1, Math.round(cls.topPct * 100))}%`);
      const acted = t.inHandPlayers().filter((q) => q !== p && t.hand.actions.some((a) => a.pid === q.id && (a.type === 'raise' || a.type === 'call')));
      if (acted.length) {
        const opps = acted.map((q) => AI.oppRange(t, q));
        const eq = Equity.equity(p.hole, [], opps, 1500);
        parts.push(`对已入池玩家的估计胜率 ${Math.round(eq * 100)}%`);
      }
    } else {
      const { eq, opps } = AI.heroHint(t, p);
      parts.push(`估计胜率 ${Math.round(eq * 100)}%（对 ${opps.length} 名对手的推测范围）`);
      parts.push(`当前牌力：${describeHand(evaluate(p.hole.concat(t.board)))}`);
    }
    if (ctx.toCall > 0) parts.push(`底池赔率需 ${Math.round(ctx.toCall / (ctx.pot + ctx.toCall) * 100)}%`);
    el.textContent = parts.join(' · ');
  }, 30);
}

/* ====================== 渲染 ====================== */
function scheduleRender() {
  if (S.renderQueued) return;
  S.renderQueued = true;
  requestAnimationFrame(() => { S.renderQueued = false; render(); });
}

function cardHTML(c, cls = '') {
  if (c == null) return `<div class="card slot ${cls}"></div>`;
  const sc = 'shdc'[c & 3];
  return `<div class="card suit-${sc} ${cls}"><span class="r">${RANK_LABELS[c >> 2]}</span><span class="s2">${SUIT_SYMBOLS[c & 3]}</span><span class="s">${SUIT_SYMBOLS[c & 3]}</span></div>`;
}
function cardsInline(cs, cls = 'xs') { return `<span class="cards-inline">${cs.map((c) => cardHTML(c, cls)).join('')}</span>`; }
function backHTML(cls = '') { return `<div class="card back ${cls}"></div>`; }

const HERO_AVATAR = { skin: '#eec29a', bg: '#7a5a12', hair: 'short', hairColor: '#1e1a18', clothes: 'hoodie', color: '#c49b2d', persona: 'hero' };
function heroAvatar(size) { return avatarSVG(HERO_AVATAR, size); }
function genericAvatar(p, size) {
  if (!p._gav) {
    const rng = mulberry32(p.id * 7919);
    const keys = Object.keys(PERSONAS);
    const k = keys[Math.floor(rng() * keys.length)];
    p._gav = genAvatar(k, rng() < PERSONAS[k].fem, 35, rng);
  }
  return avatarSVG(p._gav, size);
}

const COMPACT_MQ = window.matchMedia ? window.matchMedia('(max-width: 760px)') : null;
function seatGeom(i, n) {
  const ang = Math.PI / 2 + (i * 2 * Math.PI) / n;
  const c = Math.cos(ang), s = Math.sin(ang);
  if (COMPACT_MQ && COMPACT_MQ.matches) {
    // 手机竖屏：竖向椭圆，座位更靠边
    return { x: 50 + 36 * c, y: 50 + 37 * s, bx: 50 + 22 * c, by: 50 + 23 * s, dx: 50 + 27 * Math.cos(ang - 0.35), dy: 50 + 30 * Math.sin(ang - 0.35) };
  }
  return { x: 50 + 42 * c, y: 50 + 40 * s, bx: 50 + 27 * c, by: 50 + 24 * s, dx: 50 + 33 * Math.cos(ang - 0.3), dy: 50 + 31 * Math.sin(ang - 0.3) };
}
if (COMPACT_MQ && COMPACT_MQ.addEventListener) COMPACT_MQ.addEventListener('change', () => { if ($('game').classList.contains('hidden')) return; TableView.reset(true); rerenderTable(); });

function render() {
  if (!S.game) return;
  renderTopbar();
  renderTable();
  renderSide();
}

function renderTopbar() {
  const g = S.game, t = g.table, h = g.hero;
  const parts = [];
  if (S.career && Career.p) parts.push(`<span>资金 <b>$${fmt(Career.p.bankroll)}</b></span>`);
  if (g.mode === 'cash') {
    parts.push(`<span>${esc(g.cfg.title || '现金桌')} <b>${t.sb}/${t.bb}</b></span>`);
    parts.push(`<span>第 <b>${g.handsPlayed}</b> 手</span>`);
    if (h) {
      const net = h.stack + (S.handActive && h.inHand ? h.totalBet : 0) - h.invested;
      const bb100 = g.handsPlayed ? (net / t.bb / g.handsPlayed) * 100 : 0;
      parts.push(`<span>桌上 <b>${fmt(h.stack)}</b>（${(h.stack / t.bb).toFixed(0)}BB）</span>`);
      parts.push(`<span>本场 <b class="${net >= 0 ? 'pos' : 'neg'}">${net >= 0 ? '+' : ''}${fmt(net)}</b>（${(net / t.bb).toFixed(1)}BB）</span>`);
      parts.push(`<span><b class="${bb100 >= 0 ? 'pos' : 'neg'}">${bb100.toFixed(1)}</b> bb/100</span>`);
    }
    if (t.rakePct) parts.push(`<span>累计抽水 ${fmt(t.totalRake)}</span>`);
    $('btn-rebuy').classList.toggle('hidden', !h || h.stack >= g.startStack || (S.career && Career.p.bankroll < t.bb));
    $('btn-rebuy').textContent = S.pendingRebuy ? '下一手前补码 ✓' : '补码';
  } else {
    const [sb, bb, ante] = BLIND_LEVELS[g.level];
    parts.push(`<span>锦标赛 第 <b>${g.level + 1}</b> 级 <b>${sb}/${bb}</b>${ante ? ' 前注 ' + ante : ''}</span>`);
    parts.push(`<span>下一级还有 <b>${g.nextLevelIn()}</b> 手</span>`);
    parts.push(`<span>剩余 <b>${g.alive.length}</b>/${t.size}</span>`);
    if (h && h.stack > 0) {
      const icm = g.icmTable().find((r) => r.p === h);
      parts.push(`<span>筹码 <b>${fmt(h.stack)}</b>（${(h.stack / t.bb).toFixed(1)}BB）</span>`);
      if (icm) parts.push(`<span>ICM 价值 <b>${icm.eq.toFixed(1)}</b>（买入 ${g.buyin}）</span>`);
    }
    $('btn-rebuy').classList.add('hidden');
  }
  $('top-info').innerHTML = parts.join('');
}

/* 本机牌局 → 通用视图模型（TableView 与联机客户端共用渲染） */
function hostTableModel() {
  const g = S.game, t = g.table, n = t.size, hand = t.hand;
  const observer = !g.hero;
  const seats = t.seats.map((p, i) => {
    if (!p) return null;
    let hole = null;
    if (p.inHand && p.hole.length && (!p.folded || p.isHero)) {
      const show = p.isHero || p.shown || observer;
      hole = show ? p.hole.slice() : [-1, -1];
    }
    let tagHTML = '';
    if (p.isHero) {
      const mp = p.stats.mapPoint(n);
      tagHTML = mp ? `<span class="tag" style="background:#f5c54233;color:#f5c542">你的风格：${classifyStyle(mp.x, mp.y)}</span>` : '<span class="tag" style="color:#8b9bab">风格统计中…</span>';
    } else if (p.remote) {
      tagHTML = `<span class="tag" style="background:#8fc1ff22;color:#8fc1ff">真人玩家</span>`;
    } else if (S.reveal && p.style) {
      const col = styleColor(p.style.x, p.style.y);
      tagHTML = `<span class="tag" style="background:${col}33;color:${col}">${classifyStyle(p.style.x, p.style.y)}</span>`;
    } else {
      const mp = p.stats.mapPoint(n);
      tagHTML = mp && p.stats.hands >= 25 ? `<span class="tag" style="background:#ffffff14;color:#c9d4df">HUD：${classifyStyle(mp.x, mp.y)}?</span>` : '<span class="tag" style="background:#ffffff10;color:#8b9bab">风格未知</span>';
    }
    const st = p.stats;
    return {
      i, name: p.name, stack: p.stack, bet: p.bet, folded: p.folded, allIn: p.allIn, inHand: p.inHand,
      out: (g.mode === 'tournament' && p.stack === 0 && !p.inHand) || !!(p.place && p.stack === 0), place: p.place,
      la: p.lastAction, pos: hand && p.inHand ? t.positionOf(p).label : '', color: p.color,
      av: p.avatar || (p.isHero ? HERO_AVATAR : (genericAvatar(p, 1), p._gav)),
      me: p.isHero, win: !!(hand && hand.winnerIds.includes(p.id) && p.shown), hole, tagHTML,
      hudTxt: st.hands ? `VPIP ${fmtPct(st.vpipPct)} · PFR ${fmtPct(st.pfrPct)} · AF ${st.af == null ? '-' : st.af.toFixed(1)} · ${st.hands}手` : '暂无数据',
      extra: p.rec ? `<span class="posl" style="color:#b9c4cf">${PERSONAS[p.rec.persona].name}</span>` : '',
    };
  });
  const won = hand && hand.won ? [...hand.won].map(([p, a]) => [p.seat, a, hand.showdownVals && hand.showdownVals.get(p) != null ? describeHand(hand.showdownVals.get(p)) : '']) : null;
  const h = g.hero;
  const pot = hand && !hand.won ? t.pot() : 0;
  const spr = h && hand && !hand.won && h.inHand && !h.folded && t.street !== 'preflop' && pot > 0 ? h.stack / pot : null;
  return {
    key: 'local' + S.runId, size: n, rot: 0, seats, board: t.board, pot, potChips: hand && !hand.won ? t.potBeforeStreet() : 0,
    button: t.button, handNo: hand ? t.handNo : null, toAct: t.toAct ? t.toAct.seat : -1, won, myTurn: !!S.heroResolve, bb: t.bb, spr,
  };
}

function renderTable() {
  const g = S.game, t = g.table;
  TableView.render(hostTableModel());
  if (!S.heroResolve) {
    const ta = t.toAct;
    $('action-status').textContent = ta ? `${ta.name} 思考中…` : (!g.hero ? '观战模式' : '');
  }
}
function selectTab(name) {
  document.querySelectorAll('#side-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  for (const k of ['map', 'hud', 'log', 'tour']) $('tab-' + k).classList.toggle('hidden', k !== name);
  S.tab = name;
  renderSide();
}

function renderSide() {
  if (S.tab === 'map') renderGameMap();
  else if (S.tab === 'hud') renderHUD();
  else if (S.tab === 'tour') renderTour();
}

function renderGameMap() {
  const g = S.game, t = g.table, n = t.size;
  let s = mapBase(n);
  for (const p of t.players) {
    if (p.isHero) continue;
    const mp = p.stats.mapPoint(n);
    if (S.reveal && p.style) {
      const [tx, ty] = mapXY(p.style.x, p.style.y);
      if (mp) { const [mx, my] = mapXY(mp.x, mp.y); s += `<line x1="${tx}" y1="${ty}" x2="${mx}" y2="${my}" stroke="${p.color}" stroke-opacity=".5" stroke-dasharray="3 3"/>`; }
      s += `<circle cx="${tx}" cy="${ty}" r="8" fill="${p.color}" stroke="#111" stroke-width="1.5"/>`;
    }
    if (mp) {
      const [mx, my] = mapXY(mp.x, mp.y);
      s += `<circle cx="${mx}" cy="${my}" r="9" fill="none" stroke="${p.color}" stroke-width="2.5"/>`;
      s += `<text x="${mx + 12}" y="${my + 4}" fill="${p.color}" font-size="11.5">${esc(p.name)}</text>`;
    } else if (S.reveal && p.style) {
      const [tx, ty] = mapXY(p.style.x, p.style.y);
      s += `<text x="${tx + 11}" y="${ty + 4}" fill="${p.color}" font-size="11.5">${esc(p.name)}</text>`;
    }
  }
  const h = g.hero;
  if (h) {
    const mp = h.stats.mapPoint(n);
    if (mp) {
      const [x, y] = mapXY(mp.x, mp.y);
      const star = [];
      for (let k = 0; k < 10; k++) { const r = k % 2 ? 5 : 12; const a = -Math.PI / 2 + k * Math.PI / 5; star.push(`${x + r * Math.cos(a)},${y + r * Math.sin(a)}`); }
      s += `<polygon points="${star.join(' ')}" fill="#f5c542" stroke="#111"/>`;
      s += `<text x="${x + 14}" y="${y + 4}" fill="#f5c542" font-size="12" font-weight="700">你</text>`;
    }
  }
  $('game-map').innerHTML = s;
  $('map-legend').innerHTML =
    (S.reveal ? '● 实心点 = 对手真实风格（AI 参数）<br>' : '') +
    '○ 空心圈 = 根据 HUD 实际统计推算的位置（≥8 手后显示，样本越大越准）<br>' +
    '★ = 你自己的实际风格<br>' +
    '提示：先根据 HUD 判断对手类型，再打开「显示风格」核对自己读人是否准确。';
}

function renderHUD() {
  const g = S.game, t = g.table;
  const rows = t.players.slice().sort((a, b) => (b.isHero - a.isHero) || (a.seat - b.seat));
  let h = '<table class="data-table"><tr><th>玩家</th><th>手数</th><th>VPIP</th><th>PFR</th><th>3B</th><th>AF</th><th>CB</th><th>弃CB</th><th>WTSD</th><th>W$SD</th><th>盈亏BB</th></tr>';
  for (const p of rows) {
    const s = p.stats;
    const style = p.isHero ? '（你）' : (S.reveal && p.style ? `<br><small style="color:${styleColor(p.style.x, p.style.y)}">${classifyStyle(p.style.x, p.style.y)}</small>` : '');
    h += `<tr><td><span class="swatch" style="background:${p.color}"></span>${esc(p.name)}${style}</td><td>${s.hands}</td>` +
      `<td>${fmtPct(s.vpipPct)}</td><td>${fmtPct(s.pfrPct)}</td><td>${fmtPct(s.threeBetPct)}</td>` +
      `<td>${s.af == null ? '-' : s.af.toFixed(1)}</td><td>${fmtPct(s.cbetPct)}</td><td>${fmtPct(s.foldCbetPct)}</td>` +
      `<td>${fmtPct(s.wtsdPct)}</td><td>${fmtPct(s.wsdPct)}</td>` +
      `<td class="${s.netBB >= 0 ? 'pos' : 'neg'}">${s.netBB.toFixed(1)}</td></tr>`;
  }
  h += '</table>';
  h += `<div class="legend">VPIP 入池率 · PFR 翻前加注率 · 3B 3Bet 率 · AF 翻后攻击因子（下注+加注）/跟注 · CB 持续下注率 · 弃CB 面对持续下注弃牌率 · WTSD 看到翻牌后摊牌率 · W$SD 摊牌胜率<br>
  经验读法：VPIP 高 + AF 低 → 跟注站（多价值下注、少诈唬）；VPIP 低 + AF 高 → 紧凶（尊重其加注）；VPIP 高 + AF 高 → 松凶/疯子（放宽跟注范围、诱导诈唬）。</div>`;
  $('tab-hud').innerHTML = h;
}

function renderTour() {
  const g = S.game; if (g.mode !== 'tournament') return;
  const [sb, bb, ante] = BLIND_LEVELS[g.level];
  let h = '<div class="kv">';
  h += `<div>盲注级别</div><div>第 ${g.level + 1} 级 ${sb}/${bb}${ante ? ' 前注 ' + ante : ''}</div>`;
  const nx = BLIND_LEVELS[Math.min(g.level + 1, BLIND_LEVELS.length - 1)];
  h += `<div>下一级</div><div>${nx[0]}/${nx[1]}${nx[2] ? ' 前注 ' + nx[2] : ''}（${g.nextLevelIn()} 手后）</div>`;
  h += `<div>奖池</div><div>${fmt(g.prizePool)}：${g.payoutPct.map((x, i) => `第${i + 1}名 ${fmt(x * g.prizePool)}`).join('，')}</div>`;
  const d = g.alive.length - g.payoutPct.length;
  h += `<div>阶段</div><div>${d > 1 ? `距离奖励圈还差 ${d} 人` : d === 1 ? '<b style="color:#ef5350">泡沫期！</b>再淘汰 1 人进入奖励圈' : '已进入奖励圈'}</div>`;
  h += '</div>';
  const rows = g.icmTable().sort((a, b) => b.stack - a.stack);
  h += '<table class="data-table"><tr><th>玩家</th><th>筹码</th><th>BB</th><th>ICM 价值</th></tr>';
  for (const r of rows) {
    h += `<tr><td><span class="swatch" style="background:${r.p.color}"></span>${esc(r.p.name)}${r.p.isHero ? '（你）' : ''}</td><td>${fmt(r.stack)}</td><td>${(r.stack / bb).toFixed(1)}</td><td>${r.eq.toFixed(1)}</td></tr>`;
  }
  const outs = g.table.players.filter((p) => p.place).sort((a, b) => a.place - b.place);
  for (const p of outs) h += `<tr style="opacity:.5"><td>${esc(p.name)}${p.isHero ? '（你）' : ''}</td><td colspan="2">第 ${p.place} 名</td><td>${p.prize ? fmt(p.prize) : '-'}</td></tr>`;
  h += '</table><div class="legend">ICM 价值：按 Malmuth-Harville 模型把筹码换算成奖金期望。泡沫期筹码的“输”比“赢”更贵，所以跟注全下需要比底池赔率更高的胜率。</div>';
  $('tab-tour').innerHTML = h;
}

function addLog(msg, cls = '') {
  const box = $('log');
  const near = box.parentElement.scrollTop + box.parentElement.clientHeight >= box.parentElement.scrollHeight - 30;
  if (cls === 'hero' && msg.startsWith('你的底牌：') && UIPrefs.v.squeeze && S.game) {
    Squeeze.logLine = msg.replace('你的底牌：', '咪开底牌：');
    msg = msg.replace(/：\S+ [^（\s]+/, '：🂠 🂠');
  }
  const d = document.createElement('div');
  d.className = cls; d.textContent = msg;
  box.appendChild(d);
  while (box.childElementCount > 800) box.removeChild(box.firstChild);
  if (near) box.parentElement.scrollTop = box.parentElement.scrollHeight;
}

/* ====================== 弹窗 ====================== */
function showModal(html, buttons) {
  return new Promise((res) => {
    $('modal-content').innerHTML = html;
    $('modal-buttons').innerHTML = '';
    for (const b of buttons) {
      const el = document.createElement('button');
      el.textContent = b.label; if (b.primary) el.className = 'primary';
      el.addEventListener('click', () => { hideModal(); res(b.value); });
      $('modal-buttons').appendChild(el);
    }
    $('modal').classList.remove('hidden');
  });
}
function hideModal() { $('modal').classList.add('hidden'); }

async function showTourResult(myRun) {
  const g = S.game;
  const all = g.table.players.slice().sort((a, b) => a.place - b.place);
  let h = '<h3>锦标赛结束</h3><table class="data-table"><tr><th>名次</th><th>玩家</th><th>风格</th><th>奖金</th></tr>';
  for (const p of all) {
    const st = p.style ? classifyStyle(p.style.x, p.style.y) : '你';
    h += `<tr${p.isHero ? ' style="color:#f5c542"' : ''}><td>第 ${p.place} 名</td><td>${esc(p.name)}</td><td>${st}</td><td>${p.prize ? fmt(p.prize) : '-'}</td></tr>`;
  }
  h += '</table>';
  const c = await showModal(h, [{ label: '返回大厅', value: 'lobby' }, { label: '再来一局', value: 'again', primary: true }]);
  if (myRun !== S.runId) return;
  if (c === 'again' && !S.career) startGame(); else finishSession();
}

/* ====================== 校准测试 ====================== */
async function runCalibration() {
  const btn = $('calib-btn');
  btn.disabled = true;
  const out = $('calib-result');
  out.classList.remove('hidden');
  const cfg = buildConfig();
  cfg.mode = 'cash'; cfg.observer = true; cfg.dynamicPool = false; cfg.eqScale = 0.5;
  cfg.io = {};
  const g = new Game(cfg);
  const N = 1500;
  for (let i = 0; i < N; i++) {
    g.beforeHand();
    await g.table.playHand();
    g.afterHand(g.table.hand);
    if (i % 25 === 0) {
      out.innerHTML = `<h2>校准测试中… ${i}/${N} 手</h2>`;
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  out.innerHTML = calibrationReport(g, N);
  btn.disabled = false;
}

function calibrationReport(g, N) {
  const n = g.table.size;
  let h = `<h2>校准结果（${N} 手 AI 自对局，现金桌，${n} 人桌）</h2>`;
  h += '<p class="note">检查每个 AI 实际打出来的数据是否符合它在风格平面上的位置。0 号座位是替代你的紧凶 AI。</p>';
  h += '<table class="data-table"><tr><th>座位</th><th>设定风格</th><th>目标 VPIP</th><th>实际 VPIP</th><th>目标 PFR</th><th>实际 PFR</th><th>3B</th><th>AF</th><th>CB</th><th>弃CB</th><th>WTSD</th><th>实际判定</th><th>盈亏 bb/100</th></tr>';
  for (const p of g.table.players) {
    const s = p.stats, P = p.params, mp = s.mapPoint(n);
    h += `<tr><td><span class="swatch" style="background:${p.color}"></span>${p.seat} ${esc(p.name)}</td>` +
      `<td>${classifyStyle(p.style.x, p.style.y)} (${p.style.x.toFixed(2)}, ${p.style.y.toFixed(2)})</td>` +
      `<td>${fmtPct(P.vpip)}</td><td>${fmtPct(s.vpipPct)}</td><td>${fmtPct(P.pfr)}</td><td>${fmtPct(s.pfrPct)}</td>` +
      `<td>${fmtPct(s.threeBetPct)}</td><td>${s.af == null ? '-' : s.af.toFixed(2)}</td><td>${fmtPct(s.cbetPct)}</td><td>${fmtPct(s.foldCbetPct)}</td><td>${fmtPct(s.wtsdPct)}</td>` +
      `<td>${mp ? classifyStyle(mp.x, mp.y) : '-'}</td>` +
      `<td class="${s.netBB >= 0 ? 'pos' : 'neg'}">${(s.netBB / s.hands * 100).toFixed(1)}</td></tr>`;
  }
  h += '</table>';
  return h;
}

/* ====================== 事件绑定 ====================== */
function bindGameEvents() {
  $('btn-fold').addEventListener('click', () => heroDo('fold'));
  $('btn-call').addEventListener('click', () => heroDo('call'));
  $('btn-raise').addEventListener('click', () => heroDo('raise'));
  $('raise-slider').addEventListener('input', (e) => setRaise(+e.target.value));
  $('raise-amt').addEventListener('change', (e) => setRaise(+e.target.value));
  $('btn-next').addEventListener('click', () => { if (S.nextResolve) { const r = S.nextResolve; S.nextResolve = null; r(); } });
  $('btn-lobby').addEventListener('click', requestLeave);
  $('btn-mark').addEventListener('click', toggleMark);
  $('btn-pause').addEventListener('click', () => {
    S.paused = !S.paused;
    $('btn-pause').textContent = S.paused ? '继续' : '暂停';
    if (!S.paused && S.pauseResolve) { const r = S.pauseResolve; S.pauseResolve = null; r(); }
    if (S.paused) addLog('（将在本手结束后暂停）', 'sys');
  });
  $('btn-rebuy').addEventListener('click', () => { S.pendingRebuy = true; renderTopbar(); });
  $('tg-reveal').addEventListener('change', (e) => { S.reveal = e.target.checked; render(); });
  $('tg-hint').addEventListener('change', (e) => { S.hint = e.target.checked; if (!S.hint) $('hint').textContent = ''; });
  $('tg-auto').addEventListener('change', (e) => { S.auto = e.target.checked; });
  $('tg-speed').addEventListener('change', (e) => { S.speed = e.target.value; });
  document.querySelectorAll('#side-tabs button').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));
  document.addEventListener('keydown', (e) => {
    if ($('game').classList.contains('hidden')) return;
    if (e.target.tagName === 'INPUT' && e.target.type === 'number') return;
    const k = e.key.toLowerCase();
    if (S.heroResolve) {
      if (k === 'm') toggleMark();
      else if (k === 'f') heroDo('fold');
      else if (k === 'c') heroDo('call');
      else if (k === 'r') heroDo('raise');
    } else if (k === ' ' && S.nextResolve) {
      e.preventDefault(); $('btn-next').click();
    }
  });
}

window.addEventListener('DOMContentLoaded', () => {
  // 通过 http(s) 打开时注册离线缓存（iOS「添加到主屏幕」后可离线玩）
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && !location.hash.startsWith('#smoke')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* ignore */ });
  }
  setTimeout(() => {
    Preflop.init();
    $('loading').classList.add('hidden');
    $('lobby').classList.remove('hidden');
    initLobby();
    bindGameEvents();
    Lobby.init();
    if (location.hash.startsWith('#smoke-lan')) lanSmoke(location.hash.slice(7));
    else if (location.hash.startsWith('#smoke')) smokeTest(location.hash.slice(7) || 'cash');
    else if (location.hash.startsWith('#lobby-')) Lobby.show(location.hash.slice(7));
  }, 30);
});


/* 自动冒烟测试：index.html#smoke-cash | #smoke-tournament | #smoke-career | #smoke-ctour */
function smokeTest(mode) {
  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.message + ' @' + e.filename + ':' + e.lineno));
  window.addEventListener('unhandledrejection', (e) => errors.push('rejection: ' + (e.reason && e.reason.stack)));
  const out = (txt) => { const pre = document.createElement('pre'); pre.id = 'out'; pre.textContent = txt + '\nERRORS: ' + (errors.length ? errors.join('\n') : 'none'); document.body.appendChild(pre); };
  $('opt-speed').value = 'fast'; $('opt-hint').checked = true; $('opt-reveal').checked = true;
  // #smoke-cash-fx：开启咪牌/动画/BB 显示，并模拟点击咪牌
  const fxMode = mode.endsWith('-fx');
  if (fxMode) { mode = mode.slice(0, -3); UIPrefs.v = Object.assign({}, UI_DEFAULTS, { squeeze: true, anim: true, bbUnit: true }); UIPrefs.apply(); }
  let sqzClicks = 0, fxSeen = { fly: 0, banner: 0, toast: 0, flip: 0, deal: 0 };
  if (fxMode) {
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.classList) {
      if (n.classList.contains('fly')) fxSeen.fly++; if (n.classList.contains('win-banner')) fxSeen.banner++; if (n.classList.contains('turn-toast')) fxSeen.toast++;
    } }).observe($('fx'), { childList: true });
    setInterval(() => {
      const c = document.querySelector('.sqz-card:not(.open)');
      if (c && !Squeeze.drag) {
        sqzClicks++;
        c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7, clientY: 100 }));
        document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, clientY: 100 }));
      }
      fxSeen.flip += document.querySelectorAll('#board .card.flip').length ? 1 : 0;
      fxSeen.deal += document.querySelectorAll('.hole.deal').length ? 1 : 0;
    }, 120);
  }
  const career = mode === 'career' || mode === 'ctour';
  let bank0 = 0;
  if (career) {
    Career.reset(); Career.create('测试员', 5000); bank0 = 5000;
    if (mode === 'career') Lobby.sitCash(CASH_STAKES[2]); else Lobby.joinTour(TOURS[1]);
    setTimeout(() => $('modal-buttons').lastChild.click(), 50);
  } else {
    S.mode = mode; updateModeUI(); startGame();
  }
  S.speed = 'fast';
  let acted = 0, marked = 0, finished = false;
  const iv = setInterval(() => {
    if (finished) return;
    if (!S.game) return;
    S.speed = 'fast';
    if (S.heroResolve && $('hint').textContent) {
      acted++;
      if (acted % 4 === 0 && S.handActive && !S.game.table.hand.marked) { toggleMark(); marked++; }
      const k = acted % 7 === 0 ? 'raise' : acted % 5 === 0 ? 'fold' : 'call';
      heroDo(k);
    }
    if (!$('modal').classList.contains('hidden')) $('modal-buttons').lastChild.click();
    const done = S.game.handsPlayed >= 30 || S.game.finished || $('game').classList.contains('hidden');
    if (!done) return;
    finished = true;
    clearInterval(iv);
    for (const tab of ['hud', 'tour', 'log', 'map']) selectTab(tab);
    const info = (fxMode ? `FX: squeezeClicks=${sqzClicks} ${JSON.stringify(fxSeen)} chips=${document.querySelectorAll('.ccol').length}\n` : '') + `mode=${mode} hands=${S.game.handsPlayed} heroActions=${acted} marked=${marked} seats=${document.querySelectorAll('.seat').length} avatars=${document.querySelectorAll('.seat .avatar').length}\nTOP: ${$('top-info').textContent}`;
    if (!career) { out(info); S.runId++; return; }
    const heroStack = S.game.hero ? S.game.hero.stack : 0;
    if (!$('game').classList.contains('hidden')) finishSession();
    setTimeout(() => {
      const p = Career.p;
      let txt = info + `\nCAREER: bankroll=${p.bankroll} start=${bank0} heroStackAtLeave=${heroStack} activeSeat=${JSON.stringify(p.activeSeat)} activeTour=${JSON.stringify(p.activeTour)} history=${JSON.stringify(p.history.slice(0, 2))}`;
      const hands = HandStore.list();
      txt += `\nMARKED STORED: ${hands.length}, decisions in first: ${hands[0] ? hands[0].decisions.length : 0}`;
      // 复盘：逐个决策点自动作答
      const withDec = hands.find((h) => h.decisions.length >= 2) || hands[0];
      if (withDec) {
        Review.open(withDec.id);
        let steps = 0;
        const rv = setInterval(() => {
          steps++;
          if (Review.done() || steps > 60) {
            clearInterval(rv);
            txt += `\nREVIEW: steps=${steps} summary=${withDec && HandStore.get(withDec.id).review ? HandStore.get(withDec.id).review.summary : 'none'} rightText=${$('review-right').textContent.slice(0, 160)}`;
            Lobby.show('db'); Lobby.show('career'); Lobby.show('review');
            out(txt);
            return;
          }
          if (Review.phase === 'ask') {
            const b = document.querySelector('#review-right [data-k]'); if (b) b.click();
            const s = $('rv-submit'); if (s && !s.disabled) s.click();
          } else {
            const n = $('rv-next'); if (n) n.click();
          }
        }, 150);
      } else out(txt);
    }, 300);
  }, 40);
}
