import {
  FAMILIAS,
  acompanharStop,
  analyse,
  backtest,
  deltaFromTrades,
  OPERA,
  fichaComite,
  flowFromCandles,
  pivots,
  planoComite,
  sma,
  cvdSeries,
  testarFamilia,
  varrer,
  volumeProfile,
  zoneStats,
} from "./analysis.js?v=54";
import {
  capacidade,
  choques,
  correlacao,
  impacto,
  leque,
  melhorPar,
  monteCarlo,
  perfilDoLivro,
  porHora,
  riscoDaCarteira,
  tendenciaCorrelacao,
  volTermo,
} from "./mesa.js?v=54";
import {
  CATEGORIES,
  JANELA,
  assetSource,
  history,
  SYMBOLS,
  TF_SECONDS,
  TIMEFRAMES,
  snapshot,
  stream,
  positioning,
  spotGold,
  tape,
  universe,
} from "./feed.js?v=54";

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
  pos: null,
  scan: null,
  escaneando: false,
  dicaFechada: null,
  hist: null,
  ficha: null,
  fichando: false,
  fichaPasso: null,
  monte: null, monteRodando: false, montePasso: null, monteSel: null,
  cap: null, capRodando: false,
  mesa: null, mesaRodando: false, mesaPasso: null,
  lado: null, ladoRodando: false,
  choque: null, choqueRodando: false,
  sent: null, sentRodando: false,
  capOutros: null, capOutrosRodando: false,
  mapa: null,
  mapeando: false,
  mapaPasso: null,
  comite: null,
  comiteRodando: false,
  comiteChave: null,
  lab: null,
  labRodando: false,
  familia: "zonas",
  ranking: null,
  rankeando: false,
  rankingPasso: null,
  bt: null,
  btErro: null,
  varredura: null,
  varrendo: false,
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
let lastDeep = 0;
let lastBalao = 0;
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

  /** Replays the trade from its entry, moving the stop by the rule. */
  acompanhar(t, candles, atr) {
    return acompanharStop(t, candles, atr || t.atr || 0, pivots(candles));
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
  if (a >= 1) return v.toFixed(2);
  // a BTC lot is a fraction: two decimals would print every trade as zero
  return a ? String(Number(v.toPrecision(2))) : "0";
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

/** Round-trip fee, as a share of the position. */
function taxaAtual() {
  const t = config.load().taxa;
  return typeof t === "number" && t >= 0 ? t : 0.0002;
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

  let remedir = null;
  const remedirDepois = () => {
    clearTimeout(remedir);
    remedir = setTimeout(rodarBacktest, 500);
  };

  el("depth").addEventListener("input", (e) => {
    state.depth = parseFloat(e.target.value);
    el("depthVal").textContent = e.target.value;
    lastAnalysis = 0;
    remedirDepois();
  });
  el("zones").addEventListener("input", (e) => {
    state.zones = parseInt(e.target.value, 10);
    el("zonesVal").textContent = e.target.value;
    lastAnalysis = 0;
    remedirDepois();
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

  /**
   * The wheel zooms the chart, the way every chart does.
   *
   * It used to require the control key, which nobody guesses and nothing on the
   * screen said — so on a desktop the wheel simply did nothing over the chart.
   * Now it zooms around wherever the cursor is, and holding shift slides the
   * window sideways instead, which is the other thing a hand on a chart wants.
   */
  wrap.addEventListener(
    "wheel",
    (e) => {
      if (!total()) return;
      e.preventDefault();

      if (e.shiftKey) {
        const passo = Math.max(1, Math.round(state.view.count * 0.12));
        state.view.offset += e.deltaY > 0 ? -passo : passo;
        clampView();
        return;
      }

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
    // a class on the body so nothing anywhere starts highlighting mid-drag
    document.body.classList.add("arrastando");
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
    if (!pointers.size) document.body.classList.remove("arrastando");
  };
  wrap.addEventListener("pointerup", end);
  wrap.addEventListener("pointercancel", end);

  // a pointer released outside the chart never fires pointerup on it, and the
  // page would stay locked in the dragging state for good
  window.addEventListener("pointerup", () => {
    if (!pointers.size) document.body.classList.remove("arrastando");
  });

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
  state.scan = null;
  state.dicaFechada = null;
  state.ficha = null;
  start();
  rodarBacktest();
  escanear();
  renderFicha();
  renderRanking();
  state.lab = null;
  renderLab();
  state.comite = null;
  renderComite();
  medirComite();
  state.mapa = null;
  renderMapa();
  mapear();
  state.cap = null; renderCap();
  state.lado = null; renderLado();
  state.choque = null; renderChoque();
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
    // without a socket appending prints, each pull brings the current tape
    if (!state.streaming || !state.trades.length) state.trades = data.trades;
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
  pullDeep();
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
    const t = state.aberta;
    t.stopInicial = t.stopInicial ?? t.stop; // operação salva antes desta regra

    const passo = trade.acompanhar(t, candles, result.atr);
    const moveu = passo.stop !== t.stop;

    t.stop = passo.stop;
    t.empatou = passo.empatou;
    t.movimentos = passo.movimentos;

    if (!passo.resultado) {
      if (moveu) {
        const ultimo = passo.movimentos[passo.movimentos.length - 1];
        avisarStop(ultimo);
        trade.save(t);
      }
      state.pendente = null;
      return t;
    }

    state.ultima = { ...t, resultado: passo.resultado, r: passo.r, saida: passo.saida };
    historico.add({
      ...state.ultima,
      symbol: state.symbol,
      timeframe: state.timeframe,
      fechamento: Date.now(),
    });
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
      stopInicial: plano.stop,
      atr: result.atr,
      empatou: false,
      movimentos: [],
      abertura: ultimo ? ultimo.time : Date.now(),
      // the market as it stood when the call was made; reviewing a loss is
      // only useful next to what the panel was seeing at the time
      contexto: {
        score: result.score,
        motivos: result.reasons.slice(0, 3),
        funding: state.pos?.funding ?? null,
        grandes: state.pos?.grandes?.compradas ?? null,
        contas: state.pos?.contas?.compradas ?? null,
      },
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

// the panel keeps working from the home screen; the worker serves the shell
// from cache only when the network fails, so updates still land immediately
const mascoteImg = el("mascoteImg");
mascoteImg?.addEventListener("error", () => el("mascote")?.classList.add("vazio"));
if (mascoteImg && !mascoteImg.complete) mascoteImg.addEventListener("load", () => {});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
  if (!state.data || !state.data.candles.length) return;

  if (now - lastAnalysis >= ANALYSIS_MS) {
    lastAnalysis = now;
    recompute();
  }
  if (now - lastPaint < PAINT_MS) return;
  lastPaint = now;
  paint();

  if (!el("balao").hidden && now - lastBalao >= 2000) {
    lastBalao = now;
    renderBalao();
  }

  if (now - lastDeep >= DEEP_MS / 30) {
    lastDeep = now;
    const all = state.data.candles;
    const count = Math.min(state.view.count, all.length);
    const end = all.length - Math.min(state.view.offset, all.length - count);
    if (state.analysis) {
      paintDeep(all.slice(Math.max(0, end - count), end), shown.price, state.analysis);
    }
  }
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

  /**
   * In committee mode the plan comes from whichever seated reader speaks,
   * instead of from the single combined score. Everything downstream — the
   * chart lines, the trailing stop, the watcher — is untouched, because the
   * plan keeps its shape.
   */
  if (config.load().comite) {
    const assentos = (state.comite?.leitores || []).filter((l) => l.assento).map((l) => l.chave);
    state.analysis.plan = planoComite(candles, state.analysis.atr, assentos, {
      flowBars: FLOW_BARS[state.timeframe] || 12,
      depth: state.depth,
      zoneLimit: state.zones,
    });
  }

  // an entry waits for the bar to close: a signal that only existed mid-bar
  // was never confirmed by the market
  const openTime = candles[candles.length - 1].time;
  if (state.barTime === null) state.barTime = openTime;
  const fechou = openTime !== state.barTime;
  if (fechou) state.barTime = openTime;

  state.aberta = manageTrade(state.analysis, candles, fechou);
  renderSide();
  vigiar();
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

  // the "f:" prefix keeps futures ids unique internally; it is not a ticker
  R.chartSym.textContent = state.symbol.replace(/^f:/, "");
  paintHeader(data, result);
  paintGauge();
  paintBars();
  paintBook(data.book, shown.price);
  pintarMascote();
  pintarDica();

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
      <div class="plan-estado">
        <span>desde ${desde}</span>
        ${
          aberta.empatou
            ? `<span class="protegida">PROTEGIDA${
                aberta.movimentos?.length > 1 ? ` · ${aberta.movimentos.length} ajustes` : ""
              }</span>`
            : ""
        }
      </div>
      <div class="tiles">
        <div class="tile"><div class="t" style="color:var(--dim)">ENTRADA</div>
          <div class="v">${fmt(aberta.entrada)}</div></div>
        <div class="tile"><div class="t" style="color:var(--down-soft)">STOP</div>
          <div class="v">${fmt(aberta.stop)}</div></div>
        <div class="tile"><div class="t" style="color:${WARN}">ALVO</div>
          <div class="v">${fmt(aberta.alvo)}</div></div>
      </div>
      <div class="nota">Sem alvo fixo: a operação sai quando o stop móvel for atingido.
        A referência é só o nível que a estrutura sugeria.</div>`;
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

  /**
   * A reading the panel found and then refused, which is worth distinguishing
   * from having found nothing at all.
   */
  if (plano?.barrado) {
    return `<div class="plan-barrado">
        <div class="plan-wait-head" style="color:${DOWN}">LEITURA DE VENDA</div>
        <div class="muted">O painel opera só a compra. Medida em 18 ativos, a venda
          perdeu em alta, de lado e em queda — e afrouxar o stop dela não resolveu.
          Dá pra ligar em Configurações.</div>
      </div>`;
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
    add("line", {
      x1: 0, x2: right, y1: yy, y2: yy,
      stroke: "#18211E", "stroke-width": 1, "shape-rendering": "crispEdges",
    });
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
    // a reference the trade no longer closes at, drawn faintly to say so
    add("line", {
      x1: 0,
      x2: right,
      y1: y(aberta.alvo),
      y2: y(aberta.alvo),
      stroke: WARN,
      "stroke-width": 1,
      "stroke-dasharray": "2 6",
      opacity: 0.4,
    });

    // where the stop began, so the move is visible rather than assumed
    if (aberta.stopInicial && aberta.stopInicial !== aberta.stop) {
      add("line", {
        x1: 0,
        x2: right,
        y1: y(aberta.stopInicial),
        y2: y(aberta.stopInicial),
        stroke: DOWN,
        "stroke-width": 1,
        "stroke-dasharray": "2 6",
        opacity: 0.35,
      });
    }

    level(aberta.stop, aberta.empatou ? WARN : DOWN, "7 4");
    level(aberta.entrada, col, null);
  }

  // delta por barra e CVD
  add("line", {
    x1: 0, x2: g.W, y1: g.sep, y2: g.sep,
    stroke: "#1E2724", "stroke-width": 1, "shape-rendering": "crispEdges",
  });
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
  const ALTURA = 15;
  const ocupados = { left: [], right: [] };
  const livre = (side, v) => !ocupados[side].some((o) => Math.abs(o - v) < ALTURA);

  const pill = (side, yy, bg, text) => {
    // a level scrolled out of the price band has no line on screen, so it gets
    // no tag either — otherwise the tag rides out over the header
    if (yy < g.PT + 7 || yy > g.priceBot - 7) return;

    /**
     * Two levels at the same price — an entry and a stop moved to breakeven —
     * would stack their tags and hide one. The line stays at the true price;
     * only the tag steps aside, upward first, so a stop that came up to the
     * entry reads as having moved.
     */
    let pos = yy;
    for (let i = 1; i <= 6 && !livre(side, pos); i++) {
      const acima = yy - i * ALTURA;
      const abaixo = yy + i * ALTURA;
      if (acima > g.PT + 7 && livre(side, acima)) pos = acima;
      else if (abaixo < g.priceBot - 7 && livre(side, abaixo)) pos = abaixo;
    }
    ocupados[side].push(pos);

    parts.push(
      `<div class="pill" style="${side}:${side === "right" ? g.PR + 4 : 4}px;` +
        `top:${((pos / g.H) * 100).toFixed(2)}%;background:${bg}">${esc(text)}</div>`
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
    pill("right", y(aberta.entrada), col, `${aberta.side.toUpperCase()} ${val(aberta.entrada)}`);
    pill(
      "right",
      y(aberta.stop),
      aberta.empatou ? WARN : DOWN,
      `${aberta.empatou ? "STOP ✓ ZERO A ZERO" : "STOP"} ${val(aberta.stop)}`
    );
  }

  swap(R.pills, "pills", parts.join(""));
}

// ---------------------------------------------------------------- profundidade
const DEEP_MS = 30000;

/**
 * Closed operations, kept across sessions.
 *
 * A panel that suggests entries and forgets them can never be judged. Every
 * finished trade lands here with what it was worth in R, so the scoreboard is
 * a record rather than an impression.
 */
const historico = {
  chave: "painel:historico",

  load() {
    try {
      return JSON.parse(localStorage.getItem(historico.chave) || "[]");
    } catch {
      return [];
    }
  },

  add(t) {
    const lista = historico.load();
    lista.push(t);
    if (lista.length > 300) lista.splice(0, lista.length - 300);
    try {
      localStorage.setItem(historico.chave, JSON.stringify(lista));
    } catch {
      /* memory only */
    }
    return lista;
  },
};

async function pullDeep() {
  try {
    state.pos = await positioning(state.symbol);
  } catch {
    state.pos = null; // no positioning is better than stale positioning
  }
}

function mountDeep() {
  el("deep").innerHTML = `
    <div class="deep-head">
      <span class="deep-title">DETALHE</span>
      <span class="muted">posicionamento, volume por preço, histórico e sessão</span>
    </div>

    <div class="deep-grid">
      <div class="card deep-card" id="cardPos">
        <div class="plan-head">
          <span class="lbl">FLUXO &amp; POSICIONAMENTO</span>
          <span class="muted" id="posSym">—</span>
        </div>
        <div id="posBody" class="deep-body"></div>
      </div>

      <div class="card deep-card" id="cardPerfil">
        <div class="plan-head">
          <span class="lbl">PERFIL DE VOLUME</span>
          <span class="muted" id="perfilInfo">—</span>
        </div>
        <div id="perfilBody" class="deep-body"></div>
      </div>

      <div class="card deep-card" id="cardPlacar">
        <div class="plan-head">
          <span class="lbl">PLACAR DAS OPERAÇÕES</span>
          <span class="muted" id="placarInfo">—</span>
        </div>
        <div id="placarBody" class="deep-body"></div>
      </div>

      <div class="card deep-card" id="cardBt">
        <div class="plan-head">
          <span class="lbl">MEDIÇÃO DA ESTRATÉGIA</span>
          <span class="muted" id="btInfo">—</span>
        </div>
        <div id="btBody" class="deep-body"></div>
      </div>

      <div class="card deep-card" id="cardFicha">
        <div class="plan-head">
          <span class="lbl">FICHA DO ATIVO</span>
          <span class="muted" id="fichaInfo">—</span>
        </div>
        <div id="fichaBody" class="deep-body"></div>
      </div>







      <div class="card deep-card" id="cardMapa">
        <div class="plan-head">
          <span class="lbl">MAPA DO ATIVO</span>
          <span class="muted" id="mapaInfo">—</span>
        </div>
        <div id="mapaBody" class="deep-body"></div>
      </div>

      <div class="card deep-card" id="cardComite">
        <div class="plan-head">
          <span class="lbl">COMITÊ DE LEITORES</span>
          <span class="muted" id="comiteInfo">—</span>
        </div>
        <div id="comiteBody" class="deep-body"></div>
      </div>

      <div class="card deep-card" id="cardLab">
        <div class="plan-head">
          <span class="lbl">LABORATÓRIO DE IDEIAS</span>
          <span class="muted" id="labInfo">—</span>
        </div>
        <div id="labBody" class="deep-body"></div>
      </div>

      <div class="card deep-card" id="cardRank">
        <div class="plan-head">
          <span class="lbl">RANKING DOS ATIVOS</span>
          <span class="muted" id="rankInfo">—</span>
        </div>
        <div id="rankBody" class="deep-body"></div>
      </div>

      <div class="card deep-card" id="cardBaleia">
        <div class="plan-head">
          <span class="lbl">NEGÓCIOS GRANDES</span>
          <span class="muted" id="baleiaInfo">—</span>
        </div>
        <div id="baleiaBody" class="deep-body"></div>
      </div>

      <div class="card deep-card" id="cardSessao">
        <div class="plan-head">
          <span class="lbl">SESSÃO</span>
          <span class="muted" id="sessaoInfo">—</span>
        </div>
        <div id="sessaoBody" class="deep-body"></div>
      </div>
    </div>`;

  /**
   * The desk screens live outside the panel.
   *
   * They are not chart detail and do not belong under the chart — a path opens
   * each one on its own, and this holder is only where they wait. It stays
   * hidden, so the blocks are never a second copy of anything on screen.
   */
  const telas = document.createElement("div");
  telas.id = "telas";
  telas.hidden = true;
  telas.innerHTML = `      <div class="card deep-card" id="cardSent">
        <div class="plan-head"><span class="lbl">SENTIMENTO DO MERCADO</span>
          <span class="muted" id="sentInfo">—</span></div>
        <div id="sentBody" class="deep-body"></div>
      </div>
      <div class="card deep-card" id="cardMonte">
        <div class="plan-head"><span class="lbl">MONTE CARLO</span>
          <span class="muted" id="monteInfo">—</span></div>
        <div id="monteBody" class="deep-body"></div>
      </div>
      <div class="card deep-card" id="cardCap">
        <div class="plan-head"><span class="lbl">CAPACIDADE E IMPACTO</span>
          <span class="muted" id="capInfo">—</span></div>
        <div id="capBody" class="deep-body"></div>
      </div>
      <div class="card deep-card" id="cardMesa">
        <div class="plan-head"><span class="lbl">MESA DE RISCO</span>
          <span class="muted" id="mesaInfo">—</span></div>
        <div id="mesaBody" class="deep-body"></div>
      </div>
      <div class="card deep-card" id="cardLado">
        <div class="plan-head"><span class="lbl">QUEM ESTÁ DO OUTRO LADO</span>
          <span class="muted" id="ladoInfo">—</span></div>
        <div id="ladoBody" class="deep-body"></div>
      </div>
      <div class="card deep-card" id="cardChoque">
        <div class="plan-head"><span class="lbl">CHOQUES E VOLATILIDADE</span>
          <span class="muted" id="choqueInfo">—</span></div>
        <div id="choqueBody" class="deep-body"></div>
      </div>`;
  document.body.appendChild(telas);

  ["posSym", "posBody", "perfilInfo", "perfilBody", "placarInfo", "placarBody",
   "sessaoInfo", "sessaoBody", "btInfo", "btBody", "baleiaInfo", "baleiaBody", "fichaInfo", "fichaBody", "rankInfo", "rankBody", "labInfo", "labBody", "comiteInfo", "comiteBody", "mapaInfo", "mapaBody", "monteInfo", "monteBody", "capInfo", "capBody", "mesaInfo", "mesaBody", "ladoInfo", "ladoBody", "choqueInfo", "choqueBody", "sentInfo", "sentBody"].forEach((id) => (R[id] = el(id)));
}

/** A line chart small enough to read as a shape rather than a chart. */
function sparkline(valores, cor, altura = 34) {
  if (!valores || valores.length < 2) return `<div class="spark-vazio">sem série</div>`;

  const lo = Math.min(...valores);
  const hi = Math.max(...valores);
  const faixa = hi - lo || 1;
  const L = 160;
  const passo = L / (valores.length - 1);

  let d = "";
  valores.forEach((v, i) => {
    const x = (i * passo).toFixed(1);
    const y = (altura - 3 - ((v - lo) / faixa) * (altura - 6)).toFixed(1);
    d += `${i ? "L" : "M"}${x} ${y} `;
  });

  const area = `${d}L${L} ${altura} L0 ${altura} Z`;

  /**
   * The drawing is stretched to whatever width the card is, and a stroke
   * stretches with it — on a 300px card a 160-unit viewBox widens by nearly
   * two, so a 1.5px line becomes 2.9px across and 1.5px down. The eye reads
   * that unevenness as blur. non-scaling-stroke keeps the pen the same width
   * in real pixels however far the geometry is pulled.
   */
  return `<svg class="spark" viewBox="0 0 ${L} ${altura}" preserveAspectRatio="none">
    <path d="${area}" fill="${cor}" opacity="0.12"/>
    <path d="${d}" fill="none" stroke="${cor}" stroke-width="1.5"
      vector-effect="non-scaling-stroke" class="spark-linha"/>
  </svg>`;
}

/** Two sides of a crowd, as one bar. */
function barraLados(compradas, vendidas, rotulo) {
  const pc = Math.round(compradas * 100);
  return `<div class="lado">
    <div class="lado-topo"><span>${rotulo}</span>
      <span><b style="color:${UP}">${pc}%</b> / <b style="color:${DOWN}">${100 - pc}%</b></span></div>
    <div class="lado-barra">
      <div class="lado-compra" style="width:${pc}%"></div>
      <div class="lado-venda" style="width:${100 - pc}%"></div>
    </div>
  </div>`;
}

function renderPos() {
  const p = state.pos;

  if (!p) {
    R.posSym.textContent = "—";
    swap(R.posBody, "pos", `<div class="vazio">Este ativo não tem contrato perpétuo na
      Binance, então não há funding, open interest nem posicionamento para mostrar.</div>`);
    return;
  }

  R.posSym.textContent = p.simbolo;

  const anual = p.funding != null ? p.funding * 3 * 365 * 100 : null;
  const corF = p.funding >= 0 ? UP : DOWN;
  const faltam = p.proximoFunding ? p.proximoFunding - Date.now() : 0;

  const oiVals = p.oi.map((o) => o.valor);
  const oiAtual = oiVals[oiVals.length - 1] || 0;
  const oiAntes = oiVals[0] || oiAtual;
  const oiVar = oiAntes ? ((oiAtual - oiAntes) / oiAntes) * 100 : 0;

  const takerVals = p.taker.map((t) => t.razao);
  const takerAtual = takerVals[takerVals.length - 1];

  // the reading worth surfacing: when the crowd and the size disagree
  let divergencia = "";
  if (p.contas && p.grandes) {
    const varejo = p.contas.compradas - 0.5;
    const size = p.grandes.compradas - 0.5;
    if (varejo * size < 0 && Math.abs(varejo) > 0.03 && Math.abs(size) > 0.03) {
      const quem = size > 0 ? "grandes comprados" : "grandes vendidos";
      const outro = varejo > 0 ? "varejo comprado" : "varejo vendido";
      divergencia = `<div class="diverge" style="border-color:${size > 0 ? UP : DOWN}66">
        <b style="color:${size > 0 ? UP : DOWN}">DIVERGÊNCIA</b> — ${outro}, ${quem}</div>`;
    }
  }

  swap(
    R.posBody,
    "pos",
    `<div class="metricas">
      <div class="metrica">
        <span class="m-rot">FUNDING</span>
        <span class="m-val" style="color:${corF}">${
          p.funding != null ? `${(p.funding * 100).toFixed(4)}%` : "—"
        }</span>
        <span class="m-sub">${anual != null ? `${anual.toFixed(1)}% ao ano` : ""}</span>
      </div>
      <div class="metrica">
        <span class="m-rot">PRÓXIMO EM</span>
        <span class="m-val" id="fundingConta">${faltam > 0 ? faltam2h(faltam) : "—"}</span>
        <span class="m-sub">a cada 8 horas</span>
      </div>
      <div class="metrica">
        <span class="m-rot">OPEN INTEREST</span>
        <span class="m-val">${short(oiAtual)}</span>
        <span class="m-sub" style="color:${oiVar >= 0 ? UP : DOWN}">${
          oiVar >= 0 ? "+" : ""
        }${oiVar.toFixed(2)}% em 4h</span>
      </div>
      <div class="metrica">
        <span class="m-rot">AGRESSÃO TAKER</span>
        <span class="m-val" style="color:${takerAtual >= 1 ? UP : DOWN}">${
          takerAtual != null ? takerAtual.toFixed(2) : "—"
        }</span>
        <span class="m-sub">compra ÷ venda</span>
      </div>
    </div>

    <div class="sparks">
      <div class="spark-box">
        <span class="m-rot">OPEN INTEREST · 4h</span>
        ${sparkline(oiVals, INFO)}
      </div>
      <div class="spark-box">
        <span class="m-rot">RAZÃO TAKER · 4h</span>
        ${sparkline(takerVals, WARN)}
      </div>
    </div>

    ${p.contas ? barraLados(p.contas.compradas, p.contas.vendidas, "Todas as contas") : ""}
    ${p.grandes ? barraLados(p.grandes.compradas, p.grandes.vendidas, "Maiores posições") : ""}
    ${divergencia}`
  );
}

/** Countdown to the next funding, in hours and minutes. */
function faltam2h(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}min` : `${m}min ${String(s).padStart(2, "0")}s`;
}

function renderPerfil(candles, price) {
  const vp = volumeProfile(candles);

  if (!vp) {
    swap(R.perfilBody, "perfil", `<div class="vazio">Poucas barras para montar o perfil.</div>`);
    return;
  }

  const poc = vp.bins[vp.poc];
  R.perfilInfo.textContent = `POC ${fmt((poc.lo + poc.hi) / 2)}`;

  const linhas = [...vp.bins]
    .reverse()
    .map((b) => {
      const dentro = b.lo >= vp.vaBaixo - 1e-9 && b.hi <= vp.vaAlto + 1e-9;
      const aqui = price >= b.lo && price < b.hi;
      const ehPoc = b === poc;
      const largura = (b.vol / vp.max) * 100;
      const cor = ehPoc ? WARN : dentro ? INFO : "#31403B";

      return `<div class="perfil-linha ${aqui ? "aqui" : ""}">
        <span class="perfil-preco">${fmt((b.lo + b.hi) / 2)}</span>
        <div class="perfil-trilho">
          <div class="perfil-barra" style="width:${largura.toFixed(1)}%;background:${cor}"></div>
          ${b.delta ? `<span class="perfil-delta" style="color:${b.delta >= 0 ? UP : DOWN}">${
            b.delta >= 0 ? "+" : "−"
          }${short(Math.abs(b.delta))}</span>` : ""}
        </div>
      </div>`;
    })
    .join("");

  swap(
    R.perfilBody,
    "perfil",
    `<div class="perfil">${linhas}</div>
     <div class="perfil-legenda">
       <span><i style="background:${WARN}"></i> POC — preço mais negociado</span>
       <span><i style="background:${INFO}"></i> área de valor (70%) ${fmt(vp.vaBaixo)} a ${fmt(vp.vaAlto)}</span>
     </div>`
  );
}

function renderPlacar() {
  const todas = historico.load();
  const doAtivo = todas.filter((t) => t.symbol === state.symbol);
  const lista = doAtivo.length ? doAtivo : todas;

  R.placarInfo.textContent = doAtivo.length
    ? `${state.symbol.replace(/^f:/, "")} · ${doAtivo.length}`
    : `todos · ${todas.length}`;

  if (!lista.length) {
    swap(
      R.placarBody,
      "placar",
      `<div class="vazio">Nenhuma operação fechada ainda. Assim que uma entrada bater
       o alvo ou o stop, ela entra aqui com o resultado em R — e o placar passa a
       dizer se a leitura funciona, em vez de você ter que confiar nela.</div>`
    );
    return;
  }

  const alvos = lista.filter((t) => t.resultado === "alvo").length;
  const empates = lista.filter((t) => t.resultado === "empate").length;
  const stops = lista.length - alvos - empates;
  const taxa = (alvos / lista.length) * 100;
  const erre = (t) => t.r ?? (t.resultado === "alvo" ? t.rr : -1);
  const rTotal = lista.reduce((a, t) => a + erre(t), 0);
  const corR = rTotal >= 0 ? UP : DOWN;

  const ultimas = lista
    .slice(-8)
    .reverse()
    .map((t) => {
      const ok = t.resultado === "alvo";
      const empate = t.resultado === "empate";
      const r = erre(t);
      const c = t.contexto;
      const porque = c
        ? `placar ${c.score}` +
          (c.motivos?.length ? ` · ${c.motivos.join(" · ")}` : "") +
          (c.funding != null ? ` · funding ${(c.funding * 100).toFixed(4)}%` : "") +
          (c.grandes != null ? ` · grandes ${(c.grandes * 100).toFixed(0)}% comprados` : "")
        : "sem contexto guardado";

      return `<div class="hist-linha" title="${esc(porque)}">
        <span style="color:${t.side === "compra" ? UP : DOWN}">${t.side === "compra" ? "▲" : "▼"}</span>
        <span class="hist-sym">${t.symbol.replace(/^f:/, "")} ${t.timeframe}</span>
        ${c ? `<span class="hist-score">${c.score}</span>` : ""}
        <span class="hist-preco">${fmt(t.entrada, digitsFor(t.entrada))}</span>
        <span class="hist-res ${ok ? "ganho" : empate ? "neutro" : "perda"}">${
          ok ? "ALVO" : empate ? "EMPATE" : "STOP"
        }</span>
        <span class="hist-r" style="color:${r > 0 ? UP : r < 0 ? DOWN : NEU}">${
          r >= 0 ? "+" : ""
        }${r.toFixed(2)}R</span>
      </div>`;
    })
    .join("");

  swap(
    R.placarBody,
    "placar",
    `<div class="metricas">
      <div class="metrica"><span class="m-rot">OPERAÇÕES</span>
        <span class="m-val">${lista.length}</span></div>
      <div class="metrica"><span class="m-rot">ALVO</span>
        <span class="m-val" style="color:${UP}">${alvos}</span></div>
      <div class="metrica"><span class="m-rot">EMPATE</span>
        <span class="m-val" style="color:${NEU}">${empates}</span></div>
      <div class="metrica"><span class="m-rot">STOP</span>
        <span class="m-val" style="color:${DOWN}">${stops}</span></div>
      <div class="metrica"><span class="m-rot">RESULTADO</span>
        <span class="m-val" style="color:${corR}">${rTotal >= 0 ? "+" : ""}${rTotal.toFixed(1)}R</span>
        <span class="m-sub">acerto ${taxa.toFixed(0)}%</span></div>
    </div>
    <div class="hist">${ultimas}</div>
    ${
      lista[lista.length - 1]?.contexto
        ? `<div class="nota"><b>Última:</b> ${(() => {
            const u = lista[lista.length - 1];
            const c = u.contexto;
            return `${u.side} com placar ${c.score}${
              c.motivos?.length ? ` — ${c.motivos.join(", ")}` : ""
            }${c.grandes != null ? `; grandes ${(c.grandes * 100).toFixed(0)}% comprados` : ""}.`;
          })()}</div>`
        : ""
    }
    <div class="nota">R é o resultado medido no risco da própria operação: +2R significa
      que ela rendeu duas vezes o que arriscava. Sem taxa e sem deslize.</div>`
  );
}

function renderSessao(candles, result) {
  if (!candles.length) return;

  const alta = Math.max(...candles.map((c) => c.high));
  const baixa = Math.min(...candles.map((c) => c.low));
  const amplitude = alta - baixa;
  const price = candles[candles.length - 1].close;
  const posicao = amplitude ? ((price - baixa) / amplitude) * 100 : 50;

  const vol = candles.reduce((a, c) => a + (c.volume || 0), 0);
  const maior = candles.reduce((a, c) => (Math.abs(c.close - c.open) > Math.abs(a.close - a.open) ? c : a));

  // how many bars the market has been pushing the same way
  let seq = 1;
  const subindo = candles[candles.length - 1].close >= candles[candles.length - 1].open;
  for (let i = candles.length - 2; i >= 0; i--) {
    if (candles[i].close >= candles[i].open === subindo) seq++;
    else break;
  }

  const atrPct = price ? (result.atr / price) * 100 : 0;
  R.sessaoInfo.textContent = `${candles.length} barras · ${state.timeframe}`;

  swap(
    R.sessaoBody,
    "sessao",
    `<div class="metricas">
      <div class="metrica"><span class="m-rot">MÁXIMA</span>
        <span class="m-val">${fmt(alta)}</span></div>
      <div class="metrica"><span class="m-rot">MÍNIMA</span>
        <span class="m-val">${fmt(baixa)}</span></div>
      <div class="metrica"><span class="m-rot">AMPLITUDE</span>
        <span class="m-val">${fmt(amplitude)}</span>
        <span class="m-sub">${((amplitude / baixa) * 100).toFixed(2)}%</span></div>
      <div class="metrica"><span class="m-rot">ATR</span>
        <span class="m-val">${atrPct.toFixed(2)}%</span>
        <span class="m-sub">${fmt(result.atr)}</span></div>
    </div>

    <div class="faixa">
      <div class="faixa-topo"><span>${fmt(baixa)}</span><span>onde está na faixa</span><span>${fmt(alta)}</span></div>
      <div class="faixa-trilho"><div class="faixa-marca" style="left:${posicao.toFixed(1)}%"></div></div>
    </div>

    <div class="metricas">
      <div class="metrica"><span class="m-rot">VOLUME DA JANELA</span>
        <span class="m-val">${short(vol)}</span></div>
      <div class="metrica"><span class="m-rot">MAIOR BARRA</span>
        <span class="m-val" style="color:${maior.close >= maior.open ? UP : DOWN}">${fmt(
          Math.abs(maior.close - maior.open)
        )}</span>
        <span class="m-sub">${new Date(maior.time).toLocaleTimeString("pt-BR", {
          hour: "2-digit",
          minute: "2-digit",
        })}</span></div>
      <div class="metrica"><span class="m-rot">SEQUÊNCIA</span>
        <span class="m-val" style="color:${subindo ? UP : DOWN}">${seq}</span>
        <span class="m-sub">${subindo ? "barras de alta" : "barras de baixa"}</span></div>
      <div class="metrica"><span class="m-rot">TENDÊNCIA</span>
        <span class="m-val" style="color:${
          result.trend === "alta" ? UP : result.trend === "baixa" ? DOWN : NEU
        }">${result.trend.toUpperCase()}</span></div>
    </div>`
  );
}

function paintDeep(candles, price, result) {
  renderPos();
  renderBaleias();
  renderPerfil(candles, price);
  renderPlacar();
  renderSessao(candles, result);
}

// ---------------------------------------------------------------- medição
/**
 * Runs the panel's own reading over a long stretch of history, so a signal
 * arrives with its track record attached instead of only its confidence.
 */
async function rodarBacktest() {
  state.bt = null;
  state.btErro = null;
  state.varredura = null;
  renderBacktest();

  try {
    state.hist = await history(state.symbol, state.timeframe, 1000);
    if (!state.hist) {
      state.btErro = "Esta fonte não entrega histórico longo o bastante para medir.";
    } else {
      state.bt = backtest(state.hist, {
        depth: state.depth,
        zoneLimit: state.zones,
        flowBars: FLOW_BARS[state.timeframe] || 12,
        taxa: taxaAtual(),
      });
      if (!state.bt) state.btErro = "Histórico curto demais para medir.";
    }
  } catch (err) {
    state.btErro = err.message;
  }

  renderBacktest();
}

function otimizar() {
  if (!state.hist || state.varrendo) return;
  state.varrendo = true;
  renderBacktest();

  // let the "measuring" state paint before the sweep blocks the thread
  setTimeout(() => {
    try {
      state.varredura = varrer(state.hist, FLOW_BARS[state.timeframe] || 12);
    } catch {
      state.varredura = null;
    }
    state.varrendo = false;
    renderBacktest();
  }, 30);
}

function aplicarMelhor() {
  const m = state.varredura?.melhor;
  if (!m) return;

  state.depth = m.depth;
  state.zones = m.zoneLimit;
  el("depth").value = m.depth;
  el("zones").value = m.zoneLimit;
  el("depthVal").textContent = m.depth;
  el("zonesVal").textContent = m.zoneLimit;
  lastAnalysis = 0;

  state.bt = backtest(state.hist, {
    depth: state.depth,
    zoneLimit: state.zones,
    flowBars: FLOW_BARS[state.timeframe] || 12,
    taxa: taxaAtual(),
  });
  renderBacktest();
}

function renderBacktest() {
  const bt = state.bt;
  R.btInfo.textContent = bt ? `${bt.barras} barras · ${state.timeframe}` : "—";

  if (!bt) {
    swap(
      R.btBody,
      "bt",
      `<div class="vazio">${
        state.btErro || "Medindo a estratégia sobre o histórico…"
      }</div>`
    );
    return;
  }

  const corR = bt.r >= 0 ? UP : DOWN;
  const media = bt.total ? bt.r / bt.total : 0;

  const grade = state.varredura
    ? `<div class="varre">
        <div class="varre-cab">
          <span>R por combinação</span>
          <button class="btn mini-btn" id="btAplicar">usar a melhor</button>
        </div>
        <div class="varre-grade" style="grid-template-columns:34px repeat(${
          state.varredura.niveis.length
        },1fr)">
          <span class="varre-canto"></span>
          ${state.varredura.niveis.map((n) => `<span class="varre-topo">${n}</span>`).join("")}
          ${state.varredura.grade
            .map((linha, i) => {
              const zona = state.varredura.zonas[i];
              const celulas = linha
                .map((c) => {
                  if (!c) return `<span class="varre-cel"></span>`;
                  const forca = Math.min(1, Math.abs(c.r) / 8);
                  const cor = c.r >= 0 ? "47,224,138" : "255,77,99";
                  const melhor = c === state.varredura.melhor;
                  return `<span class="varre-cel ${melhor ? "melhor" : ""}"
                    style="background:rgba(${cor},${(forca * 0.55).toFixed(2)})"
                    title="zona ${c.depth} · níveis ${c.zoneLimit} · ${c.total} operações · acerto ${c.taxa.toFixed(
                      0
                    )}%">${c.r >= 0 ? "+" : ""}${c.r.toFixed(1)}</span>`;
                })
                .join("");
              return `<span class="varre-lado">${zona}</span>${celulas}`;
            })
            .join("")}
        </div>
        <div class="nota">Linhas: tamanho da zona em ATR. Colunas: quantidade de níveis.
          A melhor aqui é <b>zona ${state.varredura.melhor?.depth} · níveis ${
            state.varredura.melhor?.zoneLimit
          }</b>, com ${state.varredura.melhor?.r.toFixed(1)}R em ${
            state.varredura.melhor?.total
          } operações.</div>
      </div>`
    : `<button class="btn largo" id="btOtimizar" ${state.varrendo ? "disabled" : ""}>${
        state.varrendo ? "medindo 30 combinações…" : "otimizar os controles"
      }</button>`;

  const folga = bt.acertoNecessario != null ? bt.taxa - bt.acertoNecessario : null;

  swap(
    R.btBody,
    "bt",
    `${
      folga != null
        ? `<div class="equilibrio ${folga >= 0 ? "acima" : "abaixo"}">
             <div class="eq-linha">
               <span>precisa acertar</span>
               <b>${bt.acertoNecessario.toFixed(1)}%</b>
             </div>
             <div class="eq-barra">
               <div class="eq-marca" style="left:${Math.min(100, bt.acertoNecessario).toFixed(1)}%"></div>
               <div class="eq-atual" style="width:${Math.min(100, bt.taxa).toFixed(1)}%"></div>
             </div>
             <div class="eq-linha">
               <span>acerta de fato</span>
               <b>${bt.taxa.toFixed(1)}%</b>
             </div>
             <div class="eq-veredito">${
               folga >= 0
                 ? `sobra ${folga.toFixed(1)} pontos acima do empate`
                 : `falta ${Math.abs(folga).toFixed(1)} pontos para empatar`
             }</div>
           </div>`
        : ""
    }

    <div class="metricas">
      <div class="metrica"><span class="m-rot">OPERAÇÕES</span>
        <span class="m-val">${bt.total}</span></div>
      <div class="metrica"><span class="m-rot">ACERTO</span>
        <span class="m-val">${bt.taxa.toFixed(0)}%</span>
        <span class="m-sub">${bt.alvos} alvo · ${bt.empates ?? 0} empate · ${bt.stops} stop</span></div>
      <div class="metrica"><span class="m-rot">RESULTADO</span>
        <span class="m-val" style="color:${corR}">${bt.r >= 0 ? "+" : ""}${bt.r.toFixed(1)}R</span></div>
      <div class="metrica"><span class="m-rot">POR OPERAÇÃO</span>
        <span class="m-val" style="color:${corR}">${media >= 0 ? "+" : ""}${media.toFixed(
          3
        )}R</span>
        <span class="m-sub">já com taxa</span></div>
    </div>

    <div class="metricas">
      <div class="metrica"><span class="m-rot">GANHO MÉDIO</span>
        <span class="m-val" style="color:${UP}">+${bt.mediaGanho.toFixed(2)}R</span></div>
      <div class="metrica"><span class="m-rot">PERDA MÉDIA</span>
        <span class="m-val" style="color:${DOWN}">−${bt.mediaPerda.toFixed(2)}R</span></div>
    </div>

    ${
      bt.custoMedio > 0.25
        ? `<div class="alerta">A taxa consome <b>${bt.custoMedio.toFixed(
            2
          )}R</b> de cada operação neste tempo gráfico. O stop fica perto demais do preço
           para a corretagem caber — num tempo maior o mesmo sinal paga muito menos.</div>`
        : `<div class="nota">Taxa cobrada: ${bt.custoMedio.toFixed(3)}R por operação.</div>`
    }

    <div class="spark-box">
      <span class="m-rot">CURVA DE RESULTADO</span>
      ${sparkline(bt.curva.length > 1 ? [0, ...bt.curva] : null, bt.r >= 0 ? UP : DOWN, 44)}
    </div>

    ${grade}

    <div class="nota">Simulação sobre as barras já fechadas, com os controles atuais e a
      corretagem escolhida nas configurações. Sem deslize, e uma barra que toca alvo e
      stop conta como stop — não há como saber qual veio primeiro. Serve para calibrar,
      não para provar.</div>`
  );

  el("btOtimizar")?.addEventListener("click", otimizar);
  el("btAplicar")?.addEventListener("click", aplicarMelhor);
}

// ---------------------------------------------------------------- baleias
/**
 * The tape with the noise removed.
 *
 * Most prints are dust. Sizing each one against the median of the window
 * leaves the trades that actually moved something, whatever the asset's
 * usual lot size happens to be.
 */
function renderBaleias() {
  const fita = state.trades;

  if (fita.length < 20) {
    swap(R.baleiaBody, "baleia", `<div class="vazio">Sem fita suficiente nesta fonte.</div>`);
    R.baleiaInfo.textContent = "—";
    return;
  }

  const tamanhos = fita.map((t) => t.qty).sort((a, b) => a - b);
  const mediana = tamanhos[Math.floor(tamanhos.length / 2)] || 0;
  const corte = mediana * 8;

  const grandes = fita.filter((t) => t.qty >= corte).slice(-12).reverse();
  R.baleiaInfo.textContent = `acima de ${short(corte)}`;

  if (!grandes.length) {
    swap(
      R.baleiaBody,
      "baleia",
      `<div class="vazio">Nenhum negócio grande na janela atual. O maior foi
       ${short(tamanhos[tamanhos.length - 1])}, contra uma mediana de ${short(mediana)}.</div>`
    );
    return;
  }

  const compra = grandes.filter((t) => t.buyerAggressor).reduce((a, t) => a + t.qty, 0);
  const venda = grandes.reduce((a, t) => a + t.qty, 0) - compra;
  const maior = Math.max(...grandes.map((t) => t.qty));

  swap(
    R.baleiaBody,
    "baleia",
    `<div class="metricas">
      <div class="metrica"><span class="m-rot">GRANDES</span>
        <span class="m-val">${grandes.length}</span>
        <span class="m-sub">de ${fita.length} na fita</span></div>
      <div class="metrica"><span class="m-rot">COMPRARAM</span>
        <span class="m-val" style="color:${UP}">${short(compra)}</span></div>
      <div class="metrica"><span class="m-rot">VENDERAM</span>
        <span class="m-val" style="color:${DOWN}">${short(venda)}</span></div>
    </div>
    <div class="baleias">
      ${grandes
        .map((t) => {
          const cor = t.buyerAggressor ? UP : DOWN;
          return `<div class="baleia-linha">
            <span style="color:${cor}">${t.buyerAggressor ? "▲" : "▼"}</span>
            <div class="baleia-trilho">
              <div class="baleia-barra" style="width:${((t.qty / maior) * 100).toFixed(
                1
              )}%;background:${cor}22"></div>
              <span class="baleia-qtd" style="color:${cor}">${short(t.qty)}</span>
            </div>
            <span class="baleia-preco">${fmt(t.price)}</span>
          </div>`;
        })
        .join("")}
    </div>
    <div class="nota">Grande é oito vezes a mediana da janela, então o corte acompanha
      o ativo: no BTC são frações, numa memecoin são bilhões de unidades.</div>`
  );
}

// ---------------------------------------------------------------- mascote
/**
 * The mascot watches what the panel notices while you are looking elsewhere.
 *
 * Everything here is read from state the panel already computes — nothing is
 * polled for it. An event is only raised when something actually changed, so
 * the badge means "this happened", not "time passed".
 */
const AVISOS_MAX = 40;

const vigia = {
  lista: [],
  naoLidos: 0,
  /** Last seen values, so a change can be told apart from a repeat. */
  visto: {
    aberta: null,
    ultima: null,
    pendente: null,
    funding: null,
    divergencia: null,
    baleia: null,
  },

  add(tipo, texto, cor) {
    vigia.lista.push({ tipo, texto, cor, quando: Date.now() });
    if (vigia.lista.length > AVISOS_MAX) vigia.lista.shift();
    vigia.naoLidos++;
    pulsar(tipo);
  },
};

/** A short physical reaction, so an event registers even from the corner. */
function pulsar(tipo) {
  const m = el("mascote");
  if (!m) return;
  const classe = tipo === "stop" ? "treme" : tipo === "alvo" ? "pula" : "chama";
  m.classList.remove("treme", "pula", "chama");
  void m.offsetWidth; // restart the animation
  m.classList.add(classe);
  setTimeout(() => m.classList.remove(classe), 1200);
}

function vigiar() {
  const v = vigia.visto;
  const ativo = state.symbol.replace(/^f:/, "");

  // uma operação abriu
  const chaveAberta = state.aberta ? `${state.aberta.side}:${state.aberta.abertura}` : null;
  if (chaveAberta && chaveAberta !== v.aberta && config.load().avisarEntrada) {
    const a = state.aberta;
    vigia.add(
      "entrada",
      `${a.side.toUpperCase()} em ${ativo} a ${fmt(a.entrada)} · stop ${fmt(a.stop)} · alvo ${fmt(
        a.alvo
      )} · R:R 1:${a.rr.toFixed(1)}`,
      a.side === "compra" ? UP : DOWN
    );
    voz.falar(a.side === "compra" ? "entrada_compra" : "entrada_venda", "neutro");
  }
  v.aberta = chaveAberta;

  // uma operação terminou
  const chaveUltima = state.ultima ? `${state.ultima.abertura}:${state.ultima.resultado}` : null;
  if (chaveUltima && chaveUltima !== v.ultima && config.load().avisarResultado) {
    const u = state.ultima;
    const ok = u.resultado === "alvo";
    const r = u.r ?? (ok ? u.rr : -1);
    vigia.add(
      ok ? "alvo" : "stop",
      `${
        ok ? "Alvo atingido" : u.resultado === "empate" ? "Saiu no empate" : "Stop atingido"
      } em ${ativo}: ${u.side} de ${fmt(u.entrada)} · ${r >= 0 ? "+" : ""}${r.toFixed(2)}R`,
      ok ? UP : DOWN
    );
    voz.falar(ok ? "alvo" : u.resultado === "empate" ? "stop_empate" : "stop", ok ? "bom" : "ruim");
  }
  v.ultima = chaveUltima;
}

/** A stop that moved is the one message worth interrupting for. */
function avisarStop(movimento) {
  if (!movimento) return;
  const ativo = state.symbol.replace(/^f:/, "");

  if (movimento.motivo === "empate") {
    vigia.add(
      "empate",
      `Stop de ${ativo} movido para o preço de entrada — a operação não perde mais`,
      WARN
    );
    voz.falar("stop_empate", "bom");
  } else {
    vigia.add("ajuste", `Stop de ${ativo} ajustado para ${fmt(movimento.stop)}`, INFO);
    voz.falar("stop_ajustado", "neutro");
  }
}

/** The disagreement between the crowd and the size, when there is one. */
function divergencia() {
  const p = state.pos;
  if (!p?.contas || !p?.grandes) return null;

  const varejo = p.contas.compradas - 0.5;
  const size = p.grandes.compradas - 0.5;
  if (varejo * size >= 0 || Math.abs(varejo) < 0.03 || Math.abs(size) < 0.03) return null;

  const lado = size > 0 ? "comprados" : "vendidos";
  return {
    chave: size > 0 ? "grandes-comprados" : "grandes-vendidos",
    cor: size > 0 ? UP : DOWN,
    texto: `Varejo ${varejo > 0 ? "comprado" : "vendido"} e grandes ${lado} — ${(
      p.grandes.compradas * 100
    ).toFixed(0)}% contra ${(p.contas.compradas * 100).toFixed(0)}%`,
  };
}

/** The biggest print in the window, when it clears the noise. */
function maiorBaleia() {
  const fita = state.trades;
  if (fita.length < 40) return null;

  const tamanhos = fita.map((t) => t.qty).sort((a, b) => a - b);
  const mediana = tamanhos[Math.floor(tamanhos.length / 2)] || 0;
  const corte = mediana * 8;
  if (!(corte > 0)) return null;

  for (let i = fita.length - 1; i >= 0; i--) {
    const t = fita[i];
    if (t.qty >= corte) {
      return { chave: `${t.price}:${t.qty}`, qty: t.qty, price: t.price, lado: t.buyerAggressor };
    }
  }
  return null;
}

/**
 * The whole panel said out loud.
 *
 * It reads from the same numbers the cards show, in the order a person would
 * ask: where the price is, what the structure says, who is positioned how, and
 * whether this reading has worked here before.
 */
function lerMercado() {
  const r = state.analysis;
  const ativo = state.symbol.replace(/^f:/, "");
  if (!r || !state.data) return ["Ainda carregando os dados."];

  const frases = [];
  const preco = fmt(shown.price);
  const chg = state.data.stats.changePct;

  frases.push(
    `<b>${ativo}</b> a <b>${preco}</b>, ${chg >= 0 ? "subindo" : "caindo"} ${Math.abs(chg).toFixed(
      2
    )}% no dia, no gráfico de ${state.timeframe}.`
  );

  const motivos = r.reasons.filter((m) => m !== "Sem sinais relevantes");
  if (motivos.length) {
    frases.push(`A leitura vê: ${motivos.join("; ").toLowerCase()}.`);
  } else {
    frases.push("Não há nada de estrutural chamando atenção agora.");
  }

  const bias = r.score >= 58 ? "comprador" : r.score <= 42 ? "vendedor" : "neutro";
  frases.push(
    `Placar de confluência <b>${r.score}</b> — viés ${bias}.` +
      (state.aberta
        ? ` Há uma <b>${state.aberta.side}</b> aberta desde ${fmt(state.aberta.entrada)}, com stop em ${fmt(
            state.aberta.stop
          )} e alvo em ${fmt(state.aberta.alvo)}.`
        : state.pendente
          ? ` Um sinal de <b>${state.pendente.side}</b> espera a barra fechar.`
          : ` ${r.plan?.motivo || "Sem operação no momento"}.`)
  );

  const p = state.pos;
  if (p?.grandes && p?.contas) {
    const d = divergencia();
    frases.push(
      `Nos futuros, as maiores posições estão <b>${(p.grandes.compradas * 100).toFixed(
        0
      )}% compradas</b> e as contas em geral ${(p.contas.compradas * 100).toFixed(0)}%.` +
        (d ? " Os dois lados discordam." : "") +
        (p.funding != null
          ? ` O funding está em ${(p.funding * 100).toFixed(4)}%, então quem paga são os ${
              p.funding >= 0 ? "comprados" : "vendidos"
            }.`
          : "")
    );
  }

  if (state.bt) {
    const b = state.bt;
    frases.push(
      `Nas últimas ${b.barras} barras deste gráfico, esta mesma leitura teria feito <b>${
        b.total
      } operações</b> com ${b.taxa.toFixed(0)}% de acerto e <b>${b.r >= 0 ? "+" : ""}${b.r.toFixed(
        1
      )}R</b> de resultado.` + (b.r < 0 ? " Aqui ela vem perdendo — cuidado." : "")
    );
  }

  return frases;
}

// ---------------------------------------------------------------- varredura
const SCAN_MS = 60000;
const TEMPOS_SCAN = ["1m", "5m", "15m", "1h", "4h"];

/**
 * Runs the same reading across every timeframe of the asset on screen.
 *
 * An entry that is not there on the 5m may be forming on the 15m, and the
 * panel only ever shows one chart. This looks at all of them and reports the
 * one that confirms soonest, because that is the one with a deadline.
 */
async function escanear() {
  if (state.escaneando) return;
  state.escaneando = true;

  const ativo = state.symbol;
  const achados = [];

  try {
    for (const tf of TEMPOS_SCAN) {
      try {
        // a request that never settles would otherwise hold the scan open and,
        // with it, the lock that keeps the next one from starting
        const velas = await Promise.race([
          history(ativo, tf, JANELA),
          new Promise((ok) => setTimeout(() => ok(null), 8000)),
        ]);

        if (!velas || velas.length < 60) continue;
        if (state.symbol !== ativo) return; // trocou de ativo no meio

        const flow = flowFromCandles(velas, FLOW_BARS[tf] || 12);
        const r = analyse(velas, {
          depth: state.depth,
          zoneLimit: state.zones,
          flow: flow ? { ...flow, total: flow.buy + flow.sell } : null,
        });

        if (r.plan && r.plan.side !== "fora") {
          const aberta = velas[velas.length - 1];
          achados.push({
            tf,
            side: r.plan.side,
            score: r.score,
            rr: r.plan.rr,
            entrada: r.plan.entrada,
            fecha: aberta.time + (TF_SECONDS[tf] || 60) * 1000,
          });
        }
      } catch {
        /* um tempo que falhou não derruba a varredura */
      }
    }

    // the one closing soonest is the one that needs a decision first
    achados.sort((a, b) => a.fecha - b.fecha);
    state.scan = { achados, quando: Date.now(), tempos: TEMPOS_SCAN.length };
  } finally {
    // released on every path, including the early return above
    state.escaneando = false;
  }
}

/** Time left on a bar, short enough to sit in a pill. */
function curto(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h${String(m).padStart(2, "0")}`;
  if (m) return `${m}min ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

let dicaAnterior = "";

/** What the hint is currently about, so a dismissal applies to that and not
 * to every future finding. */
function chaveDaDica(scan) {
  const a = scan.achados[0];
  return a ? `${a.tf}:${a.side}:${a.fecha}` : "vazio";
}

function pintarDica() {
  const caixa = el("dica");
  const corpo = el("dicaCorpo");
  if (!caixa || !corpo) return;

  const scan = state.scan;
  if (!scan || !config.load().mostrarDica) {
    caixa.hidden = true;
    return;
  }

  const chave = chaveDaDica(scan);
  if (chave === state.dicaFechada) {
    caixa.hidden = true;
    return;
  }

  const achado = scan.achados[0];
  let html;
  let classe = "dica";

  if (!achado) {
    html = `<span class="dica-nada">sem entrada em ${scan.tempos} tempos</span>`;
    classe += " quieta";
  } else {
    const falta = achado.fecha - Date.now();
    const cor = achado.side === "compra" ? UP : DOWN;
    const outros = scan.achados.length - 1;

    html =
      `<span class="dica-tf">${achado.tf}</span>` +
      `<span class="dica-lado" style="color:${cor}">${achado.side.toUpperCase()}</span>` +
      `<span class="dica-tempo">${
        falta > 0 ? `confirma em ${curto(falta)}` : "fechando a barra"
      }</span>` +
      (outros > 0 ? `<span class="dica-mais">+${outros}</span>` : "");
    classe += achado.side === "compra" ? " compra" : " venda";
  }

  if (html !== dicaAnterior) {
    corpo.innerHTML = html;
    dicaAnterior = html;
  }
  caixa.className = classe;
  caixa.hidden = false;
}

/** Dismisses this finding only; the next different one shows again. */
function dispensarDica(e) {
  e.stopPropagation();
  if (state.scan) state.dicaFechada = chaveDaDica(state.scan);
  el("dica").hidden = true;
}

/** Tapping the hint takes the panel to the timeframe that found something. */
function irParaAchado() {
  const achado = state.scan?.achados?.[0];
  if (!achado || achado.tf === state.timeframe) return;

  state.timeframe = achado.tf;
  el("timeframe").value = achado.tf;
  reload();
}

/** Ring colour: the panel's traffic light, readable from the corner. */

function corDoMascote() {
  if (state.aberta) return state.aberta.side === "compra" ? UP : DOWN;
  if (state.pendente) return WARN;
  if (state.ultima) return state.ultima.resultado === "alvo" ? UP : DOWN;
  return "#14b8a6";
}

function pintarMascote() {
  const m = el("mascote");
  if (!m) return;

  m.style.background = corDoMascote();
  const selo = el("mascoteSelo");
  if (!selo) return;

  selo.textContent = vigia.naoLidos > 9 ? "9+" : String(vigia.naoLidos);
  selo.hidden = vigia.naoLidos === 0;
}

function renderBalao() {
  const leitura = lerMercado()
    .map((f) => `<p>${f}</p>`)
    .join("");

  const lista = vigia.lista.length
    ? [...vigia.lista]
        .reverse()
        .map(
          (a) => `<div class="aviso">
            <span class="aviso-ponto" style="background:${a.cor}"></span>
            <div class="aviso-corpo">
              <span class="aviso-texto">${esc(a.texto)}</span>
              <span class="aviso-hora">${new Date(a.quando).toLocaleTimeString("pt-BR", {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}</span>
            </div>
          </div>`
        )
        .join("")
    : `<div class="vazio">Nada aconteceu ainda. Vou avisar quando um sinal confirmar,
       um stop ou alvo bater, o funding virar ou passar um negócio grande.</div>`;

  el("balaoLeitura").innerHTML = leitura;
  el("balaoLista").innerHTML = lista;
}

function abrirBalao() {
  const b = el("balao");
  const aberto = !b.hidden;

  if (aberto) {
    b.hidden = true;
    return;
  }

  renderBalao();
  b.hidden = false;
  vigia.naoLidos = 0;
  pintarMascote();
}

function ligarMascote() {
  el("mascote")?.addEventListener("click", abrirBalao);
  el("dicaCorpo")?.addEventListener("click", irParaAchado);
  el("dicaX")?.addEventListener("click", dispensarDica);
  el("balaoFechar")?.addEventListener("click", () => (el("balao").hidden = true));

  document.addEventListener("click", (e) => {
    const b = el("balao");
    if (b.hidden) return;
    if (e.target.closest("#balao") || e.target.closest("#mascote") || e.target.closest("#dica"))
      return;
    b.hidden = true;
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") el("balao").hidden = true;
  });
}

// ---------------------------------------------------------------- conta
/**
 * Preferences, kept in this browser.
 *
 * No account exists yet, so everything here belongs to the device. The shape
 * is deliberately flat and small: when a real login arrives, this same object
 * is what gets synced, and nothing above it has to change.
 */
const config = {
  chave: "painel:config",

  padrao: {
    nome: "",
    foto: "",
    ativo: "BTC",
    tempo: "5m",
    avisarEntrada: true,
    avisarResultado: true,
    mostrarMascote: true,
    mostrarDica: true,
    som: true,
    comite: false,
    venderTambem: false,
    taxa: 0.0002,
    cards: { pos: true, perfil: true, bt: true, mapa: true, ficha: true, comite: true, lab: true, rank: true, baleia: true, placar: true, sessao: true },
  },

  atual: null,

  load() {
    if (config.atual) return config.atual;
    try {
      const salvo = JSON.parse(localStorage.getItem(config.chave) || "{}");
      config.atual = {
        ...config.padrao,
        ...salvo,
        cards: { ...config.padrao.cards, ...(salvo.cards || {}) },
      };
    } catch {
      config.atual = { ...config.padrao, cards: { ...config.padrao.cards } };
    }
    return config.atual;
  },

  save(novo) {
    config.atual = { ...config.load(), ...novo };
    try {
      localStorage.setItem(config.chave, JSON.stringify(config.atual));
    } catch {
      /* a photo too large for the quota simply is not kept */
    }
    return config.atual;
  },
};

/** Initials, for when there is no picture yet. */
function iniciais(nome) {
  const partes = (nome || "").trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return "?";
  return (partes[0][0] + (partes.length > 1 ? partes[partes.length - 1][0] : "")).toUpperCase();
}

function pintarConta() {
  const c = config.load();
  const foto = el("contaFoto");
  const letra = el("contaLetra");
  const nome = el("contaNome");
  if (!foto) return;

  if (c.foto) {
    foto.src = c.foto;
    foto.hidden = false;
    letra.hidden = true;
  } else {
    foto.hidden = true;
    letra.hidden = false;
    letra.textContent = iniciais(c.nome);
  }

  nome.textContent = c.nome || "Entrar";
}

/** Applies what the panel can change without reloading. */
function aplicarConfig() {
  const c = config.load();

  const mostra = (id, ligado) => {
    const n = el(id);
    if (n) n.hidden = !ligado;
  };

  mostra("cardPos", c.cards.pos);
  mostra("cardPerfil", c.cards.perfil);
  mostra("cardBt", c.cards.bt);
  mostra("cardFicha", c.cards.ficha !== false);
  mostra("cardRank", c.cards.rank !== false);
  OPERA.venda = c.venderTambem === true;

  mostra("cardMapa", c.cards.mapa !== false);
  mostra("cardComite", c.cards.comite !== false);
  mostra("cardLab", c.cards.lab !== false);
  mostra("cardBaleia", c.cards.baleia);
  mostra("cardPlacar", c.cards.placar);
  mostra("cardSessao", c.cards.sessao);

  mostra("mascote", c.mostrarMascote);
  if (!c.mostrarMascote) el("balao").hidden = true;
  if (!c.mostrarDica) el("dica").hidden = true;

  pintarConta();
}

/** Shrinks the picture before it is stored: a full photo would not fit. */
function lerFoto(arquivo) {
  return new Promise((ok, falha) => {
    const leitor = new FileReader();
    leitor.onerror = () => falha(new Error("não consegui ler o arquivo"));
    leitor.onload = () => {
      const img = new Image();
      img.onerror = () => falha(new Error("arquivo não é uma imagem"));
      img.onload = () => {
        // a tela do celular tem dois ou três pixels reais para cada pixel de
        // CSS; gravar em 160 era gravar metade do que a tela mostra
        const lado = 160 * Math.min(3, Math.max(1, Math.round(window.devicePixelRatio || 1)));
        const tela = document.createElement("canvas");
        tela.width = lado;
        tela.height = lado;
        const ctx = tela.getContext("2d");

        // cover: crop the long side instead of squashing the face
        const escala = Math.max(lado / img.width, lado / img.height);
        const w = img.width * escala;
        const h = img.height * escala;
        ctx.drawImage(img, (lado - w) / 2, (lado - h) / 2, w, h);

        ok(tela.toDataURL("image/jpeg", 0.82));
      };
      img.src = leitor.result;
    };
    leitor.readAsDataURL(arquivo);
  });
}

function abrirConfig() {
  const c = config.load();

  el("cfgNome").value = c.nome;
  el("cfgPadrao").textContent = `${state.symbol.replace(/^f:/, "")} · ${state.timeframe}`;
  el("cfgAtualSalvo").textContent = `${c.ativo.replace(/^f:/, "")} · ${c.tempo}`;

  const marcar = (id, v) => (el(id).checked = v);
  marcar("cfgEntrada", c.avisarEntrada);
  marcar("cfgResultado", c.avisarResultado);
  marcar("cfgMascote", c.mostrarMascote);
  marcar("cfgDica", c.mostrarDica);
  marcar("cfgSom", c.som);
  el("cfgTaxa").value = String(c.taxa);
  el("cfgVozEstado").textContent = voz.estado();
  marcar("cfgCardPos", c.cards.pos);
  marcar("cfgCardPerfil", c.cards.perfil);
  marcar("cfgCardBt", c.cards.bt);
  marcar("cfgCardFicha", c.cards.ficha !== false);
  marcar("cfgCardRank", c.cards.rank !== false);
  marcar("cfgVender", c.venderTambem === true);
  marcar("cfgComite", c.comite === true);
  marcar("cfgCardMapa", c.cards.mapa !== false);
  marcar("cfgCardComite", c.cards.comite !== false);
  marcar("cfgCardLab", c.cards.lab !== false);
  marcar("cfgCardBaleia", c.cards.baleia);
  marcar("cfgCardPlacar", c.cards.placar);
  marcar("cfgCardSessao", c.cards.sessao);

  const previa = el("cfgFoto");
  previa.style.backgroundImage = c.foto ? `url(${c.foto})` : "none";
  previa.textContent = c.foto ? "" : iniciais(c.nome);

  el("config").hidden = false;
}

function salvarConfig() {
  config.save({
    nome: el("cfgNome").value.trim().slice(0, 40),
    avisarEntrada: el("cfgEntrada").checked,
    avisarResultado: el("cfgResultado").checked,
    mostrarMascote: el("cfgMascote").checked,
    mostrarDica: el("cfgDica").checked,
    som: el("cfgSom").checked,
    venderTambem: el("cfgVender").checked,
    comite: el("cfgComite").checked,
    taxa: parseFloat(el("cfgTaxa").value),
    cards: {
      pos: el("cfgCardPos").checked,
      perfil: el("cfgCardPerfil").checked,
      bt: el("cfgCardBt").checked,
      ficha: el("cfgCardFicha").checked,
      rank: el("cfgCardRank").checked,
      mapa: el("cfgCardMapa").checked,
      comite: el("cfgCardComite").checked,
      lab: el("cfgCardLab").checked,
      baleia: el("cfgCardBaleia").checked,
      placar: el("cfgCardPlacar").checked,
      sessao: el("cfgCardSessao").checked,
    },
  });

  aplicarConfig();
  el("config").hidden = true;
}

/** The trade log, as a file a spreadsheet can open. */
function exportarHistorico() {
  const lista = historico.load();
  if (!lista.length) return;

  const linhas = [
    "abertura;fechamento;ativo;tempo;lado;entrada;stop;alvo;rr;resultado;r;placar",
    ...lista.map((t) => {
      const r = t.resultado === "alvo" ? t.rr : -1;
      return [
        new Date(t.abertura).toLocaleString("pt-BR"),
        t.fechamento ? new Date(t.fechamento).toLocaleString("pt-BR") : "",
        t.symbol.replace(/^f:/, ""),
        t.timeframe,
        t.side,
        t.entrada,
        t.stop,
        t.alvo,
        t.rr?.toFixed(2) ?? "",
        t.resultado,
        r.toFixed(2),
        t.contexto?.score ?? "",
      ].join(";");
    }),
  ];

  const blob = new Blob(["\ufeff" + linhas.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `operacoes-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function ligarConta() {
  el("conta")?.addEventListener("click", abrirConfig);
  el("cfgFechar")?.addEventListener("click", () => (el("config").hidden = true));
  el("cfgCancelar")?.addEventListener("click", () => (el("config").hidden = true));
  el("cfgSalvar")?.addEventListener("click", salvarConfig);
  el("cfgExportar")?.addEventListener("click", exportarHistorico);

  el("config")?.addEventListener("click", (e) => {
    if (e.target.id === "config") el("config").hidden = true;
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") el("config").hidden = true;
  });

  el("cfgArquivo")?.addEventListener("change", async (e) => {
    const arquivo = e.target.files?.[0];
    if (!arquivo) return;
    try {
      const foto = await lerFoto(arquivo);
      config.save({ foto });
      const previa = el("cfgFoto");
      previa.style.backgroundImage = `url(${foto})`;
      previa.textContent = "";
      pintarConta();
    } catch (err) {
      el("cfgAviso").textContent = err.message;
    }
    e.target.value = "";
  });

  el("cfgTirarFoto")?.addEventListener("click", () => {
    config.save({ foto: "" });
    const previa = el("cfgFoto");
    previa.style.backgroundImage = "none";
    previa.textContent = iniciais(config.load().nome);
    pintarConta();
  });

  el("cfgTestarVoz")?.addEventListener("click", () => {
    voz.liberar();
    voz.ultima = 0; // um teste nunca é engolido pelo intervalo
    voz.falar("entrada_compra", "neutro");
    el("cfgVozEstado").textContent = voz.estado();
  });

  el("cfgUsarAtual")?.addEventListener("click", () => {
    config.save({ ativo: state.symbol, tempo: state.timeframe });
    el("cfgAtualSalvo").textContent = `${state.symbol.replace(/^f:/, "")} · ${state.timeframe}`;
  });

  el("cfgLimpar")?.addEventListener("click", () => {
    if (el("cfgLimpar").dataset.certeza !== "sim") {
      el("cfgLimpar").dataset.certeza = "sim";
      el("cfgLimpar").textContent = "tem certeza? apagar tudo";
      return;
    }
    try {
      localStorage.removeItem(historico.chave);
    } catch {
      /* nada a fazer */
    }
    el("cfgLimpar").dataset.certeza = "";
    el("cfgLimpar").textContent = "apagar histórico";
    el("cfgAviso").textContent = "histórico apagado.";
  });
}

// ---------------------------------------------------------------- voz
/**
 * The panel speaks a fixed, small vocabulary.
 *
 * Because the phrases never change and carry no numbers, they can be real
 * recordings rather than a synthesiser — a person reads them once and the
 * panel plays the file. Until those files exist, each one falls back to a
 * short tone, so the timing and the triggers can be tested now and the voice
 * dropped in later without touching anything here.
 */
/** What the panel says, and the file that will one day replace each line. */
const FRASES = {
  entrada_compra: "Entrada de compra confirmada.",
  entrada_venda: "Entrada de venda confirmada.",
  stop_empate: "Mova o stop para o preço de entrada.",
  stop_ajustado: "Stop ajustado. Operação protegida.",
  alvo: "Alvo atingido.",
  stop: "Stop atingido.",
};

/** Recordings already in the repository; these win over the synthesiser. */
const COM_ARQUIVO = new Set();

// the API says nothing about gender, so the choice is made by name
const MASCULINAS = ["daniel", "felipe", "ricardo", "julio", "júlio", "antonio", "antônio", "eddy"];
const FEMININAS = ["maria", "luciana", "joana", "fernanda", "camila", "francisca", "helena"];

const voz = {
  ctx: null,
  voz: null,
  faltando: new Set(),
  ultima: 0,

  /**
   * Browsers only start audio inside a gesture, and iOS leaves a context
   * created outside one suspended. So this runs on every kind of first touch
   * and tries to resume again on each announcement.
   */
  liberar() {
    try {
      if (!voz.ctx) voz.ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (voz.ctx.state === "suspended") voz.ctx.resume?.();
    } catch {
      voz.ctx = null;
    }
    voz.escolher();
  },

  /** Picks a Brazilian male voice, falling back through what exists. */
  escolher() {
    if (voz.voz || !("speechSynthesis" in window)) return voz.voz;

    const todas = speechSynthesis
      .getVoices()
      .filter((v) => v.lang.toLowerCase().startsWith("pt"))
      .sort((a, b) => (b.lang.toLowerCase() === "pt-br") - (a.lang.toLowerCase() === "pt-br"));

    if (!todas.length) return null;

    const nome = (v) => v.name.toLowerCase();
    voz.voz =
      todas.find((v) => MASCULINAS.some((m) => nome(v).includes(m))) ||
      todas.find((v) => !FEMININAS.some((f) => nome(v).includes(f))) ||
      todas[0];

    return voz.voz;
  },

  /** What a test should report back. */
  estado() {
    if (!config.load().som) return "desligado nas configurações";
    if (voz.voz) return `voz: ${voz.voz.name}`;
    if (!voz.ctx) return "o navegador não deixou abrir o som";
    if (voz.ctx.state !== "running") return "aguardando um toque na tela";
    return "sem voz em português — tocando tons";
  },

  tom(tipo) {
    if (!voz.ctx) return;
    const agora = voz.ctx.currentTime;
    const notas = tipo === "bom" ? [660, 880] : tipo === "ruim" ? [440, 330] : [520, 640];

    notas.forEach((hz, i) => {
      const osc = voz.ctx.createOscillator();
      const vol = voz.ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = hz;
      vol.gain.setValueAtTime(0.0001, agora + i * 0.14);
      vol.gain.exponentialRampToValueAtTime(0.28, agora + i * 0.14 + 0.02);
      vol.gain.exponentialRampToValueAtTime(0.0001, agora + i * 0.14 + 0.18);
      osc.connect(vol).connect(voz.ctx.destination);
      osc.start(agora + i * 0.14);
      osc.stop(agora + i * 0.14 + 0.2);
    });
  },

  /**
   * A tick for the interface itself.
   *
   * Short, quiet and outside the announcement spacing — pressing three
   * buttons in a row should tick three times, while three market events in a
   * row should still only speak once.
   */
  clique(agudo = false) {
    if (!config.load().som || !voz.ctx || voz.ctx.state !== "running") return;

    const agora = voz.ctx.currentTime;
    const osc = voz.ctx.createOscillator();
    const vol = voz.ctx.createGain();

    osc.type = "triangle";
    osc.frequency.setValueAtTime(agudo ? 1500 : 1100, agora);
    osc.frequency.exponentialRampToValueAtTime(agudo ? 900 : 700, agora + 0.04);
    vol.gain.setValueAtTime(0.0001, agora);
    vol.gain.exponentialRampToValueAtTime(0.09, agora + 0.006);
    vol.gain.exponentialRampToValueAtTime(0.0001, agora + 0.05);

    osc.connect(vol).connect(voz.ctx.destination);
    osc.start(agora);
    osc.stop(agora + 0.06);
  },

  falar(chave, tipo = "neutro") {
    if (!config.load().som) return;
    voz.liberar();

    // two announcements on top of each other say nothing
    const agora = Date.now();
    if (agora - voz.ultima < 700) return;
    voz.ultima = agora;

    if (COM_ARQUIVO.has(chave) && !voz.faltando.has(chave)) {
      const audio = new Audio(`./voz/${chave}.mp3`);
      audio.volume = 0.95;
      audio.addEventListener("error", () => {
        voz.faltando.add(chave);
        voz.dizer(chave, tipo);
      });
      audio.play().catch(() => {
        voz.faltando.add(chave);
        voz.dizer(chave, tipo);
      });
      return;
    }

    voz.dizer(chave, tipo);
  },

  dizer(chave, tipo) {
    const frase = FRASES[chave];
    const escolhida = voz.escolher();

    if (!frase || !escolhida) return voz.tom(tipo);

    try {
      speechSynthesis.cancel(); // uma fala nova cancela a anterior
      const fala = new SpeechSynthesisUtterance(frase);
      fala.voice = escolhida;
      fala.lang = escolhida.lang;
      fala.rate = 1;
      fala.pitch = 0.95;
      fala.volume = 1;
      fala.onerror = () => voz.tom(tipo);
      speechSynthesis.speak(fala);
    } catch {
      voz.tom(tipo);
    }
  },
};

if ("speechSynthesis" in window) {
  speechSynthesis.onvoiceschanged = () => voz.escolher();
  voz.escolher();
}

["pointerdown", "touchend", "click", "keydown"].forEach((evento) =>
  document.addEventListener(evento, () => voz.liberar(), { passive: true })
);

// a tick on anything the person actually presses
document.addEventListener(
  "click",
  (e) => {
    if (e.target.closest("button, .btn, .cfg-opcao, .cfg-arquivo")) voz.clique();
  },
  { passive: true }
);

// sliders and pickers tick when they settle, not on every step
document.addEventListener(
  "change",
  (e) => {
    if (e.target.matches("select, input[type=range]")) voz.clique(true);
  },
  { passive: true }
);

// ---------------------------------------------------------------- ficha
const ZONAS_FICHA = [0.3, 0.5, 0.8];
const NIVEIS_FICHA = [4, 6, 9];
const VELAS_FICHA = 3000;

/** Lets the screen breathe between measurements, which each take a moment. */
const respirar = () => new Promise((ok) => setTimeout(ok, 0));

/**
 * Measures one asset on its own terms.
 *
 * Settings are swept over the first half of its history and then judged on the
 * second half, which the sweep never saw. Only a profile that beat the default
 * on that untouched half — and made money after fees — is reported as usable.
 */
async function montarFicha() {
  if (state.fichando) return;
  state.fichando = true;
  state.ficha = null;
  state.fichaPasso = "buscando histórico";
  renderFicha();

  try {
    const velas = await history(state.symbol, state.timeframe, VELAS_FICHA);
    const uteis = (velas?.length || 0) - JANELA;

    if (!velas || uteis < 600) {
      state.ficha = { erro: "Histórico curto demais para separar calibragem de prova." };
      return;
    }

    const corte = Math.floor(uteis / 2) + JANELA;
    const primeira = velas.slice(0, corte);
    const segunda = velas.slice(corte - JANELA);
    const comum = { flowBars: FLOW_BARS[state.timeframe] || 12, janela: JANELA, taxa: taxaAtual() };

    let melhor = null;
    let feitos = 0;
    const totalCombos = ZONAS_FICHA.length * NIVEIS_FICHA.length;

    for (const depth of ZONAS_FICHA) {
      for (const zoneLimit of NIVEIS_FICHA) {
        state.fichaPasso = `calibrando ${++feitos} de ${totalCombos}`;
        renderFicha();
        await respirar();

        const bt = backtest(primeira, { ...comum, depth, zoneLimit });
        if (bt && bt.total >= 6 && (!melhor || bt.porOp > melhor.bt.porOp)) {
          melhor = { depth, zoneLimit, bt };
        }
      }
    }

    if (!melhor) {
      state.ficha = { erro: "Operações demais de menos na calibragem para concluir algo." };
      return;
    }

    state.fichaPasso = "provando fora da amostra";
    renderFicha();
    await respirar();

    const fora = backtest(segunda, { ...comum, depth: melhor.depth, zoneLimit: melhor.zoneLimit });
    await respirar();
    const padrao = backtest(segunda, { ...comum, depth: 0.5, zoneLimit: 6 });

    state.ficha = {
      symbol: state.symbol,
      timeframe: state.timeframe,
      depth: melhor.depth,
      zoneLimit: melhor.zoneLimit,
      dentro: melhor.bt,
      fora,
      padrao,
      aprovado: !!fora && !!padrao && fora.porOp > padrao.porOp && fora.porOp > 0,
    };
  } catch (err) {
    state.ficha = { erro: err.message };
  } finally {
    state.fichando = false;
    state.fichaPasso = null;
    renderFicha();
  }
}

function usarPerfil() {
  const fi = state.ficha;
  if (!fi?.aprovado) return;

  state.depth = fi.depth;
  state.zones = fi.zoneLimit;
  el("depth").value = fi.depth;
  el("zones").value = fi.zoneLimit;
  el("depthVal").textContent = fi.depth;
  el("zonesVal").textContent = fi.zoneLimit;
  lastAnalysis = 0;
  rodarBacktest();
}

function renderFicha() {
  const ativo = state.symbol.replace(/^f:/, "");
  R.fichaInfo.textContent = state.ficha?.symbol ? `${ativo} · ${state.ficha.timeframe}` : "—";

  if (state.fichando) {
    swap(R.fichaBody, "ficha", `<div class="vazio">${esc(state.fichaPasso || "medindo")}…</div>`);
    return;
  }

  const fi = state.ficha;

  if (!fi) {
    swap(
      R.fichaBody,
      "ficha",
      `<div class="vazio">Cada ativo se comporta de um jeito. A ficha varre os ajustes
        na primeira metade do histórico e julga na segunda, que a varredura nunca viu —
        com taxa cobrada. Se o perfil não vencer o padrão nessa metade intocada, ele é
        reprovado.</div>
      <button class="btn largo" id="fichaBotao">montar a ficha de ${esc(ativo)}</button>`
    );
    el("fichaBotao")?.addEventListener("click", montarFicha);
    return;
  }

  if (fi.erro) {
    swap(
      R.fichaBody,
      "ficha",
      `<div class="vazio">${esc(fi.erro)}</div>
       <button class="btn largo" id="fichaBotao">tentar de novo</button>`
    );
    el("fichaBotao")?.addEventListener("click", montarFicha);
    return;
  }

  const cor = (v) => (v > 0 ? UP : v < 0 ? DOWN : NEU);
  const num = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(3)}R`;

  swap(
    R.fichaBody,
    "ficha",
    `<div class="veredito ${fi.aprovado ? "bom" : "ruim"}">
       ${fi.aprovado ? "PERFIL APROVADO" : "PERFIL REPROVADO"}
     </div>

     <div class="metricas">
       <div class="metrica"><span class="m-rot">PERFIL</span>
         <span class="m-val">${fi.depth}× · ${fi.zoneLimit}</span>
         <span class="m-sub">zona e níveis</span></div>
       <div class="metrica"><span class="m-rot">CALIBRAGEM</span>
         <span class="m-val" style="color:${cor(fi.dentro.porOp)}">${num(fi.dentro.porOp)}</span>
         <span class="m-sub">${fi.dentro.total} operações</span></div>
       <div class="metrica"><span class="m-rot">FORA DA AMOSTRA</span>
         <span class="m-val" style="color:${cor(fi.fora.porOp)}">${num(fi.fora.porOp)}</span>
         <span class="m-sub">${fi.fora.total} operações</span></div>
       <div class="metrica"><span class="m-rot">PADRÃO ALI</span>
         <span class="m-val" style="color:${cor(fi.padrao.porOp)}">${num(fi.padrao.porOp)}</span>
         <span class="m-sub">${fi.padrao.total} operações</span></div>
     </div>

     <div class="cfg-linha">
       <span class="cfg-texto">Taxa comeu <b>${fi.fora.custoMedio.toFixed(3)}R</b> por operação</span>
       ${fi.aprovado ? `<button class="btn mini-btn" id="fichaUsar">usar este perfil</button>` : ""}
     </div>

     <div class="nota">${
       fi.aprovado
         ? `Na metade que a calibragem nunca viu, este perfil rendeu ${num(
             fi.fora.porOp
           )} por operação contra ${num(fi.padrao.porOp)} do padrão. É o mínimo para levar a sério — não é garantia.`
         : `Na metade intocada ele rendeu ${num(fi.fora.porOp)} contra ${num(
             fi.padrao.porOp
           )} do padrão. O que parecia ajuste era o passado sendo decorado. Não use este perfil.`
     }</div>`
  );

  el("fichaUsar")?.addEventListener("click", usarPerfil);
}

// ---------------------------------------------------------------- ranking
/**
 * The same profile, run across a whole category.
 *
 * Reading one asset at a time never answers the question that matters — where
 * does this reading work at all. Each asset is calibrated on its own first
 * half and judged on its own second half, fees charged, and the result is
 * cached so an answer this slow is only paid for once.
 */
const RANKING_MAX = 24;

const rankingCache = {
  chave: (cat, tf) => `painel:ranking:${cat}:${tf}:${taxaAtual()}`,

  load(cat, tf) {
    try {
      const cru = localStorage.getItem(rankingCache.chave(cat, tf));
      return cru ? JSON.parse(cru) : null;
    } catch {
      return null;
    }
  },

  save(cat, tf, lista) {
    try {
      localStorage.setItem(
        rankingCache.chave(cat, tf),
        JSON.stringify({ quando: Date.now(), lista })
      );
    } catch {
      /* cabe na memória mesmo que não caiba no disco */
    }
  },
};

async function medirCategoria() {
  if (state.rankeando) return;

  const grupo = CATEGORIES.find((c) => c.id === state.category);
  const todos = await universe();
  const lista = (grupo?.assets
    ? grupo.assets.map((id) => todos.find((x) => x.id === id)).filter(Boolean)
    : todos.filter((x) => (grupo?.todos === "futuros") === x.id.startsWith("f:"))
  ).slice(0, RANKING_MAX);

  if (!lista.length) return;

  state.rankeando = true;
  state.ranking = { lista: [], cat: state.category, tf: state.timeframe };
  const comum = { flowBars: FLOW_BARS[state.timeframe] || 12, janela: JANELA, taxa: taxaAtual() };

  for (let i = 0; i < lista.length; i++) {
    const ativo = lista[i];
    state.rankingPasso = `${i + 1} de ${lista.length} · ${ativo.label}`;
    renderRanking();
    await respirar();

    try {
      const velas = await history(ativo.id, state.timeframe, 3000);
      if (!velas || velas.length - JANELA < 600) continue;

      const uteis = velas.length - JANELA;
      const corte = Math.floor(uteis / 2) + JANELA;
      const primeira = velas.slice(0, corte);
      const segunda = velas.slice(corte - JANELA);

      let melhor = null;
      for (const depth of ZONAS_FICHA) {
        for (const zoneLimit of NIVEIS_FICHA) {
          await respirar();
          const bt = backtest(primeira, { ...comum, depth, zoneLimit });
          if (bt && bt.total >= 6 && (!melhor || bt.porOp > melhor.bt.porOp)) {
            melhor = { depth, zoneLimit, bt };
          }
        }
      }
      if (!melhor) continue;

      await respirar();
      const fora = backtest(segunda, { ...comum, depth: melhor.depth, zoneLimit: melhor.zoneLimit });
      await respirar();
      const padrao = backtest(segunda, { ...comum, depth: 0.5, zoneLimit: 6 });
      if (!fora || !padrao) continue;

      state.ranking.lista.push({
        id: ativo.id,
        label: ativo.label,
        depth: melhor.depth,
        zoneLimit: melhor.zoneLimit,
        fora: fora.porOp,
        ops: fora.total,
        acerto: fora.taxa,
        padrao: padrao.porOp,
        custo: fora.custoMedio,
        ok: fora.porOp > padrao.porOp && fora.porOp > 0,
      });
      state.ranking.lista.sort((x, y) => y.fora - x.fora);
    } catch {
      /* um ativo que falhou não derruba a lista */
    }
  }

  rankingCache.save(state.category, state.timeframe, state.ranking.lista);
  state.rankeando = false;
  state.rankingPasso = null;
  renderRanking();
}

function renderRanking() {
  const grupo = CATEGORIES.find((c) => c.id === state.category);
  R.rankInfo.textContent = grupo ? `${grupo.label} · ${state.timeframe}` : "—";

  const guardado =
    state.ranking?.cat === state.category && state.ranking?.tf === state.timeframe
      ? state.ranking.lista
      : rankingCache.load(state.category, state.timeframe)?.lista;

  const cor = (v) => (v > 0 ? UP : v < 0 ? DOWN : NEU);
  const num = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(3)}R`;

  const linhas = (guardado || [])
    .map(
      (l, i) => `<div class="rank-linha ${l.ok ? "ok" : ""}" data-id="${esc(l.id)}">
        <span class="rank-pos">${l.ok ? "✓" : i + 1}</span>
        <span class="rank-nome">${esc(l.label)}</span>
        <span class="rank-perfil">${l.depth}× ${l.zoneLimit}</span>
        <span class="rank-ops">${l.ops}op ${l.acerto.toFixed(0)}%</span>
        <span class="rank-r" style="color:${cor(l.fora)}">${num(l.fora)}</span>
        <span class="rank-custo">${l.custo.toFixed(3)}R</span>
      </div>`
    )
    .join("");

  const aprovados = (guardado || []).filter((l) => l.ok).length;
  const media = guardado?.length
    ? guardado.reduce((s, l) => s + l.fora, 0) / guardado.length
    : 0;

  const corpo = state.rankeando
    ? `<div class="vazio">medindo ${esc(state.rankingPasso || "")}… cada ativo leva alguns
        segundos, e o resultado fica guardado.</div>${linhas ? `<div class="rank">${linhas}</div>` : ""}`
    : guardado?.length
      ? `<div class="rank-cab">
           <span></span><span>ativo</span><span>perfil</span><span>ops</span>
           <span>fora da amostra</span><span>custo</span>
         </div>
         <div class="rank">${linhas}</div>
         <div class="metricas">
           <div class="metrica"><span class="m-rot">APROVADOS</span>
             <span class="m-val">${aprovados} de ${guardado.length}</span></div>
           <div class="metrica"><span class="m-rot">MÉDIA DO GRUPO</span>
             <span class="m-val" style="color:${cor(media)}">${num(media)}</span></div>
         </div>
         <div class="nota">Se os perfis fossem acaso, cerca de um quarto passaria por
           sorte. Uma aprovação perto disso não é sinal de que o ativo é bom — é o que a
           moeda daria sozinha. O que vale de verdade aqui é o <b>custo</b>, que é
           geometria e não sorte, e os ativos consistentemente negativos.</div>
         <button class="btn largo" id="rankBotao">medir de novo</button>`
      : `<div class="vazio">Mede todos os ativos da categoria aberta: calibra cada um na
          primeira metade do próprio histórico e julga na segunda, com taxa. Demora alguns
          minutos e fica guardado.</div>
         <button class="btn largo" id="rankBotao">medir ${esc(grupo?.label || "")}</button>`;

  swap(R.rankBody, "rank", corpo);

  el("rankBotao")?.addEventListener("click", medirCategoria);
  R.rankBody.querySelectorAll(".rank-linha").forEach((n) =>
    n.addEventListener("click", () => {
      const id = n.dataset.id;
      if (!id || id === state.symbol) return;
      state.symbol = id;
      el("symbol").value = id;
      reload();
    })
  );
}

// ---------------------------------------------------------------- laboratório
/**
 * Runs any of the entry families against the asset on screen.
 *
 * Both halves are reported side by side and neither is hidden: a family that
 * only works on the half it was looked at is exactly the thing a panel should
 * be able to show you, rather than the thing it quietly rounds away.
 */
async function medirFamilia() {
  if (state.labRodando) return;
  state.labRodando = true;
  state.lab = null;
  renderLab();

  try {
    const velas = await history(state.symbol, state.timeframe, 3000);
    const uteis = (velas?.length || 0) - JANELA;

    if (!velas || uteis < 600) {
      state.lab = { erro: "Histórico curto demais para dividir em duas metades." };
      return;
    }

    const corte = Math.floor(uteis / 2) + JANELA;
    const opts = {
      flowBars: FLOW_BARS[state.timeframe] || 12,
      janela: JANELA,
      taxa: taxaAtual(),
      depth: state.depth,
      zoneLimit: state.zones,
    };

    const naOficina = (fatia) =>
      medir("familia", { velas: fatia, familia: state.familia, opts },
        () => testarFamilia(fatia, state.familia, opts));

    const primeira = await naOficina(velas.slice(0, corte));
    const segunda = await naOficina(velas.slice(corte - JANELA));
    const tudo = await naOficina(velas);

    state.lab = {
      familia: state.familia,
      symbol: state.symbol,
      timeframe: state.timeframe,
      primeira,
      segunda,
      tudo,
    };
  } catch (err) {
    state.lab = { erro: err.message };
  } finally {
    state.labRodando = false;
    renderLab();
  }
}

function renderLab() {
  const ideia = FAMILIAS[state.familia];
  R.labInfo.textContent = `${state.symbol.replace(/^f:/, "")} · ${state.timeframe}`;

  const seletor = `<select class="mini largo-sel" id="labFamilia">${Object.entries(FAMILIAS)
    .map(
      ([k, v]) =>
        `<option value="${k}"${k === state.familia ? " selected" : ""}>${esc(v.nome)}</option>`
    )
    .join("")}</select>`;

  const cabeca = `<div class="lab-topo">${seletor}
      <button class="btn mini-btn" id="labBotao" ${state.labRodando ? "disabled" : ""}>${
        state.labRodando ? "medindo…" : "medir"
      }</button>
    </div>
    <div class="nota">${esc(ideia.conta)}</div>`;

  const lab = state.lab;
  let corpo = "";

  if (lab?.erro) {
    corpo = `<div class="vazio">${esc(lab.erro)}</div>`;
  } else if (lab?.tudo) {
    const cor = (v) => (v > 0 ? UP : v < 0 ? DOWN : NEU);
    const num = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(3)}R`;
    const meia = (t, b) =>
      b
        ? `<div class="metrica"><span class="m-rot">${t}</span>
             <span class="m-val" style="color:${cor(b.porOp)}">${num(b.porOp)}</span>
             <span class="m-sub">${b.total} op · ${b.taxa.toFixed(0)}%</span></div>`
        : `<div class="metrica"><span class="m-rot">${t}</span>
             <span class="m-val">—</span></div>`;

    const consistente =
      lab.primeira?.porOp > 0 && lab.segunda?.porOp > 0 && lab.tudo.total >= 20;

    corpo = `<div class="metricas">
        ${meia("1ª METADE", lab.primeira)}
        ${meia("2ª METADE", lab.segunda)}
        ${meia("TUDO", lab.tudo)}
        <div class="metrica"><span class="m-rot">TAXA</span>
          <span class="m-val">${lab.tudo.custoMedio.toFixed(3)}R</span>
          <span class="m-sub">por operação</span></div>
      </div>

      <div class="spark-box">
        <span class="m-rot">CURVA · PERÍODO INTEIRO</span>
        ${sparkline(lab.tudo.curva.length > 1 ? [0, ...lab.tudo.curva] : null, cor(lab.tudo.r), 44)}
      </div>

      <div class="veredito ${consistente ? "bom" : "ruim"}">
        ${consistente ? "POSITIVA NAS DUAS METADES" : "NÃO SE SUSTENTA NAS DUAS"}
      </div>

      <div class="nota">Uma ideia que só ganha numa das metades ganhou daquele pedaço de
        passado, não do mercado. Entrada na abertura da barra seguinte ao sinal, com a
        corretagem escolhida descontada.</div>`;
  } else {
    corpo = `<div class="vazio">Escolhe uma ideia de entrada e mede neste ativo. As duas
      metades do histórico aparecem separadas — é assim que se vê se a ideia funciona ou
      se apenas decorou o passado.</div>`;
  }

  swap(R.labBody, "lab", cabeca + corpo);

  el("labBotao")?.addEventListener("click", medirFamilia);
  el("labFamilia")?.addEventListener("change", (e) => {
    state.familia = e.target.value;
    state.lab = null;
    renderLab();
  });
}

// ---------------------------------------------------------------- start
const cfgInicial = config.load();
state.symbol = cfgInicial.ativo;
state.timeframe = cfgInicial.tempo;

mount();
mountDeep();
renderFicha();
renderRanking();
renderLab();
renderComite();
renderMapa();
renderMonte();
renderCap();
renderMesa();
renderLado();
renderChoque();
renderSent();
ligarMascote();
ligarAba();
ligarSub();
ligarVersao();
ligarConta();
buildControls();
aplicarConfig();
status("", "conectando…");
start();
rodarBacktest();
pullTape();
setTimeout(escanear, 3000);
setTimeout(medirComite, 5000);
setTimeout(mapear, 9000);

// as telas leves ficam prontas antes de alguém pedir; o Monte Carlo e a mesa
// são pesados demais para rodar sem que ninguém tenha aberto a aba
setTimeout(medirSentimento, 12000);
setTimeout(medirLado, 14000);
setTimeout(medirChoque, 16000);
setTimeout(medirCapacidade, 18000);
setInterval(pullTape, 20000);
setInterval(pullSpot, 30000);
setInterval(pullDeep, DEEP_MS);
setInterval(escanear, SCAN_MS);
requestAnimationFrame(loop);

// ------------------------------------------------------------- comitê (tela)
/**
 * Measures every reader on the asset on screen and shows who earned a seat.
 *
 * The two halves are both reported, because the seat rule is exactly "positive
 * in both" — showing only the total would hide the thing the rule is made of.
 */
async function medirComite() {
  if (state.comiteRodando) return;
  const chave = `${state.symbol}:${state.timeframe}`;
  state.comiteRodando = true;
  state.comite = null;
  renderComite();

  try {
    const velas = await history(state.symbol, state.timeframe, 3000);
    if (chave !== `${state.symbol}:${state.timeframe}`) return;

    const optsFicha = {
      janela: JANELA,
      taxa: taxaAtual(),
      flowBars: FLOW_BARS[state.timeframe] || 12,
      depth: state.depth,
      zoneLimit: state.zones,
    };
    const ficha = await medir("ficha", { velas: velas || [], opts: optsFicha },
      () => fichaComite(velas || [], optsFicha));
    await respirar();

    state.comite = ficha.curto
      ? { erro: "Histórico curto demais para dar assento a alguém." }
      : { ...ficha, symbol: state.symbol, timeframe: state.timeframe };
    state.comiteChave = chave;
  } catch (err) {
    state.comite = { erro: err.message };
  } finally {
    state.comiteRodando = false;
    renderComite();
    if (state.data?.candles?.length) recompute();
  }
}

function renderComite() {
  if (!R.comiteBody) return;
  const ligado = config.load().comite === true;
  const c = state.comite;

  R.comiteInfo.textContent = state.comiteRodando
    ? "medindo…"
    : `${state.symbol.replace(/^f:/, "")} · ${state.timeframe}`;

  const chave = `<label class="cfg-opcao comite-chave">
      <input type="checkbox" id="comiteLiga"${ligado ? " checked" : ""} />
      <span>Usar o comitê no lugar da leitura padrão</span>
    </label>`;

  let corpo;
  if (c?.erro) {
    corpo = `<div class="vazio">${esc(c.erro)}</div>`;
  } else if (!c) {
    corpo = `<div class="vazio">Medindo cada leitor neste ativo…</div>`;
  } else {
    const num = (v) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(3)}R`);
    const cor = (v) => (v == null ? NEU : v > 0 ? UP : v < 0 ? DOWN : NEU);

    const linhas = c.leitores
      .map(
        (l) => `<div class="comite-linha ${l.assento ? "tem-assento" : ""}">
          <div class="comite-nome">
            <span class="comite-selo">${l.assento ? "ASSENTO" : "SEM VOTO"}</span>
            <strong>${esc(l.nome)}</strong>
            <span class="nota">${esc(l.conta)}</span>
          </div>
          <div class="comite-nums">
            <span class="m-sub">1ª</span><span style="color:${cor(l.primeira)}">${num(l.primeira)}</span>
            <span class="m-sub">2ª</span><span style="color:${cor(l.segunda)}">${num(l.segunda)}</span>
            <span class="m-sub">${l.ops} op</span>
          </div>
        </div>`
      )
      .join("");

    corpo = `<div class="comite-lista">${linhas}</div>
      <div class="veredito ${c.assentos ? "bom" : "ruim"}">
        ${c.assentos ? `${c.assentos} DE ${c.leitores.length} COM ASSENTO` : "NINGUÉM COM ASSENTO AQUI"}
      </div>
      <div class="nota">Um leitor só vota neste ativo se foi positivo nas <strong>duas</strong>
        metades do histórico, com ao menos 12 operações. Medido em 20 ativos no 1h, o comitê
        rendeu +0,086R por operação contra +0,270R da leitura padrão — por isso ele vem
        desligado. Ligue para comparar no ativo que você opera.</div>`;
  }

  swap(R.comiteBody, "comite", chave + corpo);

  el("comiteLiga")?.addEventListener("change", (e) => {
    config.save({ comite: e.target.checked });
    renderComite();
    if (state.data?.candles?.length) recompute();
  });
}

