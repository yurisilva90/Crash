create schema if not exists collector_private;
revoke all on schema collector_private from public, anon, authenticated;

create table if not exists collector_private.control_tokens (
  token_hash bytea primary key,
  created_at timestamptz not null default now()
);
create table if not exists collector_private.control_commands (
  id bigint generated always as identity primary key,
  action text not null check (action in ('gaps', 'recover', 'sync')),
  state text not null default 'queued' check (state in ('queued', 'running', 'succeeded', 'failed')),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  result text
);
alter table collector_private.control_tokens enable row level security;
alter table collector_private.control_commands enable row level security;
revoke all on all tables in schema collector_private from public, anon, authenticated;

insert into collector_private.control_tokens (token_hash)
values (decode('eaa87abfa516568985cbf1b5c4d9a72c783fa73ff881f0c1b5b9c7dcc5050712','hex'))
on conflict do nothing;

create or replace function public.crash_control_submit(p_token text, p_action text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, collector_private, extensions
as $$
declare v_id bigint;
begin
  if p_token is null or length(p_token) > 256 or not exists (
    select 1 from collector_private.control_tokens
    where token_hash = extensions.digest(p_token, 'sha256')
  ) then raise exception 'invalid control token' using errcode = '28000'; end if;
  if p_action not in ('gaps','recover','sync') then
    raise exception 'invalid action' using errcode = '22023';
  end if;
  select id into v_id from collector_private.control_commands
    where action = p_action and state in ('queued','running')
      and created_at > now() - interval '5 minutes'
    order by id desc limit 1;
  if v_id is null then
    insert into collector_private.control_commands(action) values (p_action) returning id into v_id;
  end if;
  return jsonb_build_object('id',v_id,'state','queued','action',p_action);
end;
$$;

create or replace function public.crash_control_claim(p_token text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, collector_private, extensions
as $$
declare v_id bigint; v_action text;
begin
  if p_token is null or length(p_token) > 256 or not exists (
    select 1 from collector_private.control_tokens
    where token_hash = extensions.digest(p_token, 'sha256')
  ) then raise exception 'invalid control token' using errcode = '28000'; end if;
  update collector_private.control_commands set state='failed', completed_at=now(), result='timeout'
    where state='running' and started_at < now()-interval '10 minutes';
  with candidate as (
    select id from collector_private.control_commands where state='queued'
    order by id for update skip locked limit 1
  )
  update collector_private.control_commands c
    set state='running', started_at=now()
    from candidate where c.id=candidate.id
    returning c.id,c.action into v_id,v_action;
  if v_id is null then return null; end if;
  return jsonb_build_object('id',v_id,'action',v_action);
end;
$$;

create or replace function public.crash_control_finish(p_token text, p_id bigint, p_success boolean, p_result text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, collector_private, extensions
as $$
declare v_state text;
begin
  if p_token is null or length(p_token) > 256 or not exists (
    select 1 from collector_private.control_tokens
    where token_hash = extensions.digest(p_token, 'sha256')
  ) then raise exception 'invalid control token' using errcode = '28000'; end if;
  update collector_private.control_commands set state=case when p_success then 'succeeded' else 'failed' end,
    completed_at=now(), result=left(coalesce(p_result,''),500)
    where id=p_id and state='running' returning state into v_state;
  if v_state is null then raise exception 'command not running' using errcode='22023'; end if;
  return jsonb_build_object('id',p_id,'state',v_state);
end;
$$;

create or replace function public.crash_control_status(p_token text, p_id bigint)
returns jsonb language plpgsql security definer set search_path = pg_catalog, collector_private, extensions
as $$
declare v_command collector_private.control_commands%rowtype;
begin
  if p_token is null or length(p_token) > 256 or not exists (
    select 1 from collector_private.control_tokens
    where token_hash = extensions.digest(p_token, 'sha256')
  ) then raise exception 'invalid control token' using errcode = '28000'; end if;
  select * into v_command from collector_private.control_commands where id=p_id;
  if not found then return null; end if;
  return jsonb_build_object('id',v_command.id,'action',v_command.action,'state',v_command.state,'result',v_command.result);
end;
$$;

revoke all on function public.crash_control_submit(text,text) from public, anon, authenticated;
revoke all on function public.crash_control_claim(text) from public, anon, authenticated;
revoke all on function public.crash_control_finish(text,bigint,boolean,text) from public, anon, authenticated;
revoke all on function public.crash_control_status(text,bigint) from public, anon, authenticated;
grant execute on function public.crash_control_submit(text,text) to anon;
grant execute on function public.crash_control_claim(text) to anon;
grant execute on function public.crash_control_finish(text,bigint,boolean,text) to anon;
grant execute on function public.crash_control_status(text,bigint) to anon;
