/**
 * Market data with provider fallback.
 *
 * A single exchange is a single point of failure: Binance answers 451 from some
 * networks and regions, and a panel that knows only one source goes blank there.
 * Each provider below exposes the same shape, and the feed moves to the next one
 * whenever the current one stops answering.
 */

export const SYMBOLS = [
  { id: "BTC", label: "BTC", binance: "BTCUSDT", coinbase: "BTC-USD", kraken: "XBTUSD" },
  { id: "ETH", label: "ETH", binance: "ETHUSDT", coinbase: "ETH-USD", kraken: "ETHUSD" },
  { id: "SOL", label: "SOL", binance: "SOLUSDT", coinbase: "SOL-USD", kraken: "SOLUSD" },
  { id: "XRP", label: "XRP", binance: "XRPUSDT", coinbase: "XRP-USD", kraken: "XRPUSD" },
  { id: "ADA", label: "ADA", binance: "ADAUSDT", coinbase: "ADA-USD", kraken: "ADAUSD" },
  { id: "LINK", label: "LINK", binance: "LINKUSDT", coinbase: "LINK-USD", kraken: "LINKUSD" },
];

export const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"];

/**
 * Asset groups. Binance lists no equities — its stock tokens ended in 2021 —
 * so "commodities" is tokenised gold, the only one that actually trades there.
 * Every group is filtered against the live exchange listing, so a coin that
 * was delisted simply stops appearing instead of erroring when picked.
 */
