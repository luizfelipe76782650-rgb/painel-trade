/**
 * Price-structure analysis: pivots, ATR zones, fair value gaps, confluence.
 *
 * Written from classical techniques so the panel carries no third-party licence.
 * Everything is derived from candles the exchange actually delivered — nothing
 * here invents a number when data is missing.
 */

export function atr(candles, length = 14) {
  if (candles.length < 2) return 0;

  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    trs.push(
      Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close))
    );
  }

  const window = trs.slice(-length);
  return window.length ? window.reduce((a, b) => a + b, 0) / window.length : 0;
}

/**
 * Swing highs and lows. The `right` lookahead is why a pivot is only confirmed
 * some bars later — drawing it earlier would show a level the market had not
 * formed yet.
 */
export function pivots(candles, left = 3, right = 3) {
  const highs = [];
  const lows = [];

  for (let i = left; i < candles.length - right; i++) {
    const window = candles.slice(i - left, i + right + 1);
    if (candles[i].high >= Math.max(...window.map((c) => c.high))) highs.push(i);
    if (candles[i].low <= Math.min(...window.map((c) => c.low))) lows.push(i);
  }

  return { highs, lows };
}

/** Confirmed pivots become zones; when two overlap the older one stands. */
export function buildZones(candles, a, depth = 0.5, limit = 6) {
  if (!candles.length || a <= 0) return [];

  const { highs, lows } = pivots(candles);
  const half = (a * depth) / 2;
  const raw = [];

  highs.forEach((i) => {
    const p = candles[i].high;
    raw.push({ kind: "resistance", top: p + half, bottom: p - half, origin: i });
  });
  lows.forEach((i) => {
    const p = candles[i].low;
    raw.push({ kind: "support", top: p + half, bottom: p - half, origin: i });
  });

  raw.sort((x, y) => x.origin - y.origin);

  const kept = [];
  for (const z of raw) {
    const overlaps = kept.some((k) => !(z.bottom > k.top || z.top < k.bottom));
    if (!overlaps) kept.push({ ...z, touches: 0, broken: false, swept: false });
  }

  for (const z of kept) {
    for (const c of candles.slice(z.origin + 1)) {
      if (c.low <= z.top && c.high >= z.bottom) z.touches++;
      if (z.kind === "support" && c.close < z.bottom) z.broken = true;
      if (z.kind === "resistance" && c.close > z.top) z.broken = true;
      // a wick through that closes back inside is a sweep, not a break
      if (z.kind === "support" && c.low < z.bottom && c.close >= z.bottom) z.swept = true;
      if (z.kind === "resistance" && c.high > z.top && c.close <= z.top) z.swept = true;
    }
    z.mid = (z.top + z.bottom) / 2;
  }

  const price = candles[candles.length - 1].close;
  return kept
    .filter((z) => !z.broken)
    .sort((x, y) => Math.abs(x.mid - price) - Math.abs(y.mid - price))
    .slice(0, limit);
}

/** Fair value gaps: a 3-bar imbalance where bar 1 and bar 3 do not overlap. */
export function findFvgs(candles, limit = 4) {
  const out = [];

  for (let i = 2; i < candles.length; i++) {
    const a1 = candles[i - 2];
    const a3 = candles[i];
    if (a3.low > a1.high) out.push({ kind: "bullish", top: a3.low, bottom: a1.high, index: i });
    else if (a3.high < a1.low) out.push({ kind: "bearish", top: a1.low, bottom: a3.high, index: i });
  }

  for (const g of out) {
    g.filled = candles
      .slice(g.index + 1)
      .some((c) => c.low <= g.bottom && c.high >= g.top);
  }

  return out.filter((g) => !g.filled).slice(-limit);
}

/**
 * Cumulative aggression delta from executed trades.
 * Every supported exchange publishes which side crossed the spread, so this is
 * measured from real prints rather than inferred from price direction.
 */
export function deltaFromTrades(trades) {
  let delta = 0;
  let buy = 0;
  let sell = 0;

  // each provider normalises its own convention into `buyerAggressor`
  for (const t of trades) {
    if (t.buyerAggressor) {
      buy += t.qty;
      delta += t.qty;
    } else {
      sell += t.qty;
      delta -= t.qty;
    }
  }

  const total = buy + sell;
  return { delta, buy, sell, ratio: total ? buy / total : 0.5 };
}