// ------------------------------------------------------------ mapa do ativo
const TEMPOS_MAPA = ["5m", "15m", "1h", "4h", "1d"];

/**
 * The same asset measured across every timeframe, side by side.
 *
 * The panel treats 5m and 1h with the same confidence, but they are not the
 * same trade: gold measured -0.140R an hour candle on 5m and +0.242R on 1h over
 * the same history, because a fee is a fixed share of a tight stop and a small
 * share of a wide one. That difference decides whether the panel makes money
 * for its owner, and until now it was only visible to whoever ran a backtest.
 */
async function mapear() {
  if (state.mapeando) return;
  const chave = state.symbol;
  state.mapeando = true;
  state.mapa = null;
  renderMapa();

  const linhas = [];
  try {
    for (const tf of TEMPOS_MAPA) {
      if (chave !== state.symbol) return;
      state.mapaPasso = `medindo ${tf}`;
      renderMapa();
      await respirar();

      try {
        const velas = await history(state.symbol, tf, 2500);
        if (!velas || velas.length - JANELA < 300) { linhas.push({ tf, curto: true }); continue; }
        const opts = { flowBars: FLOW_BARS[tf] || 12, janela: JANELA, taxa: taxaAtual() };
        const bt = await medir("backtest", { velas, opts }, () => backtest(velas, opts));
        linhas.push(bt && bt.total >= 5
          ? { tf, ops: bt.total, porOp: bt.porOp, acerto: bt.taxa, folga: bt.taxa - bt.acertoNecessario }
          : { tf, poucas: true });
      } catch {
        linhas.push({ tf, erro: true });
      }
    }
    state.mapa = { symbol: state.symbol, linhas };
  } finally {
    state.mapeando = false;
    state.mapaPasso = null;
    renderMapa();
  }
}

