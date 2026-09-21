import {
  analyse,
  deltaFromTrades,
  flowFromCandles,
  sma,
  cvdSeries,
  zoneStats,
} from "./analysis.js";
import {
  CATEGORIES,
  assetSource,
  SYMBOLS,
  TF_SECONDS,
  TIMEFRAMES,
  snapshot,
  stream,
  spotGold,
  tape,
  universe,
} from "./feed.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const el = (id) => document.getElementById(id);

const POLL_STREAM = 20000; // socket alive: REST only corrects drift
const POLL_REST = 3000; // no socket: REST is the only source
const POLL_FUTUROS = 2500; // futures have no usable socket, so REST carries it
const ANALYSIS_MS = 1200; // zones and score settle instead of flickering
const PAINT_MS = 40; // 25 redraws a second

/**
 * How fast a shown value catches its real one. The price is nearly immediate:
 * the stream already delivers every print, so smoothing it only adds lag on
 * top of the network's. The aggregates keep gliding, because they jump in
 * steps and the motion is what makes the step readable.
 */
const EASE_PRICE = 0.55;
const EASE_SLOW = 0.12;

const UP = "#2FE08A";
const DOWN = "#FF4D63";
const NEU = "#8FA39B";
const WARN = "#F5B72A";
const INFO = "#5C8CFF";

const MIN_BARS = 15;

/** Geometry of the last drawn chart, in CSS pixels, read by the gestures. */
const CHART = { W: 1002, H: 792, PR: 96 };
const TRADE_WINDOW = 600;

/** Bars of aggression read per timeframe, so each one reports its own window. */
const FLOW_BARS = { "1m": 20, "5m": 18, "15m": 16, "1h": 12, "4h": 12, "1d": 10 };

/** Gold tokens, shown against the real spot price rather than on their own. */
const OURO = new Set(["f:XAU", "PAXG", "XAUT"]);

const state = {
  symbol: "BTC",
  category: "principais",
  timeframe: "5m",
  depth: 0.5,
  zones: 6,
  data: null,
  trades: [],
  flow: null,
  digits: 2,
  view: { count: 150, offset: 0 },
  priceZoom: 1,
  margin: 8, // empty slots kept right of the last candle
  live: true,
  streaming: false,
  showSr: true,
  showFvg: false,
  analysis: null,
  aberta: null,
  pendente: null,
  ultima: null,
  barTime: null, // the open bar, so an entry waits for it to close
  flowBars: 0,
  lag: 0,
  spot: 0,
  statusLabel: "",
};

/**
 * Displayed values chase the real ones instead of snapping to them. The feed
 * still delivers exact numbers; this only decides how fast the screen catches
 * up, so a tick reads as movement rather than a jump.
 */
const shown = { price: 0, score: 50, buy: 0, sell: 0, change: 0 };
const approach = (cur, target, k = 0.16) =>
  Math.abs(target - cur) < 1e-9 ? target : cur + (target - cur) * k;

let socket = null;
let poller = null;
let lastAnalysis = 0;
let lastPaint = 0;
const sig = {}; // last markup written per block, so we only rewrite on change

// ---------------------------------------------------------------- operação
const trade = {
  key: () => `trade:${state.symbol}:${state.timeframe}`,

  load() {
    try {
      return JSON.parse(localStorage.getItem(trade.key()) || "null");
    } catch {
      return null;
    }
  },

  save(t) {
    try {
      if (t) localStorage.setItem(trade.key(), JSON.stringify(t));
      else localStorage.removeItem(trade.key());
    } catch {
      /* memory only */
    }
  },

  outcome(t, candles) {
    for (const c of candles.filter((c) => c.time >= t.abertura)) {
      if (t.side === "compra") {
        if (c.low <= t.stop) return "stop";
        if (c.high >= t.alvo) return "alvo";
      } else {
        if (c.high >= t.stop) return "stop";
        if (c.low <= t.alvo) return "alvo";
      }
    }
    return null;
  },
};

// ---------------------------------------------------------------- helpers
const fmt = (v, d = state.digits) =>
  Number(v).toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });

const short = (v) => {
  const a = Math.abs(v);
  // meme coins trade in billions of units, so the scale has to reach that far
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return v.toFixed(2);
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** A bar's stamp: the hour intraday, the date once bars last a day or more. */
function stamp(time) {
  const d = new Date(time);
  const dia = { day: "2-digit", month: "2-digit" };
  if (state.timeframe === "1d") return d.toLocaleDateString("pt-BR", dia);
  if (state.timeframe === "4h")
    return `${d.toLocaleDateString("pt-BR", dia)} ${String(d.getHours()).padStart(2, "0")}h`;
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

/** Time left on the open bar, in words. */
function faltam(ms) {
  if (ms <= 0) return "fechando";
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h) return `${h}h ${String(m).padStart(2, "0")}min`;
  if (m) return `${m}min ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

/** Enough decimals to separate two ticks, whatever the asset costs. */
function digitsFor(price) {
  if (!price || !isFinite(price)) return 2;
  if (price >= 1000) return 2;
  if (price >= 1) return 4;
  // below a unit, keep roughly five significant figures: a coin at 0,0000045
  // needs eight decimals before two levels stop reading as the same number
  return Math.min(8, Math.max(4, 4 - Math.floor(Math.log10(price))));
}

/** Rewrites a block only when its content actually changed. */
function swap(node, key, html) {
  if (sig[key] === html) return;
  sig[key] = html;
  node.innerHTML = html;
}

// ---------------------------------------------------------------- montagem
const R = {};

function mount() {
  el("hdr").innerHTML = `
    <span id="hPrice" style="font-size:20px;font-weight:600">—</span>
    <span id="hChange" style="font-size:12px"></span>
    <span id="hSpot" class="chip" hidden><i></i><span></span></span>
    <span id="hCvd" class="chip" hidden><i></i><span></span></span>
    <span id="hAtr" style="font-size:10px;color:var(--dim)"></span>`;

  el("side").innerHTML = `
    <div class="top-grid">
      <div class="card" style="display:flex;flex-direction:column;gap:2px">
        <div class="lbl">CONFLUÊNCIA</div>
        <div class="gauge-wrap">
          <svg viewBox="0 0 168 106" width="150" height="94">
            <path d="M 22 84 A 62 62 0 0 1 146 84" fill="none" stroke="#33413C"
              stroke-width="13" stroke-linecap="round"/>
            <path id="gArc" fill="none" stroke-width="13" stroke-linecap="round"/>
            <line id="gNeedle" x1="84" y1="84" stroke="#E6EFEA" stroke-width="2.4"
              stroke-linecap="round"/>
            <circle cx="84" cy="84" r="4.5" fill="#E6EFEA"/>
          </svg>
          <div class="gauge-score" id="gScore">—</div>
        </div>
        <div class="bias" id="gBias">—</div>
      </div>

      <div class="card" style="display:flex;flex-direction:column;gap:6px">
        <div class="lbl">AGRESSÃO <b id="aggWin" style="color:var(--muted)"></b></div>
        <div class="bars">
          <div class="bar-col">
            <div class="bar-track"><div class="bar-fill" id="aBuy" style="background:${UP}"></div></div>
            <span id="aBuyV" style="font-size:10px;color:${UP}">—</span>
          </div>
          <div class="bar-col">
            <div class="bar-track"><div class="bar-fill" id="aSell" style="background:${DOWN}"></div></div>
            <span id="aSellV" style="font-size:10px;color:var(--down-soft)">—</span>
          </div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--dim)">
          <span>COMPRA</span><span>VENDA</span>
        </div>
      </div>
    </div>

    <div class="card" id="planCard" style="display:flex;flex-direction:column;gap:7px">
      <div class="plan-head">
        <span class="lbl">PLANO SUGERIDO</span>
        <span class="muted" id="planStatus">aguardando</span>
      </div>
      <div id="planBody"></div>
      <div class="parts" id="planParts"></div>
    </div>

    <div class="card" style="display:flex;flex-direction:column;gap:5px">
      <div class="plan-head">
        <span class="lbl">SUPORTE &amp; RESISTÊNCIA</span>
        <span class="muted" id="srSrc">—</span>
      </div>
      <div class="sr-grid"><span></span><span class="right">SUP</span>
        <span class="right">RES</span><span class="right">TOTAL</span></div>
      <div id="srBody"></div>
    </div>

    <div class="card spread-card">
      <span class="lbl">SPREAD</span>
      <span class="muted" id="deltaV">—</span>
      <span id="spreadV" style="font-size:12px;font-weight:600">—</span>
    </div>`;

  [
    "hPrice", "hChange", "hCvd", "hSpot", "hAtr",
    "gArc", "gNeedle", "gScore", "gBias",
    "aBuy", "aSell", "aBuyV", "aSellV", "aggWin",
    "planCard", "planStatus", "planBody", "planParts",
    "srSrc", "srBody", "deltaV", "spreadV",
    "chart", "pills", "book", "chartSym", "statusDot", "statusText",
  ].forEach((id) => (R[id] = el(id)));
}

function buildControls() {
  const sym = el("symbol");
  SYMBOLS.forEach((s) => sym.add(new Option(s.label, s.id)));
  sym.value = state.symbol;

  const tf = el("timeframe");
  TIMEFRAMES.forEach((t) => tf.add(new Option(t, t)));
  tf.value = state.timeframe;

  // grouped by asset class, so the picker reads as what a thing is before it
  // reads as which corner of the market it sits in
  const cat = el("category");
  let grupo = null;
  CATEGORIES.forEach((c) => {
    if (!grupo || grupo.label !== c.classe) {
      grupo = document.createElement("optgroup");
      grupo.label = c.classe;
      cat.appendChild(grupo);
    }
    grupo.appendChild(new Option(c.label, c.id));
  });
  cat.value = state.category;

  sym.addEventListener("change", (e) => {
    state.symbol = e.target.value;
    reload();
  });
  tf.addEventListener("change", (e) => {
    state.timeframe = e.target.value;
    reload();
  });
  cat.addEventListener("change", (e) => {
    state.category = e.target.value;
    fillSymbols();
  });

  fillSymbols();

  el("depth").addEventListener("input", (e) => {
    state.depth = parseFloat(e.target.value);
    el("depthVal").textContent = e.target.value;
    lastAnalysis = 0;
  });
  el("zones").addEventListener("input", (e) => {
    state.zones = parseInt(e.target.value, 10);
    el("zonesVal").textContent = e.target.value;
    lastAnalysis = 0;
  });
  el("margin").addEventListener("input", (e) => {
    state.margin = parseInt(e.target.value, 10);
    el("marginVal").textContent = e.target.value;
  });

  el("bLive").addEventListener("click", () => {
    state.live = !state.live;
    el("bLive").textContent = state.live ? "Pausar" : "Ao vivo";
    if (state.live) start();
    else stop();
  });
  el("bSr").addEventListener("click", () => {
    state.showSr = !state.showSr;
    el("bSr").classList.toggle("on", state.showSr);
  });
  el("bFvg").addEventListener("click", () => {
    state.showFvg = !state.showFvg;
    el("bFvg").classList.toggle("on", state.showFvg);
  });

  el("bSr").classList.toggle("on", state.showSr);
  el("bFvg").classList.add("amber");
  bindGestures();
}

// ---------------------------------------------------------------- gestos
function bindGestures() {
  const wrap = el("chartWrap");
  const total = () => (state.data ? state.data.candles.length : 0);
  const pointers = new Map();
  let gesture = null;

  const clampView = () => {
    const n = total();
    if (!n) return;
    state.view.count = Math.max(MIN_BARS, Math.min(state.view.count, n));
    state.view.offset = Math.max(0, Math.min(state.view.offset, n - state.view.count));
  };

  const onAxis = (e) => {
    const r = wrap.getBoundingClientRect();
    return (e.clientX - r.left) / r.width > 1 - CHART.PR / CHART.W;
  };

  const spread = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  el("zoom").addEventListener("input", (e) => {
    state.view.count = Math.round((total() || 150) / parseFloat(e.target.value));
    clampView();
  });

  wrap.addEventListener(
    "wheel",
    (e) => {
      if (!total() || !e.ctrlKey) return;
      e.preventDefault();
      const r = wrap.getBoundingClientRect();
      const anchor = (e.clientX - r.left) / r.width;
      const before = state.view.count;
      state.view.count = Math.round(state.view.count * (e.deltaY > 0 ? 1.18 : 1 / 1.18));
      clampView();
      state.view.offset = Math.round(state.view.offset + (state.view.count - before) * (1 - anchor));
      clampView();
      syncZoom();
    },
    { passive: false }
  );

  wrap.addEventListener("pointerdown", (e) => {
    if (!total()) return;
    wrap.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2) {
      gesture = { type: "pinch", dist: spread() || 1, count: state.view.count };
    } else if (onAxis(e)) {
      gesture = { type: "scale", y: e.clientY, zoom: state.priceZoom };
      wrap.style.cursor = "ns-resize";
    } else {
      gesture = { type: "pan", x: e.clientX, offset: state.view.offset };
      wrap.style.cursor = "grabbing";
    }
  });

  wrap.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId) || !gesture) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const r = wrap.getBoundingClientRect();

    if (gesture.type === "pinch" && pointers.size >= 2) {
      state.view.count = Math.round(gesture.count / (spread() / gesture.dist));
      clampView();
      syncZoom();
    } else if (gesture.type === "scale") {
      const dy = (gesture.y - e.clientY) / r.height;
      state.priceZoom = clamp(gesture.zoom * (1 + dy * 2.2), 0.35, 6);
    } else if (gesture.type === "pan") {
      state.view.offset = Math.round(
        gesture.offset + (e.clientX - gesture.x) * (state.view.count / r.width)
      );
      clampView();
    }
  });

  const end = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) gesture = null;
    wrap.style.cursor = "grab";
  };
  wrap.addEventListener("pointerup", end);
  wrap.addEventListener("pointercancel", end);

  wrap.addEventListener("dblclick", () => {
    state.view = { count: total() || 150, offset: 0 };
    state.priceZoom = 1;
    syncZoom();
  });
}

function reload() {
  state.view = { count: 150, offset: 0 };
  state.priceZoom = 1;
  state.aberta = null;
  state.pendente = null;
  state.ultima = null;
  state.barTime = null;
  state.trades = [];
  state.data = null;
  state.analysis = null;
  shown.price = 0;
  start();
}

/** Refills the asset picker for the chosen group, from the live listing. */
async function fillSymbols() {
  const all = await universe();
  const group = CATEGORIES.find((c) => c.id === state.category);
  const list = group.assets
    ? group.assets.map((id) => all.find((a) => a.id === id)).filter(Boolean)
    : group.todos === "futuros"
      ? all.filter((a) => a.id.startsWith("f:"))
      : all.filter((a) => !a.id.startsWith("f:"));

  if (!list.length) return;

  const sym = el("symbol");
  sym.innerHTML = "";
  list.forEach((a) => sym.add(new Option(a.label, a.id)));

  // an asset outside the new group is replaced by the first one in it
  if (list.some((a) => a.id === state.symbol)) {
    sym.value = state.symbol;
  } else {
    state.symbol = list[0].id;
    sym.value = state.symbol;
    reload();
  }
}

function syncZoom() {
  const n = state.data ? state.data.candles.length : 150;
  el("zoom").value = clamp(n / state.view.count, 1, 10).toFixed(1);
}

// ---------------------------------------------------------------- dados
function status(kind, text) {
  R.statusDot.className = `dot ${kind}${kind === "live" ? " beat" : ""}`;
  state.statusLabel = text;
  R.statusText.textContent = text;
}

async function pull() {
  if (!state.live) return;
  try {
    const data = await snapshot(state.symbol, state.timeframe);

    // the socket owns the open candle, the book and the recent prints; REST
    // only refills the history behind them
    if (state.data && state.streaming) {
      const open = state.data.candles[state.data.candles.length - 1];
      if (open && data.candles.length && data.candles[data.candles.length - 1].time === open.time) {
        data.candles[data.candles.length - 1] = open;
      }
      data.book = state.data.book || data.book;
      data.stats = state.data.stats || data.stats;
    }

    state.data = data;
    if (!state.trades.length) state.trades = data.trades;
    state.digits = digitsFor(data.stats.price);
    if (!shown.price) shown.price = data.stats.price;
    lastAnalysis = 0;

    if (!state.streaming) status("live", `${data.source} · REST`);
  } catch (err) {
    status("off", err.message);
  }
}

function openSocket() {
  socket?.close();

  socket = stream(state.symbol, state.timeframe, {
    status: (up) => {
      state.streaming = up;
      status(up ? "live" : "", up ? `${state.data?.source || ""} ao vivo` : "reconectando…");
    },

    price: (p) => {
      if (state.data) state.data.stats.price = p;
    },

    lag: (ms) => {
      // a single print can arrive late; the running value is what to read
      if (ms >= 0 && ms < 30000) state.lag = state.lag ? state.lag * 0.9 + ms * 0.1 : ms;
    },

    stats: (s) => {
      if (state.data) state.data.stats = s;
    },

    trade: (t) => {
      state.trades.push(t);
      const over = state.trades.length - TRADE_WINDOW;
      if (over > 0) state.trades.splice(0, over);
    },

    candle: (c) => {
      if (!state.data) return;
      const list = state.data.candles;
      const last = list[list.length - 1];
      if (last && last.time === c.time) {
        list[list.length - 1] = c;
      } else {
        list.push(c);
        if (list.length > 400) list.shift();
        // a new bar shifts the window, so a scrolled view keeps its framing
        if (state.view.offset > 0) state.view.offset++;
      }
    },

    book: (b) => {
      if (state.data) state.data.book = b;
    },
  });

  state.streaming = false;
}

function start() {
  stop();
  openSocket();
  pull();
  pullSpot();
  const ritmo = socket.live
    ? POLL_STREAM
    : assetSource(state.symbol) === "futures"
      ? POLL_FUTUROS
      : POLL_REST;
  poller = setInterval(pull, ritmo);
}

function stop() {
  clearInterval(poller);
  socket?.close();
  socket = null;
  state.streaming = false;
}

async function pullSpot() {
  if (!OURO.has(state.symbol)) {
    state.spot = 0;
    return;
  }
  try {
    state.spot = await spotGold();
  } catch {
    state.spot = 0; // no reference is better than a stale one
  }
}

async function pullTape() {
  try {
    const rows = await tape();
    const html = rows
      .map(
        (t) => `<div class="item"><span class="sym">${esc(t.sym)}</span>
          <span class="val">${t.val.toLocaleString("pt-BR", { maximumFractionDigits: 4 })}</span>
          <span class="chg" style="color:${t.chg >= 0 ? UP : DOWN}">${
            t.chg >= 0 ? "+" : ""
          }${t.chg.toFixed(2)}%</span></div>`
      )
      .join("");
    el("tape").innerHTML = html + html; // duplicado para o laço da animação
  } catch {
    /* a fita não derruba o painel */
  }
}

// ---------------------------------------------------------------- operação
function manageTrade(result, candles, fechou) {
  if (state.aberta === null && state.ultima === null) state.aberta = trade.load();

  if (state.aberta) {
    const fim = trade.outcome(state.aberta, candles);
    if (!fim) {
      state.pendente = null;
      return state.aberta;
    }
    state.ultima = { ...state.aberta, resultado: fim };
    state.aberta = null;
    trade.save(null);
    return null;
  }

  const plano = result.plan;
  if (plano && plano.side !== "fora") {
    if (!fechou) {
      state.pendente = plano;
      return null;
    }
    state.pendente = null;
    const ultimo = candles[candles.length - 1];
    state.aberta = {
      side: plano.side,
      entrada: plano.entrada,
      stop: plano.stop,
      alvo: plano.alvo,
      rr: plano.rr,
      abertura: ultimo ? ultimo.time : Date.now(),
    };
    state.ultima = null;
    trade.save(state.aberta);
    return state.aberta;
  }

  state.pendente = null;
  return null;
}

// ---------------------------------------------------------------- laço
function loop(now) {
  requestAnimationFrame(loop);
  if (!state.data || !state.data.candles.length) return;

  if (now - lastAnalysis >= ANALYSIS_MS) {
    lastAnalysis = now;
    recompute();
  }
  if (now - lastPaint < PAINT_MS) return;
  lastPaint = now;
  paint();
}

function recompute() {
  const candles = state.data.candles;

  // bars when the source publishes taker volume, tape otherwise
  const perBar = flowFromCandles(candles, FLOW_BARS[state.timeframe] || 12);
  const flow = perBar || deltaFromTrades(state.trades);
  state.flow = flow;
  state.flowBars = perBar ? perBar.bars : 0;

  state.analysis = analyse(candles, {
    depth: state.depth,
    zoneLimit: state.zones,
    flow: { ...flow, total: flow.buy + flow.sell },
  });

  // an entry waits for the bar to close: a signal that only existed mid-bar
  // was never confirmed by the market
  const openTime = candles[candles.length - 1].time;
  if (state.barTime === null) state.barTime = openTime;
  const fechou = openTime !== state.barTime;
  if (fechou) state.barTime = openTime;

  state.aberta = manageTrade(state.analysis, candles, fechou);
  renderSide();
}

function paint() {
  const data = state.data;
  const result = state.analysis;
  if (!result) return;

  const price = data.stats.price || data.candles[data.candles.length - 1].close;
  shown.price = approach(shown.price || price, price, EASE_PRICE);
  shown.change = approach(shown.change, data.stats.changePct, EASE_SLOW);
  shown.score = approach(shown.score, result.score, 0.1);

  const flow = state.flow || { buy: 0, sell: 0, delta: 0 };
  shown.buy = approach(shown.buy, flow.buy, EASE_SLOW);
  shown.sell = approach(shown.sell, flow.sell, EASE_SLOW);

  R.chartSym.textContent = state.symbol;
  paintHeader(data, result);
  paintGauge();
  paintBars();
  paintBook(data.book, shown.price);

  const all = data.candles;
  const count = Math.min(state.view.count, all.length);
  const end = all.length - Math.min(state.view.offset, all.length - count);
  drawChart(result, all.slice(Math.max(0, end - count), end), shown.price, state.aberta);

  el("zoomVal").textContent = count;
  el("zoomLabel").textContent =
    count >= all.length && state.view.offset === 0
      ? "pince ou arraste o eixo para ajustar"
      : `${count} de ${all.length} barras · duplo clique reinicia`;
}

function paintHeader(data, result) {
  const col = shown.change >= 0 ? UP : DOWN;
  R.hPrice.textContent = fmt(shown.price);
  R.hPrice.style.color = col;
  R.hChange.textContent = `${shown.change >= 0 ? "+" : ""}${shown.change.toFixed(2)}%`;
  R.hChange.style.color = col;
  R.hAtr.textContent = `ATR ${fmt(result.atr)}`;
  R.statusText.textContent = state.lag
    ? `${state.statusLabel} · ${Math.round(state.lag)}ms`
    : state.statusLabel;

  if (state.spot && OURO.has(state.symbol)) {
    const dif = ((shown.price - state.spot) / state.spot) * 100;
    R.hSpot.hidden = false;
    R.hSpot.firstElementChild.style.background = Math.abs(dif) < 0.25 ? UP : WARN;
    R.hSpot.lastElementChild.textContent =
      `XAUUSD ${fmt(state.spot)} · ${dif >= 0 ? "+" : ""}${dif.toFixed(2)}%`;
  } else {
    R.hSpot.hidden = true;
  }

  const cvd = cvdSeries(data.candles);
  if (!cvd) {
    R.hCvd.hidden = true;
    return;
  }
  const now = cvd[cvd.length - 1];
  const rising = now >= cvd[Math.max(0, cvd.length - 11)];
  R.hCvd.hidden = false;
  R.hCvd.firstElementChild.style.background = rising ? UP : DOWN;
  R.hCvd.lastElementChild.textContent = `CVD ${short(now)}`;
}

function paintGauge() {
  const s = shown.score;
  const real = state.analysis.score;
  const dir = real >= 58 ? 1 : real <= 42 ? -1 : 0;
  const col = dir === 1 ? UP : dir === -1 ? DOWN : NEU;
  const a = Math.PI * (1 - s / 100);

  R.gArc.setAttribute(
    "d",
    `M 22 84 A 62 62 0 0 1 ${(84 + 62 * Math.cos(a)).toFixed(1)} ${(84 - 62 * Math.sin(a)).toFixed(1)}`
  );
  R.gArc.setAttribute("stroke", col);
  R.gNeedle.setAttribute("x2", (84 + 42 * Math.cos(a)).toFixed(1));
  R.gNeedle.setAttribute("y2", (84 - 42 * Math.sin(a)).toFixed(1));
  R.gScore.textContent = Math.round(s);
  R.gBias.textContent = dir === 1 ? "COMPRA" : dir === -1 ? "VENDA" : "NEUTRO";
  R.gBias.style.color = col;
}

function paintBars() {
  const total = shown.buy + shown.sell || 1;
  R.aBuy.style.height = `${Math.round((shown.buy / total) * 64)}px`;
  R.aSell.style.height = `${Math.round((shown.sell / total) * 64)}px`;
  R.aBuyV.textContent = short(shown.buy);
  R.aSellV.textContent = short(shown.sell);
  R.aggWin.textContent = state.flowBars
    ? `${state.flowBars}× ${state.timeframe}`
    : total > 1
      ? "tape"
      : "sem fluxo";

  const d = shown.buy - shown.sell;
  R.deltaV.textContent = `delta ${d >= 0 ? "+" : "−"}${short(Math.abs(d))}`;

  const book = state.data.book;
  R.spreadV.textContent =
    book && book.asks.length && book.bids.length
      ? fmt(book.asks[0].price - book.bids[0].price)
      : "—";
}

function renderSide() {
  const result = state.analysis;
  const aberta = state.aberta;

  R.planCard.style.borderColor = aberta ? (aberta.side === "compra" ? UP : DOWN) : "var(--line)";
  R.planStatus.textContent = aberta ? "em curso" : "aguardando";

  swap(R.planBody, "plan", planBody(aberta, result.plan));
  swap(R.planParts, "parts", partsRows(result.reasons));
  R.srSrc.textContent = state.data.source;

  const stats = zoneStats(result.zones);
  swap(
    R.srBody,
    "sr",
    [
      { label: "Zonas ativas", ...stats.ativas },
      { label: "Toques", ...stats.toques },
      { label: "Sweeps", ...stats.sweeps },
    ]
      .map(
        (r) => `<div class="sr-row"><span>${r.label}</span>
        <span class="right" style="color:${UP}">${r.sup}</span>
        <span class="right" style="color:${DOWN}">${r.res}</span>
        <span class="right">${r.total}</span></div>`
      )
      .join("")
  );
}

function planBody(aberta, plano) {
  if (aberta) {
    const col = aberta.side === "compra" ? UP : DOWN;
    const arrow = aberta.side === "compra" ? "M12 19V5M5 12l7-7 7 7" : "M12 5v14M5 12l7 7 7-7";
    const desde = new Date(aberta.abertura).toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
    });

    return `
      <div class="plan-dir">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${col}"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${arrow}"/></svg>
        <span class="word" style="color:${col}">${aberta.side.toUpperCase()}</span>
        <span style="margin-left:auto;font-size:10px;color:var(--dim)">R:R 1 : ${aberta.rr.toFixed(
          1
        )}</span>
      </div>
      <div style="font-size:10px;color:var(--dim);margin:2px 0 6px">desde ${desde}</div>
      <div class="tiles">
        <div class="tile"><div class="t" style="color:var(--dim)">ENTRADA</div>
          <div class="v">${fmt(aberta.entrada)}</div></div>
        <div class="tile"><div class="t" style="color:var(--down-soft)">STOP</div>
          <div class="v">${fmt(aberta.stop)}</div></div>
        <div class="tile"><div class="t" style="color:${WARN}">ALVO</div>
          <div class="v">${fmt(aberta.alvo)}</div></div>
      </div>`;
  }

  if (state.pendente) {
    const p = state.pendente;
    const col = p.side === "compra" ? UP : DOWN;
    const fim = (state.barTime || 0) + (TF_SECONDS[state.timeframe] || 60) * 1000;

    return `
      <div class="plan-wait" style="border-color:${col}66">
        <div class="plan-wait-head" style="color:${col}">SINAL DE ${p.side.toUpperCase()}</div>
        <div class="muted">confirma no fechamento da barra · faltam ${faltam(fim - Date.now())}</div>
      </div>
      <div class="tiles dim">
        <div class="tile"><div class="t" style="color:var(--dim)">ENTRADA</div>
          <div class="v">${fmt(p.entrada)}</div></div>
        <div class="tile"><div class="t" style="color:var(--down-soft)">STOP</div>
          <div class="v">${fmt(p.stop)}</div></div>
        <div class="tile"><div class="t" style="color:${WARN}">ALVO</div>
          <div class="v">${fmt(p.alvo)}</div></div>
      </div>`;
  }

  if (state.ultima) {
    const ok = state.ultima.resultado === "alvo";
    return `<div class="plan-result ${ok ? "ganho" : "perda"}">${
      ok ? "ALVO ATINGIDO" : "STOP ATINGIDO"
    }</div>
      <div class="plan-out">Última: ${state.ultima.side} em ${fmt(
        state.ultima.entrada
      )}.<br>Aguardando nova entrada.</div>`;
  }

  return `<div class="plan-out"><b>Sem operação.</b><br>${
    plano ? plano.motivo : "Sem leitura"
  }</div>`;
}

function partsRows(reasons) {
  return reasons
    .map((r) => {
      const positivo = /alta|apoiado|compradora/i.test(r);
      const negativo = /baixa|resistência|vendedora/i.test(r);
      const col = positivo ? UP : negativo ? DOWN : NEU;
      const w = positivo || negativo ? 34 : 8;
      const left = positivo ? 50 : negativo ? 50 - w : 46;
      return `<div class="part">
        <span class="name" title="${esc(r)}">${esc(r)}</span>
        <div class="track"><div class="zero"></div>
          <div class="fill" style="left:${left}%;width:${w}%;background:${col}"></div></div>
        <span class="val" style="color:${col}">${positivo ? "+" : negativo ? "−" : "0"}</span>
      </div>`;
    })
    .join("");
}

function paintBook(book, price) {
  if (!book || !book.asks.length) {
    swap(R.book, "book", `<div class="empty">Livro indisponível nesta fonte.</div>`);
    return;
  }

  const asks = book.asks.slice(0, 9).reverse();
  const bids = book.bids.slice(0, 9);
  const max = Math.max(...[...asks, ...bids].map((r) => r.qty), 1);

  const row = (r, side) => {
    const hot = Math.abs(r.price - price) / price < 0.0004;
    const bar = `<div class="fill" style="width:${(r.qty / max) * 100}%"></div><span>${short(
      r.qty
    )}</span>`;
    return `<div class="book-row ${hot ? "hot" : ""}">
      <div class="qty bid">${side === "bid" ? bar : ""}</div>
      <div class="px">${fmt(r.price)}</div>
      <div class="qty ask">${side === "ask" ? bar : ""}</div></div>`;
  };

  swap(
    R.book,
    "book",
    asks.map((r) => row(r, "ask")).join("") + bids.map((r) => row(r, "bid")).join("")
  );
}

// ---------------------------------------------------------------- gráfico
/**
 * The chart draws in CSS pixels: the viewBox is measured from the wrapper on
 * every frame, so a label is the same size on a phone as on a desktop and
 * nothing is stretched to fit. Bands shrink on a narrow screen instead of
 * being scaled down into illegibility.
 */
function geometry() {
  const r = el("chartWrap").getBoundingClientRect();
  const W = Math.max(300, Math.round(r.width));
  const H = Math.max(260, Math.round(r.height));
  const narrow = W < 620;

  const PR = narrow ? 56 : 96; // gutter for the price axis
  const PL = narrow ? 4 : 14;
  const PT = 12;
  const label = narrow ? 20 : 26; // time stamps
  const delta = Math.min(narrow ? 86 : 124, Math.round(H * 0.26));
  const sep = H - label - delta;

  return {
    W,
    H,
    PL,
    PR,
    PT,
    narrow,
    right: W - PR,
    sep,
    priceBot: sep - 8,
    dTop: sep + 7,
    dMid: sep + delta / 2,
    dBot: sep + delta - 5,
    dHalf: delta / 2 - 7,
    labelY: H - 6,
    font: narrow ? 9 : 10,
    ticks: narrow ? 5 : 7,
  };
}

function drawChart(result, candles, price, aberta) {
  if (!candles.length) return;

  const g = geometry();
  CHART.W = g.W;
  CHART.H = g.H;
  CHART.PR = g.PR;

  const frag = document.createDocumentFragment();
  const add = (tag, attrs, text) => {
    const n = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (text !== undefined) n.textContent = text;
    frag.appendChild(n);
    return n;
  };

  let lo = Math.min(...candles.map((c) => c.low));
  let hi = Math.max(...candles.map((c) => c.high));
  if (aberta) {
    [aberta.entrada, aberta.stop, aberta.alvo].forEach((v) => {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    });
  }
  const reach = (hi - lo) * 0.25;
  if (state.showSr) {
    result.zones.forEach((z) => {
      if (z.top >= lo - reach && z.bottom <= hi + reach) {
        lo = Math.min(lo, z.bottom);
        hi = Math.max(hi, z.top);
      }
    });
  }

  const span = hi - lo || 1;
  lo -= span * 0.05;
  hi += span * 0.05;
  if (state.priceZoom !== 1) {
    const mid = (lo + hi) / 2;
    const half = (hi - lo) / 2 / state.priceZoom;
    lo = mid - half;
    hi = mid + half;
  }

  const plotH = g.priceBot - g.PT;
  const y = (p) => g.PT + ((hi - p) / (hi - lo)) * plotH;
  const stepX = (g.W - g.PL - g.PR) / (candles.length + state.margin);
  const bw = Math.max(1, stepX * 0.56);
  const x = (i) => g.PL + i * stepX + stepX / 2;
  const right = g.right;
  const mono = { "font-size": g.font, "font-family": "IBM Plex Mono, monospace" };

  for (let i = 0; i <= g.ticks; i++) {
    const value = hi - ((hi - lo) / g.ticks) * i;
    const yy = y(value);
    add("line", { x1: 0, x2: right, y1: yy, y2: yy, stroke: "#18211E", "stroke-width": 1 });
    add("text", { x: g.W - 4, y: yy + 3, fill: NEU, "text-anchor": "end", ...mono }, fmt(value));
  }

  if (state.showSr) {
    result.zones.forEach((z) => {
      const top = y(z.top);
      const sup = z.kind === "support";
      add("rect", {
        x: 0,
        y: top,
        width: right,
        height: Math.max(2, Math.abs(y(z.bottom) - top)),
        fill: sup ? "rgba(47,224,138,.10)" : "rgba(255,77,99,.10)",
      });
      add("line", {
        x1: 0,
        x2: right,
        y1: y(z.mid),
        y2: y(z.mid),
        stroke: sup ? "rgba(47,224,138,.62)" : "rgba(255,77,99,.62)",
        "stroke-width": 1.1,
      });
    });
  }

  if (state.showFvg) {
    result.fvgs.forEach((gap) => {
      const top = y(gap.top);
      add("rect", {
        x: 0,
        y: top,
        width: right,
        height: Math.max(2, Math.abs(y(gap.bottom) - top)),
        fill: gap.kind === "bullish" ? "rgba(245,183,42,.09)" : "rgba(92,140,255,.09)",
      });
    });
  }

  const drawMa = (series, color) => {
    let d = "";
    series.forEach((v, i) => {
      if (v === null) return;
      d += `${d ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
    });
    if (d) add("path", { d, fill: "none", stroke: color, "stroke-width": 1.5, opacity: 0.8 });
  };
  drawMa(sma(candles, 9), WARN);
  drawMa(sma(candles, 21), INFO);

  candles.forEach((c, i) => {
    const cx = x(i);
    const color = c.close >= c.open ? UP : DOWN;
    add("line", { x1: cx, x2: cx, y1: y(c.high), y2: y(c.low), stroke: color, "stroke-width": 1 });
    add("rect", {
      x: cx - bw / 2,
      y: y(Math.max(c.open, c.close)),
      width: bw,
      height: Math.max(1, Math.abs(y(c.open) - y(c.close))),
      fill: color,
    });
  });

  add("line", {
    x1: 0,
    x2: right,
    y1: y(price),
    y2: y(price),
    stroke: "#E6EFEA",
    "stroke-width": 1,
    "stroke-dasharray": "2 3",
    opacity: 0.45,
  });

  // entrada, stop e alvo: a linha é a marcação, a etiqueta só a nomeia
  if (aberta) {
    const col = aberta.side === "compra" ? UP : DOWN;
    const level = (v, color, dash) =>
      add("line", {
        x1: 0,
        x2: right,
        y1: y(v),
        y2: y(v),
        stroke: color,
        "stroke-width": 1.4,
        ...(dash ? { "stroke-dasharray": dash } : {}),
      });
    level(aberta.alvo, WARN, "7 4");
    level(aberta.stop, DOWN, "7 4");
    level(aberta.entrada, col, null);
  }

  // delta por barra e CVD
  add("line", { x1: 0, x2: g.W, y1: g.sep, y2: g.sep, stroke: "#1E2724", "stroke-width": 1 });
  add("line", { x1: 0, x2: right, y1: g.dMid, y2: g.dMid, stroke: "#25302C", "stroke-width": 1 });

  if (candles.some((c) => typeof c.delta === "number")) {
    const dmax = Math.max(...candles.map((c) => Math.abs(c.delta || 0)), 1);
    candles.forEach((c, i) => {
      const h = (Math.abs(c.delta || 0) / dmax) * g.dHalf;
      const up = (c.delta || 0) >= 0;
      add("rect", {
        x: x(i) - bw / 2,
        y: up ? g.dMid - h : g.dMid,
        width: bw,
        height: h,
        fill: up ? "rgba(47,224,138,.75)" : "rgba(255,77,99,.75)",
      });
    });

    const cvd = cvdSeries(candles);
    if (cvd) {
      const cLo = Math.min(...cvd);
      const rg = Math.max(...cvd) - cLo || 1;
      const cy = (v) => g.dBot - ((v - cLo) / rg) * (g.dBot - g.dTop);
      let d = "";
      cvd.forEach((v, i) => (d += `${i ? "L" : "M"}${x(i).toFixed(1)} ${cy(v).toFixed(1)} `));
      add("path", { d, fill: "none", stroke: WARN, "stroke-width": 1.4 });
    }

    add("text", { x: 6, y: g.dTop - 2, fill: NEU, ...mono }, "DELTA");
    add("text", { x: 6 + g.font * 5.2, y: g.dTop - 2, fill: WARN, ...mono }, "CVD");
  } else {
    add(
      "text",
      { x: g.W / 2, y: g.dMid, fill: NEU, "text-anchor": "middle", ...mono },
      g.narrow ? "delta indisponível" : "delta por barra indisponível nesta fonte"
    );
  }

  const footY = g.H - (g.narrow ? 20 : 26);
  add("line", { x1: 0, x2: g.W, y1: footY, y2: footY, stroke: "#1E2724", "stroke-width": 1 });

  // stamps sit under the bar they belong to, so the margin does not skew them
  const marks = g.narrow ? [0.05, 0.5, 0.95] : [0.02, 0.27, 0.52, 0.77, 0.98];
  marks.forEach((f) => {
    const idx = Math.floor(f * (candles.length - 1));
    const c = candles[idx];
    if (!c) return;
    add(
      "text",
      { x: x(idx), y: g.labelY, fill: NEU, "text-anchor": "middle", ...mono },
      stamp(c.time)
    );
  });

  R.chart.setAttribute("viewBox", `0 0 ${g.W} ${g.H}`);
  R.chart.replaceChildren(frag);
  drawPills(result, aberta, y, g);
}

