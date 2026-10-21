import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json' }
});
const validRoles = ['Administrador', 'Fábrica'];
const validLines = ['Linha Leve', 'Linha Intermediária', 'Linha Pesada'];

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return respond({ error: 'Method not allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const authorization = request.headers.get('Authorization');
  if (!url || !serviceKey) return respond({ error: 'Função não configurada no servidor.' }, 500);
  if (!authorization) return respond({ error: 'Autenticação necessária.' }, 401);

  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const token = authorization.replace(/^Bearer\s+/i, '');
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  const actorEmail = authData.user?.email?.toLowerCase();
  if (authError || !actorEmail || authData.user?.is_anonymous) return respond({ error: 'Sessão inválida.' }, 401);

  const { data: actor, error: actorError } = await admin.from('visits_user_roles')
    .select('role,email').eq('email', actorEmail).maybeSingle();
  if (actorError || actor?.role !== 'Administrador') return respond({ error: 'Apenas Administradores podem gerir acessos.' }, 403);

  let body: { action?: string; email?: string; password?: string; role?: string; line?: string | null };
  try { body = await request.json(); } catch { return respond({ error: 'Corpo JSON inválido.' }, 400); }

  if (body.action === 'list') {
    const { data, error } = await admin.from('visits_user_roles').select('email,role,line').order('email');
    if (error) return respond({ error: error.message }, 500);
    return respond({ users: data || [] });
  }

  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return respond({ error: 'Informe um e-mail válido.' }, 400);
  const primaryAdmin = (Deno.env.get('VISITS_PRIMARY_ADMIN_EMAIL') || '').trim().toLowerCase();
  const isPrimaryAdmin = !!primaryAdmin && actorEmail === primaryAdmin;

  if (body.action === 'upsert') {
    const password = String(body.password || '');
    const role = String(body.role || '');
    const line = role === 'Fábrica' ? String(body.line || '') : null;
    if (password.length < 12 || new TextEncoder().encode(password).length > 72) {
      return respond({ error: 'A senha deve ter entre 12 e 72 bytes.' }, 400);
    }
    if (!validRoles.includes(role)) return respond({ error: 'Perfil inválido.' }, 400);
    if (role === 'Fábrica' && !validLines.includes(line || '')) return respond({ error: 'Selecione uma linha fabril válida.' }, 400);
    if (role !== 'Fábrica' && body.line) return respond({ error: 'Somente perfis de Fábrica recebem uma linha.' }, 400);
    if (role === 'Administrador' && !isPrimaryAdmin) return respond({ error: 'Somente o administrador principal pode criar ou promover administradores.' }, 403);
    if (email === primaryAdmin && role !== 'Administrador') return respond({ error: 'O administrador principal não pode perder seu perfil.' }, 400);

    const { data: oldRole, error: oldRoleError } = await admin.from('visits_user_roles')
      .select('role').eq('email', email).maybeSingle();
    if (oldRoleError) return respond({ error: oldRoleError.message }, 500);
    if (oldRole?.role === 'Administrador' && !isPrimaryAdmin) return respond({ error: 'Somente o administrador principal pode gerir contas Administrador.' }, 403);

    const { data: authUsers, error: listError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listError) return respond({ error: listError.message }, 500);
    const existing = authUsers.users.find((user) => user.email?.toLowerCase() === email);
    let userId = existing?.id;
    let created = false;
    if (existing) {
      const { error } = await admin.auth.admin.updateUserById(existing.id, { password, email_confirm: true });
      if (error) return respond({ error: error.message }, 400);
    } else {
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (error || !data.user) return respond({ error: error?.message || 'Não foi possível criar a conta.' }, 400);
      userId = data.user.id;
      created = true;
    }

    const { error: roleError } = await admin.from('visits_user_roles').upsert({ email, role, line }, { onConflict: 'email' });
    if (roleError) {
      if (created && userId) await admin.auth.admin.deleteUser(userId);
      return respond({ error: roleError.message }, 500);
    }
    return respond({ email, role, line, updated: Boolean(existing) });
  }

  if (body.action === 'delete') {
    if (email === actorEmail) return respond({ error: 'Não é possível excluir a própria conta durante a sessão.' }, 400);
    if (email === primaryAdmin) return respond({ error: 'O administrador principal não pode ser excluído.' }, 400);
    const { data: target, error: targetError } = await admin.from('visits_user_roles')
      .select('role').eq('email', email).maybeSingle();
    if (targetError) return respond({ error: targetError.message }, 500);
    if (!target) return respond({ error: 'Usuário não encontrado.' }, 404);
    if (target.role === 'Administrador' && !isPrimaryAdmin) return respond({ error: 'Somente o administrador principal pode excluir outros administradores.' }, 403);
    if (target.role === 'Administrador') {
      const { count, error } = await admin.from('visits_user_roles').select('email', { count: 'exact', head: true }).eq('role', 'Administrador');
      if (error) return respond({ error: error.message }, 500);
      if ((count || 0) <= 1) return respond({ error: 'O último administrador não pode ser excluído.' }, 400);
    }

    const { data: authUsers, error: listError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listError) return respond({ error: listError.message }, 500);
    const authUser = authUsers.users.find((user) => user.email?.toLowerCase() === email);
    if (authUser) {
      const { error } = await admin.auth.admin.deleteUser(authUser.id);
      if (error) return respond({ error: error.message }, 500);
    }
    const { error } = await admin.from('visits_user_roles').delete().eq('email', email);
    if (error) return respond({ error: error.message }, 500);
    return respond({ email, deleted: true });
  }

  return respond({ error: 'Ação inválida.' }, 400);
});