/**
 * Aggression measured over the timeframe's own bars.
 *
 * The tape only holds the last few hundred prints — seconds of trading on a
 * liquid pair — so reading it gave a 1h chart the same window as a 1m one.
 * Exchanges that publish taker volume give buy and sell per candle, so this
 * covers the period the chart actually shows.
 */
export function flowFromCandles(candles, bars) {
  const window = candles.slice(-bars).filter((c) => typeof c.delta === "number");
  if (!window.length) return null;

  let buy = 0;
  let sell = 0;
  for (const c of window) {
    const v = c.volume || 0;
    const d = c.delta || 0;
    buy += (v + d) / 2;
    sell += (v - d) / 2;
  }

  const total = buy + sell;
  return {
    buy,
    sell,
    delta: buy - sell,
    ratio: total ? buy / total : 0.5,
    bars: window.length,
  };
}

/** Simple moving average series, aligned to the candle array. */
export function sma(candles, length) {
  const out = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < length - 1) {
      out.push(null);
      continue;
    }
    let sum = 0;
    for (let k = i - length + 1; k <= i; k++) sum += candles[k].close;
    out.push(sum / length);
  }
  return out;
}

/**
 * Cumulative volume delta: the running total of per-candle aggression.
 * Only exchanges that publish taker volume give this; when they do not, the
 * caller gets nulls rather than a number invented from price direction.
 */
export function cvdSeries(candles) {
  if (!candles.some((c) => typeof c.delta === "number")) return null;

  let run = 0;
  return candles.map((c) => {
    run += c.delta || 0;
    return run;
  });
}

/** Counts behind the support and resistance panel. */
export function zoneStats(zones) {
  const sup = zones.filter((z) => z.kind === "support");
  const res = zones.filter((z) => z.kind === "resistance");
  const toques = (list) => list.reduce((a, z) => a + z.touches, 0);
  const sweeps = (list) => list.filter((z) => z.swept).length;

  return {
    ativas: { sup: sup.length, res: res.length, total: zones.length },
    toques: { sup: toques(sup), res: toques(res), total: toques(zones) },
    sweeps: { sup: sweeps(sup), res: sweeps(res), total: sweeps(zones) },
  };
}

/**
 * Volume by price.
 *
 * A candle's volume is spread across the price bins its range covers, which is
 * the honest approximation available from candles: the exchange does not say
 * where inside the bar each lot traded. The busiest bin is the point of
 * control, and the value area is the band holding seventy percent of it.
 */
export function volumeProfile(candles, buckets = 22) {
  if (candles.length < 2) return null;

  const lo = Math.min(...candles.map((c) => c.low));
  const hi = Math.max(...candles.map((c) => c.high));
  const step = (hi - lo) / buckets;
  if (!(step > 0)) return null;

  const bins = Array.from({ length: buckets }, (_, i) => ({
    lo: lo + i * step,
    hi: lo + (i + 1) * step,
    vol: 0,
    delta: 0,
  }));

  for (const c of candles) {
    const a = Math.max(0, Math.min(buckets - 1, Math.floor((c.low - lo) / step)));
    const b = Math.max(0, Math.min(buckets - 1, Math.floor((c.high - lo) / step)));
    const n = b - a + 1;
    const vol = (c.volume || 0) / n;
    const delta = (c.delta || 0) / n;
    for (let i = a; i <= b; i++) {
      bins[i].vol += vol;
      bins[i].delta += delta;
    }
  }

  const total = bins.reduce((acc, b) => acc + b.vol, 0);
  let poc = 0;
  bins.forEach((b, i) => {
    if (b.vol > bins[poc].vol) poc = i;
  });

  // grow outward from the busiest bin, always taking the fuller neighbour
  let baixo = poc;
  let alto = poc;
  let acc = bins[poc].vol;
  while (acc < total * 0.7 && (baixo > 0 || alto < buckets - 1)) {
    const desce = baixo > 0 ? bins[baixo - 1].vol : -1;
    const sobe = alto < buckets - 1 ? bins[alto + 1].vol : -1;
    if (sobe >= desce) acc += bins[++alto].vol;
    else acc += bins[--baixo].vol;
  }

  return { bins, poc, vaBaixo: bins[baixo].lo, vaAlto: bins[alto].hi, total, max: bins[poc].vol };
}

