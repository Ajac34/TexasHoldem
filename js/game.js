'use strict';
/* 会话管理：现金桌（补码、玩家流动）与锦标赛（盲注升级、淘汰、奖金/ICM） */

const BLIND_LEVELS = [
  [10, 20, 0], [15, 30, 0], [25, 50, 0], [50, 100, 0], [75, 150, 0], [100, 200, 25],
  [150, 300, 25], [200, 400, 50], [300, 600, 75], [400, 800, 100], [600, 1200, 150],
  [800, 1600, 200], [1000, 2000, 300], [1500, 3000, 400], [2000, 4000, 500],
  [3000, 6000, 1000], [4000, 8000, 1000], [6000, 12000, 2000], [10000, 20000, 3000],
];

function payoutStructure(n) {
  if (n <= 3) return [1];
  if (n <= 6) return [0.65, 0.35];
  return [0.5, 0.3, 0.2];
}

const SEAT_COLORS = ['#f5c542', '#4fc3f7', '#ef5350', '#66bb6a', '#ab47bc', '#ff8a65', '#26c6da', '#d4e157', '#ec407a'];

class Game {
  /* cfg: { mode, size, observer, pool, dynamicPool, level(职业模式级别, 可选), title,
   *        lineup: [数据库记录]（职业模式）或 styles:[{x,y,arch}]（自由练习）,
   *        hero: { name, stack, stats, avatar }（可选）,
   *        cash:{sb,bb,buyinBB,rakePct,rakeCapBB}, tour:{startStack,handsPerLevel,buyin}, io, rng, eqScale } */
  constructor(cfg) {
    this.cfg = cfg;
    this.mode = cfg.mode;
    this.rng = cfg.rng || Math.random;
    this.level = 0;
    const size = cfg.size;
    const isTour = cfg.mode === 'tournament';
    const lv = BLIND_LEVELS[0];
    this.table = new Table({
      mode: cfg.mode, size,
      sb: isTour ? lv[0] : cfg.cash.sb, bb: isTour ? lv[1] : cfg.cash.bb, ante: 0,
      rakePct: isTour ? 0 : cfg.cash.rakePct, rakeCapBB: isTour ? 3 : cfg.cash.rakeCapBB,
      io: cfg.io, rng: this.rng,
    });
    this.table.eqScale = cfg.eqScale || 1;
    this.startStack = isTour ? cfg.tour.startStack : cfg.cash.bb * cfg.cash.buyinBB;
    const names = pickNames(size, this.rng);
    let colorIdx = 1;
    for (let i = 0; i < size; i++) {
      let p;
      if (i === 0 && !cfg.observer) {
        const h = cfg.hero || {};
        p = createPlayer({ name: h.name || '你', isHero: true, stack: h.stack || this.startStack, stats: h.stats, avatar: h.avatar });
        p.invested = p.stack;
        p.color = SEAT_COLORS[0];
      } else if (cfg.lineup && cfg.lineup[i - 1]) {
        p = this.playerFromRec(cfg.lineup[i - 1]);
        p.color = SEAT_COLORS[(colorIdx++) % SEAT_COLORS.length];
      } else {
        const st = i === 0 ? { x: 0.32, y: 0.72, arch: 'tag' } : cfg.styles[i - 1];
        p = createPlayer({ name: names[i], stack: this.startStack, style: { ...st }, params: deriveParams(st.x, st.y, size) });
        p.color = SEAT_COLORS[(colorIdx++) % SEAT_COLORS.length];
      }
      p.seat = i;
      this.table.seats[i] = p;
    }
    this.handsPlayed = 0;
    this.events = [];
    this.recentHands = [];
    if (isTour) {
      this.handsPerLevel = cfg.tour.handsPerLevel;
      this.buyin = cfg.tour.buyin || 100;
      this.prizePool = this.buyin * size;
      this.payoutPct = payoutStructure(size);
      this.table.tournament = { payouts: this.payoutPct.map((x) => x * this.prizePool), game: this };
      this.finished = false;
    }
  }

