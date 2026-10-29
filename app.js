'use strict';

const STORAGE = {
  VISITS: 'visitas.visits',
  URL: 'visitas.supabaseUrl',
  KEY: 'visitas.supabaseKey'
};
const DEFAULT_SUPABASE = {
  URL: 'https://lzdsffycxtwmgeycsbbj.supabase.co',
  KEY: 'sb_publishable_En3Z1O9De545ef8379n2hg_xQR_cimh'
};

const LINE_EDITOR_ROLES = {
  'Linha Leve': 'Editor',
  'Linha Intermediária': 'Editor',
  'Linha Pesada': 'Editor'
};

let visits = [];
let sb = null;
let session = null;
let profile = null;
let appUsers = [];
let editingId = null;
let reviewingId = null;
let aiAbortController = null;
let deferredInstall = null;
let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
let calendarSelectedDate = todayStr();
const nowTime = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDate = (s) => (s ? s.split('-').reverse().join('/') : '');
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
const badge = (s) => `<span class="badge badge-${esc(s.replace(/ /g, '-'))}">${esc(s)}</span>`;

/* ---------- Estado de permissão ---------- */
const isAdmin = () => !!session && profile?.role === 'Administrador';
const canSchedule = () => !!session && (isAdmin() || profile?.role === 'Vendas');
const canEdit = () => !!session && ['Editor', 'Administrador', 'Vendas'].includes(profile?.role);
const canEditVisit = (visit) => canEdit() && (isAdmin()
  || (profile?.role === 'Editor' && profile.line === visit?.line
    && (requestStatus(visit) === 'Aprovada'
      || (['Pendente', 'Recusada', 'Nova data sugerida'].includes(requestStatus(visit))
        && visit?.requestedByEmail === profile?.email)))
  || (profile?.role === 'Vendas' && profile.line === visit?.line
    && ['Pendente', 'Recusada', 'Nova data sugerida'].includes(requestStatus(visit))
    && visit?.requestedByEmail === profile?.email));
const canReview = (visit) => !!session && (profile?.role === 'Administrador'
  || (profile?.role === LINE_EDITOR_ROLES[visit?.line] && profile?.line === visit?.line
    && visit?.requestedByEmail !== profile?.email));
const canManageTestWork = (visit) => !!session && (profile?.role === 'Administrador'
  || (profile?.role === 'Editor' && profile?.line === visit?.line));
const canManageUsers = () => !!sb && profile?.role === 'Administrador';

function refreshPermissionVisibility() {
  const accessTab = document.querySelector('.sidebar-link[data-tab="usuarios"]');
  accessTab.classList.toggle('hidden', !canManageUsers());
  if (!canManageUsers() && !$('tab-usuarios').classList.contains('hidden')) switchTab('visitas');
  $('readonlyBanner').classList.add('hidden');
  $('localBanner').classList.add('hidden');
  $('newVisitBtn').classList.remove('hidden');
  $('openAiImportBtn').classList.remove('hidden');
  if (session && !canSchedule()) {
    $('newVisitBtn').classList.add('hidden');
    $('openAiImportBtn').classList.add('hidden');
  }
}

function applyRole() {
  document.body.classList.toggle('readonly', !canEdit());
  refreshPermissionVisibility();
  $('currentUserLabel').textContent = session?.user?.email ? `${session.user.email} (${profile?.role || 'sem perfil'})` : (sb ? 'Visitante' : 'Local');
  $('authBtn').textContent = session ? 'Sair' : 'Entrar';
  $('authBtn').classList.toggle('hidden', !sb);
  $('localBanner').classList.add('hidden');
  $('authBtn').disabled = false;
  $('openAiImportBtn').classList.toggle('hidden', !!session && !canSchedule());
  $('vLine').disabled = !!sb && ['Editor', 'Vendas'].includes(profile?.role);
  if (['Editor', 'Vendas'].includes(profile?.role) && profile.line) {
    $('vLine').value = profile.line;
  }
}

function updateRefMonth() {
  const [y, m] = ($('fPeriod').value || '').split('-');
  const names = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  const label = y && m ? `${names[Number(m) - 1]}/${y}` : 'Todos os meses';
  $('headerReferenceMonth').textContent = label;
  $('lblRefMonth').textContent = label;
}

function setSync(ok, label) {
  $('syncIndicator').classList.toggle('sync-ok', ok);
  $('syncIndicator').classList.toggle('sync-error', !ok);
  $('syncLabel').textContent = label;
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), 3000);
}

/* ---------- Persistência ---------- */
function saveLocal() {
  localStorage.setItem(STORAGE.VISITS, JSON.stringify(visits));
}

function loadLocal() {
  try { visits = JSON.parse(localStorage.getItem(STORAGE.VISITS) || '[]'); } catch { visits = []; }
}

