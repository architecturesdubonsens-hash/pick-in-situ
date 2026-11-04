-- ============================================================================
-- Schéma de référence — éléments BIM tracés dans le viewer (chantiers + bim_*)
-- ============================================================================
-- DOCUMENTATION UNIQUEMENT : ce fichier reflète l'état réel du projet Supabase
-- « Forme1 » (ojoswtbarspntovtcfsh), schéma pick_in_situ, relevé le 04/11/2026
-- par requêtes sur information_schema, pg_constraint, pg_indexes, pg_policies et
-- role_table_grants.
--
-- Origine : ces tables ont été créées par des migrations enregistrées dans la base
-- (supabase_migrations.schema_migrations de « Forme1 ») mais absentes de ce dépôt :
--   20260705103156 pick_in_situ_bim_murs        20260705104642 bim_murs_decalage
--   20260705163116 bim_ouvertures_dalles_toits  20260705171601 bim_ancres
-- Rapprochées le 04/11/2026 du relevé ci-dessous : colonnes, valeurs par défaut,
-- clés étrangères, politiques et droits sont identiques. La politique « tout pour
-- tout le monde » (using true) et « grant all … to anon, authenticated » figurent
-- dans ces migrations dès leur création : ce n'est pas une dérive, c'était écrit ainsi.
-- Les migrations ne créent aucun index ; la table chantiers (migration
-- 20260621090323 pick_in_situ_init) n'a pas été relue, sa description vient du relevé.
--
-- Ne pas l'exécuter tel quel sur le projet existant : il décrit ce qui existe déjà.
--
-- Il s'exécute en revanche sur une base locale vide (voir tests/rls-bim/run-local.sh,
-- qui y ajoute des rôles et un schéma auth factices) : c'est ainsi que l'état
-- décrit ici et la migration proposée sont éprouvés hors de la production.
--
-- Consommateur unique des tables bim_* : components/ViewerMulti.tsx (client
-- Supabase du navigateur, schéma pick_in_situ, session de l'utilisateur), monté
-- uniquement par app/chantier/[id]/page.tsx derrière useRequireAuth. L'application
-- iOS n'écrit que scans et le stockage. Non couvert ici : scans et artifacts, dont
-- les politiques passent par une jointure au chantier.
--
-- CONSTAT DU 04/11/2026 — à corriger par supabase/migrations/20261104_bim_rls.sql
-- (proposée, non appliquée) :
--   1. les cinq tables bim_* ont une politique ALL avec using (true) et
--      with check (true), pour le rôle public : sans filtre de ligne ;
--   2. les rôles anon et authenticated ont tous les droits sur ces tables, y compris
--      TRUNCATE, TRIGGER et REFERENCES ;
--   3. aucun index sur chantier_id ni sur mur_id (seules les clés primaires).
-- ============================================================================

-- ── chantiers : propriétaire = auth.uid() (par défaut à l'insertion) ───────
create table pick_in_situ.chantiers (
  id          uuid primary key default gen_random_uuid(),
  nom         text not null,
  adresse     text,
  user_id     uuid default auth.uid() references auth.users(id) on delete cascade,
  created_at  timestamptz default now()
);

alter table pick_in_situ.chantiers enable row level security;
create policy chantiers_owner on pick_in_situ.chantiers
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select on pick_in_situ.chantiers to anon;
grant select, insert, update, delete, references, trigger, truncate
  on pick_in_situ.chantiers to authenticated;

-- ── bim_murs ───────────────────────────────────────────────────────────────
create table pick_in_situ.bim_murs (
  id          uuid primary key default gen_random_uuid(),
  chantier_id uuid not null references pick_in_situ.chantiers(id) on delete cascade,
  ax          double precision not null,
  az          double precision not null,
  bx          double precision not null,
  bz          double precision not null,
  epaisseur   double precision not null default 0.2,
  hauteur     double precision not null default 2.7,
  base_y      double precision not null default 0,
  created_at  timestamptz not null default now(),
  decalage    real not null default 0
);

-- ── bim_ouvertures : rattachées à un mur, pas directement à un chantier ────
create table pick_in_situ.bim_ouvertures (
  id          uuid primary key default gen_random_uuid(),
  mur_id      uuid not null references pick_in_situ.bim_murs(id) on delete cascade,
  pos         real not null,
  largeur     real not null default 1.0,
  hauteur     real not null default 1.15,
  allege      real not null default 1.0,
  created_at  timestamptz default now()
);

-- ── bim_dalles ─────────────────────────────────────────────────────────────
create table pick_in_situ.bim_dalles (
  id          uuid primary key default gen_random_uuid(),
  chantier_id uuid not null references pick_in_situ.chantiers(id) on delete cascade,
  points      jsonb not null,
  epaisseur   real not null default 0.2,
  base_y      real not null default 0,
  created_at  timestamptz default now()
);

-- ── bim_toits ──────────────────────────────────────────────────────────────
create table pick_in_situ.bim_toits (
  id          uuid primary key default gen_random_uuid(),
  chantier_id uuid not null references pick_in_situ.chantiers(id) on delete cascade,
  p1          jsonb not null,
  p2          jsonb not null,
  p3          jsonb not null,
  epaisseur   real not null default 0.2,
  created_at  timestamptz default now()
);

-- ── bim_ancres ─────────────────────────────────────────────────────────────
create table pick_in_situ.bim_ancres (
  id          uuid primary key default gen_random_uuid(),
  chantier_id uuid not null references pick_in_situ.chantiers(id) on delete cascade,
  x           real not null,
  y           real not null,
  z           real not null,
  created_at  timestamptz default now()
);

-- ── État actuel de la sécurité des lignes : politique unique, sans filtre ──
alter table pick_in_situ.bim_murs       enable row level security;
alter table pick_in_situ.bim_ouvertures enable row level security;
alter table pick_in_situ.bim_dalles     enable row level security;
alter table pick_in_situ.bim_toits      enable row level security;
alter table pick_in_situ.bim_ancres     enable row level security;

create policy bim_murs_all       on pick_in_situ.bim_murs       for all using (true) with check (true);
create policy bim_ouvertures_all on pick_in_situ.bim_ouvertures for all using (true) with check (true);
create policy bim_dalles_all     on pick_in_situ.bim_dalles     for all using (true) with check (true);
create policy bim_toits_all      on pick_in_situ.bim_toits      for all using (true) with check (true);
create policy bim_ancres_all     on pick_in_situ.bim_ancres     for all using (true) with check (true);

-- ── Droits actuels : tous les droits pour anon et authenticated ────────────
-- (aucun droit par défaut n'est défini pour le schéma pick_in_situ : ces droits
-- ont été accordés explicitement ; les tables créées plus tard n'en reçoivent pas.)
grant select, insert, update, delete, references, trigger, truncate
  on pick_in_situ.bim_murs, pick_in_situ.bim_ouvertures, pick_in_situ.bim_dalles,
     pick_in_situ.bim_toits, pick_in_situ.bim_ancres
  to anon, authenticated;