  /* 数据库记录 → 牌桌上的玩家。老板买入深（无限后手），大爷有时短码 */
  playerFromRec(rec) {
    const size = this.cfg.size;
    let stack = this.startStack;
    if (this.mode === 'cash') {
      const bb = this.cfg.cash.bb;
      if (rec.persona === 'boss') stack = bb * (200 + Math.floor(this.rng() * 3) * 50);
      else if (rec.persona === 'rich_lady') stack = bb * 150;
      else if (rec.persona === 'old_man' && this.rng() < 0.4) stack = bb * 60;
    }
    const p = createPlayer({
      name: rec.name, stack, style: { x: rec.x, y: rec.y, arch: rec.persona },
      params: deriveParams(rec.x, rec.y, size, rec.skill), stats: PlayerStats.from(rec.stats), rec, avatar: rec.avatar,
    });
    p.buyinTarget = stack;
    return p;
  }

  get hero() { return this.table.players.find((p) => p.isHero) || null; }
  get alive() { return this.table.players.filter((p) => p.stack > 0); }

  log(msg, cls) { if (this.cfg.io && this.cfg.io.log) this.cfg.io.log(msg, cls || 'sys'); }

  beforeHand() {
    const t = this.table;
    if (this.mode === 'tournament') {
      const lvIdx = Math.min(Math.floor(this.handsPlayed / this.handsPerLevel), BLIND_LEVELS.length - 1);
      if (lvIdx !== this.level) {
        this.level = lvIdx;
        const [sb, bb, ante] = BLIND_LEVELS[lvIdx];
        this.log(`盲注升级：第 ${lvIdx + 1} 级 ${sb}/${bb}${ante ? ' 前注 ' + ante : ''}`);
      }
      const [sb, bb, ante] = BLIND_LEVELS[this.level];
      t.sb = sb; t.bb = bb; t.ante = ante;
      return;
    }
    // 现金桌：AI 补码与玩家流动
    for (let i = 0; i < t.size; i++) {
      const p = t.seats[i];
      if (!p || p.isHero || p.remote) continue;
      const target = p.buyinTarget || this.startStack;
      const isBoss = p.rec && p.rec.persona === 'boss';
      const leaveChance = this.cfg.dynamicPool ? 0.006 : 0;
      if (!p.noLeave && ((p.stack === 0 && this.cfg.dynamicPool && !isBoss && this.rng() < 0.4) || this.rng() < leaveChance)) {
        this.replacePlayer(i, p.stack === 0 ? '输光离桌' : '离开了牌桌');
        continue;
      }
      if (p.stack === 0 || (p.stack < target * (isBoss ? 0.8 : 0.4) && this.rng() < (isBoss ? 1 : 0.5))) {
        const add = target - p.stack;
        p.stack += add; p.invested += add; p.buyIns++;
        if (add > 0) this.log(`${p.name} 补码 ${add}${isBoss ? '（老板：钱不是问题）' : ''}`);
      }
    }
  }

  replacePlayer(i, reason) {
    const t = this.table;
    const old = t.seats[i];
    let p;
    if (this.cfg.level && this.cfg.lineup) {
      const seated = new Set(t.players.filter((q) => q.rec).map((q) => q.rec.id));
      const [rec] = PlayerDB.pick(this.cfg.level, 1, seated, this.rng);
      if (rec) p = this.playerFromRec(rec);
    }
    if (!p) {
      const st = samplePoolStyle(this.cfg.pool, this.rng);
      const used = new Set(t.players.map((q) => q.name));
      const name = NICKNAMES.find((nm) => !used.has(nm) && this.rng() < 0.3) || NICKNAMES.find((nm) => !used.has(nm)) || ('玩家' + Math.floor(this.rng() * 1000));
      p = createPlayer({ name, stack: this.startStack, style: st, params: deriveParams(st.x, st.y, t.size) });
    }
    p.seat = i; p.color = old.color;
    t.seats[i] = p;
    this.syncRec(old);
    this.log(`${old.name} ${reason}，${p.name} 入座`);
    this.events.push({ type: 'replace', hand: this.handsPlayed, old, now: p });
  }

