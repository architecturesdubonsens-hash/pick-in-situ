#!/usr/bin/env bash
# Banc local de la sécurité des lignes des tables bim_* (PICK-RLS-BIM-1).
#
# Démarre une base Postgres JETABLE (aucune connexion à Supabase, aucun secret), y
# charge supabase/bim_schema.sql (l'état documenté), puis rejoue les scénarios :
#   phase 1  état documenté          : tous les « refus » doivent ÉCHOUER (rouge)
#   phase 2  + migration proposée    : tous les scénarios doivent PASSER (vert)
#   phase 3  + retour arrière        : retour au rouge de la phase 1
# Sortie 0 seulement si les trois phases se comportent ainsi. Le rouge de la phase 1
# prouve que le banc voit le défaut ; sans lui, un banc vert ne prouve rien.
#
# Prérequis : binaires Postgres (PGBIN, par défaut /usr/lib/postgresql/16/bin).
# Limite : émulation locale. Elle éprouve la logique des politiques et des droits, pas
# l'état déployé d'un projet Supabase ; pour cela, tests/test-rls-bim.mjs sur une copie.
set -euo pipefail

PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
RACINE="$(cd "$(dirname "$0")/../.." && pwd)"
ICI="$RACINE/tests/rls-bim"
TMP="$(mktemp -d)"
PORT="${RLS_LOCAL_PORT:-55433}"