async function initSupabase() {
  const url = localStorage.getItem(STORAGE.URL) || DEFAULT_SUPABASE.URL;
  const key = localStorage.getItem(STORAGE.KEY) || DEFAULT_SUPABASE.KEY;
  sb = null;
  session = null;
  if (!url || !key || !window.supabase?.createClient) {
    setSync(false, 'Modo local');
    loadLocal();
    return;
  }
  sb = window.supabase.createClient(url, key);
  sb.auth.onAuthStateChange((event, s) => {
    session = s;
    profile = null;
    if (event === 'PASSWORD_RECOVERY') {
      $('passwordResetError').textContent = '';
      openModal('passwordResetModal');
      return;
    }
    setTimeout(() => { void (async () => {
      if (s?.user) await loadProfile(s.user);
      applyRole();
      renderAll();
    })(); }, 0);
  });
  const { data } = await sb.auth.getSession();
  session = data.session;
  if (session?.user) await loadProfile(session.user);
  if (new URLSearchParams(window.location.hash.slice(1)).get('type') === 'recovery') {
    $('passwordResetError').textContent = '';
    openModal('passwordResetModal');
  }
  await pullRemote();
  sb.channel('visits-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'visits' }, pullRemote)
    .subscribe();
}

async function loadProfile(user) {
  if (!sb || !user?.email || user.is_anonymous) { profile = null; return; }
  const { data, error } = await sb.from('visits_user_roles')
    .select('email,role,line').eq('email', user.email.toLowerCase()).maybeSingle();
  if (error) {
    profile = null;
    toast('Não foi possível verificar seu perfil agora. Recarregue quando a conexão voltar.');
    return;
  }
  if (!data) {
    profile = null;
    await sb.auth.signOut();
    toast('Esta conta ainda não possui perfil no Controle de Visitas.');
    return;
  }
  profile = data;
  if (canManageUsers()) await loadUsers();
}

async function pullRemote() {
  const { data, error } = await sb.from('visits').select('id,data');
  if (error) {
    if (!session) {
      visits = [];
      setSync(false, 'Entre para sincronizar');
    } else {
      setSync(false, 'Sem conexão');
      loadLocal();
    }
  } else {
    visits = data.map((r) => ({ ...r.data, id: r.id }));
    saveLocal();
    setSync(true, 'Sincronizado');
  }
  renderAll();
}

async function persist(visit, { insert = false } = {}) {
  saveLocal();
  if (!sb) return true;
  const updatedAt = new Date().toISOString();
  const query = insert
    ? sb.from('visits').insert({ id: visit.id, data: visit, updated_at: updatedAt })
    : sb.from('visits').update({ data: visit, updated_at: updatedAt }).eq('id', visit.id);
  const { error } = await query.select('id').single();
  if (error) {
    toast('Erro ao sincronizar: ' + error.message);
    setSync(false, 'Erro de sync');
    return false;
  }
  setSync(true, 'Sincronizado');
  return true;
}

async function removeRemote(id) {
  saveLocal();
  if (!sb) return;
  const { error } = await sb.from('visits').delete().eq('id', id);
  if (error) toast('Erro ao excluir: ' + error.message);
}

/* ---------- Filtros ---------- */
function filtered() {
  const period = $('fPeriod').value;
  const q = $('fSearch').value.trim().toLowerCase();
  const st = $('fStatus').value;
  const rs = $('fReason').value;
  return visits
    .filter((v) => (!period || v.date.startsWith(period))
      && (!st || v.status === st)
      && (!rs || v.reason === rs)
      && (!$('fTestType').value || testType(v) === $('fTestType').value)
      && (!$('fLine').value || v.line === $('fLine').value)
      && (!$('fApproval').value || requestStatus(v) === $('fApproval').value)
      && (!q || [v.client, v.company, v.host, v.phone, v.machineRequested, v.material, v.factoryResponsible, v.notes, v.testPreparationNotes, v.testResult].some((x) => (x || '').toLowerCase().includes(q))))
    .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
}

function requestStatus(visit) { return visit.approvalStatus || 'Aprovada'; }
function testType(visit) { return visit.testType || 'Demonstração com cliente'; }
function isActiveTest(visit) { return !['Concluída', 'Cancelada', 'Não compareceu'].includes(visit.status); }

function approvalBadge(status) {
  const classes = { Pendente: 'badge-pending', Aprovada: 'badge-approved', Recusada: 'badge-rejected', 'Nova data sugerida': 'badge-reschedule' };
  return `<span class="badge ${classes[status] || ''}">${esc(status)}</span>`;
}

function fillReasonFilter() {
  const cur = $('fReason').value;
  const reasons = [...new Set([...[...$('vReason').options].map((o) => o.value), ...visits.map((v) => v.reason)])];
  $('fReason').innerHTML = '<option value="">Todos</option>' + reasons.map((r) => `<option>${esc(r)}</option>`).join('');
  $('fReason').value = reasons.includes(cur) ? cur : '';
}

/* ---------- Render: lista ---------- */
function actionButtons(v) {
  const b = [];
  const approval = requestStatus(v);
  if (approval === 'Pendente' && canReview(v)) b.push(`<button class="btn-delta btn-indigo btn-sm" data-act="review" data-id="${esc(v.id)}">Analisar</button>`);
  if (canEditVisit(v) || (!session && sb)) b.push(`<button class="btn-delta btn-slate btn-sm" data-act="edit" data-id="${esc(v.id)}">${canEditVisit(v) ? 'Editar teste' : 'Entrar para editar'}</button>`);
  if (approval === 'Aprovada' && isActiveTest(v) && canManageTestWork(v)) b.push(`<button class="btn-delta btn-emerald btn-sm" data-act="work" data-id="${esc(v.id)}">Atualizar teste</button>`);
  if (isAdmin()) b.push(`<button class="btn-delta btn-rose btn-sm" data-act="del" data-id="${esc(v.id)}" aria-label="Excluir solicitação">Excluir</button>`);
  return `<div class="row-actions">${b.join('')}</div>`;
}

function renderTable() {
  const list = filtered();
  $('visitsBody').innerHTML = list.map((v) => `
    <tr>
      <td>${esc(fmtDate(v.date))} ${esc(v.time)}</td>
      <td>${testType(v) === 'Interno' ? '<span class="test-type-badge internal">Interno</span>' : '<span class="test-type-badge customer">Com cliente</span>'}</td>
      <td><strong>${esc(v.client || (testType(v) === 'Interno' ? 'Teste interno' : v.company))}</strong>${v.phone ? `<br><small>${esc(v.phone)}</small>` : ''}${v.testResult ? '<br><small class="result-preview">Resultado registrado</small>' : ''}</td>
      <td>${esc(v.line || '—')}</td>
      <td>${esc(v.company)}</td>
      <td>${esc(v.reason)}</td>
      <td>${esc(v.host)}</td>
      <td>${esc(v.commercialResponsible || '—')}</td>
      <td>${esc(v.factoryResponsible || '—')}${v.factoryParticipants?.length ? `<br><small>Acompanham: ${esc(v.factoryParticipants.join(', '))}</small>` : ''}</td>
      <td>${esc(v.checkIn || '—')}</td>
      <td>${esc(v.checkOut || '—')}</td>
      <td>${badge(v.status)}</td>
      <td>${approvalBadge(requestStatus(v))}${v.approvalReason ? `<br><small>${esc(v.approvalReason)}</small>` : ''}${v.factoryNote ? `<br><small>${esc(v.factoryNote)}</small>` : ''}${v.suggestedDate ? `<br><small>Sugerida: ${esc(fmtDate(v.suggestedDate))} ${esc(v.suggestedTime || '')}</small>` : ''}</td>
      <td>${actionButtons(v)}</td>
    </tr>`).join('');
  $('emptyMsg').classList.toggle('hidden', list.length > 0);

  const count = (s) => list.filter((v) => requestStatus(v) === 'Aprovada' && v.status === s).length;
  $('summaryCards').innerHTML = [
    ['Total de testes', list.length], ['Aguardando aprovação', list.filter((v) => requestStatus(v) === 'Pendente').length], ['Agendados', count('Agendada')], ['Em preparação', count('Preparação')], ['Em execução', count('Em andamento')],
    ['Concluídas', count('Concluída')], ['Canceladas / faltas', count('Cancelada') + count('Não compareceu')]
  ].map(([l, n]) => `<div class="stat"><span>${l}</span><strong>${n}</strong></div>`).join('');
}

/* ---------- Render: agenda ---------- */
function agendaFact(label, value, emphasis = false) {
  return `<div class="agenda-fact${emphasis ? ' agenda-fact-emphasis' : ''}"><span>${esc(label)}</span><strong>${esc(value || '—')}</strong></div>`;
}

function agendaItem(v) {
  const kindLabel = testType(v) === 'Interno' ? 'Teste interno' : 'Demonstração com cliente';
  return `<div class="agenda-item ${testType(v) === 'Interno' ? 'agenda-item-internal' : 'agenda-item-customer'}">
    <div class="agenda-item-heading"><h4><span class="agenda-time">${esc(v.time || '—')}</span>${esc(v.client || v.company || 'Teste interno')}</h4>${approvalBadge(requestStatus(v))}</div>
    <div class="agenda-facts">
      ${agendaFact('Tipo de teste', kindLabel)}
      ${agendaFact('Cliente', v.client || (testType(v) === 'Interno' ? 'Teste interno' : v.company), true)}
      ${agendaFact('Solicitado por', v.requestedByName || v.requestedByEmail || '—')}
      ${v.salesParticipants?.length ? agendaFact('Vendedores acompanhantes', v.salesParticipants.join(', ')) : ''}
      ${v.company ? agendaFact('Empresa', v.company) : ''}
      ${agendaFact('Máquina', v.machineRequested || v.reason, true)}
      ${agendaFact('Linha', v.line)}
      ${agendaFact('Material', [v.material, v.materialThickness].filter(Boolean).join(' · '))}
      ${agendaFact('Teste realizado por', 'Fábrica')}
      ${agendaFact('Responsável da produção', v.factoryResponsible || 'A definir')}
      ${v.factoryParticipants?.length ? agendaFact('Outros acompanhantes', v.factoryParticipants.join(', ')) : ''}
      ${testType(v) === 'Demonstração com cliente' ? agendaFact('Atendimento ao cliente', v.host || 'A definir') : ''}
      ${agendaFact('Responsável comercial', v.commercialResponsible || 'A definir')}
      ${agendaFact('Status do teste', v.status)}
    </div>
    ${requestStatus(v) === 'Nova data sugerida' && v.suggestedDate && v.suggestedTime
      ? `<div class="schedule-comparison"><p class="schedule-original">Agendamento original <strong>${esc(fmtDate(v.date))} às ${esc(v.time)}</strong></p><p class="schedule-suggested">Proposta da fábrica <strong>${esc(fmtDate(v.suggestedDate))} às ${esc(v.suggestedTime)}</strong></p></div>`
      : `<p class="agenda-date">Data e horário: <strong>${esc(fmtDate(v.date))} às ${esc(v.time)}</strong></p>`}
    ${v.status === 'Preparação' ? `<p class="attention-note agenda-note">Preparação em aberto: ${(v.preparationChecklist || []).length} de 5 itens concluídos</p>` : ''}
    ${v.testPreparationNotes ? `<p class="agenda-note">Preparação: ${esc(v.testPreparationNotes)}</p>` : ''}
    ${v.testResult ? `<p class="agenda-note">Resultado: ${esc(v.testResult)}</p>` : ''}
    ${v.approvalReason ? `<p class="agenda-note">Motivo: ${esc(v.approvalReason)}</p>` : ''}${v.factoryNote ? `<p class="agenda-note">Observação da fábrica: ${esc(v.factoryNote)}</p>` : ''}
    <div>${actionButtons(v)}</div>
  </div>`;
}

function renderAgenda() {
  const t = todayStr();
  const today = visits.filter((v) => v.date === t && v.status !== 'Cancelada').sort((a, b) => a.time.localeCompare(b.time));
  const allVisits = [...visits].sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  const preparing = visits.filter((v) => v.status === 'Preparação');
  $('agendaStats').innerHTML = [
    ['Todos os testes', visits.length], ['Testes hoje', today.length], ['Em preparação', preparing.length]
  ].map(([label, value]) => `<div class="stat ${label === 'Atrasados' && value ? 'stat-alert' : ''}"><span>${label}</span><strong>${value}</strong></div>`).join('');
  $('agendaAllVisits').innerHTML = allVisits.map(agendaItem).join('') || '<p class="hint">Nenhum teste cadastrado.</p>';
}

function renderMonthCalendar() {
  const monthLabel = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(calendarMonth);
  $('calendarMonthLabel').textContent = monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1);
  const grid = $('calendarGrid');
  grid.querySelectorAll('.calendar-day').forEach((cell) => cell.remove());
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = todayStr();
  const monthVisits = visits.filter((visit) => visit.date?.startsWith(`${year}-${pad(month + 1)}`));
  const byDate = new Map();
  monthVisits.forEach((visit) => {
    if (!byDate.has(visit.date)) byDate.set(visit.date, []);
    byDate.get(visit.date).push(visit);
  });
  for (const day of byDate.values()) day.sort((a, b) => (a.time || '').localeCompare(b.time || ''));

  for (let index = 0; index < firstWeekday + daysInMonth; index += 1) {
    const dayNumber = index - firstWeekday + 1;
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'calendar-day';
    if (dayNumber < 1 || dayNumber > daysInMonth) {
      cell.classList.add('calendar-day-outside');
      cell.disabled = true;
      cell.setAttribute('aria-hidden', 'true');
    } else {
      const date = `${year}-${pad(month + 1)}-${pad(dayNumber)}`;
      const dayVisits = byDate.get(date) || [];
      if (date === today) cell.classList.add('calendar-day-today');
      if (date === calendarSelectedDate) cell.classList.add('calendar-day-selected');
      cell.dataset.calendarDate = date;
      cell.setAttribute('aria-label', `${fmtDate(date)}, ${dayVisits.length} testes`);
      cell.innerHTML = `<span class="calendar-day-number">${dayNumber}</span>${dayVisits.slice(0, 2).map((visit) => `<span class="calendar-event ${testType(visit) === 'Interno' ? 'calendar-event-internal' : 'calendar-event-customer'}" title="${esc(visit.time || '')} · Cliente: ${esc(visit.client || visit.company || 'Teste interno')} · Máquina: ${esc(visit.machineRequested || visit.reason || 'Não definida')} · Status: ${esc(visit.status)}"><strong>${esc(visit.time || '—')}</strong> ${testType(visit) === 'Interno' ? 'INT' : 'CLI'} · ${esc(visit.client || visit.company || 'Teste')}</span>`).join('')}${dayVisits.length > 2 ? `<span class="calendar-more">+${dayVisits.length - 2} mais</span>` : ''}`;
    }
    grid.appendChild(cell);
  }

  $('calendarSelectedDate').textContent = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    .format(new Date(`${calendarSelectedDate}T12:00:00`));
  const selectedVisits = byDate.get(calendarSelectedDate) || [];
  $('calendarSelectedVisits').innerHTML = selectedVisits.map(agendaItem).join('') || '<p class="hint">Nenhum teste nesta data.</p>';
}

