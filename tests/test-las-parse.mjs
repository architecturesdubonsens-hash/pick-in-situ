import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { parse } from "@loaders.gl/core";
import { LASLoader } from "@loaders.gl/las";

/**
 * Génère un buffer binaire LAS 1.2 conforme ASPRS minimal (format 0, 20 octets/point).
 * Permet un banc de test 100% déterministe, autonome et sans dépendance réseau.
 */
function createSyntheticLAS12(points) {
  const headerSize = 227;
  const pointRecordLength = 20; // Format 0
  const offsetToPoints = headerSize;
  const numPoints = points.length;
  const totalSize = headerSize + numPoints * pointRecordLength;
  const buf = new Uint8Array(totalSize);
  const view = new DataView(buf.buffer);

  // 0-3: Signature "LASF"
  buf[0] = 0x4c; buf[1] = 0x41; buf[2] = 0x53; buf[3] = 0x46;
  // 24: Version Major = 1
  buf[24] = 1;
  // 25: Version Minor = 2
  buf[25] = 2;
  // 94-95: Header Size = 227
  view.setUint16(94, headerSize, true);
  // 96-99: Offset to point data
  view.setUint32(96, offsetToPoints, true);
  // 100-103: Number of VLRs = 0
  view.setUint32(100, 0, true);
  // 104: Point Data Format = 0
  buf[104] = 0;
  // 105-106: Point Data Record Length = 20
  view.setUint16(105, pointRecordLength, true);
  // 107-110: Number of point records
  view.setUint32(107, numPoints, true);

  // Échelles (0.01 = centimètre) et offsets (ex: coordonnées Lambert/UTM réalistes)
  const scale = 0.01;
  view.setFloat64(131, scale, true); // X scale
  view.setFloat64(139, scale, true); // Y scale
  view.setFloat64(147, scale, true); // Z scale
  const offX = 650000.0;
  const offY = 6860000.0;
  const offZ = 150.0;
  view.setFloat64(155, offX, true); // X offset
  view.setFloat64(163, offY, true); // Y offset
  view.setFloat64(171, offZ, true); // Z offset

  // Points (format 0)
  for (let i = 0; i < numPoints; i++) {
    const pt = points[i];
    const byteOffset = offsetToPoints + i * pointRecordLength;
    const intX = Math.round((pt[0] - offX) / scale);
    const intY = Math.round((pt[1] - offY) / scale);
    const intZ = Math.round((pt[2] - offZ) / scale);
    view.setInt32(byteOffset, intX, true);
    view.setInt32(byteOffset + 4, intY, true);
    view.setInt32(byteOffset + 8, intZ, true);
    view.setUint16(byteOffset + 12, 1000, true); // Intensity
    buf[byteOffset + 14] = 1; // Return 1
    buf[byteOffset + 15] = 2; // Classification (Ground)
  }

  return buf.buffer;
}

async function runTests() {
  console.log("=== Banc de test LAS 1.2 : chargement et parsing @loaders.gl/las ===");

  // 1. Test avec nuage synthétique LAS 1.2
  const testPoints = [
    [650010.5, 6860020.25, 155.1],
    [650012.0, 6860025.0, 156.4],
    [650015.75, 6860018.8, 154.9],
    [650008.2, 6860030.1, 157.0],
  ];
  const syntheticBuffer = createSyntheticLAS12(testPoints);
  console.log(`[1] Nuage synthétique généré (${syntheticBuffer.byteLength} octets, ${testPoints.length} points)`);

  const parsedSynthetic = await parse(syntheticBuffer, LASLoader, {
    worker: false,
    las: { fp64: true },
  });

  assert(parsedSynthetic, "Le résultat du parse ne doit pas être nul");
  const posSynthetic = parsedSynthetic.attributes?.POSITION?.value;
  assert(posSynthetic, "Les positions POSITION.value doivent exister");
  assert(posSynthetic.length === testPoints.length * 3, `Attendu ${testPoints.length * 3} valeurs de coordonnées, reçu ${posSynthetic.length}`);

  for (let i = 0; i < posSynthetic.length; i++) {
    assert(Number.isFinite(posSynthetic[i]), `La coordonnée index ${i} doit être finie (reçu ${posSynthetic[i]})`);
  }
  console.log(`  -> Synthetique : ${posSynthetic.length / 3} points parsés avec succès, toutes positions finies et non vides.`);

  // 2. Test avec nuage de test réel s'il existe sur le système
  const candidatePaths = [
    "D:/work/projet-insitu/test-cloud.las",
    "H:/Mon Drive/claude/_projet-insitu-obsolete-20260822/test-cloud.las",
  ];
  const realFile = candidatePaths.find((p) => fs.existsSync(p));
  if (realFile) {
    console.log(`[2] Nuage de test réel détecté : ${realFile}`);
    const realBuf = fs.readFileSync(realFile);
    const parsedReal = await parse(realBuf, LASLoader, {
      worker: false,
      las: { fp64: true },
    });
    const posReal = parsedReal.attributes?.POSITION?.value;
    assert(posReal && posReal.length > 0, "Le nuage réel doit produire des positions non vides");
    let allFinite = true;
    for (let i = 0; i < posReal.length; i++) {
      if (!Number.isFinite(posReal[i])) {
        allFinite = false;
        break;
      }
    }
    assert(allFinite, "Toutes les positions du nuage réel doivent être finies");
    console.log(`  -> Nuage réel : ${posReal.length / 3} points parsés, positions finies et non vides.`);
  } else {
    console.log("[2] Aucun fichier test-cloud.las externe présent, test synthétique autonome validé.");
  }

  console.log("=== TOUS LES TESTS LAS 1.2 DU BANC SONT VERIFIES (OK) ===");
}

runTests().catch((err) => {
  console.error("ÉCHEC DU BANC LAS :", err);
  process.exit(1);
});
