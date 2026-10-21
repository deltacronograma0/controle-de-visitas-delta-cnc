'use strict';

const STORAGE = {
  VISITS: 'visitas.visits',
  URL: 'visitas.supabaseUrl',
  KEY: 'visitas.supabaseKey'
};

const LINE_RESPONSIBLES = {
  'Linha Leve': { commercial: 'Michel - Vendas - SP', factory: 'André - Fábrica' },
  'Linha Intermediária': { commercial: 'Gustavo - Vendas - SP', factory: 'Pedro Mendes - Fábrica' },
  'Linha Pesada': { commercial: 'Victor - Vendas - SP', factory: 'Leonardo e Ana - Fábrica' }
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

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const nowTime = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDate = (s) => (s ? s.split('-').reverse().join('/') : '');
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
const badge = (s) => `<span class="badge badge-${esc(s.replace(/ /g, '-'))}">${esc(s)}</span>`;

/* ---------- Estado de permissão ---------- */
const isLocalMode = () => !sb;
const isAdmin = () => isLocalMode() || profile?.role === 'Administrador';
const canEdit = () => isLocalMode() || (!!session && ['Editor', 'Administrador'].includes(profile?.role));
const canReview = (visit) => isLocalMode() || profile?.role === 'Administrador'
  || (profile?.role === LINE_EDITOR_ROLES[visit?.line] && profile?.line === visit?.line
    && visit?.requestedByEmail !== profile?.email);
const canManageUsers = () => !!sb && profile?.role === 'Administrador';

function refreshPermissionVisibility() {
  document.querySelectorAll('.admin-only').forEach((el) => el.classList.toggle('hidden', !canManageUsers()));
  $('readonlyBanner').classList.toggle('hidden', canEdit() || (isLocalMode() && !sb));
  $('newVisitBtn').classList.toggle('hidden', !canEdit());
}

function applyRole() {
  document.body.classList.toggle('readonly', !canEdit());
  refreshPermissionVisibility();
  $('currentUserLabel').textContent = session?.user?.email ? `${session.user.email} (${profile?.role || 'sem perfil'})` : (sb ? 'Visitante' : 'Local');
  $('authBtn').textContent = session ? 'Sair' : 'Entrar';
  $('authBtn').classList.toggle('hidden', !sb);
  $('localBanner').classList.toggle('hidden', !!sb);
  $('authBtn').disabled = !!session && !profile;
  $('openAiImportBtn').classList.toggle('hidden', !canEdit());
  $('vLine').disabled = !!sb && profile?.role === 'Editor';
  if (profile?.role === 'Editor' && profile.line) {
    $('vLine').value = profile.line;
    updateLineResponsibles();
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
  const url = localStorage.getItem(STORAGE.URL);
  const key = localStorage.getItem(STORAGE.KEY);
  sb = null;
  session = null;
  if (!url || !key || !window.supabase?.createClient) {
    setSync(false, 'Modo local');
    loadLocal();
    return;
  }
  sb = window.supabase.createClient(url, key);
  const { data } = await sb.auth.getSession();
  session = data.session;
  if (session?.user) await loadProfile(session.user);
  sb.auth.onAuthStateChange((_e, s) => {
    session = s;
    profile = null;
    setTimeout(() => { void (async () => {
      if (s?.user) await loadProfile(s.user);
      applyRole();
      renderAll();
    })(); }, 0);
  });
  await pullRemote();
  sb.channel('visits-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'visits' }, pullRemote)
    .subscribe();
}

async function loadProfile(user) {
  if (!sb || !user?.email || user.is_anonymous) { profile = null; return; }
  const { data, error } = await sb.from('visits_user_roles')
    .select('email,role,line').eq('email', user.email.toLowerCase()).maybeSingle();
  if (error || !data) {
    profile = null;
    await sb.auth.signOut();
    toast(error ? 'Falha ao verificar seu perfil.' : 'Esta conta ainda não possui perfil no Controle de Visitas.');
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

async function persist(visit) {
  saveLocal();
  if (!sb) return;
  const { error } = await sb.from('visits').upsert({ id: visit.id, data: visit, updated_at: new Date().toISOString() });
  if (error) { toast('Erro ao sincronizar: ' + error.message); setSync(false, 'Erro de sync'); }
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
      && (!$('fLine').value || v.line === $('fLine').value)
      && (!$('fApproval').value || requestStatus(v) === $('fApproval').value)
      && (!q || [v.client, v.company, v.host, v.phone, v.machineRequested, v.material].some((x) => (x || '').toLowerCase().includes(q))))
    .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
}

function requestStatus(visit) { return visit.approvalStatus || 'Aprovada'; }

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
  if (canEdit() && ['Pendente', 'Recusada', 'Nova data sugerida'].includes(approval)
    && (isLocalMode() || profile?.role === 'Administrador' || v.requestedByEmail === profile?.email)) {
    b.push(`<button class="btn-delta btn-slate btn-sm" data-act="edit" data-id="${esc(v.id)}">Editar pedido</button>`);
  }
  if (approval === 'Aprovada' && v.status === 'Agendada' && canReview(v)) b.push(`<button class="btn-delta btn-emerald btn-sm" data-act="in" data-id="${esc(v.id)}">Check-in</button>`);
  if (approval === 'Aprovada' && v.status === 'Em andamento' && canReview(v)) b.push(`<button class="btn-delta btn-amber btn-sm" data-act="out" data-id="${esc(v.id)}">Check-out</button>`);
  if (isAdmin()) b.push(`<button class="btn-delta btn-rose btn-sm" data-act="del" data-id="${esc(v.id)}" aria-label="Excluir solicitação">Excluir</button>`);
  return `<div class="row-actions">${b.join('')}</div>`;
}

function renderTable() {
  const list = filtered();
  $('visitsBody').innerHTML = list.map((v) => `
    <tr>
      <td>${esc(fmtDate(v.date))} ${esc(v.time)}</td>
      <td><strong>${esc(v.client)}</strong>${v.phone ? `<br><small>${esc(v.phone)}</small>` : ''}</td>
      <td>${esc(v.line || '—')}</td>
      <td>${esc(v.company)}</td>
      <td>${esc(v.reason)}</td>
      <td>${esc(v.host)}</td>
      <td>${esc(v.commercialResponsible || '—')}</td>
      <td>${esc(v.factoryResponsible || '—')}</td>
      <td>${esc(v.checkIn || '—')}</td>
      <td>${esc(v.checkOut || '—')}</td>
      <td>${badge(v.status)}</td>
      <td>${approvalBadge(requestStatus(v))}${v.approvalReason ? `<br><small>${esc(v.approvalReason)}</small>` : ''}${v.factoryNote ? `<br><small>${esc(v.factoryNote)}</small>` : ''}${v.suggestedDate ? `<br><small>Sugerida: ${esc(fmtDate(v.suggestedDate))} ${esc(v.suggestedTime || '')}</small>` : ''}</td>
      <td>${actionButtons(v)}</td>
    </tr>`).join('');
  $('emptyMsg').classList.toggle('hidden', list.length > 0);

  const count = (s) => list.filter((v) => requestStatus(v) === 'Aprovada' && v.status === s).length;
  $('summaryCards').innerHTML = [
    ['Total', list.length], ['Pendentes da fábrica', list.filter((v) => requestStatus(v) === 'Pendente').length], ['Agendadas', count('Agendada')], ['Em andamento', count('Em andamento')],
    ['Concluídas', count('Concluída')], ['Canceladas / faltas', count('Cancelada') + count('Não compareceu')]
  ].map(([l, n]) => `<div class="stat"><span>${l}</span><strong>${n}</strong></div>`).join('');
}

/* ---------- Render: agenda ---------- */
function agendaItem(v) {
  return `<div class="agenda-item">
    <h4>${esc(v.time)} — ${esc(v.client)} ${approvalBadge(requestStatus(v))}</h4>
    <p>${esc(v.line || 'Linha não definida')} · ${esc(v.company)} · ${esc(v.machineRequested || v.reason)}</p>
    <p>Material: ${esc(v.material || '—')}${v.materialThickness ? ` · ${esc(v.materialThickness)}` : ''}</p>
    <p>Anfitrião: ${esc(v.host)} · ${esc(fmtDate(v.date))}</p>
    <p>Comercial: ${esc(v.commercialResponsible || '—')} · Fabril: ${esc(v.factoryResponsible || '—')}</p>
    ${v.approvalReason ? `<p>Motivo: ${esc(v.approvalReason)}</p>` : ''}${v.factoryNote ? `<p>Fábrica: ${esc(v.factoryNote)}</p>` : ''}
    <div>${actionButtons(v)}</div>
  </div>`;
}

function renderAgenda() {
  const t = todayStr();
  const active = (v) => v.status === 'Agendada' || v.status === 'Em andamento';
  const today = visits.filter((v) => v.date === t && v.status !== 'Cancelada').sort((a, b) => a.time.localeCompare(b.time));
  const upcoming = visits.filter((v) => v.date > t && active(v)).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  $('agendaToday').innerHTML = today.map(agendaItem).join('') || '<p class="hint">Nenhuma visita hoje.</p>';
  $('agendaUpcoming').innerHTML = upcoming.map(agendaItem).join('') || '<p class="hint">Nenhuma visita futura.</p>';
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
    ['Clientes únicos', new Set(list.map((v) => v.company.toLowerCase())).size]
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
  renderDashboard();
  applyRole();
}

/* ---------- Ações ---------- */
function switchTab(tab) {
  document.querySelectorAll('.sidebar-link').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  ['visitas', 'agenda', 'dashboard', 'usuarios'].forEach((t) => $('tab-' + t).classList.toggle('hidden', t !== tab));
}

function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }

function openVisitModal(id) {
  if (!canEdit()) return;
  editingId = id || null;
  const v = visits.find((x) => x.id === id) || {};
  $('visitModalTitle').textContent = id ? 'Editar pedido de visita' : 'Novo pedido interno';
  $('vClient').value = v.client || '';
  $('vCompany').value = v.company || '';
  $('vPhone').value = v.phone || '';
  $('vLine').value = v.line || '';
  if (profile?.role === 'Editor' && profile.line) $('vLine').value = profile.line;
  $('vLine').disabled = !!sb && profile?.role === 'Editor';
  updateLineResponsibles();
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
  $('saveVisitBtn').textContent = id ? 'Atualizar pedido' : 'Enviar para validação';
  openModal('visitModal');
}

function updateLineResponsibles() {
  const responsibles = LINE_RESPONSIBLES[$('vLine').value];
  $('vCommercial').value = responsibles?.commercial || '';
  $('vFactory').value = responsibles?.factory || '';
}

async function extractVisitWithAi(sourceText, pdfFile, signal) {
  if (!sb || !session || !profile || !['Editor', 'Administrador'].includes(profile.role)) {
    throw new Error('Entre no app pelo Supabase com um perfil da produção para usar a IA.');
  }
  const body = { text: sourceText };
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
    if (error) throw new Error(error.message || 'Não foi possível interpretar as informações.');
    return data.fields;
  } finally {
    if (body.pdfPath) await sb.storage.from('visits-ai-inbox').remove([body.pdfPath]).catch(() => {});
  }
}

function applyAiVisitFields(data) {
  const fields = {
    vClient: data.client,
    vCompany: data.company,
    vPhone: data.phone,
    vMachine: data.machineRequested,
    vMaterial: data.material,
    vThickness: data.materialThickness,
    vHost: data.host,
    vDate: data.date,
    vTime: data.time,
    vNotes: data.notes
  };
  for (const [id, value] of Object.entries(fields)) if (value) $(id).value = value;
  if (profile?.role === 'Editor' && profile.line) $('vLine').value = profile.line;
  else if (data.line && [...$('vLine').options].some((option) => option.value === data.line)) $('vLine').value = data.line;
  updateLineResponsibles();
  if (data.reason && [...$('vReason').options].some((option) => option.value === data.reason)) $('vReason').value = data.reason;
}

async function processAiSource() {
  const sourceText = $('aiSourceText').value.trim();
  const pdfFile = $('aiSourcePdf').files[0];
  $('aiImportStatus').textContent = '';
  if (!sb || !session) { $('aiImportStatus').textContent = 'Configure o Supabase e entre com seu usuário da produção para usar a IA.'; return; }
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
    toast('Confira e complete os dados antes de salvar.');
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
  const v = {
    ...(prev || { id: uid(), createdAt: new Date().toISOString() }),
    client: $('vClient').value.trim(),
    company: $('vCompany').value.trim(),
    phone: $('vPhone').value.trim(),
    line: $('vLine').value,
    commercialResponsible: $('vCommercial').value,
    factoryResponsible: $('vFactory').value,
    machineRequested: $('vMachine').value.trim(),
    material: $('vMaterial').value.trim(),
    materialThickness: $('vThickness').value.trim(),
    host: $('vHost').value.trim(),
    date: $('vDate').value,
    time: $('vTime').value,
    reason: $('vReason').value,
    status: prev?.status || 'Agendada',
    notes: $('vNotes').value.trim(),
    approvalStatus: 'Pendente',
    approvalReason: '',
    factoryNote: '',
    suggestedDate: '',
    suggestedTime: '',
    requestedByEmail: profile?.email || 'local',
    requestedByName: profile?.email || 'Local',
    requestedAt: new Date().toISOString(),
    reviewedByEmail: '',
    reviewedAt: ''
  };
  if (prev) Object.assign(prev, v); else visits.push(v);
  closeModal('visitModal');
  renderAll();
  await persist(v);
  toast('Pedido encaminhado para validação interna.');
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

async function submitReview(e) {
  e.preventDefault();
  const visit = visits.find((item) => item.id === reviewingId);
  if (!visit || !canReview(visit) || requestStatus(visit) !== 'Pendente') return;
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
  await persist(visit);
  toast('Decisão da fábrica registrada.');
}

async function rowAction(act, id) {
  const v = visits.find((x) => x.id === id);
  if (!v) return;
  if (act === 'review') return openReviewModal(id);
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
  const cols = ['date', 'time', 'client', 'company', 'phone', 'line', 'machineRequested', 'material', 'materialThickness', 'reason', 'host', 'commercialResponsible', 'factoryResponsible', 'approvalStatus', 'approvalReason', 'factoryNote', 'suggestedDate', 'suggestedTime', 'checkIn', 'checkOut', 'status', 'notes'];
  const head = ['Data', 'Hora', 'Visitante', 'Empresa', 'Contato', 'Linha', 'Máquina solicitada', 'Material', 'Espessura / dimensões', 'Motivo', 'Anfitrião', 'Responsável comercial', 'Responsável fabril', 'Análise fabril', 'Motivo da recusa', 'Observação da fábrica', 'Data sugerida', 'Horário sugerido', 'Entrada', 'Saída', 'Estado da visita', 'Observações comerciais'];
  // Prefixo ' evita injeção de fórmulas ao abrir no Excel.
  const cell = (x) => { let s = String(x ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const rows = filtered().map((v) => cols.map((c) => cell(v[c])).join(';'));
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
  const isEditor = $('uRole').value === 'Editor';
  $('uLineGroup').classList.toggle('hidden', !isEditor);
  $('uLine').required = isEditor;
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
  const line = role === 'Editor' ? $('uLine').value : null;
  const password = $('uPassword').value;
  $('userError').textContent = '';
  if (password.length < 12) { $('userError').textContent = 'Use uma senha com pelo menos 12 caracteres.'; return; }
  if (role === 'Editor' && !line) { $('userError').textContent = 'Selecione a linha de responsabilidade.'; return; }
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
  ['fPeriod', 'fSearch', 'fStatus', 'fReason', 'fLine', 'fApproval'].forEach((id) => $(id).addEventListener('input', () => { updateRefMonth(); renderTable(); }));
  $('dPeriod').addEventListener('input', renderDashboard);
  $('clearFiltersBtn').addEventListener('click', () => {
    ['fSearch', 'fStatus', 'fReason', 'fLine', 'fApproval'].forEach((id) => { $(id).value = ''; });
    $('fPeriod').value = '';
    updateRefMonth();
    renderTable();
  });
  $('newVisitBtn').addEventListener('click', () => openVisitModal());
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
  $('vLine').addEventListener('change', updateLineResponsibles);
  $('reviewForm').addEventListener('submit', submitReview);
  $('reviewDecision').addEventListener('change', updateReviewFields);
  $('userForm').addEventListener('submit', submitUser);
  $('uRole').addEventListener('change', updateUserRoleFields);
  $('newUserBtn').addEventListener('click', () => openUserModal());
  $('authForm').addEventListener('submit', submitAuth);
  $('configForm').addEventListener('submit', submitConfig);
  $('configBtn').addEventListener('click', () => {
    $('cUrl').value = localStorage.getItem(STORAGE.URL) || '';
    $('cKey').value = localStorage.getItem(STORAGE.KEY) || '';
    openModal('configModal');
  });
  $('authBtn').addEventListener('click', async () => {
    if (session) { await sb.auth.signOut(); toast('Sessão encerrada.'); } else openModal('authModal');
  });
  document.body.addEventListener('click', (e) => {
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
  await initSupabase();
  renderAll();
  setTimeout(() => $('brandSplash').classList.add('is-hidden'), 600);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