function changeCalendarMonth(offset) {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + offset, 1);
  const selected = new Date(`${calendarSelectedDate}T12:00:00`);
  const day = Math.min(selected.getDate(), new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate());
  calendarSelectedDate = `${calendarMonth.getFullYear()}-${pad(calendarMonth.getMonth() + 1)}-${pad(day)}`;
  renderMonthCalendar();
}

/* ---------- Render: dashboard ---------- */
function bars(el, entries) {
  const top = entries.sort((a, b) => b[1] - a[1]).slice(0, 8);
  const max = Math.max(1, ...top.map((e) => e[1]));
  $(el).innerHTML = top.map(([l, n]) => `<div class="bar-row"><span class="bar-label" title="${esc(l)}">${esc(l)}</span><div class="bar-track"><div class="bar-fill" style="width:${(n / max) * 100}%"></div></div><strong>${n}</strong></div>`).join('')
    || '<p class="hint">Sem dados.</p>';
}

const tally = (list, fn) => { const m = new Map(); list.forEach((v) => { const k = fn(v); m.set(k, (m.get(k) || 0) + 1); }); return [...m.entries()]; };

function minutesBetween(a, b) {
  const [h1, m1] = a.split(':').map(Number);
  const [h2, m2] = b.split(':').map(Number);
  return (h2 * 60 + m2) - (h1 * 60 + m1);
}

