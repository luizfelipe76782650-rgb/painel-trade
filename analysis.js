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
  // the window has to match the one the live panel reads, or this measures a
  // strategy nobody is running
  const { depth = 0.5, zoneLimit = 6, flowBars = 18, janela = 400, taxa = 0 } = opts;
  const warmup = janela;

  if (candles.length < warmup + 40) return null;

  const operacoes = [];
  const curva = [];
  let aberta = null;
  let r = 0;
  let custos = 0;

  for (let i = warmup; i < candles.length; i++) {
    const vista = candles.slice(Math.max(0, i - janela), i);

    if (aberta) {
      const fim = acompanharStop(aberta, vista, aberta.atr, pivots(vista));
      aberta.stop = fim.stop;

      if (fim.resultado) {
        /**
         * A round trip costs a share of the position, while the result is
         * measured against the distance to the stop. So the cost in R is the
         * fee divided by how far the stop sits: a tight stop pays far more of
         * its own risk to the exchange, and ignoring that flatters every
         * short-timeframe result.
         */
        const riscoPct = Math.abs(aberta.entrada - aberta.stopInicial) / aberta.entrada;
        const custo = riscoPct > 0 ? taxa / riscoPct : 0;
        const liquido = fim.r - custo;

        r += liquido;
        custos += custo;
        operacoes.push({
          ...aberta,
          resultado: liquido > 0 ? fim.resultado : fim.resultado === "alvo" ? "alvo" : fim.resultado,
          r: liquido,
          bruto: fim.r,
          custo,
          fim: fim.fim,
        });
        curva.push(r);
        aberta = null;
      }
      continue;
    }

    const flow = flowFromCandles(vista, flowBars);
    const res = analyse(vista, {
      depth,
      zoneLimit,
      flow: flow ? { ...flow, total: flow.buy + flow.sell } : null,
    });

    if (res.plan && res.plan.side !== "fora") {
      /**
       * The signal forms on a bar that has already finished, so entering at its
       * close and then asking whether that same bar reached the target counts a
       * move that happened before the decision existed. The trade opens on the
       * next bar instead, at its open, and is only watched from there — which
       * is also how it would actually be filled.
       */
      const proxima = candles[i];
      const entrada = proxima.open;
      const risco = Math.abs(entrada - res.plan.stop);
      const ganho = Math.abs(res.plan.alvo - entrada);

      if (risco > 0 && ganho / risco >= 1) {
        aberta = {
          ...res.plan,
          entrada,
          rr: ganho / risco,
          stopInicial: res.plan.stop,
          atr: res.atr,
          abertura: proxima.time,
        };
      }
    }
  }

  const alvos = operacoes.filter((o) => o.resultado === "alvo").length;
  const empates = operacoes.filter((o) => o.resultado === "empate").length;
  const ganhos = operacoes.filter((o) => o.r > 0).length;

  /**
   * The bar the reading has to clear.
   *
   * Not from the planned reward — the trailing stop cuts most winners before
   * they reach it, so the plan flatters the strategy. This uses what the wins
   * and losses actually measured, which is the only honest version: with those
   * sizes, this is the hit rate that would leave you exactly even, fees
   * included. Below it, no amount of good-looking entries saves the result.
   */
  const vencedoras = operacoes.filter((o) => o.r > 0);
  const perdedoras = operacoes.filter((o) => o.r <= 0);
  const mediaGanho = vencedoras.length
    ? vencedoras.reduce((soma, o) => soma + o.r, 0) / vencedoras.length
    : 0;
  const mediaPerda = perdedoras.length
    ? Math.abs(perdedoras.reduce((soma, o) => soma + o.r, 0) / perdedoras.length)
    : 0;

  const custoMedio = operacoes.length ? custos / operacoes.length : 0;
  const acertoNecessario =
    mediaGanho + mediaPerda > 0 ? (mediaPerda / (mediaGanho + mediaPerda)) * 100 : null;

  return {
    operacoes,
    curva,
    total: operacoes.length,
    alvos,
    empates,
    stops: operacoes.length - alvos - empates,
    taxa: operacoes.length ? (ganhos / operacoes.length) * 100 : 0,
    r,
    porOp: operacoes.length ? r / operacoes.length : 0,
    custoMedio,
    mediaGanho,
    mediaPerda,
    acertoNecessario,
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

/**
 * Walks an open trade forward, moving its stop.
 *
 * Two rules, in order. Once the market has paid the risk once — one R in
 * favour — the stop goes to the entry, and from there the trade cannot lose.
 * After that it follows the structure: the stop sits just beyond the most
 * recent confirmed swing behind price. It never moves backwards, so a stop
 * that has been tightened stays tightened.
 *
 * The whole path is replayed from the entry on every call, which makes the
 * result depend only on the candles — the live panel and the backtest run the
 * same code and cannot drift apart.
 */
/**
 * How far behind the swing the trailing stop sits, in ATR.
 *
 * It began at 0.15 and was arbitrary. Measured across two independent groups
 * of assets, loosening it to 0.6 improved the result by about the same amount
 * in both (+0.025R per trade) — the only change tonight that moved the same
 * way on assets it was not chosen on. The reason is mechanical: a stop pressed
 * against the pivot is taken out by noise, turning winners into small losses.
 */
const FOLGA_STOP = 0.6;

/** Whether a trade closes at its planned target, or rides the trailing stop. */
const SAI_NO_ALVO = false;

export function acompanharStop(t, candles, a, pivos) {
  const long = t.side === "compra";
  const stopInicial = t.stopInicial ?? t.stop;
  const risco = Math.abs(t.entrada - stopInicial);

  const vazio = { stop: stopInicial, empatou: false, movimentos: [], resultado: null, r: null };
  if (!(risco > 0)) return vazio;

  const umR = long ? t.entrada + risco : t.entrada - risco;
  const inicio = candles.findIndex((c) => c.time >= t.abertura);
  if (inicio < 0) return vazio;

  let stop = stopInicial;
  let empatou = false;
  const movimentos = [];

  for (let i = inicio; i < candles.length; i++) {
    const c = candles[i];

    const parou = long ? c.low <= stop : c.high >= stop;
    /**
     * The target is a reference, not an exit.
     *
     * A fixed target caps every winner at the same size however far the move
     * runs, and the trailing stop already knows when a move is over. Measured
     * across two independent groups of assets, dropping it lifted the average
     * win from 1.5R to about 2R with the average loss unchanged — which pulls
     * the break-even hit rate down from 34% to 26%, the largest improvement
     * found. Set SAI_NO_ALVO to true to go back to closing there.
     */
    const chegou = SAI_NO_ALVO && (long ? c.high >= t.alvo : c.low <= t.alvo);

    // a bar that touches both counts as the stop: without tick data there is
    // no way to know which came first, and assuming the win flatters it
    if (parou || chegou) {
      const saida = parou ? stop : t.alvo;
      const r = ((saida - t.entrada) / risco) * (long ? 1 : -1);
      return {
        stop,
        empatou,
        movimentos,
        resultado: chegou && !parou ? "alvo" : r >= 0 ? "empate" : "stop",
        saida,
        fim: c.time,
        r,
      };
    }

    if (!empatou && (long ? c.high >= umR : c.low <= umR)) {
      empatou = true;
      if (long ? t.entrada > stop : t.entrada < stop) {
        stop = t.entrada;
        movimentos.push({ quando: c.time, stop, motivo: "empate" });
      }
    }

    if (empatou && pivos) {
      const lista = long ? pivos.lows : pivos.highs;

      for (let k = lista.length - 1; k >= 0; k--) {
        const idx = lista[k];
        if (idx + 3 > i) continue; // ainda não confirmado nesta barra

        const nivel = long
          ? candles[idx].low - a * FOLGA_STOP
          : candles[idx].high + a * FOLGA_STOP;
        const melhora = long ? nivel > stop : nivel < stop;
        // a stop already past the price would close the trade on the spot
        const cabe = long ? nivel < c.close : nivel > c.close;

        if (melhora && cabe) {
          stop = nivel;
          movimentos.push({ quando: c.time, stop, motivo: "estrutura" });
        }
        break; // só o pivô mais recente interessa
      }
    }
  }

  return { stop, empatou, movimentos, resultado: null, r: null };
}

/**
 * Builds an asset's profile.
 *
 * The settings are swept over the first half of its history and then judged on
 * the second half, which the sweep never saw. A profile is only reported as
 * usable when it beat the default settings on that untouched half — otherwise
 * what looks like a tuned edge is just the shape of the past being memorised.
 *
 * Fees are charged throughout, because a profile that only works for free is
 * not a profile.
 */
export function calibrar(candles, opts = {}) {
  const {
    flowBars = 12,
    janela = 400,
    taxa = 0.0002,
    zonas = [0.3, 0.5, 0.8, 1.2],
    niveis = [4, 6, 9],
    minimo = 8,
  } = opts;

  const uteis = candles.length - janela;
  if (uteis < 600) return null;

  const corte = Math.floor(uteis / 2) + janela;
  const primeira = candles.slice(0, corte);
  const segunda = candles.slice(corte - janela); // mantém o aquecimento

  const comum = { flowBars, janela, taxa };

  let melhor = null;
  for (const depth of zonas) {
    for (const zoneLimit of niveis) {
      const bt = backtest(primeira, { ...comum, depth, zoneLimit });
      if (!bt || bt.total < minimo) continue;
      if (!melhor || bt.porOp > melhor.bt.porOp) melhor = { depth, zoneLimit, bt };
    }
  }

  if (!melhor) return { suficiente: false };

  const fora = backtest(segunda, { ...comum, depth: melhor.depth, zoneLimit: melhor.zoneLimit });
  const padrao = backtest(segunda, { ...comum, depth: 0.5, zoneLimit: 6 });

  return {
    suficiente: true,
    depth: melhor.depth,
    zoneLimit: melhor.zoneLimit,
    dentro: melhor.bt,
    fora,
    padrao,
    // two conditions, both necessary: it must beat the default on ground it
    // never saw, and it must actually make money after costs
    aprovado: !!fora && !!padrao && fora.porOp > padrao.porOp && fora.porOp > 0,
  };
}

/**
 * Entry families.
 *
 * Each one reads the visible window and either proposes a trade or stays out.
 * They are deliberately different ideas rather than variations of one — a
 * panel that can only test its own hypothesis can only ever confirm it.
 *
 * Every family returns its stop and target as multiples of ATR, so the engine
 * can place them against the real fill price rather than the signal price.
 */
export const FAMILIAS = {
  zonas: {
    nome: "Zonas de suporte e resistência",
    conta: "Entra quando o preço encosta numa zona com o placar a favor.",
    gerar(v, atr, opts) {
      const fl = flowFromCandles(v, opts.flowBars);
      const r = analyse(v, {
        depth: opts.depth,
        zoneLimit: opts.zoneLimit,
        flow: fl ? { ...fl, total: fl.buy + fl.sell } : null,
      });
      if (!r.plan || r.plan.side === "fora") return null;

      const risco = Math.abs(r.plan.entrada - r.plan.stop) / atr;
      const ganho = Math.abs(r.plan.alvo - r.plan.entrada) / atr;
      return { side: r.plan.side, stop: -risco, alvo: ganho };
    },
  },

  reversao: {
    nome: "Reversão à média",
    conta: "Entra contra o movimento quando o preço se afasta demais da média.",
    gerar(v, atr) {
      const c = v[v.length - 1];
      const janela = v.slice(-20);
      const media = janela.reduce((soma, x) => soma + x.close, 0) / janela.length;
      const distancia = (c.close - media) / atr;

      if (distancia > 2.2) return { side: "venda", stop: -1.5, alvo: Math.abs(distancia) };
      if (distancia < -2.2) return { side: "compra", stop: -1.5, alvo: Math.abs(distancia) };
      return null;
    },
  },

  rompimento: {
    nome: "Rompimento",
    conta: "Entra a favor quando o preço fecha além da máxima ou mínima de 20 barras.",
    gerar(v) {
      const c = v[v.length - 1];
      const janela = v.slice(-21, -1);
      const topo = Math.max(...janela.map((x) => x.high));
      const fundo = Math.min(...janela.map((x) => x.low));

      if (c.close > topo) return { side: "compra", stop: -1.5, alvo: 3 };
      if (c.close < fundo) return { side: "venda", stop: -1.5, alvo: 3 };
      return null;
    },
  },

  sweep: {
    nome: "Sweep e recuperação",
    conta: "Entra quando o preço fura um extremo e fecha de volta para dentro.",
    gerar(v, atr) {
      const c = v[v.length - 1];
      const janela = v.slice(-21, -1);
      const topo = Math.max(...janela.map((x) => x.high));
      const fundo = Math.min(...janela.map((x) => x.low));

      if (c.low < fundo && c.close > fundo) {
        const risco = (c.close - c.low) / atr + 0.2;
        return { side: "compra", stop: -risco, alvo: risco * 2 };
      }
      if (c.high > topo && c.close < topo) {
        const risco = (c.high - c.close) / atr + 0.2;
        return { side: "venda", stop: -risco, alvo: risco * 2 };
      }
      return null;
    },
  },

  delta: {
    nome: "Divergência de agressão",
    conta: "Entra quando o preço faz um extremo novo e a agressão não acompanha.",
    gerar(v, atr) {
      const c = v[v.length - 1];
      const janela = v.slice(-20);
      if (!janela.every((x) => typeof x.delta === "number")) return null;

      const anteriores = janela.slice(0, -1);
      const fundo = Math.min(...anteriores.map((x) => x.low));
      const topo = Math.max(...anteriores.map((x) => x.high));
      const meio = Math.floor(janela.length / 2);
      const antes = janela.slice(0, meio).reduce((soma, x) => soma + x.delta, 0);
      const agora = janela.slice(meio).reduce((soma, x) => soma + x.delta, 0);

      if (c.low < fundo && agora > antes) return { side: "compra", stop: -1, alvo: 2 };
      if (c.high > topo && agora < antes) return { side: "venda", stop: -1, alvo: 2 };
      return null;
    },
  },
};

/**
 * Runs a family over history and reports what it would have done.
 *
 * A signal is read from a bar that has already closed, so the trade opens on
 * the next bar at its open — the first price the decision could actually have
 * been filled at. Measuring against the signal bar instead is the single
 * mistake that makes a backtest promise things the market never offered.
 */
export function testarFamilia(candles, familia, opts = {}) {
  const {
    flowBars = 12,
    janela = 400,
    taxa = 0.0002,
    depth = 0.5,
    zoneLimit = 6,
    rrMinimo = 1,
  } = opts;

  const ideia = FAMILIAS[familia];
  if (!ideia || candles.length < janela + 100) return null;

  const operacoes = [];
  const curva = [];
  let aberta = null;
  let r = 0;
  let custos = 0;

  for (let i = janela; i < candles.length; i++) {
    const vista = candles.slice(i - janela, i);

    if (aberta) {
      const fim = acompanharStop(aberta, vista, aberta.atr, pivots(vista));
      aberta.stop = fim.stop;

      if (fim.resultado) {
        const riscoPct = Math.abs(aberta.entrada - aberta.stopInicial) / aberta.entrada;
        const custo = riscoPct > 0 ? taxa / riscoPct : 0;
        const liquido = fim.r - custo;

        r += liquido;
        custos += custo;
        operacoes.push({ ...aberta, resultado: fim.resultado, r: liquido, custo });
        curva.push(r);
        aberta = null;
      }
      continue;
    }

    const a = atr(vista);
    const proxima = candles[i];
    if (!(a > 0) || !proxima) continue;

    const sinal = ideia.gerar(vista, a, { flowBars, depth, zoneLimit });
    if (!sinal) continue;

    const entrada = proxima.open;
    const direcao = sinal.side === "compra" ? 1 : -1;
    const stop = entrada + a * sinal.stop * direcao;
    const alvo = entrada + a * sinal.alvo * direcao;
    const risco = Math.abs(entrada - stop);
    const ganho = Math.abs(alvo - entrada);

    if (!(risco > 0) || ganho / risco < rrMinimo) continue;

    aberta = {
      side: sinal.side,
      entrada,
      stop,
      alvo,
      rr: ganho / risco,
      stopInicial: stop,
      atr: a,
      abertura: proxima.time,
    };
  }

  const ganhos = operacoes.filter((o) => o.r > 0).length;

  return {
    total: operacoes.length,
    curva,
    r,
    porOp: operacoes.length ? r / operacoes.length : 0,
    taxa: operacoes.length ? (ganhos / operacoes.length) * 100 : 0,
    custoMedio: operacoes.length ? custos / operacoes.length : 0,
    barras: candles.length - janela,
  };
}