function renderMapa() {
  if (!R.mapaBody) return;
  const ativo = state.symbol.replace(/^f:/, "");
  R.mapaInfo.textContent = state.mapeando ? state.mapaPasso || "medindo…" : ativo;

  if (state.mapeando && !state.mapa) {
    swap(R.mapaBody, "mapa", `<div class="vazio">${esc(state.mapaPasso || "medindo")}…</div>`);
    return;
  }
  if (!state.mapa) {
    swap(R.mapaBody, "mapa", `<div class="vazio">Sem medição ainda.</div>
      <button class="btn largo" id="mapaBotao">medir ${esc(ativo)} nos cinco tempos</button>`);
    el("mapaBotao")?.addEventListener("click", mapear);
    return;
  }

  const { linhas } = state.mapa;
  const validas = linhas.filter((l) => l.porOp != null);
  const melhor = validas.length ? validas.reduce((m, l) => (l.porOp > m.porOp ? l : m)) : null;
  const atual = linhas.find((l) => l.tf === state.timeframe);

  const corpo = linhas.map((l) => {
    if (l.porOp == null) {
      const por = l.curto ? "histórico curto" : l.erro ? "falhou" : "poucas operações";
      return `<div class="mapa-linha vazia"><span class="mapa-tf">${l.tf}</span>
        <span class="nota">${por}</span></div>`;
    }
    const col = l.porOp > 0 ? UP : DOWN;
    const largura = Math.min(100, Math.abs(l.porOp) * 120);
    return `<div class="mapa-linha ${l.tf === state.timeframe ? "atual" : ""}">
        <span class="mapa-tf">${l.tf}${l === melhor ? " ★" : ""}</span>
        <div class="mapa-barra"><div class="mapa-zero"></div>
          <div class="mapa-fill" style="${l.porOp > 0 ? "left:50%" : `right:50%`};width:${largura / 2}%;background:${col}"></div></div>
        <span class="mapa-val" style="color:${col}">${l.porOp >= 0 ? "+" : ""}${l.porOp.toFixed(3)}R</span>
        <span class="m-sub">${l.ops} op · ${l.acerto.toFixed(0)}%</span>
      </div>`;
  }).join("");

  let aviso = "";
  if (atual?.porOp != null && atual.porOp <= 0) {
    aviso = `<div class="mapa-aviso">
        <strong>${esc(ativo)} no ${state.timeframe} rendeu ${atual.porOp.toFixed(3)}R por operação</strong>
        em ${atual.ops} entradas medidas.${
          melhor && melhor.porOp > 0
            ? ` No ${melhor.tf} rendeu ${melhor.porOp >= 0 ? "+" : ""}${melhor.porOp.toFixed(3)}R.`
            : " Nenhum tempo deste ativo ficou positivo."
        }</div>`;
  }

  swap(R.mapaBody, "mapa", aviso + `<div class="mapa-lista">${corpo}</div>
    <div class="nota">Cada tempo medido no histórico inteiro deste ativo, com a corretagem
      escolhida e entrada na abertura da barra seguinte ao sinal. ★ é o que mais rendeu.</div>
    <button class="btn largo" id="mapaBotao">medir de novo</button>`);
  el("mapaBotao")?.addEventListener("click", mapear);
}

