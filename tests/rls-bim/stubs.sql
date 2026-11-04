-- Éléments factices pour rejouer le schéma sur une base Postgres locale VIDE.
-- Ils imitent ce que Supabase fournit : les rôles anon et authenticated, le schéma
-- auth avec auth.users et auth.uid(), et le schéma pick_in_situ. PostgREST pose le
-- rôle et la revendication « sub » du jeton avant chaque requête ; le banc fait de
-- même avec SET LOCAL ROLE et set_config('request.jwt.claim.sub', ...).
-- Limite : c'est une émulation. Elle prouve la logique des politiques et des droits,
-- pas l'état déployé d'un projet Supabase réel.

-- Les rôles sont globaux au cluster : création idempotente, le banc rejoue plusieurs bases.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
end $$;

create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

create schema pick_in_situ;
grant usage on schema auth, pick_in_situ to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
