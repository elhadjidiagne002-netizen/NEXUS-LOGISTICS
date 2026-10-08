-- =====================================================================
-- Jeu de données FICTIF — tests et mode démo uniquement.
-- Identifiants fixes pour que les tests et l'app démo s'y réfèrent.
-- Ne jamais exécuter sur la base réelle.
-- =====================================================================

-- Zones : les 42 zones réelles (relevées le 07/10/2026)
insert into public.delivery_zones (name, lat, lng, city) values
 ('Almadies',14.744,-17.523,'Dakar'),('Amitié',14.7,-17.455,'Dakar'),('Baobab',14.713,-17.472,'Dakar'),
 ('Bargny',14.694,-17.226,'Bargny'),('Biscuiterie',14.705,-17.445,'Dakar'),('Cambérène',14.755,-17.455,'Dakar'),
 ('Cité Keur Gorgui',14.718,-17.468,'Dakar'),('Colobane',14.687,-17.44,'Dakar'),('Dakar-Plateau',14.67,-17.438,'Dakar'),
 ('Derklé',14.723,-17.453,'Dakar'),('Diamniadio',14.728,-17.184,'Diamniadio'),('Dieuppeul',14.72,-17.45,'Dakar'),
 ('Fann',14.687,-17.465,'Dakar'),('Fass',14.687,-17.447,'Dakar'),('Gibraltar',14.672,-17.44,'Dakar'),
 ('Grand Dakar',14.71,-17.448,'Dakar'),('Grand Yoff',14.735,-17.445,'Dakar'),('Guédiawaye',14.77,-17.406,'Guédiawaye'),
 ('Gueule Tapée',14.68,-17.447,'Dakar'),('Hann Bel-Air',14.708,-17.43,'Dakar'),('Hann Maristes',14.702,-17.44,'Dakar'),
 ('HLM',14.715,-17.445,'Dakar'),('Liberté 6',14.719,-17.463,'Dakar'),('Mbour',14.42,-16.966,'Mbour'),
 ('Médina',14.683,-17.454,'Dakar'),('Mermoz',14.708,-17.475,'Dakar'),('Ngor',14.746,-17.517,'Dakar'),
 ('Nord Foire',14.755,-17.468,'Dakar'),('Ouakam',14.722,-17.49,'Dakar'),('Ouest Foire',14.745,-17.465,'Dakar'),
 ('Parcelles',14.767,-17.429,'Dakar'),('Patte d''Oie',14.735,-17.455,'Dakar'),('Pikine',14.755,-17.39,'Pikine'),
 ('Point E',14.695,-17.465,'Dakar'),('Rebeuss',14.665,-17.43,'Dakar'),('Rufisque',14.715,-17.273,'Rufisque'),
 ('Sacré-Cœur',14.715,-17.47,'Dakar'),('Sébikotane',14.748,-17.137,'Sébikotane'),('Sicap Liberté',14.715,-17.46,'Dakar'),
 ('Thiès',14.791,-16.926,'Thiès'),('Yarakh',14.695,-17.43,'Dakar'),('Yoff',14.755,-17.473,'Dakar')
on conflict do nothing;

-- Personnes
insert into public.profiles (id, email, name, role, phone, company_name, ninea, rc, address) values
 ('00000000-0000-4000-a000-000000000001','admin@demo.sn','Mo Admin','admin','+221770000001',null,null,null,null),
 ('00000000-0000-4000-a000-000000000002','prep@demo.sn','Fatou Préparatrice','buyer','+221770000002',null,null,null,null),
 ('00000000-0000-4000-a000-000000000003','quai@demo.sn','Ousmane Chef de quai','buyer','+221770000003',null,null,null,null),
 ('00000000-0000-4000-a000-000000000004','dispatch@demo.sn','Aïssatou Répartitrice','buyer','+221770000004',null,null,null,null),
 ('00000000-0000-4000-a000-000000000005','caisse@demo.sn','Babacar Caissier','buyer','+221770000005',null,null,null,null),
 ('00000000-0000-4000-a000-000000000006','moussa@demo.sn','Moussa Chauffeur','buyer','+221770000006',null,null,null,null),
 ('00000000-0000-4000-a000-000000000007','vendeur@demo.sn','Boutique Ndèye','vendor','+221770000007','Ndèye Distribution SARL','0071234562V2','SN-DKR-2024-B-1234','Marché Sandaga, Dakar'),
 ('00000000-0000-4000-a000-000000000008','compta@demo.sn','Khady Comptable','buyer','+221770000008',null,null,null,null),
 ('00000000-0000-4000-a000-000000000009','ibra@demo.sn','Ibrahima Chauffeur','buyer','+221770000009',null,null,null,null),
 ('00000000-0000-4000-a000-000000000010','sav@demo.sn','Coumba Service client','buyer','+221770000010',null,null,null,null),
 ('00000000-0000-4000-a000-000000000011','cheikh@demo.sn','Cheikh Chauffeur','buyer','+221770000011',null,null,null,null)
on conflict do nothing;

insert into public.lg_hubs (id, name, kind, address, lat, lng) values
 ('10000000-0000-4000-a000-000000000001','Hub Dakar','hub','Zone industrielle, Hann', 14.7065,-17.4355)
on conflict do nothing;

insert into public.lg_staff_roles (user_id, role, hub_id) values
 ('00000000-0000-4000-a000-000000000002','picker','10000000-0000-4000-a000-000000000001'),
 ('00000000-0000-4000-a000-000000000003','dock_chief','10000000-0000-4000-a000-000000000001'),
 ('00000000-0000-4000-a000-000000000004','dispatcher','10000000-0000-4000-a000-000000000001'),
 ('00000000-0000-4000-a000-000000000005','cashier','10000000-0000-4000-a000-000000000001'),
 ('00000000-0000-4000-a000-000000000008','accountant',null),
 ('00000000-0000-4000-a000-000000000010','support',null)