// ------------------------------------------------------------------ oficina
/**
 * The measurement thread, and the promise-shaped door to it.
 *
 * Every heavy figure in this panel is arithmetic over thousands of bars, and
 * it used to run here — on the thread that draws the chart and answers the
 * mouse. One backtest over 2500 candles costs about 750ms, the asset map runs
 * five and the Monte Carlo grid sixty, so the page sat frozen for seconds at a
 * time: clicks queued up, the wheel did nothing, the chart stopped moving.
 *
 * Now the numbers are worked out on their own thread and only the answers come
 * back. If the worker cannot start — an old browser, a file blocked — the
 * calculation falls back to running here, slowly but correctly, rather than
 * the screen simply staying empty.
 */
const oficina = (() => {
  let fio = null;
  let proximo = 0;
  const pendentes = new Map();

  const abrir = () => {
    if (fio !== null) return fio;
    try {
      fio = new Worker("./trabalho.js?v=54", { type: "module" });
      fio.onmessage = (e) => {
        const { id, resultado, erro } = e.data || {};
        const pedido = pendentes.get(id);
        if (!pedido) return;
        pendentes.delete(id);
        erro ? pedido.falhou(new Error(erro)) : pedido.ok(resultado);
      };
      fio.onerror = () => {
        for (const { falhou } of pendentes.values()) falhou(new Error("oficina caiu"));
        pendentes.clear();
        fio = false; // não tenta de novo; daqui em diante é na mão
      };
    } catch {
      fio = false;
    }
    return fio;
  };

  return {
    disponivel: () => abrir() !== false,
    pedir(tarefa, dados) {
      const t = abrir();
      if (t === false) return Promise.reject(new Error("sem oficina"));
      const id = ++proximo;
      return new Promise((ok, falhou) => {
        pendentes.set(id, { ok, falhou });
        t.postMessage({ id, tarefa, dados });
      });
    },
  };
})();

