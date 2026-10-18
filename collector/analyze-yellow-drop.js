const fs = require('fs');
const path = require('path');

const payout = 30, cycle = 61;
const dataDir = path.join(__dirname, 'data');
const byId = new Map();
for (const file of fs.readdirSync(dataDir).filter(name => /^crash-.*\.csv$/.test(name)).sort()) {
  for (const line of fs.readFileSync(path.join(dataDir, file), 'utf8').split(/\r?\n/).slice(1)) {
    const match = /^"([^"]*)","(\d{7})","([0-9.]+)",/.exec(line);
    if (!match || !match[2].startsWith('96')) continue;
    const id = Number(match[2]), multiplier = Number(match[3]);
    if (!byId.has(id) && Number.isFinite(multiplier)) byId.set(id, { id, multiplier });
  }
}
const rows = [...byId.values()].sort((a, b) => a.id - b.id);
const hits = [0];
for (const row of rows) hits.push(hits.at(-1) + Number(row.multiplier >= payout));
let direct = 0;
function signalAfter(index) {
  const end = index + 1;
  const short = Math.min(250, end), long = Math.min(1000, end);
  const shortHits = hits[end] - hits[end - short], longHits = hits[end] - hits[end - long];
  return Number(direct >= 3) + Number(short === 250 && shortHits >= Math.ceil(250 * .99 / payout)) + Number(long === 1000 && longHits >= Math.ceil(1000 * .99 / payout));
}
const events = [];
let start = 0, startScore = 0, firstDrop = null;
for (let i = 0; i < rows.length; i++) {
  const roundIndex = i - start + 1;
  if (rows[i].multiplier >= payout) {
    const position = roundIndex, loss = position > cycle;
    if (startScore === 2) events.push({ index: i, start, id: rows[i].id, position, loss, firstDrop: firstDrop !== null && firstDrop <= cycle ? firstDrop : null });
    direct = loss ? 0 : direct + 1;
    start = i + 1;
    startScore = signalAfter(i);
    firstDrop = null;
  } else if (startScore === 2 && firstDrop === null && signalAfter(i) < 2) firstDrop = roundIndex;
}
const exactExposure = n => (payout - 1) * (Math.pow(payout / (payout - 1), n) - 1);
function summary(source) {
  const wins = source.filter(event => !event.loss), losses = source.filter(event => event.loss);
  const levels = {};
  for (const event of losses) { const level = Math.floor((event.position - 1) / cycle); levels[level] = (levels[level] || 0) + 1; }
  return { cycles: source.length, wins: wins.length, losses: losses.length, winPct: source.length ? 100 * wins.length / source.length : null, lossPct: source.length ? 100 * losses.length / source.length : null, lossLevels: levels, maxPosition: Math.max(0, ...source.map(event => event.position)) };
}
function simulate(source, stopOnDrop) {
  let equity = 0, peak = 0, maxDD = 0, profit = 0, wins = 0, losses = 0, stopped = 0;
  for (const event of source) {
    const stopAt = stopOnDrop && event.firstDrop !== null ? Math.min(event.firstDrop, cycle) : cycle;
    const betCount = Math.min(event.position, stopAt);
    const isWin = event.position <= stopAt;
    const starting = equity;
    maxDD = Math.max(maxDD, peak - (starting - exactExposure(betCount)));
    const pnl = isWin ? payout - 1 : -exactExposure(betCount);
    equity += pnl;
    profit += pnl;
    if (isWin) wins++; else losses++;
    if (event.firstDrop !== null && event.firstDrop <= cycle && stopOnDrop) stopped++;
    peak = Math.max(peak, equity);
  }
  return { profit, maxDD, wins, losses, stopped };
}
const stable = events.filter(event => event.firstDrop === null), dropped = events.filter(event => event.firstDrop !== null);
const withinCycleDrops = dropped.filter(event => event.firstDrop <= cycle);
const nextYellow = withinCycleDrops.map(event => {
  const next = events.find(candidate => candidate.start > event.index);
  return next ? { rounds: next.start - (event.start + event.firstDrop - 1), win: !next.loss } : null;
}).filter(Boolean);
const sorted = values => values.slice().sort((a, b) => a - b);
const median = values => values.length ? sorted(values)[Math.ceil(values.length / 2) - 1] : null;
console.log(JSON.stringify({
  firstId: rows[0]?.id, lastId: rows.at(-1)?.id, rounds: rows.length,
  allYellow: summary(events), stableYellow: summary(stable), droppedYellow: summary(dropped),
  withinCycleDrops: { ...summary(withinCycleDrops), winsAfterDrop: withinCycleDrops.filter(event => !event.loss).length, lossesAfterDrop: withinCycleDrops.filter(event => event.loss).length, medianDropRound: median(withinCycleDrops.map(event => event.firstDrop)), minDropRound: Math.min(...withinCycleDrops.map(event => event.firstDrop)), maxDropRound: Math.max(...withinCycleDrops.map(event => event.firstDrop)) },
  nextYellow: { observed: nextYellow.length, medianRoundsAway: median(nextYellow.map(item => item.rounds)), wins: nextYellow.filter(item => item.win).length },
  stableOnly: simulate(stable, false), finishAll: simulate(events, false), stopOnDrop: simulate(events, true), exposure61: exactExposure(61),
}, null, 2));
