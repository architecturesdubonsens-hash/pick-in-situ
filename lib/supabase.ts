import { createClient } from "@supabase/supabase-js";

// Sanitize les variables d'env : supprime les caractères Unicode invisibles
// (zero-width space, BOM…) qui peuvent s'introduire par copier-coller depuis
// un navigateur et provoquer "String contains non ISO-8859-1 code point" lors
// des appels Auth (Authorization: Bearer <key> est un header HTTP).
// Les clés JWT Supabase ne contiennent que des caractères ASCII valides.
const supabaseURL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim().replace(/[^\x00-\x7F]/g, '');
const supabaseKeyRaw = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim().replace(/[^\x00-\x7F]/g, '');

export const supabase = createClient(supabaseURL, supabaseKeyRaw);

// Pour les requêtes de données dans le schéma pick_in_situ, utilisez :
//   supabase.schema("pick_in_situ").from("ma_table")...
// ou utilisez le helper db ci-dessous.
export const db = supabase.schema("pick_in_situ");

export type ScanStatus = "capturing" | "processing" | "ready" | "failed";

export interface Chantier {
  id: string;
  nom: string;
  adresse: string | null;
  created_at: string;
}

export interface Scan {
  id: string;
  chantier_id: string;
  nom: string;
  status: ScanStatus;
  roomplan_path: string | null;
  mesh_path: string | null;
  offset_x: number;
  offset_y: number;
  offset_z: number;
  offset_angle: number;
  tilt_x: number;
  tilt_z: number;
  captured_at: string;
}

export function meshPublicUrl(path: string) {
  return supabase.storage.from("pis-scans").getPublicUrl(path).data.publicUrl;
}