function drawPills(result, aberta, y, g) {
  const parts = [];
  const val = (v) =>
    g.narrow && Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("pt-BR") : fmt(v);

  // the svg now matches the wrapper pixel for pixel, so the axis gutter is a
  // plain pixel offset again
  const pill = (side, yy, bg, text) => {
    // a level scrolled out of the price band has no line on screen, so it gets
    // no tag either — otherwise the tag rides out over the header
    if (yy < g.PT + 7 || yy > g.priceBot - 7) return;
    parts.push(
      `<div class="pill" style="${side}:${side === "right" ? g.PR + 4 : 4}px;` +
        `top:${((yy / g.H) * 100).toFixed(2)}%;background:${bg}">${esc(text)}</div>`
    );
  };

  if (state.showSr) {
    result.zones.slice(0, g.narrow ? 2 : 3).forEach((z) => {
      const sup = z.kind === "support";
      pill(
        "left",
        y(z.mid),
        sup ? UP : DOWN,
        `${sup ? "SUP" : "RES"} ${val(z.mid)}${g.narrow ? "" : `  ${z.touches}T`}${
          z.swept && !g.narrow ? " · SW" : ""
        }`
      );
    });
  }

  if (aberta) {
    const col = aberta.side === "compra" ? UP : DOWN;
    pill("right", y(aberta.alvo), WARN, `ALVO ${val(aberta.alvo)}`);
    pill("right", y(aberta.stop), DOWN, `STOP ${val(aberta.stop)}`);
    pill("right", y(aberta.entrada), col, `${aberta.side.toUpperCase()} ${val(aberta.entrada)}`);
  }

  swap(R.pills, "pills", parts.join(""));
}

// ---------------------------------------------------------------- start
mount();
buildControls();
status("", "conectando…");
start();
pullTape();
setInterval(pullTape, 20000);
setInterval(pullSpot, 30000);
requestAnimationFrame(loop);
