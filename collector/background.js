const endpoint = 'http://127.0.0.1:8765/rounds';
const recoveryEndpoint = 'http://127.0.0.1:8765/history-recovery-request';
const recoveryMarker = 'collector_recovery=1';
const regularProgress = new Map();
const outboxKey = 'pendingRoundBatches';

async function readOutbox() {
  const data = await chrome.storage.local.get(outboxKey);
  return Array.isArray(data[outboxKey]) ? data[outboxKey] : [];
}

async function writeOutbox(queue) {
  await chrome.storage.local.set({ [outboxKey]: queue.slice(-100) });
}

let flushing = false;
async function flushOutbox() {
  if (flushing) return;
  flushing = true;
  try {
    let queue = await readOutbox();
    while (queue.length) {
      const batch = queue[0];
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: 'bc-game-crash-extension', rows: batch.rows })
        });
        if (!response.ok) break;
        queue = queue.slice(1);
        await writeOutbox(queue);
      } catch {
        break;
      }
    }
  } finally {
    flushing = false;
  }
}

async function enqueueRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return;
  const queue = await readOutbox();
  const queuedIds = new Set(queue.flatMap(batch => (batch.rows || []).map(row => String(row.id))));
  const fresh = rows.filter(row => row && row.id != null && !queuedIds.has(String(row.id)));
  if (!fresh.length) return;
  queue.push({ created_at: new Date().toISOString(), rows: fresh });
  await writeOutbox(queue);
  await flushOutbox();
}

// Só remove abas com o marcador exclusivo do watchdog. Se elas forem a única
// fonte de rodadas, mantém uma; quando uma aba normal assume o fluxo ao vivo,
// pode fechar todas sem interromper a coleta.
async function cleanRecoveryTabs(closeAll = false) {
  const tabs = (await chrome.tabs.query({ url: 'https://bc.game/*/game/crash*' }))
    .filter(tab => tab.id && tab.url?.includes(recoveryMarker))
    .sort((a, b) => a.id - b.id);
  const toClose = closeAll ? tabs : tabs.slice(0, -1);
  if (toClose.length) await chrome.tabs.remove(toClose.map(tab => tab.id));
}

async function dispatchHistoryRecovery() {
  try {
    const response = await fetch(recoveryEndpoint, { cache: 'no-store' });
    const request = await response.json();
    if (!request?.recovery_required) return;
    const tabs = await chrome.tabs.query({ url: 'https://bc.game/*/game/crash*' });
    for (const tab of tabs) {
      if (tab.id) chrome.tabs.sendMessage(tab.id, { type: 'recover-history' }).catch(() => {});
    }
  } catch {
    // O receptor pode estar reiniciando; a próxima verificação tentará de novo.
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('crash-gap-recovery', { periodInMinutes: 5 });
  chrome.alarms.create('crash-round-outbox', { periodInMinutes: 1 });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('crash-gap-recovery', { periodInMinutes: 5 });
  chrome.alarms.create('crash-round-outbox', { periodInMinutes: 1 });
  flushOutbox();
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'crash-gap-recovery') {
    cleanRecoveryTabs().catch(() => {});
    dispatchHistoryRecovery();
  }
  if (alarm.name === 'crash-round-outbox') flushOutbox();
});

chrome.runtime.onMessage.addListener((message, sender) => {
  const isRounds = message?.type === 'rounds' && Array.isArray(message.rows);
  const isMetrics = message?.type === 'live-metrics' && message.metrics;
  const isAccountStatus = message?.type === 'account-status' && message.accountStatus;
  if (!isRounds && !isMetrics && !isAccountStatus) return;
  if (isRounds) {
    enqueueRows(message.rows).then(() => {
    if (!message.rows.length || !sender.tab?.id ||
        sender.tab.url?.includes(recoveryMarker)) return;
    const latest = Math.max(...message.rows.map(row => Number(row.id)).filter(Number.isFinite));
    if (!Number.isFinite(latest)) return;
    const now = Date.now();
    const progress = regularProgress.get(sender.tab.id);
    if (!progress) regularProgress.set(sender.tab.id, { firstSeen: now, highestId: latest });
    else if (latest > progress.highestId) {
      if (now - progress.firstSeen >= 30000) cleanRecoveryTabs(true).catch(() => {});
      progress.highestId = latest;
    }
    }).catch(() => {});
    return;
  }
  fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'bc-game-crash-extension', rows: [], live_metrics: isMetrics ? message.metrics : undefined, account_status: isAccountStatus ? message.accountStatus : undefined })
  }).catch(() => {
    // O servidor pode estar reiniciando. A próxima alteração na página será enviada novamente.
  });
});