export function analyse(candles, opts = {}) {
  const { depth = 0.5, zoneLimit = 6, flow = null } = opts;

  const result = {
    zones: [],
    fvgs: [],
    atr: 0,
    trend: "lateral",
    score: 50,
    reasons: [],
    plan: null,
  };

  if (candles.length < 40) {
    result.reasons.push("Poucas barras para analisar");
    return result;
  }

  const a = atr(candles);
  result.atr = a;
  result.zones = buildZones(candles, a, depth, zoneLimit);
  result.fvgs = findFvgs(candles);

  const price = candles[candles.length - 1].close;

  const mean = (arr) => arr.reduce((x, y) => x + y, 0) / arr.length;
  const fast = mean(candles.slice(-20).map((c) => c.close));
  const slow = mean(candles.slice(-40, -20).map((c) => c.close));
  const drift = a ? (fast - slow) / a : 0;

  if (drift > 0.6) result.trend = "alta";
  else if (drift < -0.6) result.trend = "baixa";

  let score = 50;
  const reasons = [];

  if (result.trend === "alta") {
    score += 14;
    reasons.push("Médias em alta");
  } else if (result.trend === "baixa") {
    score -= 14;
    reasons.push("Médias em baixa");
  }

  const supports = result.zones.filter((z) => z.kind === "support" && z.mid < price);
  const resistances = result.zones.filter((z) => z.kind === "resistance" && z.mid > price);

  const nearSup = supports.sort((x, y) => price - x.mid - (price - y.mid))[0] || null;
  const nearRes = resistances.sort((x, y) => x.mid - price - (y.mid - price))[0] || null;

  if (nearSup && a && price - nearSup.top < a * 0.5) {
    score += 12;
    reasons.push(`Preço apoiado em suporte (${nearSup.touches} toques)`);
  }
  if (nearRes && a && nearRes.bottom - price < a * 0.5) {
    score -= 12;
    reasons.push(`Preço colado em resistência (${nearRes.touches} toques)`);
  }

  if (result.fvgs.some((g) => g.kind === "bullish")) {
    score += 6;
    reasons.push("FVG de alta aberto");
  }
  if (result.fvgs.some((g) => g.kind === "bearish")) {
    score -= 6;
    reasons.push("FVG de baixa aberto");
  }

  if (result.zones.some((z) => z.swept)) reasons.push("Houve sweep de liquidez recente");

  // real order flow, when the exchange gave us trades to measure
  if (flow && flow.total > 0) {
    if (flow.ratio > 0.58) {
      score += 8;
      reasons.push(`Agressão compradora ${(flow.ratio * 100).toFixed(0)}%`);
    } else if (flow.ratio < 0.42) {
      score -= 8;
      reasons.push(`Agressão vendedora ${((1 - flow.ratio) * 100).toFixed(0)}%`);
    }
  }

  result.score = Math.max(0, Math.min(100, score));
  result.reasons = reasons.length ? reasons : ["Sem sinais relevantes"];
  result.plan = buildPlan(price, a, result.score, nearSup, nearRes, result.zones);
  return result;
}

/**
 * A plan only when the reading is decisive and the reward covers the risk.
 * "Stay out" is a valid outcome: forcing a side on a neutral reading is how a
 * panel talks a trader into noise.
 */
