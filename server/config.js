// Réglages d'une entreprise (companies.settings, JSON). Équivalent de lg_cfg() / lg_set_config()
// de la version Postgres : mêmes clés, mêmes valeurs par défaut. Montants en FCFA entiers.

export const CONFIG_DEFAULTS = {
  max_attempts: 2,            // présentations avant retour au vendeur
  proof_radius_m: 300,        // au-delà, livraison acceptée mais signalée
  cash_limit_fcfa: 150000,    // plafond d'espèces porté par un chauffeur
  pick_lock_minutes: 15,      // libération d'une préparation inactive
  tva_rate: 18,
  detour_coef: 1.35,          // distance à vol d'oiseau × coefficient
  otp_ttl_hours: 48,
  otp_attempts: 3,
  heavy_kg: 15,
  require_photo: true,
  staged_max_hours: 24,
  stop_max_minutes: 15,
  offline_max_minutes: 20,
  pay_per_package: 500,
  pay_fixed_trip: 0,
  bonus_zero_failure: 1000,
  bonus_on_time: 0,
  double_check_fcfa: 100000,  // valeur de commande au-delà de laquelle un second contrôle est exigé
  invoice_issuer: 'company',  // la facture est émise au nom de l'entreprise de livraison ('vendor' : au nom du vendeur)
  company_ninea: null,        // mentions légales des factures
  company_rc: null,
  company_address: null,
  commission_pct: 0,          // commission retenue sur les produits des vendeurs (relevé de reversement)
  manager_phone: null,
  manager_email: null,
  peak_days: [],
  expiry_alert_days: 30,
  insurance_rate_pct: 2,
  insurance_min_fcfa: 300,
  insurance_max_value_fcfa: 1000000,
  uninsured_cap_fcfa: 50000,
  maintenance_alert_km: 500,
  auto_arrive_m: 80,
  prep_at_vendor: false,      // true : la commande d'un vendeur membre se prépare chez lui (sinon au hub)
};

export const CONFIG_KEYS = Object.keys(CONFIG_DEFAULTS);

export function parseSettings(text) {
  try {
    const v = JSON.parse(text || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Réglages complets d'une entreprise (valeurs par défaut + valeurs enregistrées). */
export function companyConfig(company) {
  return { ...CONFIG_DEFAULTS, ...parseSettings(company?.settings) };
}

/** Ne garde que les clés connues ; types vérifiés sommairement (nombre, booléen, texte, liste). */
export function cleanConfig(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const k of CONFIG_KEYS) {
    if (!(k in input)) continue;
    const def = CONFIG_DEFAULTS[k];
    let v = input[k];
    if (typeof def === 'number') {
      v = Number(v);
      if (!Number.isFinite(v) || v < 0) continue;
    } else if (typeof def === 'boolean') {
      v = v === true || v === 'true' || v === 1;
    } else if (Array.isArray(def)) {
      if (!Array.isArray(v)) continue;
      v = v.slice(0, 50);
    } else {
      v = v === null || v === '' ? null : String(v).slice(0, 200);
    }
    out[k] = v;
  }
  return out;
}
