-- Scénarios du banc RLS des tables bim_*.
-- Exécuté en superutilisateur sur une base locale jetable. Chaque scénario prend le
-- rôle et l'identité indiqués, tente UNE instruction, relève le résultat, puis tout est
-- annulé : les scénarios ne se polluent pas entre eux.
--
-- Deux familles :
--   refus : l'instruction doit être BLOQUÉE (erreur, ou 0 ligne touchée) ;
--   droit : l'instruction doit RÉUSSIR (au moins 1 ligne) pour le propriétaire.
-- Avant la migration, tous les « refus » doivent échouer au banc (c'est le rouge
-- qui prouve que le banc voit le défaut) ; après, tous les scénarios passent.

-- Identités et données de départ (insérées en superutilisateur, hors RLS).
insert into auth.users (id) values
  ('a0000000-0000-4000-8000-00000000000a'),   -- A
  ('b0000000-0000-4000-8000-00000000000b');   -- B

insert into pick_in_situ.chantiers (id, nom, user_id) values
  ('ca000000-0000-4000-8000-000000000001', 'chantier de A', 'a0000000-0000-4000-8000-00000000000a'),
  ('cb000000-0000-4000-8000-000000000001', 'chantier de B', 'b0000000-0000-4000-8000-00000000000b');

insert into pick_in_situ.bim_murs (id, chantier_id, ax, az, bx, bz) values
  ('a1000000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000001', 0, 0, 5, 0),   -- mur 1 de A
  ('a1000000-0000-4000-8000-000000000002', 'ca000000-0000-4000-8000-000000000001', 5, 0, 5, 4),   -- mur 2 de A
  ('b1000000-0000-4000-8000-000000000001', 'cb000000-0000-4000-8000-000000000001', 0, 0, 3, 0);   -- mur 1 de B

insert into pick_in_situ.bim_ouvertures (id, mur_id, pos) values
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 1.5),         -- ouverture de A
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 1.0);         -- ouverture de B

insert into pick_in_situ.bim_dalles (chantier_id, points) values
  ('ca000000-0000-4000-8000-000000000001', '[[0,0],[5,0],[5,4]]'),
  ('cb000000-0000-4000-8000-000000000001', '[[0,0],[3,0],[3,3]]');
insert into pick_in_situ.bim_toits (chantier_id, p1, p2, p3) values
  ('ca000000-0000-4000-8000-000000000001', '[0,3,0]', '[5,3,0]', '[5,3,4]');
insert into pick_in_situ.bim_ancres (chantier_id, x, y, z) values
  ('ca000000-0000-4000-8000-000000000001', 0, 0, 0);

-- Une tentative : prend le rôle, exécute, relève, annule.
create function pg_temp.tenter(p_role text, p_sub text, p_stmt text) returns text
language plpgsql as $$
declare n bigint; r text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
  execute format('set local role %I', p_role);
  begin
    execute p_stmt;
    get diagnostics n = row_count;
    r := 'lignes=' || n;
    raise exception using message = '__annuler__';
  exception when others then
    if sqlerrm <> '__annuler__' then r := 'erreur'; end if;
  end;
  reset role;
  return r;
end $$;

create temp table scenario (id text, famille text, role text, sub text, libelle text, stmt text);
insert into scenario values
-- ---- refus -------------------------------------------------------------------------
('R01','refus','anon',null,'anonyme : lire tous les murs',
  $$select 1 from pick_in_situ.bim_murs$$),
('R02','refus','anon',null,'anonyme : lire les ouvertures',
  $$select 1 from pick_in_situ.bim_ouvertures$$),
('R03','refus','anon',null,'anonyme : poser un mur dans le chantier de A',
  $$insert into pick_in_situ.bim_murs (chantier_id, ax, az, bx, bz) values ('ca000000-0000-4000-8000-000000000001', 9, 9, 9, 10)$$),
('R04','refus','anon',null,'anonyme : supprimer un mur',
  $$delete from pick_in_situ.bim_murs where id = 'a1000000-0000-4000-8000-000000000001'$$),
('R05','refus','anon',null,'anonyme : modifier les ancres',
  $$update pick_in_situ.bim_ancres set x = 99$$),
('R06','refus','authenticated','b0000000-0000-4000-8000-00000000000b','B : lire les murs du chantier de A',
  $$select 1 from pick_in_situ.bim_murs where chantier_id = 'ca000000-0000-4000-8000-000000000001'$$),
('R07','refus','authenticated','b0000000-0000-4000-8000-00000000000b','B : lire les ouvertures du mur de A',
  $$select 1 from pick_in_situ.bim_ouvertures where mur_id = 'a1000000-0000-4000-8000-000000000001'$$),
('R08','refus','authenticated','b0000000-0000-4000-8000-00000000000b','B : poser un mur dans le chantier de A',
  $$insert into pick_in_situ.bim_murs (chantier_id, ax, az, bx, bz) values ('ca000000-0000-4000-8000-000000000001', 9, 9, 9, 10)$$),
('R09','refus','authenticated','b0000000-0000-4000-8000-00000000000b','B : poser une ouverture sur le mur de A',
  $$insert into pick_in_situ.bim_ouvertures (mur_id, pos) values ('a1000000-0000-4000-8000-000000000001', 2)$$),
('R10','refus','authenticated','b0000000-0000-4000-8000-00000000000b','B : modifier le mur de A',
  $$update pick_in_situ.bim_murs set hauteur = 9 where id = 'a1000000-0000-4000-8000-000000000001'$$),
('R11','refus','authenticated','b0000000-0000-4000-8000-00000000000b','B : supprimer les dalles de A',
  $$delete from pick_in_situ.bim_dalles where chantier_id = 'ca000000-0000-4000-8000-000000000001'$$),
