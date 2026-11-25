'use strict';
/* 牌桌引擎：发牌、盲注/前注、下注轮、边池、摊牌、抽水 */

const POSITION_NAMES = {
  2: ['BTN', 'BB'],
  3: ['BTN', 'SB', 'BB'],
  4: ['BTN', 'SB', 'BB', 'CO'],
  5: ['BTN', 'SB', 'BB', 'HJ', 'CO'],
  6: ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO'],
  7: ['BTN', 'SB', 'BB', 'UTG', 'LJ', 'HJ', 'CO'],
  8: ['BTN', 'SB', 'BB', 'UTG', 'UTG1', 'LJ', 'HJ', 'CO'],
  9: ['BTN', 'SB', 'BB', 'UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO'],
};

/* ICM（Malmuth-Harville） */
function icmEquity(stacks, payouts) {
  const n = stacks.length;
  const eq = new Array(n).fill(0);
  const total0 = stacks.reduce((a, b) => a + b, 0);
  if (total0 <= 0) return eq;
  const places = Math.min(payouts.length, n);
  function rec(mask, total, place, prob) {
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i) || stacks[i] <= 0) continue;
      const p = prob * stacks[i] / total;
      eq[i] += p * payouts[place];
      if (place + 1 < places) rec(mask | (1 << i), total - stacks[i], place + 1, p);
    }
  }
  rec(0, total0, 0, 1);
  return eq;
}

let _playerIdSeq = 1;
function createPlayer(opts) {
  return {
    id: _playerIdSeq++,
    name: opts.name,
    isHero: !!opts.isHero,
    style: opts.style || null,            // {x, y, arch}
    params: opts.params || null,
    stack: opts.stack,
    stats: opts.stats || new PlayerStats(),
    rec: opts.rec || null,                // 玩家数据库记录
    avatar: opts.avatar || null,
    hole: [], bet: 0, totalBet: 0,
    folded: false, allIn: false, inHand: false,
    lastAction: '', shown: false,
    buyIns: 1, invested: opts.stack,
    place: null,
  };
}

class Table {
  constructor(cfg) {
    this.mode = cfg.mode;                 // 'cash' | 'tournament'
    this.size = cfg.size;
    this.seats = new Array(cfg.size).fill(null);
    this.sb = cfg.sb; this.bb = cfg.bb; this.ante = cfg.ante || 0;
    this.rakePct = cfg.rakePct || 0; this.rakeCapBB = cfg.rakeCapBB || 3;
    this.button = -1;
    this.handNo = 0;
    this.board = [];
    this.street = 'preflop';
    this.currentBet = 0; this.minRaise = 0;
    this.hand = null;
    this.rng = cfg.rng || Math.random;
    this.io = Object.assign({
      update() {}, log() {}, sleep: null,
      heroAction: null, aiDelay: () => 0, onHandEnd() {},
    }, cfg.io || {});
    this.tournament = null;               // 由 Tournament 管理器注入
    this.totalRake = 0;
  }

  get players() { return this.seats.filter((p) => p); }
  get chipUnit() { return Math.max(1, Math.round(this.sb / (this.mode === 'tournament' ? 1 : 1))); }
  roundChips(v) { const u = this.chipUnit; return Math.max(u, Math.round(v / u) * u); }
  pot() { return this.players.reduce((s, p) => s + (p.inHand ? p.totalBet : 0), 0); }
  potBeforeStreet() { return this.players.reduce((s, p) => s + (p.inHand ? p.totalBet - p.bet : 0), 0); }

  nextSeat(from, pred) {
    for (let k = 1; k <= this.size; k++) {
      const i = (from + k + this.size) % this.size;
      const p = this.seats[i];
      if (p && pred(p)) return i;
    }
    return -1;
  }

  inHandPlayers() { return this.players.filter((p) => p.inHand && !p.folded); }