/** Runs in the worker when there is one, here when there is not. */
async function medir(tarefa, dados, naMao) {
  try {
    if (oficina.disponivel()) return await oficina.pedir(tarefa, dados);
  } catch {
    /* cai para o caminho da mão */
  }
  await respirar();
  return naMao();
}

// ------------------------------------------------------------ tela inicial
/**
 * Where the panel opens.
 *
 * Until now it opened straight onto the chart, which suits whoever built it and
 * nobody who just bought it: every measurement the panel makes was reachable
 * only by scrolling past the part that looks like it is the whole product. This
 * screen names the paths, and each one lands on the thing it names.
 *
 * It covers the panel rather than replacing it, so the stream, the open trade
 * and the scan all keep running underneath and nothing is rebuilt on the way
 * back.
 */
/**
 * The paths out of the home screen.
 *
 * Each tile carries a `linha` — one concrete fact about what is behind it,
 * written where it can be changed without touching the layout. A tile that only
 * names itself makes the reader open it to find out whether it was worth
 * opening; a tile that says what is inside lets them decide from here.
 */
const CAMINHOS = [
  {
    id: "operar",
    titulo: "Operar",
    conta: "O gráfico ao vivo, com a entrada, o stop e o alvo desenhados na tela.",
    linha: "Entrada confirmada no fechamento da barra",
    cor: "#14b8a6",
    icone: `<path d="M3 17l6-6 4 4 8-8"/><path d="M21 7v6h-6"/>`,
  },
  {
    id: "cardSent",
    titulo: "Sentimento do mercado",
    conta: "O medo e a ganância de hoje — e o que cada faixa rendeu na semana seguinte.",
    linha: "3.151 dias medidos desde 2018",
    cor: "#ff9f5c",
    icone: `<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0"/><path d="M9 9h.01M15 9h.01"/>`,
  },
  {
    id: "cardMonte",
    titulo: "Monte Carlo",
    conta: "Todos os ativos em todos os tempos, reembaralhados mil e quinhentas vezes.",
    linha: "A chance de lucro, não a média",
    cor: "#b47cf0",
    icone: `<path d="M3 3v18h18"/><path d="M7 16c2-6 4 2 5-4s3 5 5-3"/>`,
  },
  {
    id: "cardCap",
    titulo: "Capacidade e impacto",
    conta: "Quanto dinheiro este ativo carrega antes da vantagem sumir no livro.",
    linha: "Mil níveis de livro, ao vivo",
    cor: "#2fe08a",
    icone: `<path d="M3 12h4l3-8 4 16 3-8h4"/>`,
  },
  {
    id: "cardMesa",
    titulo: "Mesa de risco",
    conta: "Quantas das suas posições são, na verdade, a mesma posição.",
    linha: "Correlação entre dez ativos",
    cor: "#ff7a88",
    icone: `<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>`,
  },
  {
    id: "cardLado",
    titulo: "Quem está do outro lado",
    conta: "As contas comuns contra as maiores, funding, prêmio e posições abertas.",
    linha: "Os dois lados da mesa, separados",
    cor: "#5c8cff",
    icone: `<path d="M12 3v18"/><path d="M5 8h4M15 8h4"/><circle cx="7" cy="14" r="3"/><circle cx="17" cy="14" r="3"/>`,
  },
  {
    id: "cardChoque",
    titulo: "Choques e volatilidade",
    conta: "As barras em que algo aconteceu, o tamanho do susto e o que veio depois.",
    linha: "Lido da fita, sem manchete",
    cor: "#f5b72a",
    largo: true,
    icone: `<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>`,
  },
  {
    id: "conta",
    titulo: "Minha conta",
    conta: "Nome, foto, corretagem, voz e quais blocos aparecem embaixo do gráfico.",
    linha: "A taxa escolhida entra em toda medição",
    cor: "#8fa39b",
    largo: true,
    icone: `<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>`,
  },
];

function renderInicio() {
  const corpo = el("abaCorpo");
  if (!corpo) return;
  const c = config.load();

  const hora = new Date().getHours();
  const parte = hora < 5 ? "Boa madrugada" : hora < 12 ? "Bom dia" : hora < 18 ? "Boa tarde" : "Boa noite";
  const nome = (c.nome || "").trim().split(/\s+/)[0];
  el("inicioOla").textContent = nome ? `${parte}, ${nome}` : parte;
  el("inicioSub").textContent = `${state.symbol.replace(/^f:/, "")} · ${state.timeframe}`;

  const foto = el("inicioPerfil");
  foto.style.backgroundImage = c.foto ? `url(${c.foto})` : "none";
  foto.textContent = c.foto ? "" : iniciais(c.nome);

  corpo.innerHTML = `<div class="hero" id="hero">
      <div class="hero-topo">
        <div class="hero-quem">
          <span class="hero-ativo" id="heroAtivo">${esc(state.symbol.replace(/^f:/, ""))}</span>
          <span class="hero-tf">${esc(state.timeframe)}</span>
        </div>
        <div class="hero-preco">
          <span class="hero-valor" id="heroValor">—</span>
          <span class="hero-var" id="heroVar">—</span>
        </div>
      </div>
      <svg class="hero-svg" id="heroSvg" preserveAspectRatio="none" aria-hidden="true"></svg>
    </div>

    <div class="inicio-grade">${CAMINHOS.map(
    (v, i) => `<button class="caminho${v.largo ? " largo" : ""}" type="button"
        data-vai="${v.id}" style="--cor:${v.cor};--atraso:${i * 60}ms">
        <span class="caminho-topo">
          <span class="caminho-icone">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${v.icone}</svg>
          </span>
          <span class="caminho-seta">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 18l6-6-6-6"/></svg>
          </span>
        </span>
        <strong class="caminho-titulo">${esc(v.titulo)}</strong>
        <span class="caminho-conta">${esc(v.conta)}</span>
        <span class="caminho-linha">${esc(v.linha)}</span>
      </button>`
  ).join("")}</div>

  <p class="inicio-rodape">O painel opera só a compra. A venda foi medida em 18 ativos e
    perdeu com o mercado subindo, de lado e caindo — dá pra ligar em Minha conta.</p>`;

  corpo.querySelectorAll("[data-vai]").forEach((b) =>
    b.addEventListener("click", () => irPara(b.dataset.vai))
  );

  desenharHero(true);
}

/**
 * The live chart at the top of the home screen.
 *
 * It draws itself in when the screen opens — the line sweeps left to right, the
 * area fills in behind it, and the last point keeps a pulse — then follows the
 * same candles the panel is already streaming, so it is the real asset rather
 * than decoration shaped like one. Drawn straight into the SVG in viewport
 * pixels, measured each pass, so it stays sharp at any width instead of being
 * a fixed viewBox stretched to fit.
 */