('R12','refus','authenticated','b0000000-0000-4000-8000-00000000000b','B : poser un toit dans le chantier de A',
  $$insert into pick_in_situ.bim_toits (chantier_id, p1, p2, p3) values ('ca000000-0000-4000-8000-000000000001', '[0,0,0]', '[1,0,0]', '[1,0,1]')$$),
('R13','refus','authenticated','b0000000-0000-4000-8000-00000000000b','B : poser une ancre dans le chantier de A',
  $$insert into pick_in_situ.bim_ancres (chantier_id, x, y, z) values ('ca000000-0000-4000-8000-000000000001', 1, 1, 1)$$),
('R14','refus','authenticated','b0000000-0000-4000-8000-00000000000b','B : voler l''ouverture de A en la rattachant à son mur',
  $$update pick_in_situ.bim_ouvertures set mur_id = 'b1000000-0000-4000-8000-000000000001' where id = 'a2000000-0000-4000-8000-000000000001'$$),
('R15','refus','authenticated','a0000000-0000-4000-8000-00000000000a','A : rattacher sa propre ouverture au mur de B',
  $$update pick_in_situ.bim_ouvertures set mur_id = 'b1000000-0000-4000-8000-000000000001' where id = 'a2000000-0000-4000-8000-000000000001'$$),
('R16','refus','anon',null,'anonyme : détient le droit TRUNCATE sur bim_murs',
  $$select 1 where has_table_privilege('anon', 'pick_in_situ.bim_murs', 'TRUNCATE')$$),
('R17','refus','authenticated','a0000000-0000-4000-8000-00000000000a','connecté : détient le droit TRUNCATE sur bim_murs (que la RLS ne filtre pas)',
  $$select 1 where has_table_privilege('authenticated', 'pick_in_situ.bim_murs', 'TRUNCATE')$$),
('R18','refus','anon',null,'anonyme : détient le droit SELECT sur bim_ouvertures',
  $$select 1 where has_table_privilege('anon', 'pick_in_situ.bim_ouvertures', 'SELECT')$$),
-- ---- droit -------------------------------------------------------------------------
('D01','droit','authenticated','a0000000-0000-4000-8000-00000000000a','A : lire ses murs',
  $$select 1 from pick_in_situ.bim_murs where chantier_id = 'ca000000-0000-4000-8000-000000000001'$$),
('D02','droit','authenticated','a0000000-0000-4000-8000-00000000000a','A : lire les ouvertures de son mur',
  $$select 1 from pick_in_situ.bim_ouvertures where mur_id = 'a1000000-0000-4000-8000-000000000001'$$),
('D03','droit','authenticated','a0000000-0000-4000-8000-00000000000a','A : poser un mur dans son chantier',
  $$insert into pick_in_situ.bim_murs (chantier_id, ax, az, bx, bz) values ('ca000000-0000-4000-8000-000000000001', 9, 9, 9, 10)$$),
('D04','droit','authenticated','a0000000-0000-4000-8000-00000000000a','A : modifier son mur',
  $$update pick_in_situ.bim_murs set hauteur = 3 where id = 'a1000000-0000-4000-8000-000000000001'$$),
('D05','droit','authenticated','a0000000-0000-4000-8000-00000000000a','A : supprimer son second mur',
  $$delete from pick_in_situ.bim_murs where id = 'a1000000-0000-4000-8000-000000000002'$$),
('D06','droit','authenticated','a0000000-0000-4000-8000-00000000000a','A : poser une ouverture sur son mur',
  $$insert into pick_in_situ.bim_ouvertures (mur_id, pos) values ('a1000000-0000-4000-8000-000000000001', 2)$$),
('D07','droit','authenticated','a0000000-0000-4000-8000-00000000000a','A : déplacer son ouverture sur son autre mur (découpe d''un mur)',
  $$update pick_in_situ.bim_ouvertures set mur_id = 'a1000000-0000-4000-8000-000000000002' where id = 'a2000000-0000-4000-8000-000000000001'$$),
('D08','droit','authenticated','a0000000-0000-4000-8000-00000000000a','A : poser une dalle dans son chantier',
  $$insert into pick_in_situ.bim_dalles (chantier_id, points) values ('ca000000-0000-4000-8000-000000000001', '[[0,0],[1,0],[1,1]]')$$),
('D09','droit','authenticated','a0000000-0000-4000-8000-00000000000a','A : poser un toit dans son chantier',
  $$insert into pick_in_situ.bim_toits (chantier_id, p1, p2, p3) values ('ca000000-0000-4000-8000-000000000001', '[0,0,0]', '[1,0,0]', '[1,0,1]')$$),
('D10','droit','authenticated','a0000000-0000-4000-8000-00000000000a','A : poser une ancre dans son chantier',
  $$insert into pick_in_situ.bim_ancres (chantier_id, x, y, z) values ('ca000000-0000-4000-8000-000000000001', 1, 1, 1)$$),
('D11','droit','authenticated','b0000000-0000-4000-8000-00000000000b','B : lire ses propres murs',
  $$select 1 from pick_in_situ.bim_murs where chantier_id = 'cb000000-0000-4000-8000-000000000001'$$);

-- Sortie lisible par machine : SCENARIO|id|famille|obtenu|OK ou ECHEC|libellé
select format('SCENARIO|%s|%s|%s|%s|%s', s.id, s.famille, r.obtenu,
         case when s.famille = 'refus' and (r.obtenu = 'erreur' or r.obtenu = 'lignes=0') then 'OK'
              when s.famille = 'droit' and r.obtenu ~ '^lignes=[1-9]' then 'OK'
              else 'ECHEC' end,
         s.libelle)
from scenario s
cross join lateral (select pg_temp.tenter(s.role, s.sub, s.stmt) as obtenu) r
order by s.id;