function renderDashboard() {
  const p = $('dPeriod').value;
  const list = visits.filter((v) => !p || v.date.startsWith(p));
  const approved = list.filter((v) => requestStatus(v) === 'Aprovada');
  const done = approved.filter((v) => v.status === 'Concluída' && v.checkIn && v.checkOut);
  const durations = done.map((v) => minutesBetween(v.checkIn, v.checkOut)).filter((m) => m >= 0);
  const avg = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
  const noShow = approved.filter((v) => v.status === 'Não compareceu').length;
  const inside = visits.filter((v) => requestStatus(v) === 'Aprovada' && v.status === 'Em andamento').length;
  const days = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

  $('dashCards').innerHTML = [
    ['Visitas no período', list.length], ['Na empresa agora', inside],
    ['Duração média', avg ? `${avg} min` : '—'], ['Não compareceram', noShow],
    ['Clientes únicos', new Set(list.map((v) => (v.company || '').trim().toLowerCase()).filter(Boolean)).size]
  ].map(([l, n]) => `<div class="stat"><span>${l}</span><strong>${esc(n)}</strong></div>`).join('');

  bars('chartReason', tally(list, (v) => v.reason));
  bars('chartHost', tally(list, (v) => v.host));
  bars('chartClient', tally(list, (v) => v.company));
  bars('chartWeekday', tally(list, (v) => days[new Date(v.date + 'T12:00:00').getDay()]));
}

function renderAll() {
  updateRefMonth();
  fillReasonFilter();
  renderTable();
  renderAgenda();
  renderMonthCalendar();
  renderDashboard();
  applyRole();
}

/* ---------- Ações ---------- */
function switchTab(tab) {
  if (tab === 'usuarios' && !canManageUsers()) {
    if (!session) openModal('authModal');
    return;
  }
  document.querySelectorAll('.sidebar-link').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  ['visitas', 'agenda', 'calendario', 'dashboard', 'usuarios'].forEach((t) => $('tab-' + t).classList.toggle('hidden', t !== tab));
}

function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }

function participantNames(value) {
  const text = Array.isArray(value) ? value.join(', ') : String(value || '');
  return [...new Set(text.split(',').map((name) => name.trim()).filter(Boolean))];
}

function openVisitModal(id) {
  if (!canEdit()) { openModal('authModal'); return; }
  if (!id && !canSchedule()) { toast('Somente o responsável comercial da linha pode agendar testes.'); return; }
  if (id && !canEditVisit(visits.find((visit) => visit.id === id))) { toast('Você não pode alterar este pedido.'); return; }
  editingId = id || null;
  const v = visits.find((x) => x.id === id) || {};
  $('visitModalTitle').textContent = id ? 'Editar teste' : 'Agendar teste';
  $('vTestType').value = v.testType || 'Demonstração com cliente';
  $('vClient').value = v.client || '';
  $('vCompany').value = v.company || '';
  $('vPhone').value = v.phone || '';
  $('vLine').value = v.line || '';
  if (['Editor', 'Vendas'].includes(profile?.role) && profile.line) $('vLine').value = profile.line;
  $('vLine').disabled = !!sb && ['Editor', 'Vendas'].includes(profile?.role);
  $('vCommercial').value = v.commercialResponsible || '';
  $('vFactory').value = v.factoryResponsible || '';
  $('visitAiStatus').textContent = '';
  document.querySelectorAll('#visitForm .ai-missing-field').forEach((field) => field.classList.remove('ai-missing-field'));
  $('factoryParticipantsGroup').classList.toggle('hidden', profile?.role === 'Vendas');
  $('vSalesParticipants').value = participantNames(v.salesParticipants).join(', ');
  $('vFactoryParticipants').value = participantNames(v.factoryParticipants).join(', ');
  $('vMachine').value = v.machineRequested || '';
  $('vMaterial').value = v.material || '';
  $('vThickness').value = v.materialThickness || '';
  $('vHost').value = v.host || '';
  $('vDate').value = v.suggestedDate || v.date || todayStr();
  $('vTime').value = v.suggestedTime || v.time || nowTime();
  if (v.reason && ![...$('vReason').options].some((o) => o.value === v.reason)) $('vReason').add(new Option(v.reason));
  $('vReason').value = v.reason || $('vReason').options[0].value;
  $('vStatus').value = v.status || 'Agendada';
  $('vNotes').value = v.notes || '';
  $('visitExecutionStatusGroup').classList.add('hidden');
  updateTestTypeFields();
  $('saveVisitBtn').textContent = id ? 'Atualizar teste' : 'Enviar para aprovação fabril';
  openModal('visitModal');
}

function updateTestTypeFields() {
  const isCustomerDemo = $('vTestType').value === 'Demonstração com cliente';
  document.querySelectorAll('.customer-field').forEach((field) => field.classList.toggle('hidden', !isCustomerDemo));
  $('vClient').required = isCustomerDemo;
  $('vCompany').required = isCustomerDemo;
  $('vHost').required = isCustomerDemo;
  if (!isCustomerDemo) {
    ['vClient', 'vCompany', 'vPhone', 'vHost'].forEach((id) => { $(id).value = ''; });
  }
}