  positionOf(p) {
    const h = this.hand; if (!h) return { label: '', lateness: 0.5 };
    const order = h.order; // 从按钮开始
    const i = order.indexOf(p.id);
    const n = order.length;
    const names = POSITION_NAMES[n] || POSITION_NAMES[9];
    const label = names[i] || '';
    let lateness;
    if (n === 2) lateness = i === 0 ? 1 : 0.6;
    else if (label === 'SB') lateness = 0.85;
    else if (label === 'BB') lateness = 0.9;
    else {
      // 非盲注位置：UTG=0 … BTN=1
      const k = n - 2;
      const idx = i === 0 ? k - 1 : i - 3;
      lateness = k <= 1 ? 1 : idx / (k - 1);
    }
    return { label, lateness, isSB: label === 'SB' || (n === 2 && i === 0), isBB: label === 'BB', index: i, n };
  }

  async sleep(ms) { if (ms > 0 && this.io.sleep) await this.io.sleep(ms); }

  logLine(msg, cls) {
    if (this.hand) this.hand.log.push([msg, cls || '']);
    this.io.log(msg, cls);
  }

  /* 记录玩家（hero）决策时的完整局面，供复盘使用 */
  snapshotDecision(p, ctx) {
    const h = this.hand;
    const pos = this.positionOf(p);
    const others = this.inHandPlayers().filter((q) => q !== p);
    let eff = 0;
    for (const q of others) eff = Math.max(eff, q.stack + q.bet);
    eff = Math.min(eff, p.stack + p.bet);
    const order = h.order;
    const rankOf = (q) => { const i = order.indexOf(q.id); return i === 0 ? order.length : i; };
    const raiser = this.players.find((q) => q.id === h.preflopAggressor);
    const cls = Preflop.classOf(p.hole[0], p.hole[1]);
    return {
      street: this.street, board: this.board.slice(), hole: p.hole.slice(),
      pot: ctx.pot, toCall: ctx.toCall, currentBet: this.currentBet, minRaiseTo: ctx.minRaiseTo, maxTo: ctx.maxTo,
      canRaise: ctx.canRaise, betThisStreet: p.bet, stack: p.stack, bb: this.bb,
      posLabel: pos.label, lateness: pos.lateness, nPlayers: order.length,
      pct: Preflop.pct(p.hole[0], p.hole[1]), handKey: cls.key, handTop: cls.topPct,
      effBB: eff / this.bb, preflopRaises: h.preflopRaises, facing: h.streetRaises,
      limpers: h.actions.filter((a) => a.street === 'preflop' && a.type === 'call' && a.facing === 0).length,
      raiseBB: this.currentBet / this.bb,
      raiserLateness: raiser && raiser !== p ? this.positionOf(raiser).lateness : 0.5,
      raiserLabel: raiser && raiser !== p ? this.positionOf(raiser).label : '',
      isPfAggr: h.preflopAggressor === p.id,
      ip: others.every((q) => rankOf(q) < rankOf(p)),
      logIndex: h.log.length,
      mode: this.mode,
      opps: others.map((q) => ({ id: q.id, name: q.name, hole: q.hole.slice(), stack: q.stack, bet: q.bet, range: AI.oppRange(this, q) })),
    };
  }

  put(p, amt) {
    amt = Math.min(amt, p.stack);
    p.stack -= amt; p.bet += amt; p.totalBet += amt;
    if (p.stack === 0) p.allIn = true;
    return amt;
  }

  /* 当前玩家的合法动作信息 */
  actionContext(p) {
    const toCall = Math.max(0, this.currentBet - p.bet);
    const maxTo = p.bet + p.stack;
    let minRaiseTo = this.currentBet + this.minRaise;
    if (this.currentBet === 0) minRaiseTo = Math.min(this.bb, maxTo);
    const canRaise = maxTo > this.currentBet && this.inHandPlayers().some((q) => q !== p && !q.allIn);
    return {
      toCall: Math.min(toCall, p.stack),
      currentBet: this.currentBet,
      minRaiseTo: Math.min(minRaiseTo, maxTo),
      maxTo,
      canRaise,
      pot: this.pot(),
    };
  }

