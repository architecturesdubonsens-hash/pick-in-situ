// tests/test-cadastre-prefiltre.mjs
// Banc de precision du pre-filtrage cadastre PickInSitu (JEV-CAD-5).
// Critere : precision division/ABF >= 85% sur le lot de parcelles de reference.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { qualifierBatch } from '../lib/cadastre-prefiltre.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const datasetPath = path.join(__dirname, '..', 'data', 'dataset_cadastre_pick.json');

process.env.JEV_MODE = 'off'; // classification deterministe (legacy), sans reseau

const parcelles = JSON.parse(await fs.readFile(datasetPath, 'utf8'));
const results = await qualifierBatch(parcelles);

let divOk = 0;
let abfOk = 0;
let typoOk = 0;
const ecarts = [];
for (const r of results) {
  const gt = r.ground_truth;
  const p = r.prediction;
  const div = p.potentiel_division === gt.potentiel_division;
  const abf = p.recours_abf === gt.recours_abf;
  const typo = p.typologie === gt.typologie;
  if (div) divOk++;
  if (abf) abfOk++;
  if (typo) typoOk++;
  if (!div || !abf) ecarts.push({ id: r.id, div: div ? 'OK' : 'KO', abf: abf ? 'OK' : 'KO' });
}

const n = results.length;
const divAcc = (divOk / n) * 100;
const abfAcc = (abfOk / n) * 100;
const combAcc = ((divOk + abfOk) / (2 * n)) * 100;
const typoAcc = (typoOk / n) * 100;

console.log('=== BANC CADASTRE PICKINSITU (JEV-CAD-5) ===');
console.log('Parcelles qualifiees : ' + n);
console.log('Precision potentiel_division : ' + divAcc.toFixed(1) + '% (' + divOk + '/' + n + ')');
console.log('Precision recours_abf         : ' + abfAcc.toFixed(1) + '% (' + abfOk + '/' + n + ')');
console.log('Precision division/ABF combinee : ' + combAcc.toFixed(1) + '% (' + (divOk + abfOk) + '/' + (2 * n) + ')');
console.log('Precision typologie (bonus)   : ' + typoAcc.toFixed(1) + '% (' + typoOk + '/' + n + ')');

const CRITERE = 85;
const ok = combAcc >= CRITERE;
console.log('Critere : precision division/ABF >= ' + CRITERE + '% -> ' + (ok ? 'PASS' : 'FAIL'));

if (!ok) {
  console.log('Ecarts :');
  for (const e of ecarts) console.log('  ' + JSON.stringify(e));
  process.exit(1);
}
process.exit(0);