async function extractVisitWithAi(sourceText, pdfFile, signal) {
  if (!sb || !session || !profile || !['Administrador', 'Vendas'].includes(profile.role)) {
    throw new Error('Entre com a conta Vendas responsável pela linha ou com um Administrador para usar a IA.');
  }
  const body = { text: sourceText, referenceDate: todayStr() };
  if (pdfFile) {
    if (!sb.storage) throw new Error('Supabase Storage não está disponível.');
    const path = `ai-imports/${profile.email}/${uid()}.pdf`;
    const { error: uploadError } = await sb.storage.from('visits-ai-inbox')
      .upload(path, pdfFile, { contentType: 'application/pdf', upsert: false });
    if (uploadError) throw new Error('Não foi possível enviar o PDF temporário. Verifique a configuração do armazenamento.');
    body.pdfPath = path;
  }
  try {
    const { data, error } = await sb.functions.invoke('visits-read-intake', { body, signal });
    if (error) {
      let detail = '';
      const response = error.context;
      if (response instanceof Response) {
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const payload = await response.clone().json().catch(() => null);
          detail = payload?.error || payload?.message || '';
        }
        if (!detail) detail = (await response.clone().text().catch(() => '')).trim();
        if (detail.length > 500) detail = `${detail.slice(0, 500)}...`;
        const status = response.status ? `HTTP ${response.status}: ` : '';
        throw new Error(`${status}${detail || error.message || 'Não foi possível interpretar as informações.'}`);
      }
      throw new Error(error.message || 'Não foi possível interpretar as informações.');
    }
    if (!data?.fields) throw new Error('A função respondeu, mas não retornou os campos extraídos. Verifique se a Edge Function foi republicada.');
    return data.fields;
  } finally {
    if (body.pdfPath) await sb.storage.from('visits-ai-inbox').remove([body.pdfPath]).catch(() => {});
  }
}

function applyAiVisitFields(data) {
  $('vTestType').value = 'Demonstração com cliente';
  updateTestTypeFields();
  const fields = {
    vClient: data.client,
    vCompany: data.company,
    vPhone: data.phone,
    vCommercial: data.commercialResponsible,
    vSalesParticipants: data.salesParticipants,
    vMachine: data.machineRequested,
    vMaterial: data.material,
    vThickness: data.materialThickness,
    vHost: data.host,
    vDate: data.date,
    vTime: data.time,
    vNotes: data.notes
  };
  for (const [id, value] of Object.entries(fields)) if (value) $(id).value = value;
  if (['Editor', 'Vendas'].includes(profile?.role) && profile.line) $('vLine').value = profile.line;
  else if (data.line && [...$('vLine').options].some((option) => option.value === data.line)) $('vLine').value = data.line;
  if (data.reason && [...$('vReason').options].some((option) => option.value === data.reason)) $('vReason').value = data.reason;
}

async function processAiSource() {
  const sourceText = $('aiSourceText').value.trim();
  const pdfFile = $('aiSourcePdf').files[0];
  $('aiImportStatus').textContent = '';
  if (!canSchedule()) { if (!session) { closeModal('aiImportModal'); openModal('authModal'); } else $('aiImportStatus').textContent = 'Somente o responsável comercial da linha pode abrir pedidos.'; return; }
  if (!sb || !session) { $('aiImportStatus').textContent = 'Configure o Supabase e entre com sua conta para usar a IA.'; return; }
  if (!sourceText && !pdfFile) { $('aiImportStatus').textContent = 'Cole o texto ou selecione um PDF.'; return; }
  if (pdfFile && pdfFile.size > 4 * 1024 * 1024) { $('aiImportStatus').textContent = 'O PDF deve ter no máximo 4 MB.'; return; }
  $('parseWithAiBtn').disabled = true;
  $('parseWithAiBtn').textContent = 'Lendo informações...';
  aiAbortController = new AbortController();
  try {
    const fields = await extractVisitWithAi(sourceText, pdfFile, aiAbortController.signal);
    closeModal('aiImportModal');
    openVisitModal();
    applyAiVisitFields(fields);
    const missingFields = [];
    if (!fields.line) missingFields.push('linha');
    if (!fields.company) missingFields.push('empresa do cliente');
    if (!fields.host) missingFields.push('quem receberá o cliente');
    if (!fields.date) missingFields.push('data');
    if (!fields.time) missingFields.push('horário');
    const requiredIds = { line: 'vLine', company: 'vCompany', host: 'vHost', date: 'vDate', time: 'vTime' };
    for (const [field, id] of Object.entries(requiredIds)) {
      if (!fields[field]) $(id).classList.add('ai-missing-field');
    }
    $('visitAiStatus').textContent = missingFields.length
      ? `A IA preencheu os dados encontrados. Complete os campos destacados: ${missingFields.join(', ')}.`
      : 'A IA preencheu os dados encontrados. Confira tudo antes de enviar.';
  } catch (error) {
    $('aiImportStatus').textContent = error.name === 'AbortError' ? 'Leitura cancelada.' : (error.message || 'Falha ao interpretar as informações.');
  } finally {
    aiAbortController = null;
    $('parseWithAiBtn').disabled = false;
    $('parseWithAiBtn').textContent = '✨ Ler informações';
  }
}

async function submitVisit(e) {
  e.preventDefault();
  if (!canEdit()) return;
  const prev = visits.find((x) => x.id === editingId);
  if ((!prev && !canSchedule()) || (prev && !canEditVisit(prev))) return;
  const v = {
    ...(prev || { id: uid(), createdAt: new Date().toISOString() }),
    testType: $('vTestType').value,
    client: $('vTestType').value === 'Interno' ? '' : $('vClient').value.trim(),
    company: $('vTestType').value === 'Interno' ? '' : $('vCompany').value.trim(),
    phone: $('vTestType').value === 'Interno' ? '' : $('vPhone').value.trim(),
    line: $('vLine').value,
    commercialResponsible: $('vCommercial').value.trim(),
    factoryResponsible: $('vFactory').value.trim(),
    salesParticipants: participantNames($('vSalesParticipants').value),
    factoryParticipants: profile?.role === 'Vendas' && prev
      ? (Array.isArray(prev.factoryParticipants) ? prev.factoryParticipants : [])
      : participantNames($('vFactoryParticipants').value),
    machineRequested: $('vMachine').value.trim(),
    material: $('vMaterial').value.trim(),
    materialThickness: $('vThickness').value.trim(),
    host: $('vTestType').value === 'Interno' ? '' : $('vHost').value.trim(),
    date: $('vDate').value,
    time: $('vTime').value,
    reason: $('vReason').value,
    status: prev?.status || 'Agendada',
    notes: $('vNotes').value.trim(),
    testPreparationNotes: prev?.testPreparationNotes || '',
    preparationChecklist: prev?.preparationChecklist || [],
    testResult: prev?.testResult || '',
    approvalStatus: 'Pendente',
    approvalReason: '',
    factoryNote: '',
    suggestedDate: '',
    suggestedTime: '',
    requestedByEmail: prev?.requestedByEmail || profile?.email || 'local',
    requestedByName: prev?.requestedByName || profile?.email || 'Local',
    requestedAt: prev?.requestedAt || new Date().toISOString(),
    reviewedByEmail: '',
    reviewedAt: ''
  };
  if (prev && requestStatus(prev) === 'Aprovada') {
    const scheduleFields = ['testType', 'client', 'company', 'phone', 'machineRequested', 'material', 'materialThickness', 'salesParticipants', 'date', 'time', 'reason', 'host'];
    const scheduleChanged = scheduleFields.some((field) => JSON.stringify(prev[field] ?? '') !== JSON.stringify(v[field] ?? ''));
    if (scheduleChanged) {
      v.status = 'Agendada';
      v.approvalStatus = 'Pendente';
      v.approvalReason = '';
      v.factoryNote = '';
      v.suggestedDate = '';
      v.suggestedTime = '';
      v.reviewedByEmail = '';
      v.reviewedAt = '';
      v.requestedAt = new Date().toISOString();
      v.checkIn = '';
      v.checkOut = '';
    } else {
      ['status', 'approvalStatus', 'approvalReason', 'factoryNote', 'suggestedDate', 'suggestedTime', 'reviewedByEmail', 'reviewedAt', 'checkIn', 'checkOut'].forEach((field) => {
        v[field] = prev[field] ?? v[field];
      });
    }
  }
  if (prev) Object.assign(prev, v); else visits.push(v);
  closeModal('visitModal');
  renderAll();
  await persist(v, { insert: !prev });
  toast('Teste encaminhado para aprovação fabril.');
}

