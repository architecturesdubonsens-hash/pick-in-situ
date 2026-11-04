// tests/test-rls-bim.mjs
// Banc de la securite des lignes des tables bim_* sur une base REELLE (PICK-RLS-BIM-1).
//
// ATTENTION : ce banc ECRIT des lignes (chantiers et murs prefixes __rls_test__) puis les
// supprime. A lancer sur une COPIE de la base ou un projet de branche, jamais d'abord sur
// la production. Il refuse de tourner sans RLS_TEST_CONFIRM_COPIE=oui.
//
// Variables d'environnement (aucune cle dans le depot ; ne rien afficher de leurs valeurs) :
//   RLS_TEST_URL, RLS_TEST_ANON_KEY            projet cible (cle publique)
//   RLS_TEST_EMAIL_A / RLS_TEST_PASSWORD_A     compte de test A
//   RLS_TEST_EMAIL_B / RLS_TEST_PASSWORD_B     compte de test B
//   RLS_TEST_CONFIRM_COPIE=oui
//
// Sortie 0 : tous les controles passent. Sortie 1 : au moins un echoue. Sortie 2 : mauvais
// appel (variable manquante).
// Attendu AVANT la migration 20261104_bim_rls.sql : les controles « refus » ECHOUENT (rouge).
// Attendu APRES : tous passent. Une logique equivalente est eprouvee hors production par
// tests/rls-bim/run-local.sh ; ce fichier, lui, n'a PAS ete execute contre une base reelle.

const manque = (k) => { console.error(`variable manquante : ${k}`); process.exit(2); };
if (process.env.RLS_TEST_CONFIRM_COPIE !== 'oui') {
  console.error('refus : ce banc ecrit des lignes. Definir RLS_TEST_CONFIRM_COPIE=oui, et seulement sur une copie ou un projet de branche.');
  process.exit(2);
}
const env = (k) => process.env[k] || manque(k);
const URL = env('RLS_TEST_URL'), ANON = env('RLS_TEST_ANON_KEY');
const ID = { A: [env('RLS_TEST_EMAIL_A'), env('RLS_TEST_PASSWORD_A')], B: [env('RLS_TEST_EMAIL_B'), env('RLS_TEST_PASSWORD_B')] };

const { createClient } = await import('@supabase/supabase-js');
const client = () => createClient(URL, ANON, { db: { schema: 'pick_in_situ' }, auth: { persistSession: false, autoRefreshToken: false } });

async function connecte(qui) {
  const c = client();
  const { error } = await c.auth.signInWithPassword({ email: ID[qui][0], password: ID[qui][1] });
  if (error) { console.error(`connexion du compte ${qui} impossible : ${error.message}`); process.exit(2); }
  return c;
}

const resultats = [];
// refus : bloque = erreur, ou aucune ligne rendue/touchee.  droit : au moins une ligne.
function note(id, famille, libelle, { error, data }) {
  const n = Array.isArray(data) ? data.length : (data ? 1 : 0);
  const ok = famille === 'refus' ? (!!error || n === 0) : (!error && n >= 1);
  resultats.push({ id, famille, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} (${famille}) ${libelle}${error ? ` [erreur : ${error.message}]` : ` [lignes : ${n}]`}`);
}

const A = await connecte('A'), B = await connecte('B'), anon = client();
const nom = `__rls_test__${Date.now()}`;
let chA, chB, murA;
try {
  // Donnees de depart, creees par leurs proprietaires.
  chA = (await A.from('chantiers').insert({ nom: `${nom} A` }).select('id').single()).data?.id;
  chB = (await B.from('chantiers').insert({ nom: `${nom} B` }).select('id').single()).data?.id;
  if (!chA || !chB) { console.error('creation des chantiers de test impossible'); process.exit(2); }
  murA = (await A.from('bim_murs').insert({ chantier_id: chA, ax: 0, az: 0, bx: 5, bz: 0 }).select('id').single()).data?.id;
  const ouvA = (await A.from('bim_ouvertures').insert({ mur_id: murA, pos: 1.5 }).select('id').single()).data?.id;
  if (!murA || !ouvA) { console.error('creation du mur de test impossible'); process.exit(2); }

  // Refus : l'anonyme (cle publique sans session).
  note('R01', 'refus', 'anonyme : lire le mur de A', await anon.from('bim_murs').select('id').eq('id', murA));
  note('R03', 'refus', 'anonyme : poser un mur dans le chantier de A', await anon.from('bim_murs').insert({ chantier_id: chA, ax: 9, az: 9, bx: 9, bz: 10 }).select('id'));
  note('R04', 'refus', 'anonyme : supprimer le mur de A', await anon.from('bim_murs').delete().eq('id', murA).select('id'));
  // Refus : le compte B face aux donnees de A.
  note('R06', 'refus', 'B : lire les murs du chantier de A', await B.from('bim_murs').select('id').eq('chantier_id', chA));
  note('R07', 'refus', 'B : lire les ouvertures du mur de A', await B.from('bim_ouvertures').select('id').eq('mur_id', murA));
  note('R08', 'refus', 'B : poser un mur dans le chantier de A', await B.from('bim_murs').insert({ chantier_id: chA, ax: 9, az: 9, bx: 9, bz: 10 }).select('id'));
  note('R09', 'refus', 'B : poser une ouverture sur le mur de A', await B.from('bim_ouvertures').insert({ mur_id: murA, pos: 2 }).select('id'));
  note('R10', 'refus', 'B : modifier le mur de A', await B.from('bim_murs').update({ hauteur: 9 }).eq('id', murA).select('id'));
  note('R11', 'refus', 'B : supprimer le mur de A', await B.from('bim_murs').delete().eq('id', murA).select('id'));
  // Droits : le proprietaire garde son plein usage (verifie apres les tentatives ci-dessus).
  note('D01', 'droit', 'A : relit son mur intact apres les tentatives', await A.from('bim_murs').select('id, hauteur').eq('id', murA).eq('hauteur', 2.7));
  note('D02', 'droit', 'A : lit les ouvertures de son mur', await A.from('bim_ouvertures').select('id').eq('mur_id', murA));
  note('D03', 'droit', 'A : modifie son mur', await A.from('bim_murs').update({ hauteur: 3 }).eq('id', murA).select('id'));
  note('D04', 'droit', 'A : supprime son mur', await A.from('bim_murs').delete().eq('id', murA).select('id'));
} finally {
  // Nettoyage : la suppression du chantier emporte ses elements (ON DELETE CASCADE).
  if (chA) await A.from('chantiers').delete().eq('id', chA);
  if (chB) await B.from('chantiers').delete().eq('id', chB);
}

const ko = resultats.filter((r) => !r.ok);
console.log(`BILAN : ${resultats.length - ko.length}/${resultats.length} controles passent${ko.length ? ` ; en echec : ${ko.map((r) => r.id).join(' ')}` : ''}`);
process.exit(ko.length ? 1 : 0);
