// Lecture du gabarit CSV d'import de commandes (src/lib/csv.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOrdersCsv } from '../../src/lib/csv.js';

test('gabarit : une commande par référence, plusieurs articles, paiement et frais', () => {
  const csv = '﻿référence;client;téléphone;adresse;repere;zone;article;quantite;prix_unitaire;poids_kg;paiement;frais_livraison;note\r\n'
    + 'CMD-1;Aminata Diop;771234567;"Villa 12; Mermoz";face pharmacie;Mermoz;Huile 5 L;2;6000;5;livraison;;\r\n'
    + 'CMD-1;Aminata Diop;771234567;;;Mermoz;Savon;3;500;0,2;livraison;;\r\n'
    + 'CMD-2;Ousmane;781112233;;;Médina;"Robe ""wax""";1;15 000;;payé;1500;Appeler\r\n\r\n';
  const o = parseOrdersCsv(csv);
  assert.equal(o.length, 2);
  assert.equal(o[0].customer.address, 'Villa 12; Mermoz');
  assert.deepEqual(o[0].items.map((x) => [x.name, x.quantity, x.unit_price_fcfa, x.weight_g]), [['Huile 5 L', 2, 6000, 5000], ['Savon', 3, 500, 200]]);
  assert.deepEqual([o[0].payment_method, o[0].delivery_fee_fcfa], ['cod', null]);
  assert.deepEqual([o[1].items[0].name, o[1].items[0].unit_price_fcfa, o[1].payment_method, o[1].delivery_fee_fcfa, o[1].note], ['Robe "wax"', 15000, 'prepaid', 1500, 'Appeler']);
  assert.equal(o[1]._line, 4);
});

test('séparateur virgule', () => {
  const o = parseOrdersCsv('reference,client,telephone,zone,article,quantite,prix_unitaire\nA,Awa,770000000,Yoff,Pain,1,200\n');
  assert.deepEqual([o[0].external_ref, o[0].zone, o[0].items[0].unit_price_fcfa], ['A', 'Yoff', 200]);
});
