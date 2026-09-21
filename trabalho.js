/**
 * A oficina — the measurement thread.
 *
 * Everything the panel measures is arithmetic over thousands of bars, and all
 * of it used to run on the same thread that draws the chart and answers the
 * mouse. One backtest over 2500 candles takes about 750ms; the asset map runs
 * five of them and the Monte Carlo grid runs sixty. While any of that ran the
 * page was frozen — clicks queued, the chart stopped, the wheel did nothing.
 *
 * A worker has its own thread. The main thread sends candles and gets numbers
 * back, and stays free the whole time. Nothing here touches the document,
 * because a worker cannot: that restriction is precisely what makes it safe.
 */
import {
  FAMILIAS,
  backtest,
  fichaComite,
  testarFamilia,
  varrer,
} from "./analysis.js?v=63";
import { leque, monteCarlo } from "./mesa.js?v=63";

/** The per-trade results a backtest produced, recovered from its equity curve. */
function resultadosDe(bt) {
  if (!bt || !bt.curva || bt.curva.length < 5) return null;
  return bt.curva.map((x, i, arr) => (i ? x - arr[i - 1] : x));
}

const TAREFAS = {
  backtest: ({ velas, opts }) => backtest(velas, opts),

  ficha: ({ velas, opts }) => fichaComite(velas, opts),

  familia: ({ velas, familia, opts }) => testarFamilia(velas, familia, opts),

  varredura: ({ velas, flowBars, zonas, niveis }) => varrer(velas, flowBars, zonas, niveis),

  /**
   * One cell of the Monte Carlo grid, measured end to end here.
   *
   * Sending the trade list back so the main thread could resample it would move
   * the cost rather than remove it, so the resampling happens beside the
   * backtest that produced it and only the summary crosses back.
   */
  celula: ({ velas, opts, caminhos = 1500, caminhosLeque = 800 }) => {
    const bt = backtest(velas, opts);
    const rs = resultadosDe(bt);
    if (!rs || rs.length < 8) return null;
    const mc = monteCarlo(rs, { caminhos });
    if (!mc) return null;
    return { ...mc, porOp: bt.porOp, leque: leque(rs, { caminhos: caminhosLeque }) };
  },

  /** The asset map: the same asset measured across several timeframes. */
  mapa: ({ series }) =>
    series.map(({ tf, velas, opts }) => {
      if (!velas || velas.length - (opts.janela || 400) < 300) return { tf, curto: true };
      const bt = backtest(velas, opts);
      return bt && bt.total >= 5
        ? { tf, ops: bt.total, porOp: bt.porOp, acerto: bt.taxa, folga: bt.taxa - bt.acertoNecessario }
        : { tf, poucas: true };
    }),

  familias: () => Object.keys(FAMILIAS),
};

self.onmessage = async (e) => {
  const { id, tarefa, dados } = e.data || {};
  const fn = TAREFAS[tarefa];

  if (!fn) {
    self.postMessage({ id, erro: `tarefa desconhecida: ${tarefa}` });
    return;
  }

  try {
    self.postMessage({ id, resultado: await fn(dados || {}) });
  } catch (err) {
    self.postMessage({ id, erro: err && err.message ? err.message : String(err) });
  }
};