if [ "$(id -u)" = "0" ]; then            # Postgres refuse de tourner en root
  chown postgres "$TMP"
  EXE=(runuser -u postgres --)
  chmod a+rx "$RACINE" "$RACINE/tests" "$ICI" "$RACINE/supabase" "$RACINE/supabase/migrations" 2>/dev/null || true
  chmod a+r "$ICI"/*.sql "$RACINE"/supabase/*.sql "$RACINE"/supabase/migrations/*.sql
else
  EXE=()
fi

arreter() { "${EXE[@]}" "$PGBIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap arreter EXIT

"${EXE[@]}" "$PGBIN/initdb" -D "$TMP/data" -A trust -U postgres >/dev/null
"${EXE[@]}" "$PGBIN/pg_ctl" -D "$TMP/data" -l "$TMP/pg.log" -w \
  -o "-k $TMP -p $PORT -c listen_addresses=''" start >/dev/null

psql_() { "${EXE[@]}" "$PGBIN/psql" -h "$TMP" -p "$PORT" -U postgres -X -q -v ON_ERROR_STOP=1 "$@"; }

phase() {                       # $1 = nom de base, $2.. = fichiers SQL supplémentaires
  local base="$1"; shift
  psql_ -d postgres -c "drop database if exists $base" -c "create database $base" >/dev/null
  psql_ -d "$base" -f "$ICI/stubs.sql" >/dev/null
  psql_ -d "$base" -f "$RACINE/supabase/bim_schema.sql" >/dev/null
  for f in "$@"; do psql_ -d "$base" -f "$f" >/dev/null; done
  psql_ -d "$base" -A -t -f "$ICI/scenarios.sql" | grep '^SCENARIO|' || true
}

compter() { grep -c "$1" <<<"$2" || true; }

verifier_phase() {              # $1 titre, $2 sortie, $3 attendu : "rouge" ou "vert"
  local titre="$1" sortie="$2" attendu="$3"
  local n_ref n_ref_ko n_droit n_droit_ko n_tot
  n_ref=$(compter '|refus|' "$sortie");  n_ref_ko=$(grep '|refus|' <<<"$sortie" | grep -c '|ECHEC|' || true)
  n_droit=$(compter '|droit|' "$sortie"); n_droit_ko=$(grep '|droit|' <<<"$sortie" | grep -c '|ECHEC|' || true)
  n_tot=$((n_ref + n_droit))
  echo "== $titre : $n_tot scénarios ; refus bloqués $((n_ref - n_ref_ko))/$n_ref ; droits conservés $((n_droit - n_droit_ko))/$n_droit"
  if [ "$n_tot" -eq 0 ]; then echo "   ECHEC DU BANC : aucun scénario n'a produit de résultat" >&2; return 1; fi
  if [ "$attendu" = "rouge" ]; then
    [ "$n_ref_ko" -eq "$n_ref" ] && [ "$n_droit_ko" -eq 0 ] \
      && { echo "   rouge attendu et constaté : aucun refus n'est bloqué, les droits du propriétaire passent"; return 0; }
  else
    [ "$n_ref_ko" -eq 0 ] && [ "$n_droit_ko" -eq 0 ] \
      && { echo "   vert attendu et constaté : tous les refus sont bloqués, tous les droits passent"; return 0; }
  fi
  echo "   RÉSULTAT INATTENDU (attendu : $attendu). Scénarios en échec :" >&2
  grep '|ECHEC|' <<<"$sortie" | sed 's/^/     /' >&2
  return 1
}

statut=0
S1=$(phase rls_avant)
verifier_phase "phase 1, état documenté (avant)" "$S1" rouge || statut=1
S2=$(phase rls_apres "$RACINE/supabase/migrations/20261104_bim_rls.sql")
verifier_phase "phase 2, migration proposée (après)" "$S2" vert || statut=1
S3=$(phase rls_retour "$RACINE/supabase/migrations/20261104_bim_rls.sql" "$RACINE/supabase/migrations/20261104_bim_rls_rollback.sql")
verifier_phase "phase 3, retour arrière" "$S3" rouge || statut=1

# phase 4 : mutants de la migration. Chacun laisse la base dans l'état qu'aurait une
# migration affaiblie ; le banc doit rougir (au moins un scénario en échec), sinon il
# ne prouve rien sur la phase 2.
mutant() {                      # $1 nom, $2 instructions SQL ajoutées après la migration
  local nom="$1" sql="$2" f="$TMP/mutant.sql" sortie ko
  printf '%s\n' "$sql" > "$f"; chmod a+r "$f"
  sortie=$(phase rls_mutant "$RACINE/supabase/migrations/20261104_bim_rls.sql" "$f")
  ko=$(grep '|ECHEC|' <<<"$sortie" | cut -d'|' -f2 | tr '\n' ' ')
  if [ -n "$ko" ]; then echo "   mutant '$nom' : le banc rougit sur $ko"; else
    echo "   mutant '$nom' : NON DÉTECTÉ, le banc est trop faible" >&2; statut=1; fi
}
echo "== phase 4, migrations affaiblies (chacune doit rougir)"
mutant "bim_murs sans filtre" \
  "drop policy bim_murs_owner on pick_in_situ.bim_murs; create policy bim_murs_owner on pick_in_situ.bim_murs for all to authenticated using (true) with check (true);"
mutant "ouvertures sans WITH CHECK" \
  "drop policy bim_ouvertures_owner on pick_in_situ.bim_ouvertures; create policy bim_ouvertures_owner on pick_in_situ.bim_ouvertures for all to authenticated using (exists (select 1 from pick_in_situ.bim_murs m join pick_in_situ.chantiers c on c.id = m.chantier_id where m.id = bim_ouvertures.mur_id and c.user_id = auth.uid())) with check (true);"
mutant "TRUNCATE rendu aux connectés" \
  "grant truncate on pick_in_situ.bim_murs to authenticated;"
mutant "lecture rouverte à l'anonyme" \
  "grant select on pick_in_situ.bim_murs to anon; create policy anon_lit on pick_in_situ.bim_murs for select to anon using (true);"
mutant "dalles lisibles par tout connecté" \
  "drop policy bim_dalles_owner on pick_in_situ.bim_dalles; create policy bim_dalles_owner on pick_in_situ.bim_dalles for all to authenticated using (true) with check (exists (select 1 from pick_in_situ.chantiers c where c.id = bim_dalles.chantier_id and c.user_id = auth.uid()));"

if [ "${VERBEUX:-0}" = "1" ]; then echo; echo "$S1"; echo "$S2"; echo "$S3"; fi
if [ "$statut" = "0" ]; then echo "BILAN : VERT (rouge avant, vert après, retour arrière conforme)"; else echo "BILAN : ROUGE" >&2; fi
exit "$statut"