function desenharHero(entrando) {
  const svg = el("heroSvg");
  const velas = state.data?.candles;
  if (!svg || !velas?.length) return;

  const caixa = svg.getBoundingClientRect();
  const L = Math.max(220, Math.round(caixa.width));
  const A = Math.max(90, Math.round(caixa.height));
  if (!L || !A) return;

  const dados = velas.slice(-140).map((c) => c.close);
  if (dados.length < 2) return;

  const alto = Math.max(...dados);
  const baixo = Math.min(...dados);
  const faixa = alto - baixo || alto * 0.001 || 1;
  const topo = 14;
  const base = A - 10;

  const x = (i) => (i / (dados.length - 1)) * L;
  const y = (v) => base - ((v - baixo) / faixa) * (base - topo);

  const pontos = dados.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const linha = `M${pontos.join(" L")}`;
  const area = `${linha} L${L},${A} L0,${A} Z`;

  const subiu = dados[dados.length - 1] >= dados[0];
  const cor = subiu ? "#2fe08a" : "#ff4d63";
  const fx = x(dados.length - 1);
  const fy = y(dados[dados.length - 1]);

  svg.setAttribute("viewBox", `0 0 ${L} ${A}`);
  svg.innerHTML = `
    <defs>
      <linearGradient id="heroFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${cor}" stop-opacity="0.34"/>
        <stop offset="100%" stop-color="${cor}" stop-opacity="0"/>
      </linearGradient>
      <filter id="heroGlow" x="-30%" y="-60%" width="160%" height="260%">
        <feGaussianBlur stdDeviation="3.2" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <path class="hero-area" d="${area}" fill="url(#heroFill)"/>
    <path class="hero-linha" d="${linha}" fill="none" stroke="${cor}" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"
      filter="url(#heroGlow)"/>
    <circle class="hero-halo" cx="${fx.toFixed(1)}" cy="${fy.toFixed(1)}" r="4" fill="${cor}"/>
    <circle cx="${fx.toFixed(1)}" cy="${fy.toFixed(1)}" r="2.6" fill="${cor}"/>`;

  if (entrando && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const caminho = svg.querySelector(".hero-linha");
    const comprimento = caminho.getTotalLength();
    caminho.style.strokeDasharray = comprimento;
    caminho.style.strokeDashoffset = comprimento;
    caminho.getBoundingClientRect(); // força o navegador a assumir o estado inicial
    caminho.style.transition = "stroke-dashoffset 1.1s cubic-bezier(0.33, 1, 0.68, 1)";
    caminho.style.strokeDashoffset = "0";
  }

  const stats = state.data?.stats;
  const preco = stats?.price || dados[dados.length - 1];
  el("heroValor").textContent = fmt(preco);
  const v = stats?.changePct;
  const alvo = el("heroVar");
  alvo.textContent = v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  alvo.style.color = v == null ? NEU : v >= 0 ? UP : DOWN;
}

/**
 * Where a path leads.
 *
 * Only "Operar" hands the screen over to the panel. Every other path opens on
 * its own, because landing someone inside the chart to read a table means they
 * arrive somewhere that looks like it wants them to trade, when they came to
 * look something up.
 *
 * The block is moved rather than copied — its live render functions write to
 * that exact element, so a duplicate would be the one going stale. A marker
 * holds its place in the panel and puts it back on the way out.
 */
let subMarcador = null;
let subCartao = null;

function irPara(destino) {
  voz.clique?.();

  if (destino === "operar") {
    el("aba").hidden = true;
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  if (destino === "conta") {
    abrirConfig();
    return;
  }

  const cartao = el(destino);
  if (!cartao) return;

  // a block switched off in the settings still opens from here
  fecharSub();

  subMarcador = document.createComment("cartao em uso");
  cartao.parentNode.insertBefore(subMarcador, cartao);
  subCartao = cartao;

  const titulo = cartao.querySelector(".lbl")?.textContent?.trim() || "";
  el("subTitulo").textContent = titulo;
  comecarTela(destino);
  el("subCorpo").replaceChildren(cartao);
  el("sub").hidden = false;
  el("subCorpo").scrollTop = 0;
  el("subVoltar").focus();
}

/**
 * A screen starts measuring the moment it is opened.
 *
 * Asking someone to press a button to see the thing they just navigated to is
 * a step that exists only because it was easier to write. Each screen knows
 * whether it already has an answer for the asset on screen, so opening it twice
 * costs nothing, and the button stays for asking again on purpose.
 */
const COMECAR = {
  cardSent: () => (state.sent || state.sentRodando ? null : medirSentimento()),
  cardMonte: () => (state.monte || state.monteRodando ? null : rodarMonte()),
  cardCap: () => (state.cap || state.capRodando ? null : medirCapacidade()),
  cardMesa: () => (state.mesa || state.mesaRodando ? null : medirMesa()),
  cardLado: () => (state.lado || state.ladoRodando ? null : medirLado()),
  cardChoque: () => (state.choque || state.choqueRodando ? null : medirChoque()),
};

function comecarTela(destino) {
  const comeca = COMECAR[destino];
  if (comeca) setTimeout(comeca, 60); // deixa a tela aparecer antes de travar o fio
}

/** Puts the block back in the panel exactly where it was. */
function fecharSub() {
  if (subCartao && subMarcador?.parentNode) {
    subMarcador.parentNode.insertBefore(subCartao, subMarcador);
    subMarcador.remove();
  }
  subMarcador = null;
  subCartao = null;
  el("sub").hidden = true;
}

function ligarSub() {
  el("subVoltar")?.addEventListener("click", () => {
    fecharSub();
    voz.clique?.();
    el("abaBtn")?.focus();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el("sub").hidden) fecharSub();
  });
}

// ------------------------------------------------------------- segunda aba
// ------------------------------------------------------------- segunda aba
/**
 * A screen of its own, reached from the button opposite the mascot.
 *
 * It is deliberately empty: what goes inside is the next decision, and an
 * empty room with a working door is easier to furnish than a door that has to
 * be cut later. The panel behind it keeps streaming — this covers it, it does
 * not replace it, so nothing has to be rebuilt when the screen closes.
 */
function ligarAba() {
  const aba = el("aba");
  const btn = el("abaBtn");
  if (!aba || !btn) return;

  const abrir = () => {
    renderInicio();
    aba.hidden = false;
    voz.clique?.();
    el("abaVoltar")?.focus();
  };

  // while the home screen is up it follows the same stream the panel is on
  setInterval(() => {
    if (!aba.hidden) desenharHero(false);
  }, 4000);
  const fechar = () => {
    fecharSub();
    aba.hidden = true;
    btn.focus();
  };

  btn.addEventListener("click", abrir);
  el("abaVoltar")?.addEventListener("click", fechar);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !aba.hidden) fechar();
  });
}

// The panel opens on its home screen. This sits last because the paths it
// draws are declared above as const, which does not hoist the way the boot
// sequence's function calls do.
renderInicio();
el("aba").hidden = false;

// ==========================================================================
//  MESA — as telas de instituição
// ==========================================================================
const TEMPOS_MESA = ["5m", "15m", "1h", "4h", "1d"];
const ATIVOS_MESA = ["BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "LINK", "AVAX",
                     "DOT", "LTC", "BNB", "f:XAU"];

/** The per-trade results a backtest produced, recovered from its equity curve. */
function resultadosDe(bt) {
  if (!bt || !bt.curva || bt.curva.length < 5) return null;
  return bt.curva.map((x, i, arr) => (i ? x - arr[i - 1] : x));
}

// -------------------------------------------------------------- monte carlo
/**
 * Every asset against every timeframe, judged by the spread of outcomes.
 *
 * The grid answers the question an average never does: not "does this pay" but
 * "how often does it pay, and what does the bad road look like". A cell is
 * shaded by how often the resampled account ends above zero, so a thin edge
 * that survives only half of its own possible futures stops looking like a
 * good cell however pretty its average was.
 */
async function rodarMonte() {
  if (state.monteRodando) return;
  state.monteRodando = true;
  state.monte = state.monte || { celulas: {} };
  renderMonte();

  try {
    for (const id of ATIVOS_MESA) {
      for (const tf of TEMPOS_MESA) {
        const chave = id + ":" + tf;
        state.montePasso = id.replace(/^f:/, "") + " " + tf;
        renderMonte();
        await respirar();

        try {
          const velas = await history(id, tf, 2500);
          if (!velas || velas.length - JANELA < 300) { state.monte.celulas[chave] = null; continue; }
          const opts = { flowBars: FLOW_BARS[tf] || 12, janela: JANELA, taxa: taxaAtual() };
          state.monte.celulas[chave] = await medir("celula", { velas, opts }, () => {
            const bt = backtest(velas, opts);
            const rs = resultadosDe(bt);
            if (!rs || rs.length < 8) return null;
            const mc = monteCarlo(rs, { caminhos: 1500 });
            return mc ? { ...mc, porOp: bt.porOp, leque: leque(rs, { caminhos: 800 }) } : null;
          });
        } catch {
          state.monte.celulas[chave] = null;
        }
        renderMonte();
      }
    }
  } finally {
    state.monteRodando = false;
    state.montePasso = null;
    renderMonte();
  }
}

function renderMonte() {
  if (!R.monteBody) return;
  const st = state.monte;
  R.monteInfo.textContent = state.monteRodando
    ? "medindo " + (state.montePasso || "")
    : "12 ativos × 5 tempos";

  if (!st) {
    swap(R.monteBody, "monte", '<div class="vazio">Cada ativo em cada tempo, reembaralhado 1.500 ' +
      'vezes. Mostra com que frequência a conta termina no lucro, o quanto ela cai pelo caminho e ' +
      'quantas perdas seguidas esperar — tudo o que a média por operação esconde.</div>' +
      '<button class="btn largo" id="monteBotao">rodar a grade</button>');
    el("monteBotao")?.addEventListener("click", rodarMonte);
    return;
  }

  const sel = state.monteSel && st.celulas[state.monteSel];
  const cor = (p) => (p == null ? "var(--line-soft)"
    : p >= 75 ? UP : p >= 60 ? "#8fd39f" : p >= 45 ? WARN : DOWN);

  const cabeca = '<div class="mc-linha mc-cab"><span class="mc-rot"></span>' +
    TEMPOS_MESA.map((t) => '<span class="mc-tf">' + t + "</span>").join("") + "</div>";

  const linhas = ATIVOS_MESA.map((id) => {
    const celulas = TEMPOS_MESA.map((tf) => {
      const k = id + ":" + tf;
      const c = st.celulas[k];
      const p = c ? c.chanceDeLucro : null;
      const fundo = p == null
        ? "var(--line-soft)"
        : "color-mix(in srgb, " + cor(p) + " " + Math.round(18 + (p / 100) * 62) + "%, transparent)";
      return '<button class="mc-cel' + (state.monteSel === k ? " viva" : "") + '" data-mc="' + k +
        '" style="background:' + fundo + '">' + (p == null ? "·" : Math.round(p)) + "</button>";
    }).join("");
    return '<div class="mc-linha"><span class="mc-rot">' + esc(id.replace(/^f:/, "")) +
      "</span>" + celulas + "</div>";
  }).join("");

  /**
   * The cone the account lives inside, not just where it ends.
   *
   * Three paths are drawn from one scale: the 5th percentile along the floor,
   * the median through the middle, the 95th along the ceiling. The zero line is
   * marked because the only question that matters while reading it is how much
   * of the floor sits below it.
   */
  const desenharLeque = (lq) => {
    if (!lq) return "";
    const todos = [...lq.baixo, ...lq.alto, 0];
    const lo = Math.min(...todos);
    const hi = Math.max(...todos);
    const faixa = hi - lo || 1;
    const L = 300;
    const A = 90;
    const x = (i) => ((i / (lq.meio.length - 1)) * L).toFixed(1);
    const y = (v) => (A - 6 - ((v - lo) / faixa) * (A - 12)).toFixed(1);
    const linha = (arr) => arr.map((v, i) => (i ? "L" : "M") + x(i) + " " + y(v)).join(" ");
    const area = linha(lq.alto) + " " +
      lq.baixo.map((v, i, a) => "L" + x(a.length - 1 - i) + " " + y(a[a.length - 1 - i])).join(" ") + " Z";

    return '<div class="spark-box"><span class="m-rot">AS ROTAS POSSÍVEIS</span>' +
      '<svg class="leque" viewBox="0 0 ' + L + " " + A + '" preserveAspectRatio="none">' +
      '<path d="' + area + '" fill="#14b8a6" opacity="0.14"/>' +
      '<line x1="0" y1="' + y(0) + '" x2="' + L + '" y2="' + y(0) +
        '" stroke="var(--dim)" stroke-width="1" stroke-dasharray="3 4" ' +
        'vector-effect="non-scaling-stroke" shape-rendering="crispEdges"/>' +
      '<path d="' + linha(lq.baixo) + '" fill="none" stroke="' + DOWN +
        '" stroke-width="1.4" vector-effect="non-scaling-stroke"/>' +
      '<path d="' + linha(lq.alto) + '" fill="none" stroke="' + UP +
        '" stroke-width="1.4" vector-effect="non-scaling-stroke"/>' +
      '<path d="' + linha(lq.meio) + '" fill="none" stroke="#14b8a6" stroke-width="2" ' +
        'vector-effect="non-scaling-stroke"/>' +
      "</svg>" +
      '<div class="leque-pes"><span style="color:' + DOWN + '">pior 5%</span>' +
      '<span style="color:#14b8a6">típico</span>' +
      '<span style="color:' + UP + '">melhor 5%</span></div></div>';
  };

  /**
   * Which timeframes are worth anything at all, averaged across the assets.
   *
   * Reading sixty cells one by one is how a pattern gets missed; collapsing the
   * grid by column says in one line where this reading works, which is the
   * conclusion someone actually takes away from the screen.
   */
  const porTempo = TEMPOS_MESA.map((tf) => {
    const vs = ATIVOS_MESA.map((id) => st.celulas[id + ":" + tf])
      .filter((c) => c && typeof c.chanceDeLucro === "number");
    return {
      tf,
      n: vs.length,
      media: vs.length ? vs.reduce((s, c) => s + c.chanceDeLucro, 0) / vs.length : null,
      bons: vs.filter((c) => c.chanceDeLucro >= 60).length,
    };
  }).filter((x) => x.n);

  const resumoTempo = porTempo.length
    ? '<div class="pf-bloco"><div class="pf-cab">' +
      '<span class="m-rot">POR TEMPO GRÁFICO</span>' +
      '<span class="m-sub">média da chance de lucro</span></div>' +
      '<div class="pf-lista">' + porTempo.map((x) => {
        const col = x.media >= 60 ? UP : x.media >= 45 ? WARN : DOWN;
        return '<div class="carrega-linha"><span class="carrega-nome">' + x.tf + "</span>" +
          '<div class="carrega-trilho"><div class="carrega-fill" style="width:' +
          x.media.toFixed(0) + "%;background:" + col + '"></div></div>' +
          '<span class="carrega-val" style="color:' + col + '">' + x.media.toFixed(0) +
          "% · " + x.bons + "/" + x.n + "</span></div>";
      }).join("") + "</div>" +
      '<div class="nota">O segundo número é quantos ativos passaram de 60% de chance naquele ' +
      "tempo. É o resumo da grade inteira numa linha por tempo.</div></div>"
    : "";

  const detalhe = sel
    ? '<div class="mc-detalhe"><div class="mc-tit">' + esc(state.monteSel.replace(/^f:/, "")) + "</div>" +
      '<div class="metricas">' +
        '<div class="metrica"><span class="m-rot">CHANCE DE LUCRO</span>' +
          '<span class="m-val" style="color:' + cor(sel.chanceDeLucro) + '">' +
          sel.chanceDeLucro.toFixed(0) + '%</span>' +
          '<span class="m-sub">' + sel.operacoes + " operações</span></div>" +
        '<div class="metrica"><span class="m-rot">CAMINHO TÍPICO</span>' +
          '<span class="m-val" style="color:' + (sel.mediana > 0 ? UP : DOWN) + '">' +
          (sel.mediana >= 0 ? "+" : "") + sel.mediana.toFixed(1) + 'R</span>' +
          '<span class="m-sub">pior 5%: ' + sel.pior5.toFixed(1) + "R</span></div>" +
        '<div class="metrica"><span class="m-rot">QUEDA ESPERADA</span>' +
          '<span class="m-val" style="color:' + DOWN + '">−' + sel.quedaTipica.toFixed(1) + 'R</span>' +
          '<span class="m-sub">ruim: −' + sel.quedaRuim.toFixed(1) + "R</span></div>" +
        '<div class="metrica"><span class="m-rot">PERDAS SEGUIDAS</span>' +
          '<span class="m-val">' + sel.perdasSeguidas.toFixed(1) + "</span>" +
          '<span class="m-sub">esperadas no caminho</span></div>' +
        (sel.leque
          ? '<div class="metrica"><span class="m-rot">RISCO DE ENCOSTAR EM −10R</span>' +
            '<span class="m-val" style="color:' +
            (sel.leque.riscoDeRuina > 20 ? DOWN : sel.leque.riscoDeRuina > 8 ? WARN : UP) + '">' +
            sel.leque.riscoDeRuina.toFixed(1) + "%</span>" +
            '<span class="m-sub">em algum ponto do caminho</span></div>'
          : "") +
      "</div>" + desenharLeque(sel.leque) +
      '<div class="nota">A média desta célula é ' + (sel.porOp >= 0 ? "+" : "") + sel.porOp.toFixed(3) +
        "R por operação. Ainda assim, em " + (100 - sel.chanceDeLucro).toFixed(0) +
        "% dos caminhos possíveis ela termina no prejuízo, e o normal é atravessar " +
        sel.perdasSeguidas.toFixed(0) + " perdas seguidas antes do fim.</div></div>"
    : '<div class="nota">Toque numa célula para ver o caminho dela. O número é a chance de ' +
      "terminar no lucro em 1.500 reembaralhamentos das operações medidas.</div>";

  swap(R.monteBody, "monte", '<div class="mc-grade">' + cabeca + linhas + "</div>" + detalhe + resumoTempo +
    '<button class="btn largo" id="monteBotao">' +
    (state.monteRodando ? "medindo…" : "rodar de novo") + "</button>");

  R.monteBody.querySelectorAll("[data-mc]").forEach((b) =>
    b.addEventListener("click", () => { state.monteSel = b.dataset.mc; renderMonte(); }));
  const botao = el("monteBotao");
  if (botao) { botao.disabled = state.monteRodando; botao.addEventListener("click", rodarMonte); }
}

// --------------------------------------------------------------- capacidade
/** A thousand levels of book — deep enough for the question to mean something. */
async function livroFundo(symbolId) {
  if (symbolId.startsWith("f:")) return null; // futuros não entregam este livro
  const par = symbolId + "USDT";
  try {
    const r = await fetch("https://api.binance.com/api/v3/depth?symbol=" + par + "&limit=1000");
    if (!r.ok) return null;
    const j = await r.json();
    return j.bids && j.bids.length ? j : null;
  } catch { return null; }
}

/**
 * How much money this edge carries before the book eats it.
 *
 * A real order walks down the levels, and what it pays above the touch is a
 * cost like any other — expressed in R it sits directly against the measured
 * edge, which gives the number no retail panel states: the size at which the
 * edge is gone.
 */
async function medirCapacidade() {
  if (state.capRodando) return;
  state.capRodando = true;
  renderCap();

  try {
    const [velas, livro] = await Promise.all([
      history(state.symbol, state.timeframe, 2500),
      livroFundo(state.symbol),
    ]);

    if (!livro) {
      state.cap = { erro: "Este ativo não entrega livro profundo — só os pares à vista da Binance." };
      return;
    }
    if (!velas) { state.cap = { erro: "Histórico indisponível." }; return; }

    const optsBt = { flowBars: FLOW_BARS[state.timeframe] || 12, janela: JANELA, taxa: taxaAtual() };
    const bt = await medir("backtest", { velas, opts: optsBt }, () => backtest(velas, optsBt));
    const a = (state.analysis && state.analysis.atr) || 0;
    const preco = +livro.asks[0][0];
    const stopPct = preco > 0 ? a / preco : 0;

    /**
     * The book is measured either way.
     *
     * Capacity needs an edge to divide into, but the spread, the depth and what
     * a given order would slip are facts about the market, not about the
     * strategy. Hiding them because this timeframe happens to be unprofitable
     * left the screen almost blank, which read as broken rather than as honest.
     */
    const perfil = perfilDoLivro(livro.bids, livro.asks);
    const temVantagem = bt && bt.total >= 5 && bt.porOp > 0 && stopPct > 0;

    const escorregoes = [1e3, 1e4, 5e4, 2e5, 1e6, 5e6].map((usd) => {
      const c = impacto(livro.asks, usd);
      const v = impacto(livro.bids, usd);
      const estourou = !c || !v || c.estourou || v.estourou;
      const pct = estourou ? null : c.escorrega + Math.abs(v.escorrega);
      return {
        usd,
        estourou,
        pct,
        custoUsd: pct == null ? null : pct * usd,
        custoR: pct == null || !(stopPct > 0) ? null : (pct + taxaAtual()) / stopPct,
      };
    });

    medirCarregam();

    state.cap = Object.assign(
      temVantagem ? capacidade(livro.bids, livro.asks, stopPct, bt.porOp, taxaAtual()) : {},
      {
        vantagem: temVantagem ? bt.porOp : null,
        porOp: bt ? bt.porOp : null,
        ops: bt ? bt.total : 0,
        timeframe: state.timeframe,
        perfil,
        escorregoes,
        stopPct,
        preco,
      }
    );
  } catch (err) {
    state.cap = { erro: err.message };
  } finally {
    state.capRodando = false;
    renderCap();
  }
}

/**
 * Where the money is sitting in the book right now.
 *
 * Two books with the same total depth behave nothing alike: a wall at the touch
 * absorbs an order, a thin film spread over a percent does not. Bands that the
 * thousand levels could not reach are said to be out of range rather than
 * repeating the last figure, which would read as depth when it is the opposite.
 */
function perfilHtml(pf) {
  if (!pf) return "";

  const maior = Math.max(...pf.faixas.map((f) => Math.max(f.compra, f.venda))) || 1;
  const dinheiro = (v) =>
    v >= 1e6 ? "$" + (v / 1e6).toFixed(1) + "M" : "$" + Math.round(v / 1e3) + "k";

  const linhas = pf.faixas.map((f) => {
    if (!f.completa) {
      return '<div class="pf-linha fora"><span class="pf-pct">' + f.pct.toFixed(2) + "%</span>" +
        '<span class="nota">além do que o livro de mil níveis alcança</span></div>';
    }
    return '<div class="pf-linha"><span class="pf-pct">' + f.pct.toFixed(2) + "%</span>" +
      '<div class="pf-barras">' +
        '<div class="pf-c" style="width:' + ((f.compra / maior) * 100).toFixed(0) + '%"></div>' +
        '<div class="pf-v" style="width:' + ((f.venda / maior) * 100).toFixed(0) + '%"></div>' +
      "</div>" +
      '<span class="pf-val">' + dinheiro(f.compra) + " / " + dinheiro(f.venda) + "</span></div>";
  }).join("");

  return '<div class="pf-bloco"><div class="pf-cab"><span class="m-rot">ONDE ESTÁ O DINHEIRO</span>' +
    '<span class="m-sub">spread ' + pf.spreadBps.toFixed(3) + " bps</span></div>" +
    '<div class="pf-lista">' + linhas + "</div>" +
    '<div class="nota">Compra em verde, venda em vermelho, por distância do preço médio. ' +
    "Os mil níveis deste livro cobrem " + pf.alcanceCompra.toFixed(2) + "% abaixo e " +
    pf.alcanceVenda.toFixed(2) + "% acima.</div></div>";
}

/**
 * Which assets can actually take size, side by side.
 *
 * The same order that vanishes into bitcoin moves a smaller coin visibly, and
 * the difference is not something a chart shows. Walking each book with one
 * fixed order puts them on the same scale.
 */
