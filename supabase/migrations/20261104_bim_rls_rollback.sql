-- ============================================================================
-- RETOUR ARRIÈRE de 20261104_bim_rls.sql — NON APPLIQUÉ
-- ============================================================================
-- Rétablit l'état relevé le 04/11/2026 : politique « tout pour tout le monde » et
-- tous les droits pour anon et authenticated. C'est précisément l'état dangereux
-- que la migration corrige : ce fichier ne sert qu'à revenir en arrière si un
-- appelant inattendu casse, le temps de le corriger. Il est rejoué dans
-- tests/rls-bim/run-local.sh pour prouver qu'il remet bien l'état d'origine.
-- Les index créés par la migration sont conservés : ils sont inoffensifs.
-- ============================================================================

begin;

drop policy if exists bim_murs_owner       on pick_in_situ.bim_murs;
drop policy if exists bim_ouvertures_owner on pick_in_situ.bim_ouvertures;
drop policy if exists bim_dalles_owner     on pick_in_situ.bim_dalles;
drop policy if exists bim_toits_owner      on pick_in_situ.bim_toits;
drop policy if exists bim_ancres_owner     on pick_in_situ.bim_ancres;

create policy bim_murs_all       on pick_in_situ.bim_murs       for all using (true) with check (true);
create policy bim_ouvertures_all on pick_in_situ.bim_ouvertures for all using (true) with check (true);
create policy bim_dalles_all     on pick_in_situ.bim_dalles     for all using (true) with check (true);
create policy bim_toits_all      on pick_in_situ.bim_toits      for all using (true) with check (true);
create policy bim_ancres_all     on pick_in_situ.bim_ancres     for all using (true) with check (true);

grant select, insert, update, delete, references, trigger, truncate
  on pick_in_situ.bim_murs, pick_in_situ.bim_ouvertures, pick_in_situ.bim_dalles,
     pick_in_situ.bim_toits, pick_in_situ.bim_ancres
  to anon, authenticated;

commit;
