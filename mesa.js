/**
 * Mesa — the desk layer.
 *
 * Everything here answers a question a trading desk asks and a retail panel
 * does not: how much money the edge carries, what the spread of outcomes looks
 * like rather than its average, how many of your positions are secretly the
 * same position, who is on the other side, and whether the market just took a
 * hit. Each function takes data the panel already has and returns numbers, not
 * opinions.
 */

// --------------------------------------------------------------- capacidade
/**
 * What an order actually pays, walked through the real book.
 *
 * The top of the book is a price for a size nobody trades. Filling a real order
 * eats through levels, and the average paid is what the trade actually got.
 * Divided by the stop distance it becomes a cost in R, which is the only unit
 * in which it can be set against a measured edge.
 */
export function impacto(niveis, tamanhoUsd) {
  if (!niveis || !niveis.length || !(tamanhoUsd > 0)) return null;

  const topo = +niveis[0][0];
  let resta = tamanhoUsd;
  let pago = 0;
  let qtd = 0;

  for (const [p, q] of niveis) {
    const preco = +p;
    const disponivel = preco * +q;
    const usado = Math.min(resta, disponivel);
    qtd += usado / preco;
    pago += usado;
    resta -= usado;
    if (resta <= 0) break;
  }

  if (resta > 0) return { estourou: true, topo, profundidadeUsd: pago };

  const medio = pago / qtd;
  return { estourou: false, topo, medio, qtd, escorrega: (medio - topo) / topo };
}

/**
 * The size at which the edge stops existing.
 *
 * Found by bisection rather than a formula, because the book is a staircase:
 * the cost jumps at each level instead of growing smoothly, so there is no
 * closed form to solve for.
 */
export function capacidade(compras, vendas, stopPct, vantagemR, taxa = 0.0002) {
  if (!(stopPct > 0) || !(vantagemR > 0)) return null;

  const custoR = (usd) => {
    const c = impacto(vendas, usd);
    const v = impacto(compras, usd);
    if (!c || !v || c.estourou || v.estourou) return Infinity;
    return (c.escorrega + Math.abs(v.escorrega) + taxa) / stopPct;
  };

  const degraus = [1e3, 1e4, 5e4, 2e5, 1e6, 5e6].map((usd) => {
    const cr = custoR(usd);
    return { usd, custoR: cr, sobra: vantagemR - cr, estourou: !isFinite(cr) };
  });

  let baixo = 0;
  let alto = 2e7;
  for (let i = 0; i < 40; i++) {
    const meio = (baixo + alto) / 2;
    if (custoR(meio) < vantagemR) baixo = meio;
    else alto = meio;
  }

  return { degraus, teto: baixo, custoNoTeto: custoR(baixo) };
}

// -------------------------------------------------------------- monte carlo
/**
 * The spread of outcomes, not the average of them.
 *
 * An edge of +0.30R per trade says nothing about the road there: the same edge
 * can arrive after a run of eleven losses that would have made most people
 * stop. Resampling the measured trades — in their own proportions, in a fresh
 * order each time — shows what that road can look like, and how often it still
 * ends below zero even when the edge is real.
 *
 * Trades are drawn with replacement, which assumes one tells you nothing about
 * the next. If results actually cluster, the true spread is wider than this,
 * never narrower.
 */
export function monteCarlo(rs, opts = {}) {
  const { caminhos = 3000 } = opts;
  const porCaminho = opts.porCaminho || (rs ? rs.length : 0);
  if (!rs || !rs.length || porCaminho < 5) return null;

  const finais = [];
  const quedas = [];
  let somaSeguidas = 0;
  let acabouNegativo = 0;

  for (let c = 0; c < caminhos; c++) {
    let soma = 0;
    let pico = 0;
    let queda = 0;
    let seguidas = 0;
    let piorSeguidas = 0;

    for (let i = 0; i < porCaminho; i++) {
      const r = rs[(Math.random() * rs.length) | 0];
      soma += r;
      if (soma > pico) pico = soma;
      if (pico - soma > queda) queda = pico - soma;
      if (r <= 0) {
        seguidas++;
        if (seguidas > piorSeguidas) piorSeguidas = seguidas;
      } else {
        seguidas = 0;
      }
    }

    finais.push(soma);
    quedas.push(queda);
    somaSeguidas += piorSeguidas;
    if (soma <= 0) acabouNegativo++;
  }

  finais.sort((a, b) => a - b);
  quedas.sort((a, b) => a - b);
  const faixa = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];

  return {
    operacoes: porCaminho,
    caminhos,
    chanceDeLucro: (1 - acabouNegativo / caminhos) * 100,
    pior5: faixa(finais, 0.05),
    mediana: faixa(finais, 0.5),
    melhor5: faixa(finais, 0.95),
    quedaTipica: faixa(quedas, 0.5),
    quedaRuim: faixa(quedas, 0.95),
    perdasSeguidas: somaSeguidas / caminhos,
  };
}

