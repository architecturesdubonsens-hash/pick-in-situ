-- PICK-NUAGE-1 : filière d'import du nuage de points LAS/LAZ (web_laz)
-- Le scan Pick In Situ acquiert un nuage de points (relevé photogrammétrique, LAZ léger),
-- en plus du maillage GLB. On ajoute la colonne qui référence le chemin du nuage dans le
-- bucket "pis-scans".
ALTER TABLE IF EXISTS scans ADD COLUMN IF NOT EXISTS points_laz_path text;