function carregamHtml(lista) {
  if (!lista || !lista.length) return "";
  const maior = Math.max(...lista.map((x) => x.pct || 0)) || 1;

  return '<div class="pf-bloco"><div class="pf-cab">' +
    '<span class="m-rot">QUEM AGUENTA TAMANHO</span>' +
    '<span class="m-sub">uma ordem de $200 mil</span></div>' +
    '<div class="pf-lista">' + lista.map((x) => {
      const col = x.pct < 0.05 ? UP : x.pct < 0.2 ? WARN : DOWN;
      return '<div class="carrega-linha"><span class="carrega-nome">' + esc(x.id) + "</span>" +
        '<div class="carrega-trilho"><div class="carrega-fill" style="width:' +
        Math.max(2, (x.pct / maior) * 100).toFixed(0) + "%;background:" + col + '"></div></div>' +
        '<span class="carrega-val" style="color:' + col + '">' + x.pct.toFixed(3) + "%</span></div>";
    }).join("") + "</div>" +
    '<div class="nota">Quanto o preço escorrega numa ordem de duzentos mil dólares, ida e ' +
    "volta. Menos é melhor: é liquidez sobrando.</div></div>";
}

/**
 * The same fixed order walked through several books at once.
 *
 * Kept separate from the main measurement so a slow list of extra requests
 * never delays the asset the reader actually opened the screen for.
 */
async function medirCarregam() {
  if (state.capOutrosRodando) return;
  state.capOutrosRodando = true;

  const ids = ["BTC", "ETH", "SOL", "XRP", "DOGE", "LINK", "AVAX", "LTC"];
  const saida = [];

  try {
    for (const id of ids) {
      const livro = await livroFundo(id);
      if (!livro) continue;
      const c = impacto(livro.asks, 2e5);
      const v = impacto(livro.bids, 2e5);
      if (!c || !v || c.estourou || v.estourou) { saida.push({ id, pct: 99 }); continue; }
      saida.push({ id, pct: (c.escorrega + Math.abs(v.escorrega)) * 100 });
      await respirar();
    }
    saida.sort((a, b) => a.pct - b.pct);
    state.capOutros = saida;
  } catch {
    /* uma lista extra que falha não derruba a tela principal */
  } finally {
    state.capOutrosRodando = false;
    renderCap();
  }
}

function renderCap() {
  if (!R.capBody) return;
  const ativo = state.symbol.replace(/^f:/, "");
  R.capInfo.textContent = state.capRodando ? "medindo…" : ativo + " · " + state.timeframe;
  const c = state.cap;

  if (state.capRodando) {
    swap(R.capBody, "cap", '<div class="vazio">andando pelos mil níveis do livro…</div>');
    return;
  }

  if (!c) {
    swap(R.capBody, "cap", '<div class="vazio">O topo do livro é um preço para um tamanho que ' +
      'ninguém negocia. Esta medida anda pelos 1.000 níveis reais e diz quanto a sua ordem ' +
      'escorrega, quanto isso custa em R, e <strong>em que tamanho a vantagem deste ativo ' +
      'acaba</strong>.</div><button class="btn largo" id="capBotao">medir ' + esc(ativo) + "</button>");
    el("capBotao")?.addEventListener("click", medirCapacidade);
    return;
  }

  let corpo;
  if (c.erro) {
    corpo = '<div class="vazio">' + esc(c.erro) + "</div>";
  } else {
    const dinheiro = (v) =>
      v == null ? "—"
      : v >= 1e6 ? "$" + (v / 1e6).toFixed(2) + "M"
      : v >= 1e3 ? "$" + (v / 1e3).toFixed(1) + "k"
      : "$" + v.toFixed(2);

    const topo = c.vantagem
      ? '<div class="metricas">' +
        '<div class="metrica"><span class="m-rot">VANTAGEM MEDIDA</span>' +
          '<span class="m-val" style="color:' + UP + '">+' + c.vantagem.toFixed(3) + 'R</span>' +
          '<span class="m-sub">' + c.ops + " operações no " + esc(c.timeframe) + "</span></div>" +
        '<div class="metrica"><span class="m-rot">TETO DESTE ATIVO</span>' +
          '<span class="m-val">$' + Math.round(c.teto).toLocaleString("pt-BR") + "</span>" +
          '<span class="m-sub">a vantagem some acima disso</span></div>' +
        '<div class="metrica"><span class="m-rot">STOP TÍPICO</span>' +
          '<span class="m-val">' + (c.stopPct * 100).toFixed(2) + "%</span>" +
          '<span class="m-sub">do preço, 1 ATR</span></div>' +
        "</div>"
      : '<div class="mesa-recado" style="border-left-color:' + WARN + '">' +
        esc(ativo) + " no " + esc(c.timeframe) + " rende <strong>" +
        (c.porOp == null ? "—" : (c.porOp >= 0 ? "+" : "") + c.porOp.toFixed(3) + "R") +
        "</strong> por operação em " + c.ops + " medidas. Sem vantagem positiva não há teto a " +
        "calcular — qualquer tamanho perde. O livro abaixo continua valendo: ele é do mercado, " +
        "não da estratégia.</div>";

    const escada = c.escorregoes
      ? '<div class="pf-cab"><span class="m-rot">O QUE A SUA ORDEM PAGA</span>' +
        '<span class="m-sub">ida e volta</span></div>' +
        '<div class="cap-lista">' + c.escorregoes.map((d) => {
          if (d.estourou) {
            return '<div class="cap-linha"><span class="cap-usd">$' +
              d.usd.toLocaleString("pt-BR") + '</span>' +
              '<span class="cap-custo">o livro de mil níveis não aguenta</span>' +
              '<span class="cap-sobra" style="color:' + DOWN + '">—</span></div>';
          }
          const sobra = c.vantagem == null ? null : c.vantagem - d.custoR;
          const col = sobra == null ? NEU : sobra > 0 ? UP : DOWN;
          return '<div class="cap-linha"><span class="cap-usd">$' +
            d.usd.toLocaleString("pt-BR") + "</span>" +
            '<span class="cap-custo">' + (d.pct * 100).toFixed(3) + "% · " +
            dinheiro(d.custoUsd) + " · " + d.custoR.toFixed(3) + "R</span>" +
            '<span class="cap-sobra" style="color:' + col + '">' +
            (sobra == null ? "" : (sobra >= 0 ? "+" : "") + sobra.toFixed(3) + "R") + "</span></div>";
        }).join("") + "</div>"
      : "";

    corpo = topo + escada + perfilHtml(c.perfil) + carregamHtml(state.capOutros) +
      '<div class="nota">O escorregão é a média paga acima do topo do livro, na ida e na volta. ' +
      "Em R ele é dividido pela distância do stop, que é a única unidade em que dá para comparar " +
      "com a vantagem. É a pergunta que mesa faz antes de qualquer outra: quanto dinheiro isso " +
      "carrega antes de virar nada.</div>";
  }

  swap(R.capBody, "cap", corpo + '<button class="btn largo" id="capBotao">medir de novo</button>');
  el("capBotao")?.addEventListener("click", medirCapacidade);
}

// -------------------------------------------------------------- mesa de risco
/**
 * How many of these positions are secretly the same position.
 *
 * Adding sizes together assumes the assets move independently. In crypto they
 * mostly do not, and a trader holding BTC, ETH and SOL believes they hold three
 * trades while carrying something closer to one of nearly triple the size. The
 * matrix is the plain correlation of hourly returns; what matters underneath it
 * is how much of the naive total survives.
 */
async function medirMesa() {
  if (state.mesaRodando) return;
  state.mesaRodando = true;
  renderMesa();

  const ids = ATIVOS_MESA.slice(0, 10);
  try {
    const series = [];
    for (const id of ids) {
      state.mesaPasso = id.replace(/^f:/, "");
      renderMesa();
      const v = await history(id, "1h", 700);
      series.push(v && v.length > 100 ? v : null);
      await respirar();
    }

    const usados = [];
    const dados = [];
    ids.forEach((id, i) => { if (series[i]) { usados.push(id); dados.push(series[i]); } });

    const matriz = dados.map((a) => dados.map((b) => (a === b ? 1 : correlacao(a, b))));
    const pesos = usados.map(() => 1);
    const risco = riscoDaCarteira(pesos, matriz);

    // a média das correlações fora da diagonal diz o quanto o mercado é um só
    let soma = 0;
    let n = 0;
    for (let i = 0; i < matriz.length; i++) {
      for (let j = i + 1; j < matriz.length; j++) {
        if (matriz[i][j] != null) { soma += matriz[i][j]; n++; }
      }
    }

    state.mesa = {
      ids: usados,
      matriz,
      risco,
      media: n ? soma / n : null,
      melhor: melhorPar(usados, matriz),
      soltos: usados
        .map((id, i) => {
          const linha = matriz[i].filter((c, j) => j !== i && c != null);
          return { id, media: linha.length ? linha.reduce((s, c) => s + c, 0) / linha.length : null };
        })
        .filter((x) => x.media != null)
        .sort((a, b) => a.media - b.media),
      tendencia: tendenciaCorrelacao(dados, correlacao),
    };
  } catch (err) {
    state.mesa = { erro: err.message };
  } finally {
    state.mesaRodando = false;
    state.mesaPasso = null;
    renderMesa();
  }
}

function renderMesa() {
  if (!R.mesaBody) return;
  R.mesaInfo.textContent = state.mesaRodando
    ? "medindo " + (state.mesaPasso || "")
    : "correlação de 1h";
  const m = state.mesa;

  if (state.mesaRodando && !m) {
    swap(R.mesaBody, "mesa", '<div class="vazio">medindo ' + esc(state.mesaPasso || "") + "…</div>");
    return;
  }

  if (!m) {
    swap(R.mesaBody, "mesa", '<div class="vazio">Se você está comprado em BTC, ETH e SOL, você ' +
      'não tem três operações. Tem uma, de tamanho maior. Esta tela mede o quanto os ativos ' +
      'andam juntos e quanto do seu risco somado sobra de verdade.</div>' +
      '<button class="btn largo" id="mesaBotao">medir a mesa</button>');
    el("mesaBotao")?.addEventListener("click", medirMesa);
    return;
  }

  if (m.erro) {
    swap(R.mesaBody, "mesa", '<div class="vazio">' + esc(m.erro) + "</div>" +
      '<button class="btn largo" id="mesaBotao">tentar de novo</button>');
    el("mesaBotao")?.addEventListener("click", medirMesa);
    return;
  }

  const cor = (c) => (c == null ? "var(--line-soft)"
    : "color-mix(in srgb, " + (c >= 0 ? DOWN : UP) + " " + Math.round(Math.abs(c) * 80) + "%, transparent)");

  const cabeca = '<div class="mc-linha mc-cab"><span class="mc-rot"></span>' +
    m.ids.map((id) => '<span class="mc-tf">' + esc(id.replace(/^f:/, "").slice(0, 4)) + "</span>").join("") +
    "</div>";

  const linhas = m.ids.map((id, i) => {
    const celulas = m.ids.map((_, j) => {
      const c = m.matriz[i][j];
      return '<button class="mc-cel" style="background:' + (i === j ? "var(--line)" : cor(c)) + '">' +
        (c == null ? "·" : (i === j ? "—" : c.toFixed(2).replace("0.", "."))) + "</button>";
    }).join("");
    return '<div class="mc-linha"><span class="mc-rot">' + esc(id.replace(/^f:/, "")) + "</span>" +
      celulas + "</div>";
  }).join("");

  const conc = m.risco ? m.risco.concentracao : null;
  const equivalentes = conc ? 1 / (conc * conc) : null;

  const topo = '<div class="metricas">' +
    '<div class="metrica"><span class="m-rot">CORRELAÇÃO MÉDIA</span>' +
      '<span class="m-val" style="color:' + (m.media > 0.7 ? DOWN : m.media > 0.4 ? WARN : UP) + '">' +
      (m.media == null ? "—" : m.media.toFixed(2)) + "</span>" +
      '<span class="m-sub">entre os 10 ativos</span></div>' +
    '<div class="metrica"><span class="m-rot">APOSTAS DE VERDADE</span>' +
      '<span class="m-val">' + (equivalentes == null ? "—" : equivalentes.toFixed(1)) + "</span>" +
      '<span class="m-sub">de 10 posições iguais</span></div>' +
    "</div>";

  const recado = equivalentes == null ? "" :
    '<div class="mesa-recado">Dez posições do mesmo tamanho nestes ativos valem por ' +
    '<strong>' + equivalentes.toFixed(1) + ' apostas independentes</strong>. O resto é a mesma ' +
    'aposta repetida — e é assim que uma carteira que parece espalhada perde tudo no mesmo dia.</div>';

  const extra =
    (m.melhor
      ? '<div class="mesa-par"><span class="m-rot">O PAR QUE MENOS ANDA JUNTO</span>' +
        "<strong>" + esc(m.melhor.a.replace(/^f:/, "")) + " e " +
        esc(m.melhor.b.replace(/^f:/, "")) + "</strong>" +
        '<span class="m-sub">correlação ' + m.melhor.c.toFixed(2) +
        " — é o mais perto de diversificação que esta lista oferece</span></div>"
      : "") +
    (m.tendencia
      ? '<div class="mesa-par"><span class="m-rot">PARA ONDE A CORRELAÇÃO VAI</span>' +
        "<strong style=\"color:" +
        (m.tendencia.variacao > 0.05 ? DOWN : m.tendencia.variacao < -0.05 ? UP : NEU) + "\">" +
        m.tendencia.antiga.toFixed(2) + " → " + m.tendencia.recente.toFixed(2) + "</strong>" +
        '<span class="m-sub">' +
        (m.tendencia.variacao > 0.05
          ? "subindo: o mercado está virando uma aposta só"
          : m.tendencia.variacao < -0.05
            ? "caindo: os ativos estão se soltando um do outro"
            : "estável nas últimas 180 horas") + "</span></div>"
      : "");

  const soltosHtml = m.soltos && m.soltos.length
    ? '<div class="pf-bloco"><div class="pf-cab">' +
      '<span class="m-rot">QUEM ANDA MAIS SOZINHO</span>' +
      '<span class="m-sub">correlação média com os outros</span></div>' +
      '<div class="pf-lista">' + m.soltos.map((x) => {
        const col = x.media < 0.5 ? UP : x.media < 0.7 ? WARN : DOWN;
        return '<div class="carrega-linha"><span class="carrega-nome">' +
          esc(x.id.replace(/^f:/, "")) + "</span>" +
          '<div class="carrega-trilho"><div class="carrega-fill" style="width:' +
          Math.max(2, x.media * 100).toFixed(0) + "%;background:" + col + '"></div></div>' +
          '<span class="carrega-val" style="color:' + col + '">' + x.media.toFixed(2) + "</span></div>";
      }).join("") + "</div>" +
      '<div class="nota">Do mais independente ao mais colado. O de cima é o único que acrescenta ' +
      "alguma coisa a uma carteira que já tem os outros.</div></div>"
    : "";

  swap(R.mesaBody, "mesa", topo + recado + extra + '<div class="mc-grade">' + cabeca + linhas + "</div>" +
    soltosHtml +
    '<div class="nota">Correlação dos retornos de hora em hora nas últimas 700 barras. ' +
    'Vermelho é andar junto, verde é andar contra. Na diagonal cada ativo consigo mesmo.</div>' +
    '<button class="btn largo" id="mesaBotao">medir de novo</button>');
  el("mesaBotao")?.addEventListener("click", medirMesa);
}

// ------------------------------------------------------- quem está do outro lado
/**
 * The two sides of the book, told apart.
 *
 * Binance publishes the long/short split of ordinary accounts and, separately,
 * of the largest ones. When those two disagree, someone is wrong, and knowing
 * which side the size is on is the oldest read on a desk. Open interest says
 * whether money is arriving or leaving, funding says who is paying to stay, and
 * the perpetual's premium over spot says how crowded the leverage is.
 */
async function medirLado() {
  if (state.ladoRodando) return;
  state.ladoRodando = true;
  renderLado();

  const par = state.symbol.replace(/^f:/, "") + "USDT";
  const F = "https://fapi.binance.com";
  const pega = async (u) => { const r = await fetch(u); return r.ok ? r.json() : null; };

  try {
    const [contas, grandes, oi, oiHist, premio] = await Promise.all([
      pega(F + "/futures/data/globalLongShortAccountRatio?symbol=" + par + "&period=1h&limit=24"),
      pega(F + "/futures/data/topLongShortPositionRatio?symbol=" + par + "&period=1h&limit=24"),
      pega(F + "/fapi/v1/openInterest?symbol=" + par),
      pega(F + "/futures/data/openInterestHist?symbol=" + par + "&period=1h&limit=24"),
      pega(F + "/fapi/v1/premiumIndex?symbol=" + par),
    ]);

    if (!contas || !contas.length) {
      state.lado = { erro: "A Binance não publica posicionamento para este ativo." };
      return;
    }

    const ult = (a) => (a && a.length ? a[a.length - 1] : null);
    const c = ult(contas);
    const g = ult(grandes);
    const oiAgora = oiHist && oiHist.length ? +ult(oiHist).sumOpenInterest : null;
    const oiAntes = oiHist && oiHist.length > 12 ? +oiHist[0].sumOpenInterest : null;

    const marca = premio ? +premio.markPrice : null;
    const indice = premio ? +premio.indexPrice : null;

    state.lado = {
      symbol: state.symbol,
      varejoLong: c ? +c.longAccount * 100 : null,
      grandesLong: g ? +g.longAccount * 100 : null,
      funding: premio ? +premio.lastFundingRate * 100 : null,
      premio: marca && indice ? ((marca - indice) / indice) * 100 : null,
      oi: oi ? +oi.openInterest : null,
      oiVariacao: oiAgora && oiAntes ? ((oiAgora - oiAntes) / oiAntes) * 100 : null,
      curvaVarejo: contas.map((x) => +x.longAccount * 100),
      curvaGrandes: grandes && grandes.length ? grandes.map((x) => +x.longAccount * 100) : null,
      curvaOi: oiHist && oiHist.length ? oiHist.map((x) => +x.sumOpenInterest) : null,
      precoVariacao: state.data && state.data.stats ? state.data.stats.changePct : null,
      varejoMin: Math.min(...contas.map((x) => +x.longAccount * 100)),
      varejoMax: Math.max(...contas.map((x) => +x.longAccount * 100)),
    };
  } catch (err) {
    state.lado = { erro: err.message };
  } finally {
    state.ladoRodando = false;
    renderLado();
  }
}

/**
 * Open interest against price, which is the whole read.
 *
 * Positions opening while price rises is new money taking a side. Positions
 * closing while price rises is the other side being forced out, and those two
 * look identical on a chart while meaning opposite things about what comes next.
 */
function leituraOi(l) {
  if (l.oiVariacao == null || l.precoVariacao == null) return "";
  const oiSobe = l.oiVariacao > 0.5;
  const oiCai = l.oiVariacao < -0.5;
  const pSobe = l.precoVariacao > 0;

  let txt;
  let cor = NEU;
  if (oiSobe && pSobe) { txt = "Dinheiro novo comprando. Posições abrindo com o preço subindo."; cor = UP; }
  else if (oiSobe && !pSobe) { txt = "Dinheiro novo vendendo. Posições abrindo com o preço caindo."; cor = DOWN; }
  else if (oiCai && pSobe) { txt = "Vendido sendo espremido para fora. Posições fechando com o preço subindo."; cor = WARN; }
  else if (oiCai && !pSobe) { txt = "Comprado desistindo. Posições fechando com o preço caindo."; cor = WARN; }
  else { txt = "Posições paradas. Ninguém está abrindo nem fechando em peso."; }

  return '<div class="mesa-recado" style="border-left-color:' + cor + '">' + txt + "</div>";
}

function renderLado() {
  if (!R.ladoBody) return;
  const ativo = state.symbol.replace(/^f:/, "");
  R.ladoInfo.textContent = state.ladoRodando ? "buscando…" : ativo + " · perpétuo";
  const l = state.lado;

  if (state.ladoRodando) { swap(R.ladoBody, "lado", '<div class="vazio">buscando os dois lados da mesa…</div>'); return; }

  if (!l) {
    swap(R.ladoBody, "lado", '<div class="vazio">A Binance publica, separado, o quanto as contas ' +
      'comuns estão compradas e o quanto as maiores estão. Quando os dois discordam, um lado ' +
      'está errado — e saber de que lado está o tamanho é a leitura mais antiga que existe numa ' +
      'mesa.</div><button class="btn largo" id="ladoBotao">ver ' + esc(ativo) + "</button>");
    el("ladoBotao")?.addEventListener("click", medirLado);
    return;
  }

  if (l.erro) {
    swap(R.ladoBody, "lado", '<div class="vazio">' + esc(l.erro) + "</div>" +
      '<button class="btn largo" id="ladoBotao">tentar de novo</button>');
    el("ladoBotao")?.addEventListener("click", medirLado);
    return;
  }

  const barra = (rot, pct, col) => pct == null ? "" :
    '<div class="lado-linha"><span class="lado-rot">' + rot + "</span>" +
    '<div class="lado-barra"><div class="lado-fill" style="width:' + pct.toFixed(0) +
    "%;background:" + col + '"></div></div>' +
    '<span class="lado-val" style="color:' + col + '">' + pct.toFixed(0) + "% comprado</span></div>";

  const diverge = l.varejoLong != null && l.grandesLong != null
    ? l.grandesLong - l.varejoLong : null;

  const recado = diverge == null ? "" :
    '<div class="mesa-recado">' + (Math.abs(diverge) < 5
      ? "Os dois lados estão de acordo. Sem divergência para ler aqui."
      : "Os grandes estão <strong>" + Math.abs(diverge).toFixed(0) + " pontos mais " +
        (diverge > 0 ? "comprados" : "vendidos") + "</strong> que as contas comuns.") + "</div>";

  const num = (v, suf, casas) => (v == null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(casas) + suf);

  swap(R.ladoBody, "lado",
    barra("CONTAS COMUNS", l.varejoLong, WARN) +
    barra("OS MAIORES", l.grandesLong, "#5c8cff") +
    recado +
    '<div class="metricas">' +
      '<div class="metrica"><span class="m-rot">FUNDING</span>' +
        '<span class="m-val" style="color:' + (l.funding > 0 ? DOWN : l.funding < 0 ? UP : NEU) + '">' +
        num(l.funding, "%", 4) + "</span>" +
        '<span class="m-sub">' + (l.funding > 0 ? "comprado paga" : l.funding < 0 ? "vendido paga" : "neutro") +
        "</span></div>" +
      '<div class="metrica"><span class="m-rot">PRÊMIO DO FUTURO</span>' +
        '<span class="m-val">' + num(l.premio, "%", 3) + "</span>" +
        '<span class="m-sub">sobre o à vista</span></div>' +
      '<div class="metrica"><span class="m-rot">POSIÇÕES ABERTAS</span>' +
        '<span class="m-val" style="color:' + (l.oiVariacao > 0 ? UP : l.oiVariacao < 0 ? DOWN : NEU) + '">' +
        num(l.oiVariacao, "%", 1) + "</span>" +
        '<span class="m-sub">nas últimas 24h</span></div>' +
      '<div class="metrica"><span class="m-rot">FUNDING AO ANO</span>' +
        '<span class="m-val" style="color:' +
        (l.funding > 0 ? DOWN : l.funding < 0 ? UP : NEU) + '">' +
        num(l.funding == null ? null : l.funding * 3 * 365, "%", 1) + "</span>" +
        '<span class="m-sub">se ficasse assim o ano todo</span></div>' +
      '<div class="metrica"><span class="m-rot">VAREJO EM 24H</span>' +
        '<span class="m-val">' + (l.varejoMin == null ? "—" :
          l.varejoMin.toFixed(0) + "–" + l.varejoMax.toFixed(0) + "%") + "</span>" +
        '<span class="m-sub">mínimo e máximo comprado</span></div>' +
    "</div>" +
    (l.curvaVarejo && l.curvaVarejo.length > 4
      ? '<div class="spark-dupla">' +
        '<div class="spark-box"><span class="m-rot">CONTAS COMUNS · 24H</span>' +
        sparkline(l.curvaVarejo, WARN, 36) + "</div>" +
        (l.curvaGrandes
          ? '<div class="spark-box"><span class="m-rot">OS MAIORES · 24H</span>' +
            sparkline(l.curvaGrandes, "#5c8cff", 36) + "</div>"
          : "") + "</div>"
      : "") +
    leituraOi(l) +
    '<div class="nota">Posições abertas subindo com o preço é dinheiro novo entrando. Caindo ' +
    "com o preço subindo é gente sendo espremida para fora. O funding é quem paga para " +
    "continuar de pé.</div>" +
    '<button class="btn largo" id="ladoBotao">atualizar</button>');
  el("ladoBotao")?.addEventListener("click", medirLado);
}