on conflict do nothing;

insert into public.couriers (id, user_id, name, phone, vehicle_type, status) values
 ('20000000-0000-4000-a000-000000000001','00000000-0000-4000-a000-000000000006','Moussa K.','+221770000006','fourgonnette','active'),
 ('20000000-0000-4000-a000-000000000002','00000000-0000-4000-a000-000000000009','Ibrahima S.','+221770000009','moto','active'),
 ('20000000-0000-4000-a000-000000000003','00000000-0000-4000-a000-000000000011','Cheikh N.','+221770000011','tricycle','active')
on conflict do nothing;

insert into public.lg_vehicles (id, plate, kind, label, capacity_kg, capacity_l, max_packages, equipment, hub_id, default_courier_id) values
 ('30000000-0000-4000-a000-000000000001','DK-4521-BF','fourgonnette','Fourgonnette blanche',600,3000,40,'{bâche}','10000000-0000-4000-a000-000000000001','20000000-0000-4000-a000-000000000001'),
 ('30000000-0000-4000-a000-000000000002','DK-1187-AM','moto','Moto caisson',40,90,6,'{caisson}','10000000-0000-4000-a000-000000000001','20000000-0000-4000-a000-000000000002'),
 ('30000000-0000-4000-a000-000000000003','DK-7730-TC','tricycle','Tricycle',300,1200,20,'{glacière}','10000000-0000-4000-a000-000000000001','20000000-0000-4000-a000-000000000003')
on conflict do nothing;

-- Produits (prix en EUR, comme la prod ; affichage FCFA = × 655,957)
insert into public.products (id, name, category, price, stock, vendor_id, vendor_name, barcode, sku, weight_g, length_cm, width_cm, height_cm, handling) values
 ('41000000-0000-4000-a000-000000000001','Riz parfumé 5 kg','Épicerie',7.62,40,'00000000-0000-4000-a000-000000000007','Boutique Ndèye','6111234500017','RIZ-5',5000,40,28,10,'{alimentaire}'),
 ('42000000-0000-4000-a000-000000000002','Huile 1 L','Épicerie',2.29,60,'00000000-0000-4000-a000-000000000007','Boutique Ndèye','6111234500024','HUI-1',950,8,8,30,'{liquide,alimentaire}'),
 ('43000000-0000-4000-a000-000000000003','Œufs, plateau de 30','Épicerie',4.57,12,'00000000-0000-4000-a000-000000000007','Boutique Ndèye',null,'OEUF-30',1900,30,30,8,'{fragile,alimentaire}'),
 ('44000000-0000-4000-a000-000000000004','Savon de Marseille x4','Entretien',3.05,30,'00000000-0000-4000-a000-000000000007','Boutique Ndèye','6111234500048','SAV-4',600,15,10,8,'{}'),
 ('45000000-0000-4000-a000-000000000005','Ventilateur sur pied','Maison',27.44,5,'00000000-0000-4000-a000-000000000007','Boutique Ndèye','6111234500055','VEN-1',4200,45,40,25,'{fragile}')
on conflict do nothing;
insert into public.products (id, name, price, stock, vendor_id, is_educational) values
 ('49000000-0000-4000-a000-000000000009','Formation Excel (en ligne)',15.24,999,'00000000-0000-4000-a000-000000000007',true)
on conflict do nothing;
update public.products set is_shippable = false where id = '49000000-0000-4000-a000-000000000009';

update public.profiles set home_lat = 14.6705, home_lng = -17.4388 where id = '00000000-0000-4000-a000-000000000007';

-- Entrepôt du hub : emplacements et produits rangés (cycle 4)
insert into public.lg_stock_locations (id, hub_id, code, kind, label) values
 ('50000000-0000-4000-a000-000000000001','10000000-0000-4000-a000-000000000001','A-01-1','shelf','Épicerie sèche'),
 ('50000000-0000-4000-a000-000000000002','10000000-0000-4000-a000-000000000001','A-02-1','shelf','Huiles et liquides'),
 ('50000000-0000-4000-a000-000000000003','10000000-0000-4000-a000-000000000001','A-10-2','shelf','Fragile'),
 ('50000000-0000-4000-a000-000000000004','10000000-0000-4000-a000-000000000001','B-03-1','shelf','Entretien'),
 ('50000000-0000-4000-a000-000000000005','10000000-0000-4000-a000-000000000001','C-01-0','floor','Gros volumes')
on conflict do nothing;
insert into public.lg_product_locations (product_id, location_id, qty) values
 ('41000000-0000-4000-a000-000000000001','50000000-0000-4000-a000-000000000001',30),
 ('42000000-0000-4000-a000-000000000002','50000000-0000-4000-a000-000000000002',40),
 ('43000000-0000-4000-a000-000000000003','50000000-0000-4000-a000-000000000003',10),
 ('44000000-0000-4000-a000-000000000004','50000000-0000-4000-a000-000000000004',25),
 ('45000000-0000-4000-a000-000000000005','50000000-0000-4000-a000-000000000005',4)
on conflict do nothing;

-- Quais du hub (cycle 11)
insert into public.lg_docks (id, hub_id, code, label) values
 ('60000000-0000-4000-a000-000000000001','10000000-0000-4000-a000-000000000001','Q1','Grand quai (fourgonnettes)'),
 ('60000000-0000-4000-a000-000000000002','10000000-0000-4000-a000-000000000001','Q2','Quai motos'),
 ('60000000-0000-4000-a000-000000000003','10000000-0000-4000-a000-000000000001','Q3','Quai tricycles')
on conflict do nothing;