  async playHand() {
    const active = this.players.filter((p) => p.stack > 0);
    if (active.length < 2) return false;
    this.handNo++;
    for (const p of this.players) {
      p.hole = []; p.bet = 0; p.totalBet = 0; p.folded = false; p.allIn = false;
      p.inHand = p.stack > 0; p.lastAction = ''; p.shown = false; p.startStack = p.stack;
      p.handResult = null;
    }
    this.button = this.nextSeat(this.button, (p) => p.stack > 0);
    const order = [];
    { let s = this.button; do { order.push(this.seats[s].id); s = this.nextSeat(s, (p) => p.inHand); } while (s !== this.button); }
    const hand = this.hand = {
      no: this.handNo, actions: [], order,
      players: active.slice(), preflopRaises: 0, preflopAggressor: null,
      streetRaises: 0, flopSeen: false, flopPlayers: [], showdownPlayers: [], winnerIds: [],
      log: [], results: [], sb: this.sb, bb: this.bb, ante: this.ante, heroDecisions: [], button: this.button,
    };
    this.board = [];
    this.deck = Cards.shuffle(Cards.newDeck(), this.rng);
    const n = active.length;
    let sbSeat, bbSeat;
    if (n === 2) { sbSeat = this.button; bbSeat = this.nextSeat(sbSeat, (p) => p.inHand); }
    else { sbSeat = this.nextSeat(this.button, (p) => p.inHand); bbSeat = this.nextSeat(sbSeat, (p) => p.inHand); }
    hand.sbSeat = sbSeat; hand.bbSeat = bbSeat;

    this.logLine(`—— 第 ${this.handNo} 手 ——  盲注 ${this.sb}/${this.bb}${this.ante ? ' 前注 ' + this.ante : ''}`, 'hand');

    if (this.ante > 0) {
      for (const p of active) {
        const a = Math.min(this.ante, p.stack);
        p.stack -= a; p.totalBet += a; if (p.stack === 0) p.allIn = true;
      }
    }
    const sbP = this.seats[sbSeat], bbP = this.seats[bbSeat];
    this.put(sbP, this.sb); sbP.lastAction = '小盲';
    this.put(bbP, this.bb); bbP.lastAction = '大盲';
    this.currentBet = this.bb; this.minRaise = this.bb;
    this.street = 'preflop';

    // 发底牌
    for (let r = 0; r < 2; r++) {
      let s = this.button;
      for (let k = 0; k < n; k++) { s = this.nextSeat(s, (p) => p.inHand); this.seats[s].hole.push(this.deck.pop()); }
    }
    const hero = active.find((p) => p.isHero);
    if (hero) this.logLine(`你的底牌：${hero.hole.map(Cards.label).join(' ')}（${hand.order.length}人桌，${this.positionOf(hero).label}）`, 'hero');
    this.io.update();

    const first = n === 2 ? sbSeat : this.nextSeat(bbSeat, (p) => p.inHand);
    await this.bettingRound('preflop', first);

    const streets = [['flop', 3], ['turn', 1], ['river', 1]];
    for (const [st, cnt] of streets) {
      if (this.inHandPlayers().length <= 1) break;
      this.collectBets();
      this.deck.pop(); // 烧牌
      for (let k = 0; k < cnt; k++) this.board.push(this.deck.pop());
      this.street = st;
      if (st === 'flop') { hand.flopSeen = true; hand.flopPlayers = this.inHandPlayers().map((p) => p.id); }
      this.logLine(`${{ flop: '翻牌', turn: '转牌', river: '河牌' }[st]}：${this.board.map(Cards.label).join(' ')}  （底池 ${this.pot()}）`, 'street');
      this.currentBet = 0; this.minRaise = this.bb; hand.streetRaises = 0;
      for (const p of this.players) if (p.inHand && !p.folded) p.lastAction = p.allIn ? '全下' : '';
      this.io.update();
      const canAct = this.inHandPlayers().filter((p) => !p.allIn);
      if (canAct.length >= 2) {
        await this.sleep(this.io.aiDelay() * 0.6);
        await this.bettingRound(st, this.nextSeat(this.button, (p) => p.inHand && !p.folded));
      } else {
        if (this.inHandPlayers().length > 1) for (const p of this.inHandPlayers()) p.shown = true; // 全下后亮牌
        this.io.update();
        await this.sleep(this.io.aiDelay() * 1.3 + (this.io.allInPause || 0));
      }
    }
    this.collectBets();
    await this.showdown();
    Stats_process(hand);
    for (const p of hand.players) {
      const diff = p.stack - p.startStack;
      p.stats.net += diff; p.stats.netBB += diff / this.bb;
    }
    this.io.update();
    this.io.onHandEnd(hand);
    return true;
  }