function updateReviewFields() {
  const decision = $('reviewDecision').value;
  const reject = decision === 'Recusada';
  const suggest = decision === 'Nova data sugerida';
  $('reviewReasonGroup').classList.toggle('hidden', !reject);
  $('reviewReason').required = reject;
  $('reviewSuggestedDateGroup').classList.toggle('hidden', !suggest);
  $('reviewSuggestedTimeGroup').classList.toggle('hidden', !suggest);
  $('reviewSuggestedDate').required = suggest;
  $('reviewSuggestedTime').required = suggest;
  $('reviewNoteGroup').classList.toggle('hidden', reject);
}

function openReviewModal(id) {
  const visit = visits.find((item) => item.id === id);
  if (!visit || !canReview(visit) || requestStatus(visit) !== 'Pendente') return;
  reviewingId = id;
  $('reviewTitle').textContent = `Analisar pedido de ${visit.client}`;
  $('reviewSummary').textContent = `${visit.line} · ${visit.machineRequested} · ${visit.material} · ${fmtDate(visit.date)} às ${visit.time}`;
  $('reviewDecision').value = 'Aprovada';
  $('reviewReason').value = '';
  $('reviewNote').value = '';
  $('reviewSuggestedDate').value = '';
  $('reviewSuggestedTime').value = '';
  updateReviewFields();
  openModal('reviewModal');
}

function openTestWorkModal(id) {
  const visit = visits.find((item) => item.id === id);
  if (!visit || !canManageTestWork(visit) || requestStatus(visit) !== 'Aprovada') return;
  reviewingId = id;
  $('testWorkTitle').textContent = `Acompanhar teste · ${visit.client || visit.company || 'Interno'}`;
  $('testWorkSummary').textContent = `${testType(visit)} · ${visit.line} · ${visit.machineRequested} · ${visit.material} · ${fmtDate(visit.date)} às ${visit.time}`;
  $('testWorkStatus').value = visit.status || 'Agendada';
  $('testPreparationNotes').value = visit.testPreparationNotes || '';
  $('testResult').value = visit.testResult || '';
  document.querySelectorAll('[name="prepChecklist"]').forEach((input) => {
    input.checked = (visit.preparationChecklist || []).includes(input.value);
  });
  openModal('testWorkModal');
}

async function submitTestWork(e) {
  e.preventDefault();
  const visit = visits.find((item) => item.id === reviewingId);
  if (!visit || !canManageTestWork(visit) || requestStatus(visit) !== 'Aprovada') return;
  const status = $('testWorkStatus').value;
  const result = $('testResult').value.trim();
  if (status === 'Concluída' && !result) {
    $('testResult').setCustomValidity('Registre o resultado antes de concluir o teste.');
    $('testResult').reportValidity();
    $('testResult').setCustomValidity('');
    return;
  }
  const previousStatus = visit.status;
  visit.status = status;
  visit.preparationChecklist = [...document.querySelectorAll('[name="prepChecklist"]:checked')].map((input) => input.value);
  visit.testPreparationNotes = $('testPreparationNotes').value.trim();
  visit.testResult = result;
  if (status === 'Em andamento' && !visit.checkIn) visit.checkIn = nowTime();
  if (status === 'Concluída' && !visit.checkOut) visit.checkOut = nowTime();
  if (previousStatus === 'Concluída' && status !== 'Concluída') visit.checkOut = '';
  closeModal('testWorkModal');
  renderAll();
  await persist(visit);
  toast(status === 'Concluída' ? 'Teste concluído e resultado registrado.' : 'Andamento do teste salvo.');
}

async function submitReview(e) {
  e.preventDefault();
  const visit = visits.find((item) => item.id === reviewingId);
  if (!visit || !canReview(visit) || requestStatus(visit) !== 'Pendente') return;
  const previous = { ...visit };
  const decision = $('reviewDecision').value;
  visit.approvalStatus = decision;
  visit.approvalReason = decision === 'Recusada' ? $('reviewReason').value.trim() : '';
  visit.factoryNote = decision === 'Aprovada' ? $('reviewNote').value.trim() : '';
  visit.suggestedDate = decision === 'Nova data sugerida' ? $('reviewSuggestedDate').value : '';
  visit.suggestedTime = decision === 'Nova data sugerida' ? $('reviewSuggestedTime').value : '';
  visit.factoryNote = decision === 'Nova data sugerida' ? $('reviewNote').value.trim() : visit.factoryNote;
  visit.reviewedByEmail = profile?.email || 'local';
  visit.reviewedAt = new Date().toISOString();
  closeModal('reviewModal');
  renderAll();
  const saved = await persist(visit);
  if (!saved) {
    Object.assign(visit, previous);
    renderAll();
    return;
  }
  if (decision === 'Aprovada') {
    const [year, month] = visit.date.split('-').map(Number);
    calendarMonth = new Date(year, month - 1, 1);
    calendarSelectedDate = visit.date;
    renderMonthCalendar();
    switchTab('calendario');
  }
  toast('Decisão da fábrica registrada.');
}

