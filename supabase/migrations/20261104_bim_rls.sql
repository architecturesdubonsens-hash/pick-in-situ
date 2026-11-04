-- ============================================================================
-- PROPOSITION — NON APPLIQUÉE : durcir la sécurité des lignes des tables bim_*
-- ============================================================================
-- Tâche PICK-RLS-BIM-1. Cette migration ne s'applique à AUCUNE base sans l'accord
-- écrit de l'utilisateur, et d'abord sur une copie ou un projet de branche, jamais
-- sur la production. Elle a été éprouvée seulement sur une base locale vide
-- (tests/rls-bim/run-local.sh) : cela prouve la logique des politiques, pas l'état
-- déployé de « Forme1 ».
--
-- Ce qu'elle change, et pour qui :
--   1. anon perd tous les droits sur les cinq tables : l'application n'y accède
--      qu'avec une session (le viewer est derrière useRequireAuth) ;
--   2. authenticated garde SELECT, INSERT, UPDATE, DELETE et perd TRUNCATE,
--      TRIGGER, REFERENCES ;
--   3. la politique « tout pour tout le monde » est remplacée par un filtre : une
--      ligne n'est visible et modifiable que par le propriétaire de son chantier
--      (chantiers.user_id = auth.uid()), comme pour scans et artifacts. WITH CHECK
--      empêche aussi d'écrire dans le chantier d'un autre ou de rattacher une
--      ouverture au mur d'un autre ;
--   4. des index sur les colonnes que les politiques et le viewer filtrent.
--
-- Risque à connaître avant d'appliquer : tout appelant qui lit ou écrit bim_* sans
-- session utilisateur cessera de fonctionner. Dans ce dépôt, le seul appelant est
-- components/ViewerMulti.tsx, derrière une session. Les appelants hors dépôt
-- (autres applications sur la même base) : non vérifiés.
--
-- Retour arrière : 20261104_bim_rls_rollback.sql.
-- ============================================================================

begin;

-- 1. Droits ----------------------------------------------------------------------
revoke all on pick_in_situ.bim_murs, pick_in_situ.bim_ouvertures, pick_in_situ.bim_dalles,
              pick_in_situ.bim_toits, pick_in_situ.bim_ancres from anon;

revoke truncate, trigger, references
  on pick_in_situ.bim_murs, pick_in_situ.bim_ouvertures, pick_in_situ.bim_dalles,
     pick_in_situ.bim_toits, pick_in_situ.bim_ancres
  from authenticated;

-- 2. Politiques ------------------------------------------------------------------
drop policy if exists bim_murs_all       on pick_in_situ.bim_murs;
drop policy if exists bim_ouvertures_all on pick_in_situ.bim_ouvertures;
drop policy if exists bim_dalles_all     on pick_in_situ.bim_dalles;
drop policy if exists bim_toits_all      on pick_in_situ.bim_toits;
drop policy if exists bim_ancres_all     on pick_in_situ.bim_ancres;

-- Tables rattachées directement au chantier.
create policy bim_murs_owner on pick_in_situ.bim_murs
  for all to authenticated
  using (exists (select 1 from pick_in_situ.chantiers c
                  where c.id = bim_murs.chantier_id and c.user_id = auth.uid()))
  with check (exists (select 1 from pick_in_situ.chantiers c
                       where c.id = bim_murs.chantier_id and c.user_id = auth.uid()));

create policy bim_dalles_owner on pick_in_situ.bim_dalles
  for all to authenticated
  using (exists (select 1 from pick_in_situ.chantiers c
                  where c.id = bim_dalles.chantier_id and c.user_id = auth.uid()))
  with check (exists (select 1 from pick_in_situ.chantiers c
                       where c.id = bim_dalles.chantier_id and c.user_id = auth.uid()));

create policy bim_toits_owner on pick_in_situ.bim_toits
  for all to authenticated
  using (exists (select 1 from pick_in_situ.chantiers c
                  where c.id = bim_toits.chantier_id and c.user_id = auth.uid()))
  with check (exists (select 1 from pick_in_situ.chantiers c
                       where c.id = bim_toits.chantier_id and c.user_id = auth.uid()));

create policy bim_ancres_owner on pick_in_situ.bim_ancres
  for all to authenticated
  using (exists (select 1 from pick_in_situ.chantiers c
                  where c.id = bim_ancres.chantier_id and c.user_id = auth.uid()))
  with check (exists (select 1 from pick_in_situ.chantiers c
                       where c.id = bim_ancres.chantier_id and c.user_id = auth.uid()));

-- Ouvertures : rattachées à un mur ; le propriétaire est celui du chantier du mur.
-- À l'INSERT, WITH CHECK empêche de poser une ouverture sur le mur d'un autre (banc :
-- R09). À l'UPDATE, déplacer une ouverture sur le mur d'un autre est bloqué aussi
-- (banc : R14, R15), et le banc constate que R15 reste bloqué même si l'on affaiblit
-- WITH CHECK en (true) : la politique de lecture s'applique aussi à la nouvelle ligne
-- d'une modification. Explication probable, non vérifiée dans le code de PostgreSQL ;
-- le constat, lui, est reproductible (tests/rls-bim/run-local.sh, phase 4).
create policy bim_ouvertures_owner on pick_in_situ.bim_ouvertures
  for all to authenticated
  using (exists (select 1 from pick_in_situ.bim_murs m
                   join pick_in_situ.chantiers c on c.id = m.chantier_id
                  where m.id = bim_ouvertures.mur_id and c.user_id = auth.uid()))
  with check (exists (select 1 from pick_in_situ.bim_murs m
                        join pick_in_situ.chantiers c on c.id = m.chantier_id
                       where m.id = bim_ouvertures.mur_id and c.user_id = auth.uid()));

-- 3. Index (les clés étrangères n'en créent pas) ------------------------------------
create index if not exists bim_murs_chantier_id_idx   on pick_in_situ.bim_murs   (chantier_id);
create index if not exists bim_dalles_chantier_id_idx on pick_in_situ.bim_dalles (chantier_id);
create index if not exists bim_toits_chantier_id_idx  on pick_in_situ.bim_toits  (chantier_id);
create index if not exists bim_ancres_chantier_id_idx on pick_in_situ.bim_ancres (chantier_id);
create index if not exists bim_ouvertures_mur_id_idx  on pick_in_situ.bim_ouvertures (mur_id);

commit;