  collectBets() { for (const p of this.players) p.bet = 0; }

  async bettingRound(street, startSeat) {
    this.street = street;
    this.pending = new Set(this.inHandPlayers().filter((p) => !p.allIn));
    let seat = startSeat;
    let guard = 0;
    while (this.pending.size > 0 && guard++ < 1000) {
      if (this.inHandPlayers().length === 1) return;
      const p = this.seats[seat];
      if (p && this.pending.has(p)) {
        const ctx = this.actionContext(p);
        const others = this.inHandPlayers().filter((q) => q !== p && !q.allIn);
        if (others.length === 0 && ctx.toCall <= 0) {
          this.pending.delete(p);
        } else {
          this.toAct = p;
          this.io.update();
          let action, snap = null;
          if (p.remote && this.io.remoteAction) {
            action = await this.io.remoteAction(p, ctx);   // 局域网联机的真人玩家
          } else if (p.isHero && this.io.heroAction) {
            snap = this.snapshotDecision(p, ctx);
            action = await this.io.heroAction(p, ctx);
          } else {
            await this.sleep(this.io.aiDelay());
            action = AI.decide(this, p, ctx);
          }
          this.toAct = null;
          this.pending.delete(p);
          this.applyAction(p, action, ctx);
          if (snap) {
            const rec = this.hand.actions[this.hand.actions.length - 1];
            snap.action = { type: rec.type, to: rec.to || 0, amount: rec.amount || 0, allIn: rec.allIn };
            this.hand.heroDecisions.push(snap);
          }
          this.io.update();
        }
      }
      seat = (seat + 1) % this.size;
    }
  }

  applyAction(p, a, ctx) {
    const hand = this.hand;
    let type = a.type;
    const facing = hand.streetRaises + (this.street === 'preflop' ? 0 : 0);
    if (type === 'check' && ctx.toCall > 0) type = 'fold';
    if (type === 'call' && ctx.toCall === 0) type = 'check';
    if (type === 'raise' && !ctx.canRaise) type = ctx.toCall > 0 ? 'call' : 'check';
    let amount = 0;
    let rec;
    const wasBetZero = this.currentBet === 0;
    if (type === 'fold') {
      p.folded = true; p.lastAction = '弃牌';
      rec = { type: 'fold' };
    } else if (type === 'check') {
      p.lastAction = '过牌'; rec = { type: 'check' };
    } else if (type === 'call') {
      amount = this.put(p, ctx.toCall);
      p.lastAction = p.allIn ? '跟注全下' : '跟注';
      rec = { type: 'call', amount };
    } else {
      let to = Math.round(a.amount || ctx.minRaiseTo);
      to = Math.max(to, ctx.minRaiseTo);
      to = Math.min(to, ctx.maxTo);
      if (to <= this.currentBet) { // 实际只能跟注
        amount = this.put(p, ctx.toCall);
        p.lastAction = p.allIn ? '跟注全下' : '跟注';
        rec = { type: 'call', amount };
        type = 'call';
      } else {
        const raiseSize = to - this.currentBet;
        if (raiseSize >= this.minRaise) this.minRaise = raiseSize;
        amount = this.put(p, to - p.bet);
        this.currentBet = Math.max(this.currentBet, p.bet);
        hand.streetRaises++;
        if (this.street === 'preflop') { hand.preflopRaises++; hand.preflopAggressor = p.id; }
        // 重新开启行动
        for (const q of this.inHandPlayers()) if (q !== p && !q.allIn) this.pending.add(q);
        type = wasBetZero ? 'bet' : 'raise';
        p.lastAction = (p.allIn ? '全下 ' : (type === 'bet' ? '下注 ' : '加注到 ')) + p.bet;
        rec = { type, amount, to: p.bet };
      }
    }
    rec.pid = p.id; rec.street = this.street; rec.facing = facing; rec.allIn = p.allIn;
    rec.potBefore = ctx.pot; rec.toCall = ctx.toCall;
    hand.actions.push(rec);
    const verb = { fold: '弃牌', check: '过牌', call: `跟注 ${amount}`, bet: `下注 ${rec.to}`, raise: `加注到 ${rec.to}` }[type];
    this.logLine(`${p.name}${p.isHero ? '(你)' : ''}：${verb}${p.allIn && type !== 'fold' && type !== 'check' ? '（全下）' : ''}`, p.isHero ? 'hero' : '');
  }