async function rowAction(act, id) {
  const v = visits.find((x) => x.id === id);
  if (!v) return;
  if (act === 'review') return openReviewModal(id);
  if (act === 'work') return openTestWorkModal(id);
  if (act === 'edit') return openVisitModal(id);
  if (act === 'del') {
    if (!isAdmin()) return;
    if (!confirm(`Excluir a visita de ${v.client}?`)) return;
    visits = visits.filter((x) => x.id !== id);
    renderAll();
    return removeRemote(id);
  }
  if (!canReview(v) || requestStatus(v) !== 'Aprovada') return;
  if (act === 'in') { v.status = 'Em andamento'; v.checkIn = nowTime(); }
  if (act === 'out') { v.status = 'Concluída'; v.checkOut = nowTime(); }
  renderAll();
  await persist(v);
}

function exportCsv() {
  const cols = ['testType', 'date', 'time', 'client', 'company', 'phone', 'line', 'machineRequested', 'material', 'materialThickness', 'reason', 'host', 'requestedByEmail', 'commercialResponsible', 'factoryResponsible', 'salesParticipants', 'factoryParticipants', 'approvalStatus', 'approvalReason', 'factoryNote', 'suggestedDate', 'suggestedTime', 'status', 'preparationChecklist', 'testPreparationNotes', 'testResult', 'checkIn', 'checkOut', 'notes'];
  const head = ['Tipo de teste', 'Data', 'Hora', 'Cliente', 'Empresa', 'Contato', 'Linha', 'Máquina', 'Material', 'Espessura / dimensões', 'Objetivo', 'Quem atenderá o cliente', 'Solicitado por', 'Responsável comercial da linha', 'Responsável da produção da linha', 'Vendedores acompanhantes', 'Outros acompanhantes da produção', 'Aprovação fabril', 'Motivo da recusa', 'Observação da fábrica', 'Data sugerida', 'Horário sugerido', 'Etapa', 'Checklist de preparação', 'Pendências de preparação', 'Resultado do teste', 'Início', 'Conclusão', 'Observações'];
  // Prefixo ' evita injeção de fórmulas ao abrir no Excel.
  const cell = (x) => { let s = String(x ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const rows = filtered().map((v) => cols.map((c) => cell(Array.isArray(v[c]) ? v[c].join(', ') : v[c])).join(';'));
  const blob = new Blob(['\ufeff' + [head.map(cell).join(';'), ...rows].join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `visitas-${todayStr()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function submitAuth(e) {
  e.preventDefault();
  $('authError').textContent = '';
  const { error } = await sb.auth.signInWithPassword({ email: $('aEmail').value.trim(), password: $('aPass').value });
  if (error) { $('authError').textContent = 'E-mail ou senha inválidos.'; return; }
  $('aPass').value = '';
  closeModal('authModal');
  toast('Sessão iniciada.');
}

async function requestPasswordReset() {
  $('authError').textContent = '';
  const email = $('aEmail').value.trim().toLowerCase();
  if (!email) {
    $('authError').textContent = 'Informe seu e-mail para receber o link de recuperação.';
    $('aEmail').focus();
    return;
  }
  const redirectTo = `${window.location.origin}${window.location.pathname}`;
  const button = $('requestPasswordResetBtn');
  button.disabled = true;
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo });
  button.disabled = false;
  if (error) {
    $('authError').textContent = error.status === 429
      ? 'O serviço limitou os pedidos de recuperação. Aguarde antes de tentar novamente; não clique várias vezes.'
      : 'Não foi possível solicitar a recuperação. Confira sua conexão e tente novamente.';
    return;
  }
  $('authError').textContent = 'Pedido enviado. Confira sua caixa de entrada e spam; abra o link neste mesmo navegador para definir a senha aqui.';
}

async function submitPasswordReset(e) {
  e.preventDefault();
  $('passwordResetError').textContent = '';
  const password = $('newPassword').value;
  if (password.length < 12) {
    $('passwordResetError').textContent = 'Use pelo menos 12 caracteres.';
    return;
  }
  if (password !== $('confirmNewPassword').value) {
    $('passwordResetError').textContent = 'As senhas não coincidem.';
    return;
  }
  $('saveNewPasswordBtn').disabled = true;
  const { error } = await sb.auth.updateUser({ password });
  $('saveNewPasswordBtn').disabled = false;
  if (error) {
    $('passwordResetError').textContent = 'Não foi possível atualizar a senha. Solicite um novo link e tente novamente.';
    return;
  }
  $('passwordResetForm').reset();
  closeModal('passwordResetModal');
  toast('Senha atualizada. Sua sessão será iniciada.');
}

async function loadUsers() {
  if (!canManageUsers()) return;
  const { data, error } = await sb.functions.invoke('visits-admin-users', { body: { action: 'list' } });
  if (error) { toast('Não foi possível carregar os usuários.'); return; }
  appUsers = data.users || [];
  renderUsers();
}

function renderUsers() {
  if (!$('usersBody')) return;
  $('usersBody').innerHTML = appUsers.map((user) => `<tr>
    <td><strong>${esc(user.email)}</strong></td><td>${esc(user.role)}</td><td>${esc(user.line || 'Todas')}</td>
    <td><div class="row-actions"><button class="btn-delta btn-slate btn-sm" data-user-edit="${esc(user.email)}">Redefinir acesso</button>${user.email !== profile?.email ? `<button class="btn-delta btn-rose btn-sm" data-user-delete="${esc(user.email)}">Excluir</button>` : ''}</div></td>
  </tr>`).join('');
  $('usersEmpty').classList.toggle('hidden', appUsers.length > 0);
}

function updateUserRoleFields() {
  const needsLine = ['Editor', 'Vendas'].includes($('uRole').value);
  $('uLineGroup').classList.toggle('hidden', !needsLine);
  $('uLine').required = needsLine;
}

function openUserModal(email = '') {
  if (!canManageUsers()) return;
  $('userForm').reset();
  $('userError').textContent = '';
  $('userModalTitle').textContent = email ? 'Redefinir acesso' : 'Adicionar usuário';
  $('saveUserBtn').textContent = email ? 'Salvar nova senha' : 'Criar acesso';
  $('uEmail').readOnly = Boolean(email);
  $('uEmail').value = email;
  const existing = appUsers.find((user) => user.email === email);
  if (existing) {
    $('uRole').value = existing.role;
    $('uLine').value = existing.line || '';
  }
  updateUserRoleFields();
  openModal('userModal');
}

async function submitUser(e) {
  e.preventDefault();
  if (!canManageUsers()) return;
  const email = $('uEmail').value.trim().toLowerCase();
  const role = $('uRole').value;
  const line = ['Editor', 'Vendas'].includes(role) ? $('uLine').value : null;
  const password = $('uPassword').value;
  $('userError').textContent = '';
  if (password.length < 12) { $('userError').textContent = 'Use uma senha com pelo menos 12 caracteres.'; return; }
  if (['Editor', 'Vendas'].includes(role) && !line) { $('userError').textContent = 'Selecione a linha de responsabilidade.'; return; }
  $('saveUserBtn').disabled = true;
  try {
    const { data, error } = await sb.functions.invoke('visits-admin-users', {
      body: { action: 'upsert', email, password, role, line }
    });
    if (error) throw error;
    closeModal('userModal');
    $('uPassword').value = '';
    await loadUsers();
    toast(data?.updated ? 'Acesso atualizado.' : 'Usuário criado.');
  } catch (error) {
    $('userError').textContent = error.message || 'Não foi possível salvar o usuário.';
  } finally {
    $('saveUserBtn').disabled = false;
  }
}

async function deleteManagedUser(email) {
  if (!canManageUsers() || !confirm(`Excluir o acesso de ${email}?`)) return;
  const { error } = await sb.functions.invoke('visits-admin-users', { body: { action: 'delete', email } });
  if (error) { toast('Não foi possível excluir o acesso.'); return; }
  await loadUsers();
  toast('Acesso excluído.');
}

async function submitConfig(e) {
  e.preventDefault();
  const url = $('cUrl').value.trim();
  const key = $('cKey').value.trim();
  if (url && !/^https:\/\/[^\s/]+/.test(url)) { toast('URL inválida (use https://).'); return; }
  if (url && key) { localStorage.setItem(STORAGE.URL, url); localStorage.setItem(STORAGE.KEY, key); }
  else { localStorage.removeItem(STORAGE.URL); localStorage.removeItem(STORAGE.KEY); }
  closeModal('configModal');
  location.reload();
}

/* ---------- Init ---------- */
function bindEvents() {
  document.querySelectorAll('.sidebar-link').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(b.dataset.close)));
  ['fPeriod', 'fSearch', 'fStatus', 'fReason', 'fLine', 'fApproval', 'fTestType'].forEach((id) => $(id).addEventListener('input', () => { updateRefMonth(); renderTable(); }));
  $('dPeriod').addEventListener('input', renderDashboard);
  $('clearFiltersBtn').addEventListener('click', () => {
    ['fSearch', 'fStatus', 'fReason', 'fLine', 'fApproval', 'fTestType'].forEach((id) => { $(id).value = ''; });
    $('fPeriod').value = '';
    updateRefMonth();
    renderTable();
  });
  $('newVisitBtn').addEventListener('click', () => openVisitModal());
  $('vTestType').addEventListener('change', updateTestTypeFields);
  ['vLine', 'vCompany', 'vHost', 'vDate', 'vTime'].forEach((id) => $(id).addEventListener('input', () => $(id).classList.remove('ai-missing-field')));
  $('openAiImportBtn').addEventListener('click', () => {
    $('aiImportStatus').textContent = '';
    openModal('aiImportModal');
  });
  $('parseWithAiBtn').addEventListener('click', processAiSource);
  $('aiSourcePdf').addEventListener('change', () => {
    $('aiPdfName').textContent = $('aiSourcePdf').files[0]?.name || 'O PDF será enviado ao serviço Gemini para leitura.';
  });
  $('exportBtn').addEventListener('click', exportCsv);
  $('visitForm').addEventListener('submit', submitVisit);
  $('testWorkForm').addEventListener('submit', submitTestWork);
  $('reviewForm').addEventListener('submit', submitReview);
  $('reviewDecision').addEventListener('change', updateReviewFields);
  $('userForm').addEventListener('submit', submitUser);
  $('uRole').addEventListener('change', updateUserRoleFields);
  $('newUserBtn').addEventListener('click', () => openUserModal());
  $('calendarPrevBtn').addEventListener('click', () => changeCalendarMonth(-1));
  $('calendarNextBtn').addEventListener('click', () => changeCalendarMonth(1));
  $('calendarTodayBtn').addEventListener('click', () => {
    const today = new Date();
    calendarMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    calendarSelectedDate = todayStr();
    renderMonthCalendar();
  });
  $('authForm').addEventListener('submit', submitAuth);
  $('requestPasswordResetBtn').addEventListener('click', requestPasswordReset);
  $('passwordResetForm').addEventListener('submit', submitPasswordReset);
  $('configForm').addEventListener('submit', submitConfig);
  $('configBtn').addEventListener('click', () => {
    $('cUrl').value = localStorage.getItem(STORAGE.URL) || DEFAULT_SUPABASE.URL;
    $('cKey').value = localStorage.getItem(STORAGE.KEY) || DEFAULT_SUPABASE.KEY;
    openModal('configModal');
  });
  $('authBtn').addEventListener('click', async () => {
    if (session) { await sb.auth.signOut(); toast('Sessão encerrada.'); } else openModal('authModal');
  });
  document.body.addEventListener('click', (e) => {
    const calendarDay = e.target.closest('[data-calendar-date]');
    if (calendarDay) {
      calendarSelectedDate = calendarDay.dataset.calendarDate;
      renderMonthCalendar();
    }
    const btn = e.target.closest('[data-act]');
    if (btn) rowAction(btn.dataset.act, btn.dataset.id);
    const editUserBtn = e.target.closest('[data-user-edit]');
    if (editUserBtn) openUserModal(editUserBtn.dataset.userEdit);
    const deleteUserBtn = e.target.closest('[data-user-delete]');
    if (deleteUserBtn) deleteManagedUser(deleteUserBtn.dataset.userDelete);
  });
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    $('installAppBtn').classList.remove('hidden');
  });
  $('installAppBtn').addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
    $('installAppBtn').classList.add('hidden');
  });
}

function startClock() {
  const tick = () => { $('clockEl').textContent = '⏱️ ' + new Date().toLocaleTimeString('pt-BR'); };
  tick();
  setInterval(tick, 1000);
}

async function init() {
  bindEvents();
  startClock();
  const d = new Date();
  $('fPeriod').value = $('dPeriod').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  loadLocal();
  renderAll();

  let splashDismissed = false;
  let splashMinimumElapsed = false;
  let bootstrapSettled = false;
  const dismissSplash = () => {
    if (splashDismissed || !splashMinimumElapsed) return;
    splashDismissed = true;
    $('brandSplash').classList.add('is-hidden');
  };
  window.setTimeout(() => {
    splashMinimumElapsed = true;
    if (bootstrapSettled) dismissSplash();
  }, 650);
  window.setTimeout(() => {
    splashMinimumElapsed = true;
    dismissSplash();
  }, 1800);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  void initSupabase()
    .then(() => renderAll())
    .catch((error) => {
      console.warn('Supabase initialization failed; keeping the app available offline.', error);
      loadLocal();
      setSync(false, 'Sem conexão');
      renderAll();
    })
    .finally(() => {
      bootstrapSettled = true;
      dismissSplash();
    });
}

init();
