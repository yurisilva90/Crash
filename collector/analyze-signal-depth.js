const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
const payout = Number(process.argv[2] || 30);
const cycle = Number(process.argv[3] || 61);
const files = fs.readdirSync(dataDir).filter(name => /^crash-.*\.csv$/.test(name)).sort();
const byId = new Map();
for (const file of files) {
  for (const line of fs.readFileSync(path.join(dataDir, file), 'utf8').split(/\r?\n/).slice(1)) {
    const match = /^"([^"]*)","(\d{7})","([0-9.]+)",/.exec(line);
    if (!match) continue;
    const [, capturedAt, id, multiplierText] = match;
    const multiplier = Number(multiplierText);
    if (id.startsWith('96') && Number.isFinite(multiplier) && !byId.has(Number(id))) byId.set(Number(id), { id: Number(id), multiplier, capturedAt });
  }
}
const rows = [...byId.values()].sort((a, b) => a.id - b.id);
const prefix = [0];
for (const row of rows) prefix.push(prefix.at(-1) + Number(row.multiplier >= payout));
let run = 0, direct = 0, signal = 'red';
const events = [];
for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  if (row.multiplier < payout) { run++; continue; }
  const position = run + 1;
  const loss = position > cycle;
  events.push({ id: row.id, capturedAt: row.capturedAt, position, loss, signal, level: Math.floor(run / cycle) });
  direct = loss ? 0 : direct + 1;
  const short = Math.min(250, i + 1), long = Math.min(1000, i + 1);
  const shortHits = prefix[i + 1] - prefix[i + 1 - short];
  const longHits = prefix[i + 1] - prefix[i + 1 - long];
  const score = Number(direct >= 3) + Number(short === 250 && shortHits >= Math.ceil(250 * .99 / payout)) + Number(long === 1000 && longHits >= Math.ceil(1000 * .99 / payout));
  signal = ['red', 'orange', 'yellow', 'green'][score];
  run = 0;
}
const sorted = values => values.slice().sort((a, b) => a - b);
const percentile = (values, p) => values.length ? sorted(values)[Math.ceil(values.length * p) - 1] : null;
function exactStakeDrawdown(selected) {
  let equity = 0, peak = 0, dd = 0, worstCycleExposure = 0, totalProfit = 0;
  for (const event of selected) {
    let spent = 0;
    for (let step = 1; step <= Math.min(event.position, cycle); step++) {
      const stake = (payout - 1 + spent) / (payout - 1);
      spent += stake;
      equity -= stake;
      dd = Math.max(dd, peak - equity);
      if (step === event.position && !event.loss) equity += payout * stake;
    }
    worstCycleExposure = Math.max(worstCycleExposure, spent);
    totalProfit += event.loss ? -spent : payout - 1;
    peak = Math.max(peak, equity);
  }
  return { maxDrawdown: dd, worstCycleExposure, totalProfit };
}
function summarize(key) {
  const selected = events.filter(event => event.signal === key);
  const losses = selected.filter(event => event.loss), wins = selected.filter(event => !event.loss);
  const depths = losses.map(event => event.position), levels = {};
  for (const event of losses) levels[event.level] = (levels[event.level] || 0) + 1;
  let selectedLossStreak = 0, maxSelectedLossStreak = 0, maxAdjacentLossStreak = 0;
  for (const event of selected) { selectedLossStreak = event.loss ? selectedLossStreak + 1 : 0; maxSelectedLossStreak = Math.max(maxSelectedLossStreak, selectedLossStreak); }
  let adjacent = 0;
  for (const event of events) { adjacent = event.signal === key && event.loss ? adjacent + 1 : 0; maxAdjacentLossStreak = Math.max(maxAdjacentLossStreak, adjacent); }
  const nextEvents = losses.map(event => events[events.indexOf(event) + 1]).filter(Boolean);
  const nextWins = nextEvents.filter(event => !event.loss);
  const untilWin = losses.map(event => {
    let rounds = 0, extraLosses = 0, cycles = 0;
    for (let index = events.indexOf(event) + 1; index < events.length; index++) {
      const next = events[index];
      rounds += next.position;
      cycles++;
      if (!next.loss) return { rounds, extraLosses, cycles };
      extraLosses++;
    }
    return null;
  }).filter(Boolean);
  return {
    signal: key, cycles: selected.length, wins: wins.length, losses: losses.length,
    winPct: 100 * wins.length / selected.length, lossPct: 100 * losses.length / selected.length,
    lossPositions: { min: Math.min(...depths), median: percentile(depths, .5), p90: percentile(depths, .9), max: Math.max(...depths) },
    lossLevels: levels, maxSelectedLossStreak, maxAdjacentLossStreak,
    nextCycle: { observed: nextEvents.length, wins: nextWins.length, winPct: 100 * nextWins.length / nextEvents.length, medianRoundsToNextPayout: percentile(nextEvents.map(event => event.position), .5), maxRoundsToNextPayout: Math.max(...nextEvents.map(event => event.position)) },
    untilNextWin: { observed: untilWin.length, medianRounds: percentile(untilWin.map(item => item.rounds), .5), p90Rounds: percentile(untilWin.map(item => item.rounds), .9), maxRounds: Math.max(...untilWin.map(item => item.rounds)), maxExtraLosses: Math.max(...untilWin.map(item => item.extraLosses)), winsOnNextCycle: untilWin.filter(item => item.cycles === 1).length },
    exactStake: exactStakeDrawdown(selected),
    longestWinStreak: (() => { let now = 0, max = 0; for (const event of selected) { now = event.loss ? 0 : now + 1; max = Math.max(max, now); } return max; })(),
  };
}
const missing = [];
for (let i = 1; i < rows.length; i++) for (let id = rows[i - 1].id + 1; id < rows[i].id; id++) missing.push(id);
console.log(JSON.stringify({ payout, cycle, rounds: rows.length, firstId: rows[0]?.id, lastId: rows.at(-1)?.id, missing, events: events.length, green: summarize('green'), yellow: summarize('yellow') }, null, 2));
