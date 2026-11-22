import { DurableObject } from "cloudflare:workers";

const PAIRS = {
  USDJPY: { b: "USD", q: "JPY", d: 3, pip: 0.01, sp: 0.2 },
  EURUSD: { b: "EUR", q: "USD", d: 5, pip: 0.0001, sp: 0.3 },
  GBPUSD: { b: "GBP", q: "USD", d: 5, pip: 0.0001, sp: 0.5 },
  AUDUSD: { b: "AUD", q: "USD", d: 5, pip: 0.0001, sp: 0.4 },
  EURJPY: { b: "EUR", q: "JPY", d: 3, pip: 0.01, sp: 0.4 },
  GBPJPY: { b: "GBP", q: "JPY", d: 3, pip: 0.01, sp: 0.7 },
};
const BASE0 = { USDJPY: 152.4, EURUSD: 1.085, GBPUSD: 1.29, AUDUSD: 0.66 };
const VOL = { USDJPY: 0.00018, EURUSD: 0.00014, GBPUSD: 0.00017, AUDUSD: 0.00019 };
const STEP = 2000, HIST = 240, INIT = 1_000_000, LEV = 25;
const NEWS = [
  { h: "日銀総裁が早期の追加利上げを示唆", p: "USDJPY", d: -0.0035 },
  { h: "米雇用統計が予想を大幅に上回る", p: "USDJPY", d: 0.003 },
  { h: "米雇用統計が予想を下回り、利下げ観測が拡大", p: "USDJPY", d: -0.004 },
  { h: "ECBが利下げに前向きな姿勢を示す", p: "EURUSD", d: -0.003 },
  { h: "ユーロ圏のインフレ率が予想を上回る", p: "EURUSD", d: 0.0025 },
  { h: "英首相の失言で政局不安が拡大", p: "GBPUSD", d: -0.004 },
  { h: "英中銀が予想外の利上げを決定", p: "GBPUSD", d: 0.0035 },
  { h: "中国の景気刺激策で資源国通貨が上昇", p: "AUDUSD", d: 0.003 },
  { h: "豪中銀が据え置き、ハト派姿勢を示唆", p: "AUDUSD", d: -0.0025 },
];
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,OPTIONS" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...CORS } });
const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());

const T = (name, description, properties = {}, required = []) => ({ name, description, inputSchema: { type: "object", properties, required } });
const PAIR = { type: "string", enum: Object.keys(PAIRS), description: "Currency pair" };
const TOOLS = [
  T("get_market", "Get current bid/ask for all pairs, change since session start, and latest news headlines."),
  T("get_price_history", "Recent mid prices (one point per 2 seconds) with high/low/SMA20 for a pair.", { pair: PAIR, points: { type: "integer", description: "1-240, default 60" } }, ["pair"]),
  T("get_account", "Balance, equity, used/free margin, margin level and open positions with live P/L (JPY account, leverage 25x)."),
  T("place_order", "Open a market position. Buy fills at ask, sell at bid. units: 1000-500000. sl_pips/tp_pips are optional distances from the fill price.", { pair: PAIR, side: { type: "string", enum: ["buy", "sell"] }, units: { type: "integer" }, sl_pips: { type: "number" }, tp_pips: { type: "number" } }, ["pair", "side", "units"]),
  T("close_position", "Close one open position by id.", { id: { type: "integer" } }, ["id"]),
  T("close_all", "Close every open position at market."),
  T("get_news", "Recent market news events that moved prices."),
  T("get_activity", "Recent activity log (orders, closes, stop-outs) from both AI and human."),
  T("reset_account", "Reset the whole demo: balance back to 1,000,000 JPY, positions and history cleared."),
];
const LABEL = { get_market: "相場を確認", get_price_history: "価格推移を確認", get_account: "口座を確認", get_news: "ニュースを確認", get_activity: "操作履歴を確認" };