// ------------------------------------------------------------------ choques
/**
 * Bars the market would have called news, read from the tape alone.
 *
 * A move counts as an event when it is large against this asset's own recent
 * range AND carries the volume to match — price without volume is noise,
 * volume without price is churn. The panel cannot say what happened; it can
 * say that something did, how big it was, and what the asset did afterwards.
 */
export function choques(velas, opts = {}) {
  const { desviosMin = 2.5, olharAdiante = 12, limite = 8 } = opts;
  if (!velas || velas.length < 120) return [];

  const retornos = [];
  for (let i = 1; i < velas.length; i++) {
    retornos.push((velas[i].close - velas[i - 1].close) / velas[i - 1].close);
  }

  const achados = [];
  for (let i = 60; i < velas.length - 1; i++) {
    const janela = retornos.slice(i - 60, i);
    const media = janela.reduce((s, r) => s + r, 0) / janela.length;
    const dp = Math.sqrt(janela.reduce((s, r) => s + (r - media) ** 2, 0) / janela.length);
    if (!(dp > 0)) continue;

    const r = retornos[i - 1];
    const desvios = (r - media) / dp;

    const vols = velas.slice(i - 60, i).map((c) => c.volume || 0);
    const volMedio = vols.reduce((s, v) => s + v, 0) / vols.length;
    const vezes = volMedio > 0 ? (velas[i].volume || 0) / volMedio : 0;

    if (Math.abs(desvios) < desviosMin || vezes < 2) continue;

    const depois = velas[Math.min(velas.length - 1, i + olharAdiante)];
    achados.push({
      time: velas[i].time,
      retorno: r,
      desvios,
      vezesVolume: vezes,
      depois: (depois.close - velas[i].close) / velas[i].close,
      barrasDepois: olharAdiante,
    });
    i += olharAdiante; // um choque e o seu rescaldo contam uma vez só
  }

  return achados.slice(-limite).reverse();
}

// --------------------------------------------------------------- correlação
/** Pearson on returns: how much two assets have been the same bet. */
export function correlacao(a, b) {
  if (!a || !b) return null;
  const n = Math.min(a.length, b.length);
  if (n < 40) return null;

  const ra = [];
  const rb = [];
  for (let k = 1; k < n; k++) {
    const x0 = a[a.length - n + k - 1];
    const x1 = a[a.length - n + k];
    const y0 = b[b.length - n + k - 1];
    const y1 = b[b.length - n + k];
    if (!x0 || !x1 || !y0 || !y1 || !(x0.close > 0) || !(y0.close > 0)) continue;
    ra.push((x1.close - x0.close) / x0.close);
    rb.push((y1.close - y0.close) / y0.close);
  }
  if (ra.length < 40) return null;

  const m = (x) => x.reduce((s, v) => s + v, 0) / x.length;
  const ma = m(ra);
  const mb = m(rb);
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < ra.length; i++) {
    cov += (ra[i] - ma) * (rb[i] - mb);
    va += (ra[i] - ma) ** 2;
    vb += (rb[i] - mb) ** 2;
  }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : null;
}

/**
 * What a basket of positions really risks.
 *
 * Adding position sizes together assumes they move independently. When they do
 * not, the basket carries far more than the sum suggests, and the number worth
 * knowing is how much of that naive total the correlation leaves standing.
 */
export function riscoDaCarteira(pesos, matriz) {
  const n = pesos.length;
  if (!n) return null;

  let soma = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const c = i === j ? 1 : (matriz[i] && matriz[i][j]) || 0;
      soma += pesos[i] * pesos[j] * c;
    }
  }

  const efetivo = Math.sqrt(Math.max(0, soma));
  const ingenuo = pesos.reduce((s, p) => s + Math.abs(p), 0);
  return { efetivo, ingenuo, concentracao: ingenuo > 0 ? efetivo / ingenuo : 0 };
}

// ----------------------------------------------------- volatilidade a termo
/** Realised volatility over several horizons, annualised so they compare. */
export function volTermo(velas, segundosPorBarra) {
  if (!velas || velas.length < 200 || !(segundosPorBarra > 0)) return null;
  const porAno = (365 * 24 * 3600) / segundosPorBarra;

  const vol = (n) => {
    const w = velas.slice(-n - 1);
    if (w.length < n) return null;
    const rs = [];
    for (let i = 1; i < w.length; i++) {
      if (w[i - 1].close > 0) rs.push(Math.log(w[i].close / w[i - 1].close));
    }
    if (rs.length < 10) return null;
    const m = rs.reduce((s, r) => s + r, 0) / rs.length;
    const dp = Math.sqrt(rs.reduce((s, r) => s + (r - m) ** 2, 0) / rs.length);
    return dp * Math.sqrt(porAno) * 100;
  };

  const curta = vol(24);
  const media = vol(96);
  const longa = vol(400);
  if (curta == null || longa == null) return null;

  return { curta, media, longa, razao: longa > 0 ? curta / longa : null };
}
