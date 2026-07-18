import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Sanitize les variables d'env : supprime les caractères Unicode invisibles
// (zero-width space, BOM…) qui peuvent s'introduire par copier-coller depuis
// un navigateur et provoquer "String contains non ISO-8859-1 code point" lors
// des appels Auth (Authorization: Bearer <key> est un header HTTP).
// Les clés JWT Supabase ne contiennent que des caractères ASCII valides.
const sanitize = (v?: string) => (v ?? "").trim().replace(/[^\x00-\x7F]/g, "");

let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (!_client) {
    _client = createClient(
      sanitize(process.env.NEXT_PUBLIC_SUPABASE_URL),
      sanitize(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    );
  }
  return _client;
}

// Initialisation paresseuse : le client n'est créé qu'au premier accès réel,
// jamais à l'import du module — un build dont les variables d'env Supabase
// manquent (environnement Vercel incomplet) ne peut donc plus échouer avec
// "supabaseUrl is required" pendant le prerendering.
function lazy<T extends object>(make: () => T): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      const obj = make() as Record<PropertyKey, unknown>;
      const value = obj[prop as keyof typeof obj];
      return typeof value === "function" ? value.bind(obj) : value;
    },
  });
}

export const supabase = lazy(() => getClient());

// Pour les requêtes de données dans le schéma pick_in_situ, utilisez :
//   supabase.schema("pick_in_situ").from("ma_table")...
// ou utilisez le helper db ci-dessous.
export const db = lazy(() => getClient().schema("pick_in_situ"));

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
