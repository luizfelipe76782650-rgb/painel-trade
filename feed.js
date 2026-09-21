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
    label: "IA & dados",
    assets: ["FET", "RENDER", "TAO", "GRT", "AR", "FIL", "THETA", "WLD", "ARKM", "NFP", "PHB"],
  },
  {
    id: "games",
    classe: "Cripto",
    label: "Games & metaverso",
    assets: ["AXS", "SAND", "MANA", "GALA", "IMX", "ENJ", "APE", "BEAMX", "PIXEL", "ACE", "YGG"],
  },
  { id: "todas", classe: "Cripto", label: "Todas as moedas", assets: null },

  // gold that actually trades on the exchange: each token is backed by an ounce
  // and tracks XAU/USD, which is the closest thing to XAUUSD available here
  { id: "ouro", classe: "Commodities", label: "Ouro", assets: ["XAU", "PAXG", "XAUT"] },

  { id: "cambio", classe: "Câmbio", label: "Moedas", assets: ["EUR", "GBP", "AUD", "JPY", "TRY"] },
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
 * Yahoo publishes candles but sends no CORS header, so a page cannot read it
 * directly. These public relays fetch it server side and add the header. They
 * are free and occasionally flaky, hence more than one.
 */
const RELAYS = [
  {
    // returns the page as text behind a short preamble, so the JSON starts at
    // the first brace
    url: (u) => `https://r.jina.ai/${u}`,
    read: (txt) => JSON.parse(txt.slice(txt.indexOf('{"'))),
  },
  {
    url: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    read: JSON.parse,
  },
  {
    url: (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
    read: JSON.parse,
  },
];

async function relayed(url) {
  let erro = new Error("nenhum repassador respondeu");

  for (const relay of RELAYS) {
    try {
      const res = await fetch(relay.url(url));
      if (!res.ok) throw new Error(String(res.status));
      return relay.read(await res.text());
    } catch (e) {
      erro = e;
    }
  }

  throw erro;
}

// Yahoo has no 4h bar, so it is folded from hourly ones
const YF = {
  "1m": { interval: "1m", range: "1d" },
  "5m": { interval: "5m", range: "5d" },
  "15m": { interval: "15m", range: "5d" },
  "1h": { interval: "60m", range: "1mo" },
  "4h": { interval: "60m", range: "3mo", fold: 4 },
  "1d": { interval: "1d", range: "1y" },
};

function fold(candles, n) {
  const out = [];
  for (let i = 0; i < candles.length; i += n) {
    const bloco = candles.slice(i, i + n);
    if (!bloco.length) continue;
    out.push({
      time: bloco[0].time,
      open: bloco[0].open,
      high: Math.max(...bloco.map((c) => c.high)),
      low: Math.min(...bloco.map((c) => c.low)),
      close: bloco[bloco.length - 1].close,
      volume: bloco.reduce((a, c) => a + c.volume, 0),
    });
  }
  return out;
}

async function yahooChart(sym, tf) {
  const cfg = YF[tf] || YF["1h"];
  const d = await relayed(
    `https://query1.finance.yahoo.com/v8/finance/chart/${sym}` +
      `?interval=${cfg.interval}&range=${cfg.range}`
  );

  const r = d?.chart?.result?.[0];
  if (!r) throw new Error(d?.chart?.error?.description || "sem dados");

  const q = r.indicators.quote[0];
  let candles = r.timestamp
    .map((t, i) => ({
      time: t * 1000,
      open: q.open[i],
      high: q.high[i],
      low: q.low[i],
      close: q.close[i],
      volume: q.volume[i] || 0,
    }))
    // Yahoo pads gaps with nulls; a null candle is a hole, not a price
    .filter((c) => c.open != null && c.close != null && c.high != null && c.low != null);

  if (cfg.fold) candles = fold(candles, cfg.fold);
  return { candles: candles.slice(-300), meta: r.meta };
}

const yahoo = {
  name: "Yahoo",
  key: "yahoo",

  async candles(sym, tf) {
    return (await yahooChart(sym, tf)).candles;
  },

  async stats(sym) {
    const { meta } = await yahooChart(sym, "1h");
    const last = meta.regularMarketPrice;
    // previousClose is the prior session; chartPreviousClose is whatever sat
    // before the requested range, which on a month of bars is a month-old price
    const prev = meta.previousClose || meta.chartPreviousClose || last;
    return { price: last, changePct: prev ? ((last - prev) / prev) * 100 : 0 };
  },

  // a futures quote page gives neither the tape nor the book
  async trades() {
    return [];
  },
  async book() {
    return null;
  },
};

const PROVIDERS = [binance, coinbase, kraken];

/** The provider currently answering; stays chosen until it fails. */
let active = null;

/**
 * Assets that do not live on a crypto exchange.
 *
 * There is no spot XAUUSD feed a browser can reach for free, so gold here is
 * the COMEX front-month future — real OHLC, trading a carry premium above
 * spot. The header shows the spot price beside it, so the gap is on screen
 * rather than hidden behind a familiar ticker.
 */
const EXTRAS = [
  { id: "XAU", label: "XAU futuro", source: "yahoo", yahoo: "GC=F" },
];

const ASSETS = new Map([...SYMBOLS, ...EXTRAS].map((s) => [s.id, s]));

/** Which feed serves an asset: "yahoo" for the extras, exchanges otherwise. */
export function assetSource(id) {
  return ASSETS.get(id)?.source || "exchange";
}

function symbolFor(provider, id) {
  return ASSETS.get(id)?.[provider.key];
}

let listing = null;

/**
 * Everything trading against USDT on Binance right now, read from the exchange
 * itself. The fallback providers get a derived symbol; when a pair does not
 * exist there, that provider simply fails and the next one is tried.
 */
export function universe() {
  if (listing) return listing;

  listing = getJson("https://api.binance.com/api/v3/exchangeInfo")
    .then((info) => {
      const out = [];

      for (const s of info.symbols) {
        if (s.status !== "TRADING" || s.quoteAsset !== "USDT") continue;
        if (s.isSpotTradingAllowed === false) continue;

        const base = s.baseAsset;
        // leveraged tokens track a multiple of a price, not the asset itself
        if (/(UP|DOWN|BULL|BEAR)$/.test(base) && base.length > 4) continue;

        const known = ASSETS.get(base);
        const asset = known || {
          id: base,
          label: base,
          binance: s.symbol,
          coinbase: `${base}-USD`,
          kraken: `${base}USD`,
        };
        ASSETS.set(base, asset);
        out.push(asset);
      }

      out.sort((a, b) => a.id.localeCompare(b.id));
      return [...EXTRAS, ...out];
    })
    .catch(() => [...EXTRAS, ...SYMBOLS]); // the majors still work if the listing fails

  return listing;
}

/**
 * One full snapshot, moving down the provider list on failure. Returns which
 * source served it, so the panel can name the data it is showing.
 */
export async function snapshot(symbolId, timeframe) {
  const ordered =
    assetSource(symbolId) === "yahoo"
      ? [yahoo]
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

      active = provider;
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
  if (assetSource(symbolId) === "yahoo") return { live: false, close() {} };

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
