'use strict';
/* 职业生涯：资金（bankroll）、级别、锦标赛、手牌标记存储 */

const CASH_STAKES = [
  { lv: 1, name: '新手桌', sb: 1, bb: 2, rakePct: 0.05, rakeCapBB: 4 },
  { lv: 2, name: '娱乐桌', sb: 2, bb: 5, rakePct: 0.05, rakeCapBB: 3 },
  { lv: 3, name: '进阶桌', sb: 5, bb: 10, rakePct: 0.05, rakeCapBB: 3 },
  { lv: 4, name: '常客桌', sb: 10, bb: 20, rakePct: 0.05, rakeCapBB: 2.5 },
  { lv: 5, name: '高额桌', sb: 25, bb: 50, rakePct: 0.045, rakeCapBB: 2 },
  { lv: 6, name: '鲨鱼池', sb: 50, bb: 100, rakePct: 0.04, rakeCapBB: 1.5 },
];

const TOURS = [
  { id: 't1', name: '新手 SNG', buyin: 20, fee: 2, lv: 1, size: 6, startStack: 1500, handsPerLevel: 12 },
  { id: 't2', name: '周末 SNG', buyin: 100, fee: 10, lv: 2, size: 9, startStack: 1500, handsPerLevel: 12 },
  { id: 't3', name: '进阶 SNG', buyin: 300, fee: 25, lv: 4, size: 9, startStack: 1500, handsPerLevel: 12 },
  { id: 't4', name: '高额 SNG', buyin: 1000, fee: 60, lv: 5, size: 6, startStack: 1500, handsPerLevel: 12 },
  { id: 't5', name: '豪客赛', buyin: 5000, fee: 250, lv: 6, size: 6, startStack: 2000, handsPerLevel: 12 },
];

const MIN_BUYIN_BB = 40, MAX_BUYIN_BB = 100;
const MIN_ENTRY = Math.min(CASH_STAKES[0].bb * MIN_BUYIN_BB, ...TOURS.map((t) => t.buyin + t.fee));

const CAREER_KEY = 'thsim_career_v1';
const Career = {
  p: null,
  load() {
    try { const s = localStorage.getItem(CAREER_KEY); this.p = s ? JSON.parse(s) : null; } catch (e) { this.p = null; }
    // 上次关闭页面时还坐在现金桌上：筹码退回资金
    if (this.p && this.p.activeSeat) {
      this.p.bankroll += this.p.activeSeat.stack;
      this.addHistory('cash', `${this.p.activeSeat.desc}（页面关闭，自动离桌）`, this.p.activeSeat.stack - this.p.activeSeat.invested, false);
      this.p.activeSeat = null;
      this.save();
    }
    if (this.p && this.p.activeTour) {
      this.addHistory('tour', `${this.p.activeTour.desc}（中途离开，视为弃赛）`, -this.p.activeTour.cost, false);
      this.p.activeTour = null;
      this.save();
    }
    return this.p;
  },
  save() { try { localStorage.setItem(CAREER_KEY, JSON.stringify(this.p)); } catch (e) { /* ignore */ } },
  create(name, start) {
    this.p = {
      name: name || '你', start, bankroll: start, peak: start, created: Date.now(),
      history: [], heroStats: null, hands: 0, activeSeat: null, activeTour: null, over: false,
      tourResults: [],
    };
    this.save();
  },
  reset() { this.p = null; try { localStorage.removeItem(CAREER_KEY); } catch (e) { /* ignore */ } },
  addHistory(type, desc, net, save = true) {
    this.p.history.unshift({ ts: Date.now(), type, desc, net, bankroll: this.p.bankroll });
    if (this.p.history.length > 200) this.p.history.length = 200;
    this.p.peak = Math.max(this.p.peak, this.p.bankroll);
    if (save) this.save();
  },
  checkOver() {
    if (this.p && !this.p.activeSeat && !this.p.activeTour && this.p.bankroll < MIN_ENTRY) { this.p.over = true; this.save(); }
    return this.p && this.p.over;
  },
  /* 资金管理评估：现金桌按满买入(100BB)计，锦标赛按（买入+手续费）计 */
  brm(cost, kind) {
    const n = this.p.bankroll / cost;
    const [good, ok, risky] = kind === 'tour' ? [50, 30, 15] : [30, 20, 10];
    if (n >= good) return { n, level: 'good', text: '稳健' };
    if (n >= ok) return { n, level: 'ok', text: '合理' };
    if (n >= risky) return { n, level: 'risky', text: '激进' };
    return { n, level: 'danger', text: '超出资金管理' };
  },
};

const HANDS_KEY = 'thsim_marked_v1';
const HandStore = {
  list() { try { return JSON.parse(localStorage.getItem(HANDS_KEY) || '[]'); } catch (e) { return []; } },
  saveAll(arr) {
    try { localStorage.setItem(HANDS_KEY, JSON.stringify(arr.slice(0, 120))); } catch (e) { /* ignore */ }
  },
  add(rec) { const a = this.list().filter((h) => h.id !== rec.id); a.unshift(rec); this.saveAll(a); },
  get(id) { return this.list().find((h) => h.id === id); },
  update(rec) { const a = this.list().map((h) => (h.id === rec.id ? rec : h)); this.saveAll(a); },
  remove(id) { this.saveAll(this.list().filter((h) => h.id !== id)); },
};