  buildPots() {
    const ps = this.players.filter((p) => p.inHand && p.totalBet > 0);
    const levels = [...new Set(ps.filter((p) => !p.folded).map((p) => p.totalBet))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const lv of levels) {
      let amount = 0;
      for (const p of ps) amount += Math.max(0, Math.min(p.totalBet, lv) - prev);
      const elig = ps.filter((p) => !p.folded && p.totalBet >= lv);
      if (amount > 0) pots.push({ amount, elig });
      prev = lv;
    }
    // 弃牌者超出最高层级的部分（极少见）并入最后一个池
    let extra = 0;
    for (const p of ps) extra += Math.max(0, p.totalBet - prev);
    if (extra > 0 && pots.length) pots[pots.length - 1].amount += extra;
    return pots;
  }

  awardOrder(winners) {
    // 余数筹码从按钮左侧开始分配
    const res = [];
    let s = this.button;
    for (let k = 0; k < this.size; k++) {
      s = (s + 1) % this.size;
      const p = this.seats[s];
      if (p && winners.includes(p)) res.push(p);
    }
    return res;
  }

  async showdown() {
    const hand = this.hand;
    const contenders = this.inHandPlayers();
    let pots = this.buildPots();
    const total = pots.reduce((s, x) => s + x.amount, 0);
    // 抽水（No flop, no drop）
    let rake = 0;
    if (this.mode === 'cash' && this.rakePct > 0 && hand.flopSeen) {
      rake = Math.min(Math.floor(total * this.rakePct), this.rakeCapBB * this.bb);
      let r = rake;
      for (const pt of pots) { const take = Math.min(r, pt.amount); pt.amount -= take; r -= take; if (r <= 0) break; }
      this.totalRake += rake;
    }
    hand.rake = rake;
    const won = new Map();
    if (contenders.length === 1) {
      const w = contenders[0];
      const amt = pots.reduce((s, x) => s + x.amount, 0);
      w.stack += amt; won.set(w, amt);
      hand.winnerIds = [w.id];
      this.logLine(`${w.name} 赢得底池 ${amt}${rake ? '（抽水 ' + rake + '）' : ''}`, 'win');
      w.lastAction = `赢 ${amt}`;
    } else {
      hand.showdownPlayers = contenders.map((p) => p.id);
      const vals = new Map();
      for (const p of contenders) {
        p.shown = true;
        const v = evaluate(p.hole.concat(this.board), 7);
        vals.set(p, v);
        this.logLine(`${p.name} 亮牌 ${p.hole.map(Cards.label).join(' ')} —— ${describeHand(v)}`, 'show');
      }
      for (const pt of pots) {
        if (pt.amount <= 0) continue;
        const elig = pt.elig.filter((p) => !p.folded);
        if (elig.length === 0) continue;
        let best = -1;
        for (const p of elig) best = Math.max(best, vals.get(p));
        const winners = this.awardOrder(elig.filter((p) => vals.get(p) === best));
        const share = Math.floor(pt.amount / winners.length);
        let rem = pt.amount - share * winners.length;
        for (const w of winners) {
          const a = share + (rem > 0 ? 1 : 0); if (rem > 0) rem--;
          w.stack += a; won.set(w, (won.get(w) || 0) + a);
        }
      }
      hand.winnerIds = [...won.keys()].map((p) => p.id);
      for (const [w, amt] of won) {
        w.lastAction = `赢 ${amt}`;
        this.logLine(`${w.name} 赢得 ${amt}（${describeHand(vals.get(w))}）${rake ? ' 抽水 ' + rake : ''}`, 'win');
      }
      hand.showdownVals = vals;
    }
    hand.won = won;
    this.io.update();
  }
}

function Stats_process(hand) { PlayerStats.processHand(hand); }
