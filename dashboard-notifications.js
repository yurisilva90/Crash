(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.CrashDashboardNotifications = api;
  if (typeof document !== 'undefined') api.mount();
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const ROUND_MIN = 9000000, ROUND_MAX = 9999999;
  const LOG_KEY = 'crash-dashboard-notifications-v1';
  const GAP_KEY = 'crash-dashboard-open-gaps-v1';

  function runtimeReading(row, fetchOk, now = Date.now(), maxAgeMs = 90000) {
    const time = Date.parse(row?.captured_at || '');
    return Boolean(fetchOk && row && row.balance !== null && row.balance !== undefined &&
      Number.isFinite(Number(row.balance)) && typeof row.bet_active === 'boolean' &&
      Number.isFinite(time) && now - time >= -10000 && now - time <= maxAgeMs);
  }

  function roundReading(rows, connected, now = Date.now(), maxAgeMs = 120000) {
    const latest = (rows || []).reduce((best, row) => {
      const id = Number(row?.round_id);
      return id >= ROUND_MIN && id <= ROUND_MAX && (!best || id > Number(best.round_id)) ? row : best;
    }, null);
    const time = Date.parse(latest?.captured_at || '');
    return Boolean(connected && Number.isFinite(time) && now - time >= -10000 && now - time <= maxAgeMs);
  }

  function recentGaps(rows, span = 300, stableTail = 5) {
    const ids = [...new Set((rows || []).map(row => Number(row?.round_id)).filter(id => Number.isInteger(id) && id >= ROUND_MIN && id <= ROUND_MAX))].sort((a, b) => a - b);
    if (ids.length < 2) return [];
    const end = ids.at(-1) - stableTail;
    const start = Math.max(ids[0], end - span + 1);
    const present = new Set(ids);
    const missing = [];
    for (let id = start; id <= end; id++) if (!present.has(id)) missing.push(id);
    return missing;
  }

  function gapChanges(previous, current, rows) {
    const present = new Set((rows || []).map(row => Number(row?.round_id)));
    const prior = new Set(previous || []);
    const detected = (current || []).filter(id => !prior.has(id));
    const filled = [...prior].filter(id => present.has(id));
    const open = [...new Set([...(previous || []), ...(current || [])])].filter(id => !present.has(id)).sort((a, b) => a - b).slice(-500);
    return { detected, filled, open };
  }

  function gapLabel(ids) {
    if (!ids.length) return '';
    if (ids.length > 8) return `${ids.length} rodadas (IDs ${ids[0]}–${ids.at(-1)})`;
    return `rodada${ids.length > 1 ? 's' : ''} ${ids.join(', ')}`;
  }

  function mount() {
    const button = document.querySelector('#enableAlerts');
    const header = document.querySelector('.top');
    if (!button || !header || !root.crashTelemetryInput) return;
    const readJson = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
    const writeJson = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage unavailable. */ } };
    let entries = readJson(LOG_KEY, []);
    if (!Array.isArray(entries)) entries = [];
    entries = entries.filter(item => item && typeof item.message === 'string').slice(0, 80);
    let openGaps = readJson(GAP_KEY, []);
    if (!Array.isArray(openGaps)) openGaps = [];
    openGaps = openGaps.filter(Number.isInteger);
    let roundState, runtimeState, lastGapScan = 0;

    button.textContent = '';
    button.className = 'alert-button notification-trigger';
    button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg><span class="notification-count" hidden></span>';
    button.title = 'Notificações';
    button.setAttribute('aria-label', 'Abrir notificações');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', 'notificationPanel');

    const panel = document.createElement('section');
    panel.id = 'notificationPanel';
    panel.className = 'notification-panel';
    panel.hidden = true;
    panel.setAttribute('aria-label', 'Histórico de notificações');
    panel.innerHTML = '<div class="notification-head"><strong>Notificações</strong><button type="button" class="notification-close" aria-label="Fechar notificações">×</button></div><div class="notification-list" role="list"></div><div class="notification-foot">Histórico deste dispositivo, registrado com o painel aberto.</div>';
    header.append(panel);
    const list = panel.querySelector('.notification-list');
    const formatter = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

    function renderList() {
      list.replaceChildren();
      if (!entries.length) {
        const empty = document.createElement('p');
        empty.className = 'notification-empty';
        empty.textContent = 'Nenhum evento registrado.';
        list.append(empty);
      }
      for (const item of entries) {
        const row = document.createElement('div');
        row.className = `notification-item ${item.kind === 'ok' ? 'ok' : item.kind === 'warn' ? 'warn' : 'info'}`;
        row.setAttribute('role', 'listitem');
        const message = document.createElement('span');
        message.textContent = item.message;
        const time = document.createElement('time');
        time.dateTime = item.at;
        time.textContent = formatter.format(new Date(item.at));
        row.append(message, time);
        list.append(row);
      }
      const unread = entries.filter(item => !item.read).length;
      const badge = button.querySelector('.notification-count');
      badge.hidden = unread === 0;
      badge.textContent = unread > 9 ? '9+' : String(unread);
      button.setAttribute('aria-label', unread ? `Abrir notificações: ${unread} não lidas` : 'Abrir notificações');
    }

    function notify(message, kind = 'info') {
      const latest = entries[0];
      if (latest?.message === message && Date.now() - Date.parse(latest.at) < 60000) return;
      entries.unshift({ message, kind, at: new Date().toISOString(), read: !panel.hidden });
      entries = entries.slice(0, 80);
      writeJson(LOG_KEY, entries);
      renderList();
    }
    root.crashDashboardNotify = notify;

    function close() { panel.hidden = true; button.setAttribute('aria-expanded', 'false'); }
    button.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      button.setAttribute('aria-expanded', String(!panel.hidden));
      if (!panel.hidden) { entries.forEach(item => { item.read = true; }); writeJson(LOG_KEY, entries); renderList(); }
    });
    panel.querySelector('.notification-close').addEventListener('click', close);
    document.addEventListener('pointerdown', event => { if (!panel.hidden && !panel.contains(event.target) && !button.contains(event.target)) close(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) close(); });

    function tick() {
      const feed = root.crashTelemetryInput();
      const now = Date.now();
      if (feed.roundAttempted) {
        const next = roundReading(feed.rows, feed.connected, now);
        if (roundState !== next) {
          if (next) { if (roundState === false) notify('Coleta de rodadas voltou a atualizar.', 'ok'); }
          else notify('Rodadas desatualizadas; verifique o coletor e a sincronização.', 'warn');
          roundState = next;
        }
      }
      if (feed.runtimeAttempted) {
        const next = runtimeReading(feed.runtime, feed.runtimeFetchOk, now);
        if (runtimeState !== next) {
          if (next) { if (runtimeState === false) notify('Leitura de saldo e apostas voltou a atualizar.', 'ok'); }
          else notify('Leitura de saldo ou apostas desatualizada.', 'warn');
          runtimeState = next;
        }
      }
      if (feed.rows?.length > 100 && now - lastGapScan > 30000) {
        lastGapScan = now;
        const changes = gapChanges(openGaps, recentGaps(feed.rows), feed.rows);
        if (changes.detected.length) notify(`Lacuna detectada: ${gapLabel(changes.detected)}.`, 'warn');
        if (changes.filled.length) notify(`Lacuna preenchida: ${gapLabel(changes.filled)}.`, 'ok');
        openGaps = changes.open;
        writeJson(GAP_KEY, openGaps);
      }
    }
    renderList();
    tick();
    setInterval(tick, 5000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  }

  return { runtimeReading, roundReading, recentGaps, gapChanges, mount };
});