export class Market extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.s = (await ctx.storage.get("s")) || this.fresh();
    });
  }
  fresh() {
    const s = { t: Date.now(), px: { ...BASE0 }, drift: { USDJPY: 0, EURUSD: 0, GBPUSD: 0, AUDUSD: 0 }, hist: {}, bal: INIT, pos: [], closed: [], log: [], news: [], nid: 1 };
    for (const p in BASE0) s.hist[p] = [];
    for (let i = 0; i < HIST; i++) this.tick(s, true);
    return s;
  }
  mid(s, p) { return p === "EURJPY" ? s.px.EURUSD * s.px.USDJPY : p === "GBPJPY" ? s.px.GBPUSD * s.px.USDJPY : s.px[p]; }
  quote(s, p) { const m = this.mid(s, p), h = (PAIRS[p].sp * PAIRS[p].pip) / 2; return { bid: m - h, ask: m + h, mid: m }; }
  q2jpy(s, p) { return PAIRS[p].q === "JPY" ? 1 : s.px.USDJPY; }
  baseJPY(s, p) { const b = PAIRS[p].b; return b === "USD" ? s.px.USDJPY : s.px[b + "USD"] * s.px.USDJPY; }
  pnl(s, x) { const q = this.quote(s, x.pair); return (x.side === "buy" ? q.bid - x.open : x.open - q.ask) * x.units * this.q2jpy(s, x.pair); }
  lg(by, msg) { this.s.log.unshift({ t: Date.now(), by, msg }); this.s.log.length = Math.min(this.s.log.length, 40); }
  fmt(p, v) { return +v.toFixed(PAIRS[p].d); }

  tick(s, seed) {
    for (const p in BASE0) {
      const r = VOL[p] * gauss() + s.drift[p] - 0.0004 * Math.log(s.px[p] / BASE0[p]) * 0.1;
      s.drift[p] *= 0.7;
      s.px[p] *= Math.exp(r);
      s.hist[p].push(s.px[p]);
      if (s.hist[p].length > HIST) s.hist[p].shift();
    }
    if (!seed && Math.random() < 0.004) {
      const n = NEWS[Math.floor(Math.random() * NEWS.length)];
      s.drift[n.p] += n.d * 0.3;
      s.news.unshift({ t: Date.now(), h: n.h, pair: n.p, dir: n.d > 0 ? "up" : "down" });
      s.news.length = Math.min(s.news.length, 10);
    }
    if (!seed) this.stops();
  }
  stops() {
    const s = this.s;
    for (const x of [...s.pos]) {
      const q = this.quote(s, x.pair), px = x.side === "buy" ? q.bid : q.ask, up = x.side === "buy" ? 1 : -1;
      if (x.sl != null && (px - x.sl) * up <= 0) this.closePos(x, "損切り(SL)", "SYS");
      else if (x.tp != null && (px - x.tp) * up >= 0) this.closePos(x, "利確(TP)", "SYS");
    }
    const m = s.pos.reduce((a, x) => a + (x.units * this.baseJPY(s, x.pair)) / LEV, 0);
    const eq = s.bal + s.pos.reduce((a, x) => a + this.pnl(s, x), 0);
    if (m > 0 && eq / m < 0.5) { for (const x of [...s.pos]) this.closePos(x, "ロスカット", "SYS"); }
  }
  advance() {
    const s = this.s, n = Math.min(Math.floor((Date.now() - s.t) / STEP), 600);
    for (let i = 0; i < n; i++) this.tick(s);
    s.t = n >= 600 ? Date.now() : s.t + n * STEP;
  }
  closePos(x, reason, by) {
    const s = this.s, q = this.quote(s, x.pair), price = this.fmt(x.pair, x.side === "buy" ? q.bid : q.ask), pnl = Math.round(this.pnl(s, x));
    s.bal += pnl;
    s.pos = s.pos.filter((y) => y.id !== x.id);
    s.closed.unshift({ ...x, close: price, pnl, reason, tc: Date.now() });
    s.closed.length = Math.min(s.closed.length, 20);
    this.lg(by, `#${x.id} ${x.pair} ${x.side === "buy" ? "買い" : "売り"} を決済(${reason}) ${pnl >= 0 ? "+" : ""}${pnl.toLocaleString("ja-JP")}円`);
    return { id: x.id, close: price, pnl_jpy: pnl, reason };
  }
  acct() {
    const s = this.s, pnl = s.pos.reduce((a, x) => a + this.pnl(s, x), 0), margin = s.pos.reduce((a, x) => a + (x.units * this.baseJPY(s, x.pair)) / LEV, 0), equity = s.bal + pnl;
    return { balance: Math.round(s.bal), equity: Math.round(equity), unrealized_pnl: Math.round(pnl), margin: Math.round(margin), free_margin: Math.round(equity - margin), margin_level_pct: margin ? Math.round((equity / margin) * 100) : null, leverage: LEV, currency: "JPY" };
  }
  positions() {
    const s = this.s;
    return s.pos.map((x) => { const q = this.quote(s, x.pair); return { ...x, current: this.fmt(x.pair, x.side === "buy" ? q.bid : q.ask), pnl_jpy: Math.round(this.pnl(s, x)) }; });
  }
  hist(p) {
    const h = this.s.hist;
    if (p === "EURJPY") return h.EURUSD.map((v, i) => v * h.USDJPY[i]);
    if (p === "GBPJPY") return h.GBPUSD.map((v, i) => v * h.USDJPY[i]);
    return h[p];
  }
  quotes() {
    const s = this.s;
    return Object.keys(PAIRS).map((p) => { const q = this.quote(s, p), h = this.hist(p); return { pair: p, bid: this.fmt(p, q.bid), ask: this.fmt(p, q.ask), spread_pips: PAIRS[p].sp, change_pct: +((q.mid / h[0] - 1) * 100).toFixed(3), base_jpy: Math.round(this.baseJPY(s, p) * 1000) / 1000 }; });
  }

  async call(name, a, by) {
    this.advance();
    const s = this.s;
    let r;
    switch (name) {
      case "get_market": r = { quotes: this.quotes(), news: s.news.slice(0, 3) }; break;
      case "get_price_history": {
        if (!PAIRS[a.pair]) throw new Error("unknown pair");
        const n = Math.max(1, Math.min(a.points || 60, HIST)), h = this.hist(a.pair).slice(-n), f = (v) => this.fmt(a.pair, v), l = h.slice(-20);
        r = { pair: a.pair, step_sec: 2, prices: h.map(f), high: f(Math.max(...h)), low: f(Math.min(...h)), sma20: f(l.reduce((x, y) => x + y, 0) / l.length), change_pips: +((h[h.length - 1] - h[0]) / PAIRS[a.pair].pip).toFixed(1) };
        break;
      }
      case "get_account": r = { ...this.acct(), positions: this.positions() }; break;
      case "place_order": {
        const p = PAIRS[a.pair], u = Math.floor(a.units);
        if (!p) throw new Error("unknown pair");
        if (a.side !== "buy" && a.side !== "sell") throw new Error("side must be buy or sell");
        if (!(u >= 1000 && u <= 500000)) throw new Error("units must be 1000-500000");
        const need = (u * this.baseJPY(s, a.pair)) / LEV, ac = this.acct();
        if (need > ac.free_margin) throw new Error(`証拠金不足: 必要${Math.round(need)}円 / 余剰${ac.free_margin}円`);
        const q = this.quote(s, a.pair), open = this.fmt(a.pair, a.side === "buy" ? q.ask : q.bid), sg = a.side === "buy" ? 1 : -1;
        const x = { id: s.nid++, pair: a.pair, side: a.side, units: u, open, sl: a.sl_pips > 0 ? this.fmt(a.pair, open - sg * a.sl_pips * p.pip) : null, tp: a.tp_pips > 0 ? this.fmt(a.pair, open + sg * a.tp_pips * p.pip) : null, t: Date.now(), by };
        s.pos.push(x);
        this.lg(by, `${a.pair} を ${u.toLocaleString("ja-JP")}通貨 ${a.side === "buy" ? "買い" : "売り"} @${open}`);
        r = { position: x, account: this.acct() };
        break;
      }
      case "close_position": {
        const x = s.pos.find((y) => y.id === a.id);
        if (!x) throw new Error("position not found");
        r = { closed: this.closePos(x, "手動決済", by), account: this.acct() };
        break;
      }
      case "close_all": r = { closed: [...s.pos].map((x) => this.closePos(x, "全決済", by)), account: this.acct() }; break;
      case "get_news": r = { news: s.news }; break;
      case "get_activity": r = { log: s.log.slice(0, 20), recent_closed: s.closed.slice(0, 10) }; break;
      case "reset_account": { this.s = this.fresh(); this.lg(by, "デモ口座をリセット"); r = { ok: true, account: this.acct() }; break; }
      default: throw new Error("unknown tool: " + name);
    }
    if (by === "AI" && LABEL[name]) this.lg("AI", LABEL[name]);
    await this.ctx.storage.put("s", this.s);
    return r;
  }

  async rpc(m) {
    const id = m.id, ok = (result) => ({ jsonrpc: "2.0", id, result });
    if (id === undefined) return null;
    switch (m.method) {
      case "initialize": return ok({ protocolVersion: m.params?.protocolVersion || "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fx-demo", version: "1.0.0" }, instructions: "Virtual FX trading simulator (JPY account, 25x leverage). Prices move every 2 seconds. Check get_market and get_price_history before trading, and use sl_pips/tp_pips to manage risk." });
      case "ping": return ok({});
      case "tools/list": return ok({ tools: TOOLS });
      case "tools/call": {
        try { return ok({ content: [{ type: "text", text: JSON.stringify(await this.call(m.params?.name, m.params?.arguments || {}, "AI")) }] }); }
        catch (e) { return ok({ content: [{ type: "text", text: String(e.message || e) }], isError: true }); }
      }
      default: return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
    }
  }
  async mcp(req) {
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: CORS });
    let b;
    try { b = await req.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
    const out = [];
    for (const m of Array.isArray(b) ? b : [b]) { const r = await this.rpc(m); if (r) out.push(r); }
    if (!out.length) return new Response(null, { status: 202, headers: CORS });
    return json(Array.isArray(b) ? out : out[0]);
  }
  async fetch(req) {
    const u = new URL(req.url), p = u.pathname;
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (p === "/mcp") return this.mcp(req);
    if (p === "/api/state") {
      this.advance();
      await this.ctx.storage.put("s", this.s);
      const pair = PAIRS[u.searchParams.get("pair")] ? u.searchParams.get("pair") : "USDJPY";
      return json({ now: Date.now(), pair, hist: this.hist(pair).map((v) => this.fmt(pair, v)), quotes: this.quotes(), account: this.acct(), positions: this.positions(), closed: this.s.closed, log: this.s.log, news: this.s.news });
    }
    if (p.startsWith("/api/tool/") && req.method === "POST") {
      try { return json({ result: await this.call(p.slice(10), await req.json().catch(() => ({})), "UI") }); }
      catch (e) { return json({ error: String(e.message || e) }, 400); }
    }
    return new Response("Not found", { status: 404 });
  }
}

export default {
  fetch(req, env) {
    const p = new URL(req.url).pathname;
    if (p === "/mcp" || p.startsWith("/api/")) return env.MARKET.get(env.MARKET.idFromName("main")).fetch(req);
    return env.ASSETS.fetch(req);
  },
};