export const CATEGORIES = [
  {
    id: "principais",
    classe: "Cripto",
    label: "Principais",
    assets: ["BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "DOGE", "TRX", "AVAX", "LINK", "DOT", "LTC", "BCH"],
  },
  {
    id: "l1",
    classe: "Cripto",
    label: "Camada 1",
    assets: ["ETH", "SOL", "AVAX", "NEAR", "APT", "SUI", "SEI", "TIA", "ATOM", "DOT", "ADA", "ALGO", "TON", "INJ", "FTM"],
  },
  {
    id: "defi",
    classe: "Cripto",
    label: "DeFi",
    assets: ["UNI", "AAVE", "MKR", "CRV", "LDO", "COMP", "SNX", "SUSHI", "1INCH", "CAKE", "PENDLE", "ENA", "JUP", "RAY"],
  },
  {
    id: "meme",
    classe: "Cripto",
    label: "Memecoins",
    assets: ["DOGE", "SHIB", "PEPE", "WIF", "BONK", "FLOKI", "BOME", "MEME", "NEIRO", "PNUT", "TURBO", "ACT", "BRETT"],
  },
  {
    id: "ia",
    classe: "Cripto",
    label: "IA e dados",
    assets: ["FET", "RENDER", "TAO", "GRT", "AR", "FIL", "THETA", "WLD", "ARKM", "NFP", "PHB"],
  },
  {
    id: "games",
    classe: "Cripto",
    label: "Games",
    assets: ["AXS", "SAND", "MANA", "GALA", "IMX", "ENJ", "APE", "BEAMX", "PIXEL", "ACE", "YGG"],
  },
  { id: "todascripto", classe: "Cripto", label: "Todas as moedas", todos: "cripto" },

  {
    id: "metais",
    classe: "Commodities",
    label: "Metais",
    assets: ["f:XAU", "f:XAG", "f:XPT", "f:XPD", "f:COPPER"],
  },
  { id: "energia", classe: "Commodities", label: "Energia", assets: ["f:CL", "f:BZ", "f:NATGAS"] },

  {
    id: "acoestec",
    classe: "Ações",
    label: "Tecnologia",
    assets: ["f:NVDA", "f:AAPL", "f:MSFT", "f:GOOGL", "f:AMZN", "f:META", "f:TSLA", "f:AMD",
             "f:AVGO", "f:ORCL", "f:INTC", "f:QCOM", "f:TSM", "f:ASML", "f:ARM", "f:MU",
             "f:SMCI", "f:DELL", "f:CSCO", "f:IBM"],
  },
  {
    id: "acoesia",
    classe: "Ações",
    label: "Software e IA",
    assets: ["f:PLTR", "f:SNOW", "f:MDB", "f:DDOG", "f:NET", "f:CRWD", "f:PANW", "f:CRM",
             "f:ADBE", "f:NOW", "f:TEAM", "f:IONQ", "f:ANTHROPIC", "f:OPENAI", "f:ZS"],
  },
  {
    id: "acoesfin",
    classe: "Ações",
    label: "Finanças e cripto",
    assets: ["f:COIN", "f:MSTR", "f:HOOD", "f:CRCL", "f:MARA", "f:HUT", "f:BMNR", "f:IREN",
             "f:PYPL", "f:SOFI", "f:V", "f:JPM", "f:GS", "f:BX"],
  },
  {
    id: "acoesconsumo",
    classe: "Ações",
    label: "Consumo e saúde",
    assets: ["f:WMT", "f:COST", "f:KO", "f:HD", "f:DIS", "f:NFLX", "f:UBER", "f:SHOP",
             "f:EBAY", "f:BABA", "f:PDD", "f:SONY", "f:LLY", "f:MRK", "f:MRNA", "f:CAT",
             "f:GME", "f:AMC", "f:DKNG"],
  },
  { id: "todasacoes", classe: "Ações", label: "Todas as ações", todos: "futuros" },

  {
    id: "indices",
    classe: "Índices e ETFs",
    label: "Índices",
    assets: ["f:SPY", "f:QQQ", "f:IWM", "f:EWZ", "f:EWJ", "f:EWY", "f:EWT", "f:KODEX200"],
  },
  {
    id: "setores",
    classe: "Índices e ETFs",
    label: "Setores",
    assets: ["f:SMH", "f:GDX", "f:XLE", "f:XBI", "f:URNM", "f:BITO"],
  },
  {
    id: "alavancados",
    classe: "Índices e ETFs",
    label: "Alavancados",
    assets: ["f:TQQQ", "f:SQQQ", "f:SOXL", "f:SOXS", "f:UVXY", "f:TSLL", "f:NVDL",
             "f:TBT", "f:TMF", "f:TZA", "f:KORU"],
  },
];

export const TF_SECONDS = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
const SECONDS = TF_SECONDS;

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

// ---------------------------------------------------------------- Binance
const binance = {
  name: "Binance",
  key: "binance",

  async candles(sym, tf) {
    const raw = await getJson(
      `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${tf}&limit=150`
    );
    // k[9] is taker buy volume, so the rest of the bar's volume was sold into
    // the bid: real per-candle delta, not an inference from the candle's colour
    return raw.map((k) => {
      const volume = +k[5];
      const buy = +k[9];
      return {
        time: k[0],
        open: +k[1],
        high: +k[2],
        low: +k[3],
        close: +k[4],
        volume,
        delta: buy - (volume - buy),
      };
    });
  },

  async stats(sym) {
    const d = await getJson(`https://api.binance.com/api/v3/ticker/24hr?symbol=${sym}`);
    return { price: +d.lastPrice, changePct: +d.priceChangePercent };
  },

  async trades(sym) {
    const raw = await getJson(`https://api.binance.com/api/v3/trades?symbol=${sym}&limit=500`);
    // isBuyerMaker true => the aggressor was the seller
    return raw.map((t) => ({ price: +t.price, qty: +t.qty, buyerAggressor: !t.isBuyerMaker }));
  },

  async book(sym) {
    const d = await getJson(`https://api.binance.com/api/v3/depth?symbol=${sym}&limit=20`);
    return {
      bids: d.bids.map(([p, q]) => ({ price: +p, qty: +q })),
      asks: d.asks.map(([p, q]) => ({ price: +p, qty: +q })),
    };
  },
};

// ---------------------------------------------------------------- Coinbase
const coinbase = {
  name: "Coinbase",
  key: "coinbase",

  async candles(sym, tf) {
    const raw = await getJson(
      `https://api.exchange.coinbase.com/products/${sym}/candles?granularity=${SECONDS[tf]}`
    );
    // [time, low, high, open, close, volume], newest first
    return raw
      .map((c) => ({
        time: c[0] * 1000,
        low: +c[1],
        high: +c[2],
        open: +c[3],
        close: +c[4],
        volume: +c[5],
      }))
      .reverse()
      .slice(-150);
  },

  async stats(sym) {
    const d = await getJson(`https://api.exchange.coinbase.com/products/${sym}/stats`);
    const open = +d.open;
    const last = +d.last;
    return { price: last, changePct: open ? ((last - open) / open) * 100 : 0 };
  },

  async trades(sym) {
    const raw = await getJson(`https://api.exchange.coinbase.com/products/${sym}/trades?limit=200`);
    // Coinbase reports the MAKER side: a "sell" maker means the taker bought
    return raw.map((t) => ({
      price: +t.price,
      qty: +t.size,
      buyerAggressor: t.side === "sell",
    }));
  },

  async book(sym) {
    const d = await getJson(`https://api.exchange.coinbase.com/products/${sym}/book?level=2`);
    return {
      bids: d.bids.slice(0, 20).map(([p, q]) => ({ price: +p, qty: +q })),
      asks: d.asks.slice(0, 20).map(([p, q]) => ({ price: +p, qty: +q })),
    };
  },
};

// ---------------------------------------------------------------- Kraken
const kraken = {
  name: "Kraken",
  key: "kraken",

  async candles(sym, tf) {
    const d = await getJson(
      `https://api.kraken.com/0/public/OHLC?pair=${sym}&interval=${SECONDS[tf] / 60}`
    );
    const rows = Object.values(d.result).find(Array.isArray) || [];
    return rows
      .map((r) => ({
        time: r[0] * 1000,
        open: +r[1],
        high: +r[2],
        low: +r[3],
        close: +r[4],
        volume: +r[6],
      }))
      .slice(-150);
  },

  async stats(sym) {
    const d = await getJson(`https://api.kraken.com/0/public/Ticker?pair=${sym}`);
    const t = Object.values(d.result)[0];
    const last = +t.c[0];
    const open = +t.o;
    return { price: last, changePct: open ? ((last - open) / open) * 100 : 0 };
  },

  async trades(sym) {
    const d = await getJson(`https://api.kraken.com/0/public/Trades?pair=${sym}`);
    const rows = Object.values(d.result).find(Array.isArray) || [];
    // [price, volume, time, side, ordertype, misc] — "b" marks an aggressive buy
    return rows.slice(-200).map((r) => ({
      price: +r[0],
      qty: +r[1],
      buyerAggressor: r[3] === "b",
    }));
  },

  async book(sym) {
    const d = await getJson(`https://api.kraken.com/0/public/Depth?pair=${sym}&count=20`);
    const b = Object.values(d.result)[0];
    return {
      bids: b.bids.map(([p, q]) => ({ price: +p, qty: +q })),
      asks: b.asks.map(([p, q]) => ({ price: +p, qty: +q })),
    };
  },
};

/**
 * Binance USDⓈ-M futures.
 *
 * Besides crypto perpetuals it lists TRADIFI contracts — gold, silver, oil,
 * and a few hundred equities and ETFs — and publishes the same shape of data
 * as the spot venue: taker volume per candle, the aggressor side of each
 * print, and the book. So these assets get the whole panel, not a price line.
 */
const FAPI = "https://fapi.binance.com/fapi/v1";

const futures = {
  name: "Binance Futuros",
  key: "futures",

  async candles(sym, tf) {
    const raw = await getJson(`${FAPI}/klines?symbol=${sym}&interval=${tf}&limit=300`);
    return raw.map((k) => {
      const volume = +k[5];
      const buy = +k[9];
      return {
        time: k[0],
        open: +k[1],
        high: +k[2],
        low: +k[3],
        close: +k[4],
        volume,
        delta: buy - (volume - buy),
      };
    });
  },

  async stats(sym) {
    const d = await getJson(`${FAPI}/ticker/24hr?symbol=${sym}`);
    return { price: +d.lastPrice, changePct: +d.priceChangePercent };
  },

  async trades(sym) {
    const raw = await getJson(`${FAPI}/aggTrades?symbol=${sym}&limit=500`);
    // m marks the buyer as maker, so the aggressor was the seller
    return raw.map((t) => ({ price: +t.p, qty: +t.q, buyerAggressor: !t.m }));
  },

  async book(sym) {
    const d = await getJson(`${FAPI}/depth?symbol=${sym}&limit=20`);
    return {
      bids: d.bids.map(([p, q]) => ({ price: +p, qty: +q })),
      asks: d.asks.map(([p, q]) => ({ price: +p, qty: +q })),
    };
  },
};

const PROVIDERS = [binance, coinbase, kraken];

/** The provider currently answering; stays chosen until it fails. */
let active = null;

const ASSETS = new Map(SYMBOLS.map((s) => [s.id, s]));

/**
 * Futures assets carry an "f:" prefix so a stock ticker can never collide with
 * a coin of the same name. The prefix is internal: the panel shows the label.
 */
export function assetSource(id) {
  return id.startsWith("f:") ? "futures" : "exchange";
}

function symbolFor(provider, id) {
  return ASSETS.get(id)?.[provider.key];
}

let listing = null;

/** Base asset to perpetual symbol, filled from the futures listing. */
const FUTUROS = new Map();

/** The perpetual behind an asset, when the exchange lists one. */
export function futuresSymbol(id) {
  return id.startsWith("f:") ? ASSETS.get(id)?.futures : FUTUROS.get(id);
}

/**
 * Everything trading against USDT on Binance right now, read from the exchange
 * itself. The fallback providers get a derived symbol; when a pair does not
 * exist there, that provider simply fails and the next one is tried.
 */
export function universe() {
  if (listing) return listing;

  const spot = getJson("https://api.binance.com/api/v3/exchangeInfo").then((info) => {
    const out = [];

    for (const s of info.symbols) {
      if (s.status !== "TRADING" || s.quoteAsset !== "USDT") continue;
      if (s.isSpotTradingAllowed === false) continue;

      const base = s.baseAsset;
      // leveraged tokens track a multiple of a price, not the asset itself
      if (/(UP|DOWN|BULL|BEAR)$/.test(base) && base.length > 4) continue;

      const asset = ASSETS.get(base) || {
        id: base,
        label: base,
        binance: s.symbol,
        coinbase: `${base}-USD`,
        kraken: `${base}USD`,
      };
      ASSETS.set(base, asset);
      out.push(asset);
    }

    return out.sort((a, b) => a.id.localeCompare(b.id));
  });

  // the traditional-finance contracts: metals, energy, equities, ETFs
  const trad = getJson(`${FAPI}/exchangeInfo`).then((info) => {
    const out = [];

    for (const s of info.symbols) {
      if (s.status !== "TRADING" || s.quoteAsset !== "USDT") continue;

      // perpetuals only: the quarterly delivery contracts share a base asset
      // and would otherwise shadow the perpetual everyone actually watches
      const perp = s.contractType === "PERPETUAL" || s.contractType === "TRADIFI_PERPETUAL";
      if (perp) FUTUROS.set(s.baseAsset, s.symbol);

      if (s.contractType !== "TRADIFI_PERPETUAL") continue;

      const asset = { id: `f:${s.baseAsset}`, label: s.baseAsset, futures: s.symbol };
      ASSETS.set(asset.id, asset);
      out.push(asset);
    }

    return out.sort((a, b) => a.label.localeCompare(b.label));
  });

  listing = Promise.all([spot.catch(() => SYMBOLS), trad.catch(() => [])]).then(
    ([a, b]) => [...b, ...a]
  );

  return listing;
}

/**
 * One full snapshot, moving down the provider list on failure. Returns which
 * source served it, so the panel can name the data it is showing.
 */
export async function snapshot(symbolId, timeframe) {
  const ordered =
    assetSource(symbolId) === "futures"
      ? [futures]
      : active
        ? [active, ...PROVIDERS.filter((p) => p !== active)]
        : PROVIDERS;

  const failures = [];

  for (const provider of ordered) {
    const sym = symbolFor(provider, symbolId);
    if (!sym) continue;

    try {
      const [candles, stats, trades, book] = await Promise.all([
        provider.candles(sym, timeframe),
        provider.stats(sym),
        provider.trades(sym).catch(() => []),
        provider.book(sym).catch(() => null),
      ]);

      if (!candles.length) throw new Error("sem candles");

      // the futures venue is not part of the crypto fallback chain
      if (provider !== futures) active = provider;
      return { candles, stats, trades, book, source: provider.name, failures };
    } catch (err) {
      failures.push(`${provider.name} ${err.message}`);
      if (active === provider) active = null;
    }
  }

  throw new Error(`nenhuma fonte respondeu (${failures.join(", ")})`);
}

/** Prices for the top strip, from whichever provider is currently working. */
export async function tape() {
  const provider = active || PROVIDERS[0];
  const out = [];

  for (const s of SYMBOLS) {
    const sym = symbolFor(provider, s.id);
    if (!sym) continue;
    try {
      const st = await provider.stats(sym);
      out.push({ sym: s.label, val: st.price, chg: st.changePct });
    } catch {
      /* a symbol that fails is left out rather than shown as zero */
    }
  }

  return out;
}

/* ------------------------------------------------------------------ streams
 * REST answers once every few seconds, so the panel moved in jumps. These
 * sockets deliver every print as the exchange publishes it — price, the open
 * candle, aggression and the book all arrive continuously.
 *
 * Kraken's public socket speaks a different symbol format than its REST API,
 * so it has no stream here and keeps the polling path; the panel stays correct
 * there, only less fluid.
 */
/**
 * Offset between this machine's clock and the exchange's, so the lag we report
 * is the data's travel time and not a wrong clock on the viewer's device.
 */
let clockOffset = 0;

async function syncClock() {
  try {
    const t0 = Date.now();
    const { serverTime } = await getJson("https://api.binance.com/api/v3/time");
    const t1 = Date.now();
    clockOffset = serverTime - (t0 + (t1 - t0) / 2);
  } catch {
    clockOffset = 0;
  }
}

const SOCKETS = {
  binance(sym, tf, on) {
    const s = sym.toLowerCase();
    const ws = new WebSocket(
      `wss://stream.binance.com:9443/stream?streams=` +
        [`${s}@aggTrade`, `${s}@kline_${tf}`, `${s}@depth20@100ms`, `${s}@ticker`].join("/")
    );

    ws.onmessage = (ev) => {
      const { stream, data } = JSON.parse(ev.data);

      if (stream.includes("@aggTrade")) {
        // m marks the buyer as maker, so the aggressor was the seller
        on.trade({ price: +data.p, qty: +data.q, buyerAggressor: !data.m });
        on.price(+data.p);
        on.lag(Date.now() + clockOffset - data.T);
      } else if (stream.includes("@kline")) {
        const k = data.k;
        const volume = +k.v;
        const buy = +k.V;
        on.candle({
          time: k.t,
          open: +k.o,
          high: +k.h,
          low: +k.l,
          close: +k.c,
          volume,
          delta: buy - (volume - buy),
          closed: k.x,
        });
      } else if (stream.includes("@depth")) {
        on.book({
          bids: data.bids.map(([p, q]) => ({ price: +p, qty: +q })),
          asks: data.asks.map(([p, q]) => ({ price: +p, qty: +q })),
        });
      } else if (stream.includes("@ticker")) {
        on.stats({ price: +data.c, changePct: +data.P });
      }
    };

    return ws;
  },

  coinbase(sym, tf, on) {
    const ws = new WebSocket("wss://ws-feed.exchange.coinbase.com");

    ws.onopen = () =>
      ws.send(
        JSON.stringify({ type: "subscribe", product_ids: [sym], channels: ["ticker", "matches"] })
      );

    ws.onmessage = (ev) => {
      const d = JSON.parse(ev.data);

      if (d.type === "ticker" && d.price) {
        const open = +d.open_24h;
        const last = +d.price;
        on.price(last);
        on.stats({ price: last, changePct: open ? ((last - open) / open) * 100 : 0 });
      } else if ((d.type === "match" || d.type === "last_match") && d.price) {
        // Coinbase names the MAKER side: a "sell" maker means the taker bought
        on.trade({ price: +d.price, qty: +d.size, buyerAggressor: d.side === "sell" });
        on.price(+d.price);
      }
    };

    return ws;
  },
};

/**
 * Opens a live stream for the provider currently serving snapshots. Reconnects
 * on its own, and reports whether a stream exists at all so the caller knows
 * to keep polling harder when it does not.
 */
export function stream(symbolId, timeframe, on) {
  // the futures socket does not deliver trades or klines reliably, so these
  // assets are polled instead — the REST feed carries the same numbers
  if (assetSource(symbolId) === "futures") return { live: false, close() {} };

  const provider = active || PROVIDERS[0];
  const open = SOCKETS[provider.key];
  const sym = symbolFor(provider, symbolId);

  if (!open || !sym) return { live: false, close() {} };
  if (provider.key === "binance") syncClock();

  let ws = null;
  let retry = null;
  let closed = false;
  let wait = 1000;

  const connect = () => {
    if (closed) return;
    try {
      ws = open(sym, timeframe, on);
    } catch {
      return schedule();
    }
    // the provider may have set onopen to send its subscribe frame, so this
    // listener is added rather than assigned
    ws.addEventListener("open", () => {
      wait = 1000;
      on.status(true);
    });
    ws.onclose = () => {
      on.status(false);
      schedule();
    };
    ws.onerror = () => ws.close();
  };

  const schedule = () => {
    if (closed) return;
    clearTimeout(retry);
    retry = setTimeout(connect, wait);
    wait = Math.min(wait * 2, 15000); // back off rather than hammer the exchange
  };

  connect();

  return {
    live: true,
    close() {
      closed = true;
      clearTimeout(retry);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    },
  };
}

/**
 * Spot XAU/USD, the real gold price.
 *
 * The tokens on the exchange are backed by an ounce each, but they are their
 * own market and drift from spot. This gives the panel the actual number to
 * show beside them, so the gap is visible instead of assumed away. It is a
 * price only — no candles — so it never drives the chart.
 */
let goldPrice = 0;
let goldAt = 0;

export async function spotGold() {
  if (Date.now() - goldAt < 30000) return goldPrice;
  const d = await getJson("https://api.gold-api.com/price/XAU");
  goldPrice = +d.price;
  goldAt = Date.now();
  return goldPrice;
}

/**
 * Positioning around a contract: what longs pay shorts, how much money is
 * committed, and how the crowd is leaning.
 *
 * The two long/short readings are deliberately separate. One counts every
 * account, the other weighs the largest positions — and when they disagree,
 * that disagreement is the information.
 */
export async function positioning(symbolId) {
  const sym = futuresSymbol(symbolId);
  if (!sym) return null;

  const hist = (path, extra = "") =>
    getJson(`https://fapi.binance.com/futures/data/${path}?symbol=${sym}&period=5m&limit=48${extra}`)
      .catch(() => []);

  const [premio, oi, contas, grandes, taker] = await Promise.all([
    getJson(`${FAPI}/premiumIndex?symbol=${sym}`).catch(() => null),
    hist("openInterestHist"),
    hist("globalLongShortAccountRatio"),
    hist("topLongShortPositionRatio"),
    hist("takerlongshortRatio"),
  ]);

  const ultimo = (arr) => (arr.length ? arr[arr.length - 1] : null);
  const c = ultimo(contas);
  const g = ultimo(grandes);

  return {
    simbolo: sym,
    funding: premio ? +premio.lastFundingRate : null,
    proximoFunding: premio ? +premio.nextFundingTime : null,
    marca: premio ? +premio.markPrice : null,
    oi: oi.map((r) => ({ valor: +r.sumOpenInterestValue, qtd: +r.sumOpenInterest })),
    contas: c ? { compradas: +c.longAccount, vendidas: +c.shortAccount } : null,
    grandes: g ? { compradas: +g.longAccount, vendidas: +g.shortAccount } : null,
    taker: taker.map((r) => ({ compra: +r.buyVol, venda: +r.sellVol, razao: +r.buySellRatio })),
  };
}

/**
 * A longer run of candles than the chart needs, for measuring the strategy.
 *
 * Only the Binance venues answer this: the fallbacks cap their history far
 * shorter, and a measurement over a different amount of data would not be
 * comparable. When they are serving, the caller gets null and says so.
 */
export async function history(symbolId, timeframe, limit = 1000) {
  const futuro = assetSource(symbolId) === "futures";
  const provider = futuro ? futures : binance;
  const sym = symbolFor(provider, symbolId);

  if (!sym) return null;
  if (!futuro && active && active !== binance) return null;

  const base = futuro ? FAPI : "https://api.binance.com/api/v3";
  const raw = await getJson(`${base}/klines?symbol=${sym}&interval=${timeframe}&limit=${limit}`);

  return raw.map((k) => {
    const volume = +k[5];
    const buy = +k[9];
    return {
      time: k[0],
      open: +k[1],
      high: +k[2],
      low: +k[3],
      close: +k[4],
      volume,
      delta: buy - (volume - buy),
    };
  });
}