  /* 把牌桌上的统计写回玩家数据库（HUD 数据跨场次保留） */
  syncRec(p) {
    if (!p || !p.rec) return;
    p.rec.stats = p.stats.toJSON();
  }
  syncAll() {
    for (const p of this.table.players) this.syncRec(p);
    if (this.cfg.lineup) PlayerDB.save();
  }

  heroRebuy(amount) {
    const h = this.hero; if (!h || this.mode !== 'cash') return 0;
    const add = amount != null ? amount : this.startStack - h.stack;
    if (add <= 0) return 0;
    h.stack += add; h.invested += add; h.buyIns++;
    this.log(`你补码 ${add}`);
    return add;
  }

  /* 生成一手牌的完整记录（用于复盘） */
  buildHandRecord(hand) {
    const t = this.table;
    const hero = hand.players.find((p) => p.isHero);
    if (!hero) return null;
    return {
      id: `${Date.now()}-${hand.no}`, ts: Date.now(), mode: this.mode, title: this.cfg.title || (this.mode === 'cash' ? `现金桌 ${t.sb}/${t.bb}` : '锦标赛'),
      no: hand.no, sb: hand.sb, bb: hand.bb, ante: hand.ante, button: hand.button,
      players: hand.players.map((p) => ({
        id: p.id, name: p.name, seat: p.seat, isHero: p.isHero, startStack: p.startStack, endStack: p.stack,
        hole: p.hole.slice(), avatar: p.avatar, persona: p.rec ? p.rec.persona : null,
        style: p.style ? { x: p.style.x, y: p.style.y } : null, pos: '',
      })),
      board: t.board.slice(), log: hand.log.slice(), decisions: hand.heroDecisions,
      heroNet: hero.stack - hero.startStack, heroHole: hero.hole.slice(),
      showdown: hand.showdownPlayers.length > 0, marked: false, review: null,
    };
  }

  afterHand(hand) {
    this.handsPlayed++;
    const status = { over: false, heroBusted: false };
    const rec = this.buildHandRecord(hand);
    if (rec) {
      this.recentHands.unshift(rec);
      if (this.recentHands.length > 40) this.recentHands.length = 40;
      if (hand.marked) { rec.marked = true; HandStore.add(rec); }
      status.record = rec;
    }
    if (this.cfg.lineup && this.handsPlayed % 5 === 0) this.syncAll();
    if (this.mode === 'cash') {
      const h = this.hero;
      if (h && h.stack === 0) status.heroBusted = true;
      return status;
    }
    const t = this.table;
    const busted = t.players.filter((p) => p.stack === 0 && p.place == null);
    const aliveN = this.alive.length;
    busted.sort((a, b) => b.startStack - a.startStack);
    busted.forEach((p, i) => {
      p.place = aliveN + 1 + i;
      p.prize = (this.payoutPct[p.place - 1] || 0) * this.prizePool;
      this.log(`${p.name} 被淘汰，获得第 ${p.place} 名${p.prize ? '，奖金 ' + Math.round(p.prize) : ''}`, 'elim');
      if (p.isHero) status.heroBusted = true;
    });
    if (aliveN === 1) {
      const w = this.alive[0];
      w.place = 1; w.prize = this.payoutPct[0] * this.prizePool;
      this.log(`${w.name} 赢得锦标赛冠军！奖金 ${Math.round(w.prize)}`, 'win');
      this.finished = true;
      status.over = true;
    }
    return status;
  }

  icmTable() {
    const alive = this.alive;
    const eq = icmEquity(alive.map((p) => p.stack), this.table.tournament.payouts);
    return alive.map((p, i) => ({ p, stack: p.stack, eq: eq[i] }));
  }

  nextLevelIn() { return this.handsPerLevel - (this.handsPlayed % this.handsPerLevel); }
}
