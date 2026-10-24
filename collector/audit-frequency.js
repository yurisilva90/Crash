/*
 * Auditoria reproduzível: não envia apostas nem altera parâmetros do jogo.
 * Usa o mesmo motor financeiro do mapa para testar C0/N0, mão fixa.
 */
const fs = require('node:fs');
const path = require('node:path');
const finance = require('../map-finance.js');
const frequency = require('../signal-frequency.js');

function csvRows(dataDir) {
  const byId = new Map();
  const clean = value => String(value || '').replace(/^"|"$/g, '');
  for (const name of fs.readdirSync(dataDir).filter(n => /^crash-\d{4}-\d{2}-\d{2}\.csv$/.test(n))) {
    const lines = fs.readFileSync(path.join(dataDir, name), 'utf8').trim().split(/\r?\n/);
    const header = (lines.shift()?.split(',') || []).map(clean);
    const idAt = header.indexOf('round_id'), multiplierAt = header.indexOf('multiplier'), capturedAt = header.indexOf('captured_at');
    for (const line of lines) {
      const fields = line.split(',');
      const round_id = Number(clean(fields[idAt]));
      const multiplier = Number(clean(fields[multiplierAt]).replace(',', '.'));
      if (Number.isFinite(round_id) && Number.isFinite(multiplier) && multiplier > 0)
        byId.set(round_id, { round_id, multiplier, captured_at: clean(fields[capturedAt]) });
    }
  }
  const rows = [...byId.values()];
  // O histórico antigo contém alguns IDs de jogador/valor que uma versão
  // anterior do capturador leu como rodada. A referência é a última rodada
  // realmente capturada no relógio recente; descarta apenas outliers fora de
  // uma faixa muito ampla, sem apagar o arquivo bruto.
  const latestByTime = rows.filter(row => !Number.isNaN(Date.parse(row.captured_at)))
    .sort((a, b) => Date.parse(b.captured_at) - Date.parse(a.captured_at))[0];
  const referenceId = latestByTime?.round_id;
  return rows.filter(row => !referenceId || (row.round_id >= referenceId * .75 && row.round_id <= referenceId * 1.25))
    .sort((a, b) => a.round_id - b.round_id);
}

function bucket(ratio) {
  if (!Number.isFinite(ratio)) return 'sem base';
  const pct = (ratio - 1) * 100;
  if (pct <= -30) return '≤−30%';
  if (pct <= -20) return '−30..−20%';
  if (pct <= -10) return '−20..−10%';
  if (pct < 10) return '−10..+10%';
  if (pct < 20) return '+10..+20%';
  if (pct < 30) return '+20..+30%';
  return '≥+30%';
}

function summarize(outcomes) {
  let equity = 0, peak = 0, maxDD = 0, profit = 0;
  for (const outcome of outcomes) {
    profit += outcome.profit;
    for (const delta of outcome.deltas) {
      equity += delta;
      peak = Math.max(peak, equity);
      maxDD = Math.max(maxDD, peak - equity);
    }
  }
  const wins = outcomes.filter(x => x.win).length;
  return { outcomes: outcomes.length, wins, losses: outcomes.length - wins, winRate: outcomes.length ? wins / outcomes.length : 0, profit, maxDD: -maxDD };
}

function format(n, digits = 2) { return Number(n).toLocaleString('pt-BR', { maximumFractionDigits: digits, minimumFractionDigits: digits }); }

function run(dataDir) {
  const source = csvRows(dataDir);
  const last = source.at(-1)?.round_id;
  const scopes = [250, 500, 1000, 'total'];
  const results = [];
  for (const payout of [20, 30]) for (const rounds of [21, 31, 41]) for (const frequencyWindow of [250, 500, 1000]) {
    const trend = frequency.trendAtAnchors(source, payout, 20, frequencyWindow, frequencyWindow).byRoundId;
    const signalByRoundId = Object.fromEntries(Object.entries(trend).map(([id, value]) => [id, { tone: value.level > 0 ? 'green' : value.level < 0 ? 'red' : 'yellow' }]));
    const projected = finance.project(source, { payout, cycleRounds: rounds, recoveries: 1, levels: 0 }, 20, signalByRoundId);
    for (const scope of scopes) {
      const minId = scope === 'total' ? -Infinity : last - scope + 1;
      const items = projected.events.filter(e => e.anchorRoundId >= minId).flatMap(e => (e.completed || []).map(o => ({ ...o, anchorRoundId: e.anchorRoundId })));
      const grouped = new Map();
      for (const item of items) {
        const key = bucket(trend[item.anchorRoundId]?.ratio);
        const list = grouped.get(key) || [];
        list.push(item); grouped.set(key, list);
      }
      results.push({ payout, rounds, frequencyWindow, scope, overall: summarize(items), bins: Object.fromEntries([...grouped].map(([key, value]) => [key, summarize(value)])) });
    }
  }
  return { generatedAt: new Date().toISOString(), rounds: source.length, firstRound: source[0]?.round_id, lastRound: last, results };
}

function markdown(audit) {
  const lines = [
    '# Auditoria de frequência do Crash', '',
    `Gerado: ${audit.generatedAt}`, `Base contínua: ${audit.rounds.toLocaleString('pt-BR')} rodadas (${audit.firstRound}–${audit.lastRound}).`,
    '', 'C0/N0, mão fixa, sem níveis, ciclos adicionais ou recuperação. O resultado e o drawdown usam o motor financeiro do painel. Frequência é calculada antes da âncora do ciclo; não representa previsão.', '',
    '## Resumo por estratégia, janela de frequência e recorte', '',
    '| Payout | R | Freq. | Recorte | Ciclos | Win | Resultado | DD máx. |', '|---:|---:|---:|---:|---:|---:|---:|---:|'
  ];
  for (const r of audit.results) lines.push(`| ${r.payout}x | ${r.rounds} | ${r.frequencyWindow} | ${r.scope} | ${r.overall.outcomes} | ${format(r.overall.winRate * 100, 1)}% | ${format(r.overall.profit)} | ${format(r.overall.maxDD)} |`);
  lines.push('', '## Faixas de frequência (resultado por ciclo)', '');
  for (const r of audit.results.filter(x => x.scope === 1000 && x.frequencyWindow === 500)) {
    lines.push(`### ${r.payout}x · ${r.rounds}R · frequência 500 · últimas 1.000`);
    lines.push('| Faixa | Ciclos | Win | Resultado | DD máx. |', '|---|---:|---:|---:|---:|');
    for (const key of ['≤−30%','−30..−20%','−20..−10%','−10..+10%','+10..+20%','+20..+30%','≥+30%','sem base']) {
      const s = r.bins[key]; if (s) lines.push(`| ${key} | ${s.outcomes} | ${format(s.winRate * 100, 1)}% | ${format(s.profit)} | ${format(s.maxDD)} |`);
    }
    lines.push('');
  }
  lines.push('Amostras pequenas não são filtro operacional: exigem validação fora da amostra antes de qualquer conclusão.');
  return lines.join('\n');
}

const dataDir = process.argv[2];
const out = process.argv[3];
if (!dataDir || !out) throw new Error('Uso: node audit-frequency.js <data-dir> <arquivo.md>');
const audit = run(dataDir);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, markdown(audit) + '\n', 'utf8');
console.log(JSON.stringify({ output: out, rounds: audit.rounds, lastRound: audit.lastRound, resultCount: audit.results.length }));