export function buildPlan(price, a, score, sup, res, zones = []) {
  if (a <= 0) return { side: "fora", motivo: "Volatilidade indefinida" };
  if (score >= 40 && score <= 60)
    return { side: "fora", motivo: "Leitura neutra — sem vantagem clara" };

  const long = score > 60;
  const entry = price;
  const stop = long
    ? sup
      ? sup.bottom - a * 0.15
      : price - a
    : res
      ? res.top + a * 0.15
      : price + a;

  const risk = Math.abs(entry - stop);
  if (risk <= 0) return { side: "fora", motivo: "Stop inválido para a estrutura atual" };

  /**
   * The nearest level ahead is often a few ticks away, which made almost every
   * plan fail the reward test on short timeframes — the panel was not being
   * disciplined, it was aiming at the wrong level. Walk outward instead and
   * take the first one that pays for the risk; if the structure offers none,
   * fall back to a volatility target.
   */
  const MIN_RR = 1.2;
  const reach = long ? entry + risk * MIN_RR : entry - risk * MIN_RR;
  const ahead = zones
    .map((z) => (long ? z.bottom : z.top))
    .filter((v) => (long ? v >= reach : v <= reach))
    .sort((x, y) => (long ? x - y : y - x));

  const target = ahead.length ? ahead[0] : long ? entry + a * 2 : entry - a * 2;

  const reward = Math.abs(target - entry);
  const rr = reward / risk;
  if (rr < 1)
    return { side: "fora", motivo: `Risco/retorno insuficiente (${rr.toFixed(2)}:1)` };

  return {
    side: long ? "compra" : "venda",
    entrada: entry,
    stop,
    alvo: target,
    risco: risk,
    rr,
  };
}

/**
 * Walks the strategy forward over history, one closed bar at a time.
 *
 * Only bars the analysis could actually have seen are passed in, and while a
 * trade is open no new one is considered — the same rule the live panel obeys.
 * What comes back is a record of what this reading would have done, measured
 * in R: the result divided by what the trade risked.
 *
 * It is a simple simulation. No fee, no slippage, and the target and stop are
 * assumed to fill at the level. Treat it as calibration, not proof.
 */
export function backtest(candles, opts = {}) {
  const { depth = 0.5, zoneLimit = 6, flowBars = 18, warmup = 200 } = opts;

  if (candles.length < warmup + 40) return null;

  const operacoes = [];
  const curva = [];
  let aberta = null;
  let r = 0;

  for (let i = warmup; i < candles.length; i++) {
    const barra = candles[i - 1];

    if (aberta) {
      const parou =
        aberta.side === "compra" ? barra.low <= aberta.stop : barra.high >= aberta.stop;
      const chegou =
        aberta.side === "compra" ? barra.high >= aberta.alvo : barra.low <= aberta.alvo;

      // a bar that touches both is counted as a loss: without tick data there
      // is no way to know which came first, and assuming the win flatters it
      if (parou || chegou) {
        const ganhou = chegou && !parou;
        r += ganhou ? aberta.rr : -1;
        operacoes.push({ ...aberta, resultado: ganhou ? "alvo" : "stop", fim: barra.time });
        curva.push(r);
        aberta = null;
      }
      continue;
    }

    const janela = candles.slice(0, i);
    const flow = flowFromCandles(janela, flowBars);
    const res = analyse(janela, {
      depth,
      zoneLimit,
      flow: flow ? { ...flow, total: flow.buy + flow.sell } : null,
    });

    if (res.plan && res.plan.side !== "fora") aberta = { ...res.plan, inicio: barra.time };
  }

  const alvos = operacoes.filter((o) => o.resultado === "alvo").length;

  return {
    operacoes,
    curva,
    total: operacoes.length,
    alvos,
    stops: operacoes.length - alvos,
    taxa: operacoes.length ? (alvos / operacoes.length) * 100 : 0,
    r,
    barras: candles.length - warmup,
  };
}

/**
 * Sweeps the two controls the panel exposes and reports what each pairing
 * would have returned, so the sliders can be set from evidence.
 */
export function varrer(candles, flowBars, zonas = [0.2, 0.4, 0.6, 0.8, 1.2, 1.6], niveis = [3, 4, 6, 8, 10]) {
  const grade = [];
  let melhor = null;

  for (const depth of zonas) {
    const linha = [];
    for (const zoneLimit of niveis) {
      const bt = backtest(candles, { depth, zoneLimit, flowBars });
      const cel = bt ? { depth, zoneLimit, r: bt.r, total: bt.total, taxa: bt.taxa } : null;
      linha.push(cel);
      if (cel && cel.total >= 3 && (!melhor || cel.r > melhor.r)) melhor = cel;
    }
    grade.push(linha);
  }

  return { grade, zonas, niveis, melhor };
}
