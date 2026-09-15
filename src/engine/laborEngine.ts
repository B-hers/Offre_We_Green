/**
 * Main-d'oeuvre et postes electriques optionnels absents du moteur avant le
 * 10/09/2026 (decision 38, cf. claude/cartographie-et-plan-action.md et
 * claude/referentiel-regles-metier-excel.md sections 4.4 a 4.7) : provision
 * cablage/matos AC au Wc, main-d'oeuvre toiture/electricien, tranchees,
 * redevance GRD, certification electrique, cabine de decouplage, EMS.
 *
 * Meme discipline que les autres modules du moteur : chaque fonction ici
 * reproduit une formule precisement identifiee dans le classeur Excel audite
 * (jamais une regle devinee), avec le renvoi vers la section du referentiel
 * en commentaire. Les valeurs de test dans engine/validate.ts proviennent
 * toutes du MEME cas de reference deja utilise par les autres modules (16
 * panneaux Jinko 515W, Huawei SUN2000 25kW KTL-MB0 = 27,5 kVA, toiture plate,
 * Bruxelles-Capitale) : elles ont ete lues directement dans les cellules du
 * classeur, pas recalculees a la main.
 */

import type {
  CablingForfaitTier,
  ElecOptionComponent,
  ElectricalCertificationTier,
  GrdFeeBracket,
  LaborElectricianRate,
  LaborRoofRate,
  TrenchRate,
} from "./types";

/**
 * Main-d'oeuvre pose panneaux par type de toiture (referentiel section 9).
 * Reproduit le bareme a 3 paliers observe en base (`labor_roof_rates`) :
 * prix fixe jusqu'a threshold1, taux tier1 entre threshold1 et threshold2,
 * taux tier2 au-dela. Pour les toitures inclinee/ardoise, tier1 == tier2
 * dans les donnees importees (un seul taux continu au-dela du seuil 1,
 * conforme a la formule Excel a 2 branches de ces toitures) : la meme
 * formule generale a 3 paliers s'applique donc sans cas particulier.
 */
export function roofLaborCost(panelCount: number, rate: LaborRoofRate): number {
  if (panelCount <= rate.threshold1Units) return rate.fixedPrice;
  if (panelCount <= rate.threshold2Units) {
    return rate.fixedPrice + (panelCount - rate.threshold1Units) * rate.rateTier1;
  }
  return (
    rate.fixedPrice +
    (rate.threshold2Units - rate.threshold1Units) * rate.rateTier1 +
    (panelCount - rate.threshold2Units) * rate.rateTier2
  );
}

/**
 * Choisit le palier main-d'oeuvre electricien selon la puissance totale des
 * onduleurs (kVA) : <10 / [10,30[ / >=30 (feuille MO, lignes H3/I3/J3).
 */
export function pickElectricianRateTier(powerKva: number, rates: LaborElectricianRate[]): LaborElectricianRate {
  const tierLabel = powerKva < 10 ? "< 10 kVA" : powerKva < 30 ? "> 10 kVA" : "> 30 kVA";
  const match = rates.find((r) => r.inverterCountTier === tierLabel);
  if (!match) throw new Error(`Aucun tarif main-d'oeuvre electricien pour le palier "${tierLabel}".`);
  return match;
}

/**
 * Cout main-d'oeuvre electricien pour N onduleurs du meme palier de
 * puissance : prix fixe + prix par onduleur supplementaire x (N-1).
 * Reproduit 'MO '!H7 = H4+H5*(H3-1) dans le cas a un seul palier represente
 * (le modele actuel de l'app ne propose qu'un seul onduleur, N=1 -> le terme
 * additionnel s'annule).
 */
export function electricianLaborCost(inverterCount: number, rate: LaborElectricianRate): number {
  if (inverterCount <= 0) return 0;
  return rate.fixedPrice + rate.pricePerAdditionalInverter * (inverterCount - 1);
}

/** Tranchee : prix au metre selon le type de sol (referentiel section 9). */
export function trenchCost(lengthM: number, rate: TrenchRate): number {
  return lengthM * rate.pricePerMeter;
}

/**
 * Redevance GRD (referentiel section 9 et 4.7) : reproduit
 * VLOOKUP(puissance, bareme, ..., TRUE) -- le palier dont le seuil est le
 * plus grand tout en restant <= a la puissance du projet (recherche
 * approximative standard Excel).
 */
export function grdFee(powerKva: number, regionId: string, schedule: GrdFeeBracket[]): number {
  const candidates = schedule
    .filter((b) => b.regionId === regionId && b.powerThresholdKva <= powerKva)
    .sort((a, b) => b.powerThresholdKva - a.powerThresholdKva);
  if (candidates.length === 0) {
    throw new Error(`Aucun palier de redevance GRD pour ${powerKva} kVA dans cette region.`);
  }
  return candidates[0].fee;
}

