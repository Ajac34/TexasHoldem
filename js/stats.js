'use strict';
/* HUD 统计：根据每手的动作记录计算 VPIP / PFR / 3Bet / AF / CBet / 弃牌给CBet / WTSD 等 */
class PlayerStats {
  constructor() {
    this.hands = 0; this.vpip = 0; this.pfr = 0;
    this.threeBetOpp = 0; this.threeBet = 0;
    this.postBR = 0; this.postCall = 0; this.postFold = 0; this.postCheck = 0;
    this.cbetOpp = 0; this.cbet = 0;
    this.foldCbetOpp = 0; this.foldCbet = 0;
    this.sawFlop = 0; this.wtsd = 0; this.wsd = 0;
    this.net = 0; this.netBB = 0;
  }
  static pct(a, b) { return b > 0 ? a / b : null; }
  static from(obj) { const s = new PlayerStats(); if (obj) Object.assign(s, obj); return s; }
  toJSON() { return Object.assign({}, this); }
  get vpipPct() { return PlayerStats.pct(this.vpip, this.hands); }
  get pfrPct() { return PlayerStats.pct(this.pfr, this.hands); }
  get threeBetPct() { return PlayerStats.pct(this.threeBet, this.threeBetOpp); }
  get af() { return this.postCall > 0 ? this.postBR / this.postCall : (this.postBR > 0 ? 9.9 : null); }
  get aggFreq() { return PlayerStats.pct(this.postBR, this.postBR + this.postCall + this.postFold); }
  get cbetPct() { return PlayerStats.pct(this.cbet, this.cbetOpp); }
  get foldCbetPct() { return PlayerStats.pct(this.foldCbet, this.foldCbetOpp); }
  get wtsdPct() { return PlayerStats.pct(this.wtsd, this.sawFlop); }
  get wsdPct() { return PlayerStats.pct(this.wsd, this.wtsd); }

  /* 由实际统计反推在风格平面上的位置（deriveParams 的近似逆运算） */
  mapPoint(tableSize) {
    if (this.hands < 8) return null;
    const sizeMul = tableSize >= 8 ? 0.78 : 1;
    const v = this.vpipPct;
    const x = clamp01((v / sizeMul - 0.10) / 0.55);
    const ratio = v > 0 ? this.pfrPct / v : 0;
    const yPre = clamp01((ratio - 0.12) / 0.83);
    const af = this.aggFreq;
    if (af == null || this.postBR + this.postCall + this.postFold < 6) return { x, y: yPre };
    const yPost = clamp01((af - 0.18) / 0.42);
    return { x, y: 0.55 * yPre + 0.45 * yPost };
  }

  static processHand(hand) {
    const acts = hand.actions;
    const byPlayer = new Map();
    for (const p of hand.players) byPlayer.set(p.id, []);
    for (const a of acts) if (byPlayer.has(a.pid)) byPlayer.get(a.pid).push(a);

    // 翻前最后加注者
    let pfAggr = null;
    for (const a of acts) if (a.street === 'preflop' && a.type === 'raise') pfAggr = a.pid;
    const flopActs = acts.filter((a) => a.street === 'flop');
    let cbetMade = false;
    if (pfAggr != null) {
      const first = flopActs.find((a) => a.pid === pfAggr);
      if (first && first.facing === 0) cbetMade = first.type === 'bet';
    }

    for (const p of hand.players) {
      const s = p.stats; const mine = byPlayer.get(p.id) || [];
      s.hands++;
      const pre = mine.filter((a) => a.street === 'preflop');
      if (pre.some((a) => a.type === 'call' || a.type === 'raise')) s.vpip++;
      if (pre.some((a) => a.type === 'raise')) s.pfr++;
      const f1 = pre.find((a) => a.facing === 1);
      if (f1) { s.threeBetOpp++; if (f1.type === 'raise') s.threeBet++; }
      for (const a of mine) {
        if (a.street === 'preflop') continue;
        if (a.type === 'bet' || a.type === 'raise') s.postBR++;
        else if (a.type === 'call') s.postCall++;
        else if (a.type === 'fold') s.postFold++;
        else if (a.type === 'check') s.postCheck++;
      }
      if (hand.flopSeen && hand.flopPlayers.includes(p.id)) {
        s.sawFlop++;
        if (hand.showdownPlayers.includes(p.id)) {
          s.wtsd++;
          if (hand.winnerIds.includes(p.id)) s.wsd++;
        }
      }
      if (p.id === pfAggr) {
        const first = flopActs.find((a) => a.pid === p.id);
        if (first && first.facing === 0) { s.cbetOpp++; if (first.type === 'bet') s.cbet++; }
      } else if (cbetMade) {
        // 面对 CBet 的第一个动作
        const aggIdx = flopActs.findIndex((a) => a.pid === pfAggr);
        const resp = flopActs.find((a, i) => i > aggIdx && a.pid === p.id);
        if (resp && resp.facing === 1) { s.foldCbetOpp++; if (resp.type === 'fold') s.foldCbet++; }
      }
    }
  }
}

function fmtPct(v) { return v == null ? '-' : Math.round(v * 100).toString(); }
