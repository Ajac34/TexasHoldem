'use strict';
/* 局域网联机：牌局逻辑运行在房主的浏览器里，tools/serve.ps1 只做消息中转。
 * 客户端（其他手机）发送 join / act / leave，房主为每位玩家单独生成视图（只含自己的底牌）推送过去。 */

const NET_ACTION_TIMEOUT = 45000;   // 真人玩家行动限时
const NET_AWAY_MS = 12000;          // 超过这么久没有轮询 → 视为掉线，轮到时自动过牌/弃牌
const NET_DROP_MS = 90000;          // 现金桌掉线超过这么久 → 让出座位给 AI

function asciiJSON(o) {
  return JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
function netCleanName(s) { return String(s || '').replace(/[<>&"]/g, '').trim().slice(0, 10) || '玩家'; }

class NetLink {
  constructor(id, onMsg, onEpoch) {
    this.id = id; this.onMsg = onMsg; this.onEpoch = onEpoch;
    this.since = 0; this.epoch = null; this.peers = {}; this.alive = true; this.failures = 0; this.interval = 400; this.timer = null;
    this.room = 'lan'; this.key = ''; this.onGone = null;   // 房间号 / 房主密钥（在线服务器多房间；局域网服务器忽略）
  }
  qs() { return `&room=${encodeURIComponent(this.room)}${this.key ? '&key=' + encodeURIComponent(this.key) : ''}`;
  }
  async send(to, kind, data) {
    try {
      const r = await fetch(`/api/send?from=${this.id}&to=${encodeURIComponent(to)}&kind=${kind}${this.qs()}`,
        { method: 'POST', body: asciiJSON(data), headers: { 'Content-Type': 'text/plain' } });
      return r.ok;
    } catch (e) { return false; }
  }
  start() {
    const loop = async () => {
      if (!this.alive) return;
      await this.pollOnce();
      if (this.alive) this.timer = setTimeout(loop, this.interval);
    };
    loop();
  }
  async pollOnce() {
    try {
      const r = await fetch(`/api/poll?id=${this.id}&since=${this.since}&epoch=${this.epoch == null ? '' : this.epoch}${this.qs()}`, { cache: 'no-store' });
      if (r.status === 404 && this.onGone) { this.onGone(); return; }
      const j = await r.json();
      this.failures = 0;
      const changed = this.epoch != null && j.epoch !== this.epoch;
      this.epoch = j.epoch; this.peers = j.peers || {};
      if (changed) { this.since = 0; if (this.onEpoch) this.onEpoch(); }
      for (const m of j.msgs) {
        this.since = Math.max(this.since, m.seq);
        try { this.onMsg(m); } catch (e) { console.error(e); }
      }
    } catch (e) { this.failures++; }
  }
  stop() { this.alive = false; clearTimeout(this.timer); }
}

/* ============================ 房主 ============================ */
const NetHost = {
  active: false, phase: 'off', link: null, clients: {}, room: null,
  logBuf: [], pendingTurn: null, turnSeq: 0, dirtyTimer: null, beatTimer: null, myRun: 0,

  async create(room) {
    let j, code = 'lan', key = '';
    if (Backend.online) {
      // 在线服务器：分配 4 位房间号 + 房主密钥
      j = await Backend.api('POST', '/api/rooms', { desc: room.desc, hostName: room.hostName, mode: room.mode, size: room.size, level: room.level });
      code = j.room; key = j.key;
    } else {
      const r = await fetch('/api/reset', { method: 'POST', body: '' });
      j = await r.json();
    }
    this.stopLink();
    room.code = code;
    this.room = room; this.clients = {}; this.logBuf = []; this.pendingTurn = null;
    this.link = new NetLink('host', (m) => this.onMsg(m));
    this.link.room = code; this.link.key = key;
    this.link.epoch = j.epoch; this.link.interval = 250;
    this.link.start();
    this.active = true; this.phase = 'lobby';
    this.beatTimer = setInterval(() => this.heartbeat(), 1000);
  },

  heartbeat() {
    if (!this.active) return;
    if (this.phase === 'lobby') { if (Lobby.tab === 'lan' && !$('lobby').classList.contains('hidden')) NetUI.render(); }
    this.beat = (this.beat || 0) + 1;
    if (this.beat % 3 === 0) this.sendStates();
  },

  onMsg(m) {
    const cid = m.from, d = m.data || {};
    let c = this.clients[cid];
    if (m.kind === 'join') {
      if (!c) c = this.clients[cid] = { cid, joinedAt: Date.now() };
      let name = netCleanName(d.name);
      const taken = new Set(Object.values(this.clients).filter((x) => x !== c && !x.left).map((x) => x.name));
      if (S.game) for (const p of S.game.table.players) if (!(p.remote && p.cid === cid)) taken.add(p.name);
      if (this.room && this.room.hostPlays) taken.add(this.room.hostName);
      let k = 2; const base = name; while (taken.has(name)) name = base + (k++);
      if (!c.player) c.name = name;
      c.avatar = d.avatar || null; c.left = false;
      if (c.player) c.player.leaving = false;
      this.hostLog(`${c.name} ${c.player ? '重新连接' : '进入了房间'}`);
      this.dirty();
    } else if (!c) {
      return;
    } else if (m.kind === 'leave') {
      c.left = true;
      if (c.player) c.player.leaving = true;
      this.hostLog(`${c.name} 离开了房间`);
      if (this.pendingTurn && this.pendingTurn.cid === cid) this.pendingTurn.auto();
      this.dirty();
    } else if (m.kind === 'act') {
      const pt = this.pendingTurn;
      if (pt && pt.cid === cid && d.turn === pt.id) pt.resolve(d);
    } else if (m.kind === 'hello') {
      this.dirty();
    }
  },

  hostLog(msg) {
    if (this.phase === 'playing' && S.game) addLog(msg, 'sys');
    this.logBuf.push([msg, 'sys']);
  },

  awayMs(cid) { const a = this.link && this.link.peers[cid]; return a == null ? 1e9 : a; },
  isAway(p) { const c = this.clients[p.cid]; return !c || c.left || this.awayMs(p.cid) > NET_AWAY_MS; },

  /* startGame 调用：在 new Game 之前挂到 io 上 */
  attach(io, myRun) {
    const up = io.update, lg = io.log;
    io.update = () => { up(); this.dirty(); };
    io.log = (msg, cls) => { lg(msg, cls); this.onLog(msg, cls); };
    io.remoteAction = (p, ctx) => this.remoteAction(p, ctx, myRun);
    this.myRun = myRun; this.phase = 'playing';
  },

  onLog(msg, cls) {
    if (/^你/.test(msg)) return;                 // 房主自己的私有信息（底牌等）
    this.logBuf.push([msg.replace('(你)', ''), cls === 'hero' ? '' : (cls || '')]);
    if (this.logBuf.length > 300) this.logBuf.splice(0, 100);
  },

  seatClient(g, i, c) {
    const t = g.table, old = t.seats[i];
    const p = createPlayer({ name: c.name, stack: g.startStack, avatar: c.avatar });
    p.remote = true; p.cid = c.cid; p.seat = i; p.color = old ? old.color : SEAT_COLORS[i % SEAT_COLORS.length]; p.invested = p.stack;
    t.seats[i] = p; c.player = p;
    if (old) g.syncRec(old);
    g.log(`${c.name}（真人）入座${old ? '，' + old.name + ' 离开' : ''}`);
  },

  freeAISeat(g) {
    const t = g.table;
    for (let i = 1; i < t.size; i++) { const p = t.seats[i]; if (p && !p.isHero && !p.remote) return i; }
    const p0 = t.seats[0];
    if (p0 && !p0.isHero && !p0.remote) return 0;
    return -1;
  },

  /* 开局时让所有在房间里的玩家入座 */
  seatAll(g) {
    for (const c of Object.values(this.clients)) {
      if (c.left || c.player) continue;
      const i = this.freeAISeat(g);
      if (i < 0) break;
      this.seatClient(g, i, c);
    }
  },

  /* 每手开始前：现金桌处理离开/掉线/补码/新入座 */
  beforeHand(g) {
    const t = g.table;
    for (let i = 0; i < t.size; i++) {
      const p = t.seats[i];
      if (!p || !p.remote) continue;
      const c = this.clients[p.cid];
      if (g.mode === 'cash') {
        if (!c || c.left || this.awayMs(p.cid) > NET_DROP_MS) {
          g.replacePlayer(i, c && c.left ? '离开了牌桌' : '掉线，让出座位');
          if (c) c.player = null;
          continue;
        }
        if (p.stack === 0) {
          p.stack = g.startStack; p.invested += g.startStack; p.buyIns++;
          g.log(`${p.name} 补码 ${g.startStack}`);
        }
      }
    }
    if (g.mode === 'cash') {
      for (const c of Object.values(this.clients)) {
        if (c.left || c.player || this.awayMs(c.cid) > NET_AWAY_MS) continue;
        const i = this.freeAISeat(g);
        if (i < 0) break;
        this.seatClient(g, i, c);
      }
    }
  },

  remoteAction(p, ctx, myRun) {
    return new Promise((res) => {
      const pt = { id: ++this.turnSeq, cid: p.cid, p, ctx, deadline: Date.now() + NET_ACTION_TIMEOUT };
      const finish = (a) => {
        if (this.pendingTurn !== pt) return;
        clearTimeout(pt.timer); clearInterval(pt.watch);
        this.pendingTurn = null;
        res(a);
        this.dirty();
      };
      pt.auto = () => finish(ctx.toCall > 0 ? { type: 'fold' } : { type: 'check' });
      pt.resolve = (d) => {
        const type = ['fold', 'check', 'call', 'raise'].includes(d.type) ? d.type : 'fold';
        finish(type === 'raise' ? { type, amount: Math.round(+d.amount || 0) } : { type });
      };
      this.pendingTurn = pt;
      pt.timer = setTimeout(() => { addLog(`${p.name} 超时，自动${ctx.toCall > 0 ? '弃牌' : '过牌'}`, 'sys'); pt.auto(); }, NET_ACTION_TIMEOUT);
      pt.watch = setInterval(() => {
        if (myRun !== S.runId) finish({ type: 'fold' });
        else if (this.isAway(p) || p.leaving) pt.auto();
      }, 700);
      if (this.isAway(p) || p.leaving) setTimeout(pt.auto, 300);
      this.sendStates();
    });
  },

  dirty() {
    if (this.dirtyTimer || !this.active) return;
    this.dirtyTimer = setTimeout(() => { this.dirtyTimer = null; this.sendStates(); }, 120);
  },

  sendStates() {
    if (!this.active || !this.link) return;
    for (const c of Object.values(this.clients)) {
      if (c.left) continue;
      this.link.send(c.cid, 'state', this.buildView(c));
    }
  },

  buildView(c) {
    const base = { phase: this.phase, host: this.room ? this.room.hostName : '房主', room: this.room ? this.room.desc : '', you: c.name };
    if (this.phase === 'closed') return base;
    if (this.phase === 'lobby' || !S.game) {
      base.phase = 'lobby';
      base.players = Object.values(this.clients).filter((x) => !x.left).map((x) => ({ name: x.name, av: x.avatar, me: x === c }));
      return base;
    }
    const g = S.game, t = g.table, hand = t.hand;
    const me = c.player && t.seats.includes(c.player) ? c.player : null;
    const seats = t.seats.map((p, i) => {
      if (!p) return null;
      let hole = null;
      if (p.inHand && p.hole.length && (!p.folded || p === me)) hole = p === me || p.shown ? p.hole.slice() : [-1, -1];
      const s = p.stats;
      return {
        i, name: p.name, stack: p.stack, bet: p.bet, folded: p.folded, allIn: p.allIn, inHand: p.inHand, la: p.lastAction,
        pos: hand && p.inHand ? t.positionOf(p).label : '', color: p.color,
        av: p.avatar || (p.isHero ? HERO_AVATAR : (genericAvatar(p, 1), p._gav)),
        tag: p === me ? '你' : p.remote ? '真人' : p.isHero ? '房主' : (p.rec ? PERSONAS[p.rec.persona].name : ''),
        human: !!(p.remote || p.isHero), me: p === me, hole,
        win: !!(hand && hand.winnerIds.includes(p.id) && p.shown),
        out: g.mode === 'tournament' && p.stack === 0 && !p.inHand, place: p.place, away: !!(p.remote && this.isAway(p)),
        hud: s.hands ? { v: s.vpipPct, p: s.pfrPct, af: s.af, h: s.hands } : null,
      };
    });
    const v = Object.assign(base, {
      mode: g.mode, title: g.cfg.title || '', sb: t.sb, bb: t.bb, ante: t.ante, handNo: t.handNo, street: t.street,
      board: t.board.slice(), pot: hand && !hand.won ? t.pot() : 0, potC: hand && !hand.won ? t.potBeforeStreet() : 0, button: t.button, size: t.size,
      won: hand && hand.won ? [...hand.won].map(([p, a]) => [p.seat, a, hand.showdownVals && hand.showdownVals.get(p) != null ? describeHand(hand.showdownVals.get(p)) : '']) : null,
      taRem: this.pendingTurn && t.toAct && this.pendingTurn.p === t.toAct ? Math.max(0, this.pendingTurn.deadline - Date.now()) : null,
      toAct: t.toAct ? t.toAct.seat : -1, seats, mySeat: me ? me.seat : -1,
      me: me ? { stack: me.stack, invested: me.invested, buyIns: me.buyIns, place: me.place, prize: me.prize || 0 } : null,
      log: this.logBuf.slice(-40), startStack: g.startStack,
    });
    if (g.mode === 'tournament') {
      v.tour = { level: g.level + 1, nextIn: g.nextLevelIn(), alive: g.alive.length, finished: !!g.finished, prizePool: g.prizePool, payouts: g.payoutPct };
    }
    const pt = this.pendingTurn;
    if (pt && pt.cid === c.cid && me) {
      const ctx = pt.ctx;
      v.turn = {
        id: pt.id, toCall: ctx.toCall, minRaiseTo: ctx.minRaiseTo, maxTo: ctx.maxTo, pot: ctx.pot, currentBet: ctx.currentBet,
        canRaise: ctx.canRaise && me.stack > ctx.toCall, remaining: Math.max(0, pt.deadline - Date.now()),
        presets: ctx.canRaise ? presetAmounts(t, ctx) : [], pos: t.positionOf(me).label, chip: t.chipUnit,
      };
    }
    return v;
  },

  stopLink() {
    if (this.link) this.link.stop();
    this.link = null;
    clearInterval(this.beatTimer); clearTimeout(this.dirtyTimer); this.dirtyTimer = null;
  },

  /* 房主离开牌桌 / 解散房间 */
  stop() {
    if (!this.active) return;
    this.phase = 'closed';
    const link = this.link;
    if (link) for (const c of Object.values(this.clients)) link.send(c.cid, 'state', { phase: 'closed' });
    if (this.pendingTurn) this.pendingTurn.auto();
    this.active = false;
    clearInterval(this.beatTimer); clearTimeout(this.dirtyTimer); this.dirtyTimer = null;
    setTimeout(() => { if (link) link.stop(); }, 1500);
    this.link = null;
    this.phase = 'off';
    if (S.net === 'host') S.net = null;
  },

  startGame() {
    const r = this.room;
    const stake = CASH_STAKES[r.level - 1];
    const lineup = PlayerDB.pick(r.level, r.size - 1, new Set(), Math.random);
    const cfg = {
      mode: r.mode, size: r.size, observer: !r.hostPlays, pool: 'mixed', dynamicPool: true,
      level: r.level, lineup,
      title: r.desc, hero: { name: r.hostName },
      cash: { sb: stake.sb, bb: stake.bb, buyinBB: 100, rakePct: stake.rakePct, rakeCapBB: stake.rakeCapBB },
      tour: { startStack: 1500, handsPerLevel: r.handsPerLevel, buyin: 100 },
      net: 'host',
    };
    if (Backend.online && this.link) fetch(`/api/rooms/meta?${this.link.qs().slice(1)}`, { method: 'POST', body: JSON.stringify({ phase: 'playing' }) }).catch(() => {});
    startGame(cfg);
  },
};

/* ============================ 客户端 ============================ */
const NetClient = {
  active: false, link: null, view: null, name: '', avatar: null, turnShown: 0, sentTurn: 0, cdTimer: null, joinTimer: null, lastStateAt: 0,

  cid() {
    let id = null;
    try { id = sessionStorage.getItem('thsim_cid'); } catch (e) { /* ignore */ }
    if (!id) {
      id = 'c' + Math.random().toString(36).slice(2, 10);
      try { sessionStorage.setItem('thsim_cid', id); } catch (e) { /* ignore */ }
    }
    return id;
  },

  join(name, avatar, code) {
    this.leaveQuiet();
    this.name = name; this.avatar = avatar; this.view = null; this.active = true; this.lastStateAt = 0;
    this.link = new NetLink(this.cid(), (m) => this.onMsg(m), () => this.sendJoin());
    this.link.room = code || 'lan';
    this.link.onGone = () => {
      if (!this.active) return;
      this.leaveQuiet();
      if (!$('game').classList.contains('hidden')) this.exitGameUI();
      showModal(`<h3>房间不存在或已关闭</h3><p>房间号 ${esc(code || '')} 无效，或者房主已经离开。</p>`, [{ label: '好的', value: 'ok', primary: true }]);
      NetUI.render();
    };
    this.link.interval = 350;
    this.sendJoin();
    this.link.start();
    // 房主还没建房 / 消息丢失时，定期重发
    this.joinTimer = setInterval(() => {
      if (!this.active) return;
      if (!this.view || Date.now() - this.lastStateAt > 8000) this.sendJoin();
    }, 3000);
    NetUI.render();
  },

  sendJoin() { if (this.link) this.link.send('host', 'join', { name: this.name, avatar: this.avatar }); },

  onMsg(m) {
    if (m.kind !== 'state' || !this.active) return;
    this.view = m.data; this.lastStateAt = Date.now();
    const v = this.view;
    if (v.phase === 'closed') {
      this.leaveQuiet();
      if (!$('game').classList.contains('hidden')) this.exitGameUI();
      showModal('<h3>房间已关闭</h3><p>房主解散了房间或离开了牌桌。</p>', [{ label: '好的', value: 'ok', primary: true }]);
      NetUI.render();
      return;
    }
    if (v.phase === 'lobby') { if (!$('game').classList.contains('hidden')) this.exitGameUI(); NetUI.render(); return; }
    if ($('game').classList.contains('hidden')) this.enterGameUI();
    this.render();
  },

  enterGameUI() {
    S.runId++; S.game = null; S.net = 'client';
    $('lobby').classList.add('hidden'); $('review').classList.add('hidden');
    $('game').classList.remove('hidden'); $('game').classList.add('net-client');
    for (const k of ['map', 'hud', 'tour']) $('tab-' + k).classList.add('hidden');
    $('tab-log').classList.remove('hidden');
    $('log').innerHTML = '';
    $('btn-lobby').textContent = '离开房间';
    $('next-controls').classList.add('hidden');
    $('action-controls').classList.add('hidden');
    $('hint').textContent = '';
    TableView.reset();
    this.turnShown = 0;
  },

  exitGameUI() {
    $('game').classList.remove('net-client');
    S.heroResolve = null; S.net = null;
    clearInterval(this.cdTimer);
    gotoLobby();
    Lobby.show('lan');
  },

  leave() {
    if (this.link) this.link.send('host', 'leave', {});
    this.leaveQuiet();
    this.exitGameUI();
  },

  leaveQuiet() {
    this.active = false;
    clearInterval(this.joinTimer); clearInterval(this.cdTimer);
    if (this.link) { const l = this.link; setTimeout(() => l.stop(), 800); }
    this.link = null;
  },

  render() {
    const v = this.view; if (!v || v.phase !== 'playing') return;
    const myTurn = !!(v.turn && v.turn.id !== this.sentTurn);
    const meS = v.mySeat >= 0 ? v.seats[v.mySeat] : null;
    const seats = v.seats.map((s) => {
      if (!s) return null;
      const tagCol = s.me ? '#f5c542' : s.human ? '#8fc1ff' : '#b9c4cf';
      return Object.assign({}, s, {
        out: !!(s.out || (s.place && s.stack === 0)),
        av: s.av || (() => { const o = { id: s.i + 1 }; genericAvatar(o, 1); return o._gav; })(),
        tagHTML: s.tag ? `<span class="tag" style="background:${tagCol}22;color:${tagCol}">${esc(s.tag)}${s.away ? ' · 掉线' : ''}</span>` : '',
        hudTxt: s.hud ? `VPIP ${fmtPct(s.hud.v)} · PFR ${fmtPct(s.hud.p)} · ${s.hud.h}手` : '暂无数据',
        timer: v.toAct === s.i && v.taRem != null ? { rem: v.taRem - (Date.now() - this.lastStateAt), total: NET_ACTION_TIMEOUT } : null,
      });
    });
    const spr = meS && meS.inHand && !meS.folded && v.board.length >= 3 && v.pot > 0 ? meS.stack / v.pot : null;
    TableView.render({
      key: 'net', size: v.size, rot: v.mySeat >= 0 ? v.mySeat : 0, seats, board: v.board, pot: v.pot, potChips: v.potC || 0,
      button: v.button, handNo: v.handNo, toAct: v.toAct, won: v.won, myTurn, bb: v.bb, spr,
    });
    // 顶栏
    const parts = [`<span>房间 <b>${esc(v.host)}</b></span>`];
    if (v.mode === 'cash') {
      parts.push(`<span>${esc(v.title)} <b>${v.sb}/${v.bb}</b></span>`, `<span>第 <b>${v.handNo}</b> 手</span>`);
      if (v.me) {
        const net = v.me.stack - v.me.invested;
        parts.push(`<span>筹码 <b>${fmt(v.me.stack)}</b></span>`, `<span>盈亏 <b class="${net >= 0 ? 'pos' : 'neg'}">${net >= 0 ? '+' : ''}${fmt(net)}</b>（${(net / v.bb).toFixed(1)}BB）</span>`);
      }
    } else if (v.tour) {
      parts.push(`<span>锦标赛 第 <b>${v.tour.level}</b> 级 <b>${v.sb}/${v.bb}</b>${v.ante ? ' 前注 ' + v.ante : ''}</span>`, `<span>剩余 <b>${v.tour.alive}</b>/${v.size}</span>`);
      if (v.me) parts.push(v.me.place ? `<span>名次 <b>第 ${v.me.place} 名</b></span>` : `<span>筹码 <b>${fmt(v.me.stack)}</b>（${(v.me.stack / v.bb).toFixed(1)}BB）</span>`);
    }
    if (!v.me) parts.push('<span class="note">旁观中（现金桌会在下一手自动入座）</span>');
    $('top-info').innerHTML = parts.join('');

    // 日志
    $('log').innerHTML = v.log.map(([m, c]) => `<div class="${c}">${esc(m)}</div>`).join('');
    const tb = $('tab-log'); tb.scrollTop = tb.scrollHeight;

    // 牌力提示（客户端本地计算）
    const meSeat = v.mySeat >= 0 ? v.seats[v.mySeat] : null;
    let hint = '';
    if (meSeat && meSeat.hole && meSeat.hole[0] >= 0 && Squeeze.active(v.handNo)) hint = '咪牌中…';
    else if (meSeat && meSeat.hole && meSeat.hole[0] >= 0 && !meSeat.folded) {
      if (v.board.length >= 3) hint = `当前牌力：${describeHand(evaluate(meSeat.hole.concat(v.board)))}`;
      else { const cl = Preflop.classOf(meSeat.hole[0], meSeat.hole[1]); hint = `起手牌 ${cl.key}：约前 ${Math.max(1, Math.round(cl.topPct * 100))}%`; }
      if (v.turn && v.turn.toCall > 0) hint += ` · 底池赔率需 ${Math.round(v.turn.toCall / (v.turn.pot + v.turn.toCall) * 100)}%`;
    }
    $('hint').textContent = hint;

    // 行动
    if (v.turn && v.turn.id !== this.sentTurn) {
      if (this.turnShown !== v.turn.id) this.showControls(v);
    } else {
      $('action-controls').classList.add('hidden');
      S.heroResolve = null;
      clearInterval(this.cdTimer); this.cdTimer = null;
      const ta = v.toAct >= 0 && v.seats[v.toAct];
      $('action-status').textContent = ta ? `${ta.name} 思考中…` : (v.me ? '' : '旁观中');
    }
  },

  showControls(v) {
    const tn = v.turn, me = v.seats[v.mySeat];
    this.turnShown = tn.id;
    S.heroCtx = { toCall: tn.toCall, minRaiseTo: tn.minRaiseTo, maxTo: tn.maxTo, canRaise: tn.canRaise, pot: tn.pot, currentBet: tn.currentBet };
    S.heroResolve = (a) => {
      S.heroResolve = null;
      this.sentTurn = tn.id;
      $('action-controls').classList.add('hidden');
      clearInterval(this.cdTimer); this.cdTimer = null;
      $('action-status').textContent = '已发送…';
      if (this.link) this.link.send('host', 'act', Object.assign({ turn: tn.id }, a));
    };
    $('action-controls').classList.remove('hidden');
    $('btn-fold').classList.toggle('hidden', tn.toCall === 0);
    $('btn-call').innerHTML = (tn.toCall === 0 ? '过牌' : `跟注 ${fmt(tn.toCall)}${tn.toCall >= me.stack ? '（全下）' : ''}`) + ' <kbd>C</kbd>';
    $('btn-raise').classList.toggle('hidden', !tn.canRaise);
    document.querySelector('.raise-row').classList.toggle('hidden', !tn.canRaise);
    $('presets').classList.toggle('hidden', !tn.canRaise);
    if (tn.canRaise) {
      const sl = $('raise-slider'), num = $('raise-amt');
      sl.min = num.min = tn.minRaiseTo; sl.max = num.max = tn.maxTo; sl.step = num.step = tn.chip;
      const def = tn.presets.length > 2 ? tn.presets[v.board.length ? 2 : 1][1] : tn.minRaiseTo;
      setRaise(def);
      $('presets').innerHTML = tn.presets.map(([l, val]) => `<button data-v="${val}">${l}</button>`).join('');
      $('presets').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setRaise(+b.dataset.v)));
    }
    const deadline = Date.now() + tn.remaining;
    const upd = () => {
      const sec = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      $('action-status').innerHTML = `轮到你行动（${tn.pos}）· 底池 <b>${fmt(tn.pot)}</b>` +
        (tn.toCall > 0 ? ` · 需跟注 <b>${fmt(tn.toCall)}</b>` : '') + ` · <span class="${sec <= 10 ? 'neg' : ''}">剩余 ${sec} 秒</span>`;
    };
    upd();
    clearInterval(this.cdTimer);
    this.cdTimer = setInterval(() => { if (S.heroResolve) upd(); }, 1000);
  },
};

/* ============================ 大厅页签 ============================ */
const NetUI = {
  previewAv: null, female: false,

  newAvatar() {
    const rng = Math.random;
    const persona = pickFrom(['student', 'office', 'hoodie', 'tourist', 'girl'], rng);
    const fem = this.female;
    this.previewAv = genAvatar(fem && persona !== 'girl' ? 'girl' : (!fem && persona === 'girl' ? 'student' : persona), fem, 20 + Math.floor(rng() * 25), rng);
  },

  savedName() { try { return localStorage.getItem('thsim_lan_name') || ''; } catch (e) { return ''; } },

  render() {
    const el = $('lt-lan'); if (!el) return;
    if (location.protocol === 'file:') {
      el.innerHTML = `<div class="panel" style="max-width:720px"><h2>局域网对战</h2>
        <p>联机需要通过局域网服务器打开本页（不能直接双击 index.html）：</p>
        <ol><li>在电脑上运行 <code>pwsh tools/serve.ps1</code>（局域网）或 <code>node server/server.js</code>（完整后端，支持多房间和账号）</li><li>所有人（包括房主）用浏览器打开它显示的地址，如 <code>http://192.168.x.x:8080/</code></li><li>一人创建房间，其他人加入</li></ol></div>`;
      return;
    }
    if (NetClient.active) { el.innerHTML = this.clientWaitingHTML(); this.bindClientWaiting(); return; }
    if (NetHost.active && NetHost.phase === 'lobby') { el.innerHTML = this.hostRoomHTML(); this.bindHostRoom(); return; }
    if (!this.previewAv) this.newAvatar();
    const lvOpts = CASH_STAKES.map((s) => `<option value="${s.lv}">L${s.lv} ${s.name}（${s.sb}/${s.bb}）</option>`).join('');
    el.innerHTML = `<div class="lobby-grid">
      <div class="panel"><h2>创建房间（我当房主）</h2>
        <p class="note">牌局在房主的浏览器里运行，建议房主用电脑，并保持页面在前台。空位由玩家数据库里的 AI 补齐。</p>
        <div class="opts">
          <label>房主昵称 <input id="lan-hname" maxlength="10" value="${esc(this.savedName() || '房主')}" style="width:150px"></label>
          <label>模式 <select id="lan-mode"><option value="cash">现金桌（随时加入/离开，输光自动补码）</option><option value="tournament">锦标赛 SNG（开赛后不能加入）</option></select></label>
          <label>AI 对手级别 / 盲注 <select id="lan-level">${lvOpts}</select></label>
          <label>人数 <select id="lan-size"><option value="6">6 人桌</option><option value="9">9 人桌</option></select></label>
          <label>锦标赛升盲 <select id="lan-hpl"><option value="10">每 10 手</option><option value="6">每 6 手（Turbo）</option><option value="15">每 15 手</option></select></label>
          <label class="chk"><input type="checkbox" id="lan-hostplays" checked> 房主也上桌打牌</label>
        </div>
        <div class="lobby-actions"><button id="lan-create" class="primary big">创建房间</button></div>
      </div>
      <div class="panel"><h2>加入房间</h2>
        ${Backend.online ? `<p class="note">输入房主告诉你的 4 位房间号，或从下面的列表里选。</p>
        <div class="row"><label>房间号 <input id="lan-code" maxlength="12" inputmode="numeric" value="${esc(this.code || '')}" style="width:110px"></label><button id="lan-refresh">刷新列表</button></div>
        <div id="lan-rooms" class="room-list"></div>` : '<p class="note">和房主连同一个 Wi-Fi，打开同一个地址即可。</p>'}
        <div class="row">${avatarSVG(this.previewAv, 72)}
          <div class="opts" style="flex:1">
            <label>昵称 <input id="lan-name" maxlength="10" value="${esc(this.savedName())}" placeholder="你的名字" style="width:150px"></label>
            <div class="row" style="margin:0"><button id="lan-av">换个头像</button><label class="chk"><input type="checkbox" id="lan-fem" ${this.female ? 'checked' : ''}> 女生头像</label></div>
          </div></div>
        <div class="lobby-actions"><button id="lan-join" class="primary big">加入</button></div>
      </div></div>`;
    $('lan-av').addEventListener('click', () => { this.keepName(); this.newAvatar(); this.render(); });
    $('lan-fem').addEventListener('change', (e) => { this.keepName(); this.female = e.target.checked; this.newAvatar(); this.render(); });
    const doJoin = (code) => {
      const name = netCleanName($('lan-name').value);
      try { localStorage.setItem('thsim_lan_name', name); } catch (e) { /* ignore */ }
      if (Backend.online) {
        code = String(code || $('lan-code').value || '').trim();
        if (!/^[A-Za-z0-9]{1,12}$/.test(code)) { showModal('<h3>请输入房间号</h3>', [{ label: '好的', value: 'ok', primary: true }]); return; }
        this.code = code;
      }
      NetClient.join(name, this.previewAv, Backend.online ? code : 'lan');
    };
    $('lan-join').addEventListener('click', () => doJoin());
    if (Backend.online) {
      $('lan-refresh').addEventListener('click', () => this.loadRooms(doJoin));
      this.loadRooms(doJoin);
    }
    $('lan-create').addEventListener('click', async () => {
      const lv = +$('lan-level').value, mode = $('lan-mode').value, size = +$('lan-size').value;
      const stake = CASH_STAKES[lv - 1];
      const hostName = netCleanName($('lan-hname').value);
      try { localStorage.setItem('thsim_lan_name', hostName); } catch (e) { /* ignore */ }
      const room = {
        hostName, mode, level: lv, size, hostPlays: $('lan-hostplays').checked, handsPerLevel: +$('lan-hpl').value,
        desc: (Backend.online ? '在线' : '局域网') + (mode === 'cash' ? ` · ${stake.name} ${stake.sb}/${stake.bb}` : ` SNG · AI 级别 L${lv}`),
      };
      try { await NetHost.create(room); } catch (e) { showModal(`<h3>无法创建房间</h3><p>${Backend.online ? esc(e.message) : '连不上局域网服务器，请确认 tools/serve.ps1 正在运行。'}</p>`, [{ label: '好的', value: 'ok' }]); return; }
      this.render();
    });
  },

  async loadRooms(doJoin) {
    const box = $('lan-rooms'); if (!box) return;
    try {
      const j = await Backend.api('GET', '/api/rooms');
      if (!$('lan-rooms')) return;
      box.innerHTML = j.rooms.length ? j.rooms.map((r) => `<div class="room-item"><b>${esc(r.code)}</b><span>${esc(r.desc)}<br><small class="note">房主 ${esc(r.hostName)} · ${r.size} 人桌 · ${r.players} 人在线${r.phase === 'playing' ? ' · 进行中' : ''}</small></span>` +
        `<button data-code="${esc(r.code)}" ${r.phase === 'playing' && r.mode === 'tournament' ? 'disabled' : ''}>加入</button></div>`).join('') : '<p class="note">暂时没有公开的房间。</p>';
      box.querySelectorAll('button[data-code]').forEach((b) => b.addEventListener('click', () => doJoin(b.dataset.code)));
    } catch (e) { box.innerHTML = `<p class="neg">获取房间列表失败：${esc(e.message)}</p>`; }
  },

  keepName() { const i = $('lan-name'); if (i) try { localStorage.setItem('thsim_lan_name', netCleanName(i.value)); } catch (e) { /* ignore */ } },

  hostRoomHTML() {
    const r = NetHost.room;
    const urls = location.origin + '/';
    const list = Object.values(NetHost.clients).filter((c) => !c.left);
    const rows = list.map((c) => {
      const age = NetHost.awayMs(c.cid);
      return `<tr><td>${c.avatar ? avatarSVG(c.avatar, 28) : ''}</td><td>${esc(c.name)}</td><td>${age < NET_AWAY_MS ? '<span class="pos">在线</span>' : '<span class="neg">掉线</span>'}</td></tr>`;
    }).join('');
    const seatsForHumans = r.size - (r.hostPlays ? 1 : 0);
    const howTo = Backend.online
      ? `<p>房间号：<b class="room-code">${esc(r.code)}</b></p><p>让朋友打开 <b>${esc(urls)}</b> →「联机对战」页签 → 输入房间号加入（也可以直接在房间列表里点）。</p>`
      : `<p>让朋友（同一 Wi-Fi）用手机打开：<b style="font-size:18px">${esc(urls)}</b><br><span class="note">→「局域网对战」页签 → 填昵称 → 加入</span></p>`;
    return `<div class="panel" style="max-width:720px"><h2>房间已创建：${esc(r.desc)}</h2>
      ${howTo}
      <p>${r.size} 人桌，${r.hostPlays ? '房主上桌，' : '房主观战，'}最多 ${seatsForHumans} 位真人，空位由 L${r.level} 的 AI 补齐。${r.mode === 'cash' ? '开局后仍可随时加入。' : '锦标赛开赛后不能再加入。'}</p>
      <h2>已加入（${list.length}）</h2>
      <table class="seat-list">${rows || '<tr><td class="note">等待玩家加入…</td></tr>'}</table>
      <div class="lobby-actions"><button id="lan-start" class="primary big">开始游戏</button><button id="lan-close">解散房间</button></div></div>`;
  },

  bindHostRoom() {
    $('lan-start').addEventListener('click', () => NetHost.startGame());
    $('lan-close').addEventListener('click', () => { NetHost.stop(); this.render(); });
  },

  clientWaitingHTML() {
    const v = NetClient.view;
    if (!v) {
      return `<div class="panel" style="max-width:640px"><h2>正在连接房间…</h2><p class="note">等待房主创建房间。确认房主已经点了「创建房间」，并且你们在同一个 Wi-Fi。</p>
        <div class="lobby-actions"><button id="lan-leave">取消</button></div></div>`;
    }
    const ps = (v.players || []).map((p) => `<div class="rv-opp">${p.av ? avatarSVG(p.av, 32) : ''}<b>${esc(p.name)}</b>${p.me ? '（你）' : ''}</div>`).join('');
    return `<div class="panel" style="max-width:640px"><h2>已加入：${esc(v.room)}</h2>
      <p>房主：<b>${esc(v.host)}</b>。等待房主开始游戏…</p><div class="rv-row">${ps}</div>
      <div class="lobby-actions"><button id="lan-leave">离开房间</button></div></div>`;
  },

  bindClientWaiting() {
    $('lan-leave').addEventListener('click', () => { if (NetClient.link) NetClient.link.send('host', 'leave', {}); NetClient.leaveQuiet(); this.render(); });
  },
};

/* 联机冒烟测试：index.html#smoke-lan / #smoke-lantour（需通过 serve.ps1 打开）。房主 + 2 个机器人客户端 */
async function lanSmoke(mode) {
  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.message + ' @' + e.filename + ':' + e.lineno));
  window.addEventListener('unhandledrejection', (e) => errors.push('rejection: ' + (e.reason && e.reason.stack)));
  const out = (txt) => { const pre = document.createElement('pre'); pre.id = 'out'; pre.textContent = txt + '\nERRORS: ' + (errors.length ? errors.join('\n') : 'none'); document.body.appendChild(pre); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  $('opt-speed').value = 'fast';
  const tour = mode === 'lantour';
  await NetHost.create({ hostName: '房主', mode: tour ? 'tournament' : 'cash', level: 2, size: 6, hostPlays: true, handsPerLevel: 4, desc: '测试房' });
  const bots = [];
  for (let k = 1; k <= 2; k++) {
    const b = { name: '机器人' + k, view: null, acted: 0, last: 0, states: 0 };
    b.link = new NetLink('bot' + k, (m) => {
      if (m.kind !== 'state') return;
      b.view = m.data; b.states++;
      const t = m.data.turn;
      if (t && t.id !== b.last) {
        b.last = t.id; b.acted++;
        const a = b.acted % 6 === 0 && t.canRaise ? { type: 'raise', amount: t.minRaiseTo } : b.acted % 4 === 0 ? { type: 'fold' } : { type: t.toCall ? 'call' : 'check' };
        b.link.send('host', 'act', Object.assign({ turn: t.id }, a));
      }
    });
    b.link.interval = 300;
    b.link.send('host', 'join', { name: b.name, avatar: null });
    b.link.start();
    bots.push(b);
  }
  await sleep(2000);
  const lobbyPlayers = bots.map((b) => b.view && b.view.players ? b.view.players.length : -1).join(',');
  NetHost.startGame();
  S.speed = 'fast';
  const t0 = Date.now();
  let heroActs = 0, conservation = 'ok', left = false;
  while (Date.now() - t0 < 150000) {
    await sleep(60);
    S.speed = 'fast';
    if (S.heroResolve) { heroActs++; heroDo(heroActs % 5 === 0 ? 'fold' : 'call'); }
    if (!$('modal').classList.contains('hidden')) $('modal-buttons').lastChild.click();
    const g = S.game; if (!g) break;
    if (!tour && !S.handActive) {
      const t = g.table;
      const sumStack = t.players.reduce((s, p) => s + p.stack, 0);
      const sumInv = t.players.reduce((s, p) => s + p.invested, 0);
      // 换人后 invested 不再可比，只在无人替换时检查
      if (!g.events.length && sumStack + t.totalRake !== sumInv) conservation = `stack ${sumStack} + rake ${t.totalRake} != invested ${sumInv}`;
    }
    if (!tour && !left && g.handsPlayed >= 12) { left = true; bots[1].link.send('host', 'leave', {}); bots[1].link.stop(); }
    if (g.finished || g.handsPlayed >= (tour ? 200 : 20) || $('game').classList.contains('hidden')) break;
  }
  const g = S.game, t = g.table;
  const remote = t.players.filter((p) => p.remote).map((p) => `${p.name}:${p.stack}`).join(' ');
  const v = bots[0].view || {};
  const txt = [
    `mode=${mode} hands=${g.handsPlayed} heroActs=${heroActs} finished=${!!g.finished}`,
    `lobbyPlayersSeenByBots=${lobbyPlayers}`,
    `bot1 acted=${bots[0].acted} states=${bots[0].states} | bot2 acted=${bots[1].acted} states=${bots[1].states}`,
    `remote seated now: ${remote || '(none)'}`,
    `bot1 view: phase=${v.phase} mySeat=${v.mySeat} me=${JSON.stringify(v.me)} seats=${(v.seats || []).filter(Boolean).length} logLines=${(v.log || []).length}`,
    `bot1 hidden-cards check: ${(v.seats || []).filter((s) => s && !s.me && s.hole && s.hole[0] >= 0 && !s.win && !v.seats.some((q) => q && q.win)).length} visible non-showdown opp holes`,
    `conservation: ${conservation}`,
    `host log tail: ${[...document.querySelectorAll('#log div')].slice(-4).map((d) => d.textContent).join(' | ')}`,
  ].join('\n');
  S.runId++;
  NetHost.stop();
  bots[0].link.stop();
  out(txt);
}