/**
 * Taux de provision "Cablage"/"Matos AC" au Wc crete (referentiel 4.4).
 * Reproduit F23/F24 = IF(Wc<7700, 0.03, IF(Wc>25000, 0.015, 0.02)),
 * generalise a une table de 3 paliers ordonnes (voir migrations/
 * 009_labor_and_electrical_options.sql) : seul le premier palier utilise une
 * comparaison stricte (<), les suivants une comparaison large (<=), pour
 * reproduire exactement les bornes de la formule Excel (7700 est dans le
 * palier 2, pas le palier 1).
 */
export function cablingForfaitRate(wc: number, tiers: CablingForfaitTier[]): number {
  const sorted = [...tiers].sort((a, b) => a.tierOrder - b.tierOrder);
  for (let i = 0; i < sorted.length; i++) {
    const tier = sorted[i];
    if (tier.powerMaxWc === null) return tier.rateEurPerWc;
    const withinTier = i === 0 ? wc < tier.powerMaxWc : wc <= tier.powerMaxWc;
    if (withinTier) return tier.rateEurPerWc;
  }
  throw new Error("Bareme de provision cablage incomplet (aucun palier ne couvre cette puissance).");
}

/**
 * Cout de la ligne "Cablage" ou "Matos AC" : taux au Wc x puissance
 * installee, majore de `complexityMultiplier` si la configuration est jugee
 * "compliquee" (choix manuel, reproduit E23/E24).
 */
export function cablingForfaitCost(
  wc: number,
  tiers: CablingForfaitTier[],
  isComplique: boolean,
  complexityMultiplier: number,
): number {
  const rate = cablingForfaitRate(wc, tiers);
  return rate * wc * (isComplique ? complexityMultiplier : 1);
}

/**
 * Certification electrique (referentiel 4.6) : toujours active, forfait par
 * palier de puissance onduleur. Reproduit F25 = IF(G4<=10,115,250).
 */
export function electricalCertificationPrice(powerKva: number, tiers: ElectricalCertificationTier[]): number {
  const sorted = [...tiers].sort((a, b) => a.tierOrder - b.tierOrder);
  for (const tier of sorted) {
    if (tier.powerThresholdKva === null) return tier.price;
    if (powerKva <= tier.powerThresholdKva) return tier.price;
  }
  throw new Error("Bareme de certification electrique incomplet.");
}

/**
 * Cabine de decouplage (referentiel 4.6) : declenchee automatiquement au-dela
 * de 30 kVA d'onduleurs, tarif par palier de puissance (recherche
 * approximative, plus grand seuil <= puissance, cf. `elec_components`,
 * component_type='cabine_decouplage', specs.power_threshold_from_kva).
 * Renvoie 0 (et non une erreur) en dessous du premier palier : c'est
 * exactement la donnee du premier palier du catalogue ("Max 30 kVA", seuil 0,
 * prix 0), pas un cas particulier code en dur.
 */
export function cabineDecouplagePrice(powerKva: number, catalog: ElecOptionComponent[]): number {
  const candidates = catalog
    .map((c) => ({ component: c, threshold: Number(c.specs?.power_threshold_from_kva ?? NaN) }))
    .filter((x) => !Number.isNaN(x.threshold) && x.threshold <= powerKva)
    .sort((a, b) => b.threshold - a.threshold);
  if (candidates.length === 0) {
    throw new Error(`Aucun palier de cabine de decouplage ne couvre ${powerKva} kVA.`);
  }
  return candidates[0].component.unitPrice;
}

/**
 * Frais de licence EMS (referentiel 4.6). Reproduit
 * M49/M50 = 5 * 1,5 * 'Calcul du prix'!G4, ou G4 est la puissance totale des
 * onduleurs en kVA (pas la puissance crete PV en kWc, malgre le nom de la
 * cle `license_fee_per_kwc` stockee en base -- c'est le nom du champ dans le
 * classeur d'origine qui pretait a confusion, la formule elle-meme multiplie
 * bien par la puissance onduleur). La constante 7,5 (= 5 x 1,5) est deja
 * stockee telle quelle dans `elec_components.specs.license_fee_per_kwc` pour
 * les marques qui facturent une licence (Nexxtlab, ENIRIS) ; 0 sinon.
 */
export function emsLicenseFee(inverterPowerKva: number, ems: ElecOptionComponent): number {
  const requiresLicense = Boolean(ems.specs?.requires_license);
  if (!requiresLicense) return 0;
  const feePerKva = Number(ems.specs?.license_fee_per_kwc ?? 0);
  return feePerKva * inverterPowerKva;
}

/** Nombre de voyages de transport necessaires : QUOTIENT(nb_panneaux, panneaux_par_voyage). */
export function transportTripsForPanels(panelCount: number, panelsPerTrip: number): number {
  if (panelsPerTrip <= 0) return 0;
  return Math.floor(panelCount / panelsPerTrip);
}
