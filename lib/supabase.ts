import { createClient } from "@supabase/supabase-js";

const supabaseURL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseURL, supabaseKey, {
  db: { schema: "pick_in_situ" },
});

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
  offset_angle: number;
  captured_at: string;
}

export function meshPublicUrl(path: string) {
  return supabase.storage.from("pis-scans").getPublicUrl(path).data.publicUrl;
}