// ------------------------------------------------------ choques e volatilidade
/**
 * What the tape says happened, and how wound up the market is now.
 *
 * The panel has no headlines, so it does not claim to know what the news was.
 * It can say that a bar moved far beyond this asset's own recent range while
 * carrying the volume to mean it, how big that was, and — the part that is
 * actually useful — what the asset went on to do in the hours afterwards.
 */
async function medirChoque() {
  if (state.choqueRodando) return;
  state.choqueRodando = true;
  renderChoque();

  try {
    const velas = await history(state.symbol, state.timeframe, 2000);
    if (!velas || velas.length < 200) { state.choque = { erro: "Histórico curto demais." }; return; }

    const lista = choques(velas, { olharAdiante: 12, limite: 12 });
    const depois = lista.map((c) => c.depois).filter((x) => typeof x === "number");
    const media = depois.length ? depois.reduce((s, x) => s + x, 0) / depois.length : null;

    /**
     * Does the market continue the shock or give it back?
     *
     * Every shock in the window, split by direction, and scored on whether the
     * hours afterwards went the same way. This is the only question that makes
     * a shock tradeable, and it is asked of this asset rather than of a saying.
     */
    const todos = choques(velas, { olharAdiante: 12, limite: 9999 });
    const paraCima = todos.filter((x) => x.retorno > 0);
    const paraBaixo = todos.filter((x) => x.retorno < 0);
    const seguiu = (arr) =>
      arr.length ? (arr.filter((x) => Math.sign(x.depois) === Math.sign(x.retorno)).length / arr.length) * 100 : null;
    const mediaDe = (arr) =>
      arr.length ? arr.reduce((s, x) => s + x.depois, 0) / arr.length : null;

    state.choque = {
      lista,
      media,
      vol: volTermo(velas, TF_SECONDS[state.timeframe] || 3600),
      horas: porHora(velas, TF_SECONDS[state.timeframe] || 3600),
      resumo: {
        total: todos.length,
        altaN: paraCima.length,
        altaSeguiu: seguiu(paraCima),
        altaMedia: mediaDe(paraCima),
        baixaN: paraBaixo.length,
        baixaSeguiu: seguiu(paraBaixo),
        baixaMedia: mediaDe(paraBaixo),
      },
      timeframe: state.timeframe,
      symbol: state.symbol,
    };
  } catch (err) {
    state.choque = { erro: err.message };
  } finally {
    state.choqueRodando = false;
    renderChoque();
  }
}

function renderChoque() {
  if (!R.choqueBody) return;
  const ativo = state.symbol.replace(/^f:/, "");
  R.choqueInfo.textContent = state.choqueRodando ? "medindo…" : ativo + " · " + state.timeframe;
  const c = state.choque;

  if (state.choqueRodando) { swap(R.choqueBody, "choque", '<div class="vazio">medindo…</div>'); return; }

  if (!c) {
    swap(R.choqueBody, "choque", '<div class="vazio">O painel não tem manchete, então não finge ' +
      'saber o que aconteceu. Ele acha as barras em que o preço saiu muito da faixa normal ' +
      '<em>com volume para valer</em>, mede o tamanho do choque, e mostra o que o ativo fez ' +
      'nas horas seguintes.</div><button class="btn largo" id="choqueBotao">procurar em ' +
      esc(ativo) + "</button>");
    el("choqueBotao")?.addEventListener("click", medirChoque);
    return;
  }

  if (c.erro) {
    swap(R.choqueBody, "choque", '<div class="vazio">' + esc(c.erro) + "</div>" +
      '<button class="btn largo" id="choqueBotao">tentar de novo</button>');
    el("choqueBotao")?.addEventListener("click", medirChoque);
    return;
  }

  const v = c.vol;
  const tensao = v && v.razao != null
    ? (v.razao > 1.3 ? { txt: "ESTICADA", col: DOWN } :
       v.razao < 0.7 ? { txt: "COMPRIMIDA", col: WARN } : { txt: "NORMAL", col: NEU })
    : null;

  const topo = v ? '<div class="metricas">' +
      '<div class="metrica"><span class="m-rot">AGORA (24 BARRAS)</span>' +
        '<span class="m-val">' + v.curta.toFixed(0) + '%</span><span class="m-sub">ao ano</span></div>' +
      '<div class="metrica"><span class="m-rot">DE FUNDO (400)</span>' +
        '<span class="m-val">' + v.longa.toFixed(0) + '%</span><span class="m-sub">ao ano</span></div>' +
      '<div class="metrica"><span class="m-rot">TENSÃO</span>' +
        '<span class="m-val" style="color:' + tensao.col + '">' + tensao.txt + "</span>" +
        '<span class="m-sub">' + v.razao.toFixed(2) + "× do normal</span></div>" +
    "</div>" : "";

  const linhas = c.lista.length
    ? c.lista.map((x) => {
        const quando = new Date(x.time).toLocaleString("pt-BR",
          { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
        const col = x.retorno >= 0 ? UP : DOWN;
        const colD = x.depois >= 0 ? UP : DOWN;
        return '<div class="choque-linha"><span class="choque-quando">' + quando + "</span>" +
          '<span class="choque-mov" style="color:' + col + '">' +
          (x.retorno >= 0 ? "+" : "") + (x.retorno * 100).toFixed(2) + "%</span>" +
          '<span class="m-sub">' + Math.abs(x.desvios).toFixed(1) + "σ · " +
          x.vezesVolume.toFixed(1) + "× vol</span>" +
          '<span class="choque-depois" style="color:' + colD + '">' +
          (x.depois >= 0 ? "+" : "") + (x.depois * 100).toFixed(2) + "%</span></div>";
      }).join("")
    : '<div class="vazio">Nenhum choque grande no histórico recente deste ativo.</div>';

  const veredito = c.media == null ? "" :
    '<div class="mesa-recado">Depois dos choques, nas 12 barras seguintes, este ativo andou em ' +
    "média <strong>" + (c.media >= 0 ? "+" : "") + (c.media * 100).toFixed(2) +
    "%</strong> — " + (Math.abs(c.media) < 0.3
      ? "ou seja, o choque foi o movimento todo e não sobrou continuação."
      : c.media > 0 ? "a favor do susto." : "contra o susto, devolvendo parte dele.") + "</div>";

  /**
   * The hours this asset is actually awake.
   *
   * Sessions open, desks staff up, and the range follows — one of the few
   * patterns in a market that is not a story. The dead hours matter as much as
   * the live ones: a stop placed in a dead hour is a stop that survives.
   */
  const horasHtml = (() => {
    const h = c.horas;
    if (!h) return "";
    const maior = Math.max(...h.medias.map((m) => m.faixa || 0)) || 1;
    const barras = h.medias.map((m) => {
      const alt = m.faixa == null ? 0 : (m.faixa / maior) * 100;
      const viva = m.hora === h.pico.hora;
      const morta = m.hora === h.morta.hora;
      return '<div class="hora-col" title="' + m.hora + 'h UTC">' +
        '<div class="hora-barra" style="height:' + alt.toFixed(0) + "%;background:" +
        (viva ? UP : morta ? DOWN : "var(--line)") + '"></div>' +
        '<span class="hora-rot">' + (m.hora % 6 === 0 ? m.hora : "") + "</span></div>";
    }).join("");

    return '<div class="hora-bloco"><div class="pf-cab">' +
      '<span class="m-rot">QUANDO ESTE ATIVO SE MEXE</span>' +
      '<span class="m-sub">hora UTC</span></div>' +
      '<div class="hora-grade">' + barras + "</div>" +
      '<div class="nota">Mais forte às <strong>' + h.pico.hora + "h</strong> (" +
      h.pico.faixa.toFixed(2) + "% de faixa média) e mais parado às <strong>" +
      h.morta.hora + "h</strong> (" + h.morta.faixa.toFixed(2) + "%).</div></div>";
  })();

  const resumoHtml = (() => {
    const r = c.resumo;
    if (!r || !r.total) return "";
    const linha = (rot, n, pct, med, cor) =>
      n
        ? '<div class="choque-resumo-linha"><span class="m-rot">' + rot + "</span>" +
          '<span class="choque-resumo-val" style="color:' + cor + '">' + pct.toFixed(0) + "%</span>" +
          '<span class="m-sub">seguiram · ' + n + " choques · média " +
          (med >= 0 ? "+" : "") + (med * 100).toFixed(2) + "%</span></div>"
        : "";

    return '<div class="pf-bloco"><div class="pf-cab">' +
      '<span class="m-rot">O CHOQUE CONTINUA OU VOLTA?</span>' +
      '<span class="m-sub">' + r.total + " no histórico</span></div>" +
      linha("SUSTO PARA CIMA", r.altaN, r.altaSeguiu, r.altaMedia, UP) +
      linha("SUSTO PARA BAIXO", r.baixaN, r.baixaSeguiu, r.baixaMedia, DOWN) +
      '<div class="nota">Quantos por cento dos choques foram seguidos por mais movimento no ' +
      "mesmo sentido nas 12 barras seguintes. Perto de 50% quer dizer moeda ao ar: o susto foi " +
      "o movimento inteiro.</div></div>";
  })();

  swap(R.choqueBody, "choque", topo + resumoHtml + horasHtml +
    '<div class="choque-cab"><span>quando</span><span>movimento</span><span>tamanho</span>' +
    "<span>12 barras depois</span></div>" +
    '<div class="choque-lista">' + linhas + "</div>" + veredito +
    '<div class="nota">Um choque é uma barra além de 2,5 desvios do normal deste ativo <em>e</em> ' +
    "com pelo menos o dobro do volume médio. Preço sem volume é ruído; volume sem preço é " +
    'rodízio.</div><button class="btn largo" id="choqueBotao">procurar de novo</button>');
  el("choqueBotao")?.addEventListener("click", medirChoque);
}

// ------------------------------------------------------------ versão nova
/**
 * Notices when a newer build is published and offers to take it.
 *
 * A panel someone paid for should not require them to know what a cache is.
 * The published page carries its own version in the script tags, so fetching it
 * past every cache and comparing that string against the one running is enough
 * to know — and the reload is offered rather than forced, because taking the
 * screen away from someone mid-trade to install an update is its own bug.
 */
const VERSAO_ATUAL = (() => {
  const s = [...document.scripts].map((x) => x.src).find((x) => x.includes("app.js"));
  return (s && s.match(/v=(\d+)/) || [])[1] || null;
})();

async function conferirVersao() {
  if (!VERSAO_ATUAL) return;
  try {
    const r = await fetch("./index.html?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) return;
    const nova = ((await r.text()).match(/app\.js\?v=(\d+)/) || [])[1];
    if (!nova || nova === VERSAO_ATUAL) return;

    const aviso = el("versaoNova");
    if (!aviso || !aviso.hidden) return;
    aviso.hidden = false;
  } catch {
    /* sem rede: nada a atualizar */
  }
}

function ligarVersao() {
  el("versaoBotao")?.addEventListener("click", async () => {
    try {
      const regs = await navigator.serviceWorker?.getRegistrations?.();
      await Promise.all((regs || []).map((r) => r.update()));
      const nomes = await caches?.keys?.();
      await Promise.all((nomes || []).map((n) => caches.delete(n)));
    } catch {
      /* limpar é um bônus; recarregar é o que importa */
    }
    location.reload();
  });
  el("versaoX")?.addEventListener("click", () => { el("versaoNova").hidden = true; });

  setTimeout(conferirVersao, 6000);
  setInterval(conferirVersao, 5 * 60 * 1000);
}

// ---------------------------------------------------------------- sentimento
/**
 * The mood of the market, and what it has actually been worth.
 *
 * The fear and greed index is quoted everywhere and checked almost nowhere. So
 * the screen shows today's reading and, beside it, every past reading joined to
 * what bitcoin did over the following week — 992 of them since 2018. The table
 * is the point: measured this way, "buy when others are fearful" produced the
 * WORST forward return of the five bands. Anyone selling this panel can say the
 * index is here; only this panel says what it was worth.
 */
async function medirSentimento() {
  if (state.sentRodando) return;
  state.sentRodando = true;
  renderSent();

  const pega = async (u) => { const r = await fetch(u); return r.ok ? r.json() : null; };

  try {
    const [fg, alta, velas] = await Promise.all([
      pega("https://api.alternative.me/fng/?limit=0&format=json"),
      pega("https://api.coingecko.com/api/v3/search/trending"),
      history("BTC", "1d", 1000),
    ]);

    if (!fg || !fg.data || !fg.data.length) {
      state.sent = { erro: "O índice de medo e ganância não respondeu." };
      return;
    }

    const serie = fg.data
      .map((d) => ({ t: +d.timestamp * 1000, v: +d.value, rot: d.value_classification }))
      .sort((a, b) => a.t - b.t);
    const hoje = serie[serie.length - 1];

    // cada leitura contra o que o bitcoin fez na semana seguinte
    let faixas = null;
    if (velas && velas.length > 200) {
      const dia = (t) => new Date(t).toISOString().slice(0, 10);
      const porDia = new Map(velas.map((v) => [dia(v.time), v.close]));
      const pares = [];
      for (const d of serie) {
        const p0 = porDia.get(dia(d.t));
        const p1 = porDia.get(dia(d.t + 7 * 864e5));
        if (p0 && p1) pares.push({ v: d.v, ret: (p1 - p0) / p0 });
      }

      if (pares.length > 100) {
        const ord = pares.sort((a, b) => a.v - b.v);
        const n = Math.floor(ord.length / 5);
        const nomes = ["medo extremo", "medo", "neutro", "ganância", "ganância extrema"];
        faixas = [];
        for (let i = 0; i < 5; i++) {
          const f = ord.slice(i * n, i === 4 ? ord.length : (i + 1) * n);
          faixas.push({
            nome: nomes[i],
            indice: f.reduce((s, x) => s + x.v, 0) / f.length,
            retorno: f.reduce((s, x) => s + x.ret, 0) / f.length,
            subiu: (f.filter((x) => x.ret > 0).length / f.length) * 100,
            amostras: f.length,
            atual: hoje.v >= (f[0] ? f[0].v : 0) && hoje.v <= (f[f.length - 1] ? f[f.length - 1].v : 100),
          });
        }
      }
    }

    // quanto tempo desde a última visita a cada extremo
    const desde = (teste) => {
      for (let i = serie.length - 1; i >= 0; i--) {
        if (teste(serie[i].v)) return Math.round((Date.now() - serie[i].t) / 864e5);
      }
      return null;
    };

    // onde o índice costuma ficar, para saber se hoje é fora do comum
    const todosV = serie.map((d) => d.v).sort((a, b) => a - b);
    const percentil = (todosV.filter((v) => v <= hoje.v).length / todosV.length) * 100;
    const baldes = [0, 0, 0, 0, 0];
    for (const v of todosV) baldes[Math.min(4, Math.floor(v / 20))]++;

    state.sent = {
      hoje,
      percentil,
      baldes: baldes.map((n) => (n / todosV.length) * 100),
      curva: serie.slice(-90).map((d) => d.v),
      desdeMedo: desde((v) => v <= 25),
      desdeGanancia: desde((v) => v >= 75),
      faixas,
      dias: serie.length,
      procurados: alta && alta.coins
        ? alta.coins.slice(0, 7).map((c) => c.item.symbol.toUpperCase())
        : null,
    };
  } catch (err) {
    state.sent = { erro: err.message };
  } finally {
    state.sentRodando = false;
    renderSent();
  }
}

function renderSent() {
  if (!R.sentBody) return;
  const s = state.sent;
  R.sentInfo.textContent = state.sentRodando ? "buscando…" : "mercado cripto";

  if (state.sentRodando) { swap(R.sentBody, "sent", '<div class="vazio">buscando os dois lados da mesa…</div>'); return; }

  if (!s) {
    swap(R.sentBody, "sent", '<div class="vazio">O índice de medo e ganância aparece em todo ' +
      'lugar e quase ninguém confere se ele serve para alguma coisa. Aqui ele vem com a conta ' +
      'feita: cada leitura desde 2018 contra o que o bitcoin fez na semana seguinte.</div>' +
      '<button class="btn largo" id="sentBotao">ver o sentimento</button>');
    el("sentBotao")?.addEventListener("click", medirSentimento);
    return;
  }

  if (s.erro) {
    swap(R.sentBody, "sent", '<div class="vazio">' + esc(s.erro) + "</div>" +
      '<button class="btn largo" id="sentBotao">tentar de novo</button>');
    el("sentBotao")?.addEventListener("click", medirSentimento);
    return;
  }

  const v = s.hoje.v;
  const col = v >= 75 ? UP : v >= 55 ? "#8fd39f" : v >= 45 ? NEU : v >= 25 ? WARN : DOWN;
  const rot = { "Extreme Fear": "MEDO EXTREMO", Fear: "MEDO", Neutral: "NEUTRO",
                Greed: "GANÂNCIA", "Extreme Greed": "GANÂNCIA EXTREMA" }[s.hoje.rot] ||
              String(s.hoje.rot).toUpperCase();

  const medidor = '<div class="sent-medidor">' +
    '<div class="sent-num" style="color:' + col + '">' + v + "</div>" +
    '<div class="sent-rot" style="color:' + col + '">' + rot + "</div>" +
    '<div class="sent-trilho"><div class="sent-marca" style="left:' + v + '%;background:' + col + '"></div></div>' +
    '<div class="sent-pontas"><span>0 · medo</span><span>ganância · 100</span></div></div>';

  const tabela = s.faixas
    ? '<div class="sent-cab"><span>faixa</span><span>índice</span><span>7 dias depois</span>' +
      "<span>subiu</span></div>" +
      '<div class="sent-lista">' + s.faixas.map((f) =>
        '<div class="sent-linha' + (f.atual ? " agora" : "") + '">' +
        '<span class="sent-nome">' + f.nome + (f.atual ? " ←" : "") + "</span>" +
        '<span class="m-sub">' + f.indice.toFixed(0) + "</span>" +
        '<span style="color:' + (f.retorno >= 0 ? UP : DOWN) + '">' +
        (f.retorno >= 0 ? "+" : "") + (f.retorno * 100).toFixed(2) + "%</span>" +
        '<span class="m-sub">' + f.subiu.toFixed(0) + "%</span></div>").join("") + "</div>"
    : '<div class="nota">Sem histórico suficiente para medir as faixas agora.</div>';

  const pior = s.faixas ? s.faixas.reduce((m, f) => (f.retorno < m.retorno ? f : m)) : null;
  const veredito = pior
    ? '<div class="mesa-recado">Medido em ' + s.dias.toLocaleString("pt-BR") + ' dias desde 2018, a ' +
      'faixa de <strong>' + pior.nome + '</strong> foi a que menos rendeu na semana seguinte. ' +
      "O conselho de comprar quando há medo não aparece nos números — trate este índice como " +
      "termômetro do humor, nunca como sinal de entrada.</div>"
    : "";

  const historia = s.curva && s.curva.length > 10
    ? '<div class="spark-box"><span class="m-rot">ÚLTIMOS 90 DIAS</span>' +
      sparkline(s.curva, col, 40) + "</div>"
    : "";

  const extremos = '<div class="metricas">' +
    '<div class="metrica"><span class="m-rot">DESDE O ÚLTIMO MEDO</span>' +
      '<span class="m-val">' + (s.desdeMedo == null ? "—" : s.desdeMedo) + "</span>" +
      '<span class="m-sub">dias abaixo de 25</span></div>' +
    '<div class="metrica"><span class="m-rot">DESDE A ÚLTIMA GANÂNCIA</span>' +
      '<span class="m-val">' + (s.desdeGanancia == null ? "—" : s.desdeGanancia) + "</span>" +
      '<span class="m-sub">dias acima de 75</span></div>' +
    "</div>";

  const distribuicao = s.baldes
    ? '<div class="pf-bloco"><div class="pf-cab">' +
      '<span class="m-rot">ONDE O ÍNDICE COSTUMA FICAR</span>' +
      '<span class="m-sub">desde 2018</span></div>' +
      '<div class="dist-grade">' + s.baldes.map((pct, i) => {
        const faixaCor = [DOWN, WARN, NEU, "#8fd39f", UP][i];
        const aqui = Math.min(4, Math.floor(v / 20)) === i;
        return '<div class="dist-col"><div class="dist-barra" style="height:' +
          Math.max(3, pct * 2.6).toFixed(0) + "px;background:" + faixaCor +
          ";opacity:" + (aqui ? "1" : "0.42") + '"></div>' +
          '<span class="dist-rot">' + (i * 20) + "–" + (i * 20 + 20) + "</span>" +
          '<span class="dist-pct">' + pct.toFixed(0) + "%</span></div>";
      }).join("") + "</div>" +
      '<div class="nota">O índice de hoje está acima de <strong>' + s.percentil.toFixed(0) +
      "%</strong> de todos os dias já medidos. A coluna acesa é a faixa de agora.</div></div>"
    : "";

  const procurados = s.procurados
    ? '<div class="sent-busca"><span class="m-rot">MAIS PROCURADOS AGORA</span><div class="sent-tags">' +
      s.procurados.map((t) => '<span class="sent-tag">' + esc(t) + "</span>").join("") + "</div></div>"
    : "";

  swap(R.sentBody, "sent", medidor + historia + extremos + tabela + veredito + distribuicao + procurados +
    '<button class="btn largo" id="sentBotao">atualizar</button>');
  el("sentBotao")?.addEventListener("click", medirSentimento);
}
