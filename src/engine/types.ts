/**
 * Types du moteur de calcul de l'application Offre.
 *
 * Port fidele de moteur-calcul/models.py (Python, valide le 04-09/09/2026 contre
 * l'Excel audite). Ne pas modifier la logique metier ici sans repasser par
 * claude/referentiel-regles-metier-excel.md et claude/moteur-calcul-synthese.md
 * dans le projet Claude "Digitalisation Offre We Green".
 */

/**
 * Valeurs alignees telles quelles sur regions.name en base (voir
 * migrations/001_schema_v1.sql) : a ne pas modifier sans repasser par la
 * table `regions`, sous peine de desynchroniser les lookups (cv brackets,
 * auto-consommation, regime de revenus).
 */
export enum Region {
  BRUXELLES = "Bruxelles-Capitale",
  WALLONIE = "Wallonie",
  FLANDRE = "Flandre",
}

export enum RevenueRegime {
  /** Bruxelles : certificats verts par palier de puissance. */
  CV_BRACKET = "cv_bracket",
  /** Flandre et Wallonie : auto-consommation + revente du surplus, sans CV. */
  RESALE_FLAT = "resale_flat",
  // Le regime "taxe prosumer" du classeur Excel n'alimentait que la feuille de
  // presentation "Offre Wallonie<=10kVA", supprimee du perimetre cible
  // (decision de Ben, 02/09/2026). Non porte ici : voir referentiel des
  // regles metier, section 11.2.
}

export interface MarginCurvePoint {
  powerKwc: number;
  suggestedMarginMultiplier: number;
}

export interface CommissionSettings {
  defaultRate: number;
  minRate: number;
  maxRate: number;
}

export function clampCommission(settings: CommissionSettings, rate: number): number {
  return Math.max(settings.minRate, Math.min(settings.maxRate, rate));
}

/** Regle de forfait deplacement decidee par Ben le 02/09/2026. */
export interface TravelCostRule {
  baseFee: number;
  distanceThresholdKm: number;
  distanceSurcharge: number;
  powerThresholdKwc: number;
  powerSurcharge: number;
}

export interface CvBracket {
  powerMinKwc: number;
  powerMaxKwc: number | null;
  grantYearLabel: string;
  rateCvPerMwh: number;
}

export interface Product {
  id: string;
  category: string;
  modelName: string;
  brand: string;
  unitCost: number;
  safetyMarginPct?: number;
  powerKva?: number | null;
  /** Puissance crete en watts (panneaux PV uniquement). Distincte de powerKva
   * (kVA, onduleurs uniquement) : voir migrations/007_products_power_w.sql. */
  powerW?: number | null;
  /** Champs additionnels par categorie (ex : imax_a pour un onduleur,
   * annual_degradation_pct pour un panneau). Voir products.specs en base. */
  specs?: Record<string, unknown>;
  /** Onduleurs uniquement : "Mono" / "Tri + N" / "Tri sans N". */
  phaseType?: string | null;
}

/** Ligne du catalogue carport (table `carport_configs`), Manorga uniquement a ce jour. */
export interface CarportConfig {
  id: string;
  brand: string;
  rowCount: number;
  placeCount: number;
  nbPv: number;
  price: number;
}

/** Ligne du catalogue optimiseurs (table `optimizers`). */
export interface Optimizer {
  id: string;
  brand: string;
  maxPowerW: number;
  unitPrice: number;
}

/** Ligne de cable AC catalogue (table `elec_components`, component_type='cable_ac'). */
export interface CableAcOption {
  id: string;
  modelName: string;
  /** Famille de cable (nombre de conducteurs) : "3G" mono, "5G" tri+N petites
   * sections, "4x"/"3x" grosses sections (conducteurs separes). */
  phases: string;
  sectionMm2: number;
  unitPricePerMeter: number;
}

/** Ligne de cable DC catalogue (table `elec_components`, component_type='cable_dc'). */
export interface CableDcOption {
  id: string;
  modelName: string;
  /** Gamme : "Cca Cu souple 1kV" (circuit +/-) ou "Cca Cu souple vert-jaune"
   * (terre). Seule la gamme 1kV est utilisee pour le dimensionnement du
   * circuit DC ; la terre n'est pas dimensionnee automatiquement (meme
   * niveau d'approximation que le cablage AC, qui ne detaille pas non plus
   * la terre separement). */
  gamme: string;
  sectionMm2: number;
  unitPricePerMeter: number;
}

/** Entree de la table d'ampacite DC (table `elec_components`,
 * component_type='cable_dc_ampacite') : reference technique, pas un article
 * vendable, sert uniquement au choix de section par courant admissible. */
export interface DcAmpacityEntry {
  sectionMm2: number;
  currentMaxA: number;
}

export interface AutoConsumptionDefault {
  hasBattery: boolean;
  defaultRate: number;
}

export interface FinancialParameters {
  networkPricePerKwh: number;
  inflationRate: number;
  cvBuybackPrice: number;
  resalePriceRatio: number;
  /** kWh produits par Wc installe et par an (rendement de production solaire),
   * referentiel section 3. Suggestion, modifiable par offre. */
  productionYieldKwhPerWc: number;
}

export interface BatteryComposition {
  productId: string;
  moduleCost: number;
  chargerCost: number;
  massKg: number;
  laborCost: number;
  energyMeterCost: number;
  panelCost: number;
}

/**
 * Classification demandee par Ben le 10/09/2026 ("differencier la main
 * d'oeuvre des marchandises/materiaux") : trois valeurs plutot que deux pour
 * ne pas forcer les frais payes a des tiers (GRD, certifications, etudes) ni
 * les prestations logistiques (manutention) dans l'une ou l'autre case a
 * tort. Voir migrations/009_labor_and_electrical_options.sql (offer_lines.line_type).
 */
export type LineType = "marchandise" | "main_doeuvre" | "service";

export interface OfferLine {
  category: string;
  description: string;
  quantity: number;
  unitCost: number;
  unitPrice: number;
  marginAppliedAmount: number;
  manuallyOverridden: boolean;
  /** Toggle "Poste ?" des marches publics, OUI par defaut. */
  repartitionPoste: boolean;
  /** Marchandise (par defaut) / main d'oeuvre / service, decision 38. */
  lineType: LineType;
}

/** Tarif main-d'oeuvre pose panneaux par type de toiture (table `labor_roof_rates`). */
export interface LaborRoofRate {
  roofType: string;
  fixedPrice: number;
  threshold1Units: number;
  rateTier1: number;
  threshold2Units: number;
  rateTier2: number;
}

/** Tarif main-d'oeuvre electricien par palier de puissance onduleur (table `labor_electrician_rates`). */
export interface LaborElectricianRate {
  dayRate: number;
  /** "< 10 kVA" | "> 10 kVA" | "> 30 kVA" (voir feuille MO, lignes H2/H3/I3/J3). */
  inverterCountTier: string;
  fixedPrice: number;
  pricePerAdditionalInverter: number;
}

/** Tarif tranchee par type de sol (table `trench_rates`). */
export interface TrenchRate {
  soilType: string;
  pricePerMeter: number;
}

/** Palier de redevance GRD par region (table `grd_fee_schedule`). */
export interface GrdFeeBracket {
  regionId: string;
  powerThresholdKva: number;
  fee: number;
}

/** Palier de provision cablage/matos AC au Wc (table `cabling_forfait_tiers`). */
export interface CablingForfaitTier {
  tierOrder: number;
  powerMaxWc: number | null;
  rateEurPerWc: number;
}

/** Palier de tarif certification electrique (table `electrical_certification_rates`). */
export interface ElectricalCertificationTier {
  tierOrder: number;
  powerThresholdKva: number | null;
  price: number;
}

/** Forfait manutention nomme (table `handling_rates`). */
export interface HandlingRate {
  handlingKey: string;
  label: string;
  price: number;
  unit: string;
}

/** Forfait optionnel divers : Green Box, certification Brugel, etude de stabilite (table `flat_fee_options`). */
export interface FlatFeeOption {
  feeKey: string;
  label: string;
  price: number;
  regionRestriction: string | null;
  category: LineType;
}

/**
 * Ligne du catalogue `elec_components` pour les component_type qui ne sont
 * pas du cablage (cabine_decouplage, transformateur, compteur, ems) : le
 * detail utile est dans `specs` (bareme/kVA, phase, licence...), voir
 * data/catalog.ts pour le detail par type.
 */
export interface ElecOptionComponent {
  id: string;
  componentType: string;
  modelName: string;
  brand: string | null;
  specs: Record<string, unknown>;
  unitPrice: number;
}

export function lineTotalCost(line: OfferLine): number {
  return line.quantity * line.unitCost;
}

export function lineTotalPrice(line: OfferLine): number {
  return line.quantity * line.unitPrice;
}

export function newOfferLine(partial: Partial<OfferLine> & Pick<OfferLine, "category" | "description" | "quantity" | "unitCost">): OfferLine {
  return {
    unitPrice: 0,
    marginAppliedAmount: 0,
    manuallyOverridden: false,
    repartitionPoste: true,
    lineType: "marchandise",
    ...partial,
  };
}

export interface Offer {
  region: Region;
  lines: OfferLine[];
  /** K12 : constante manuelle, editable par le PM. */
  marginPvElectrical: number;
  /** K21 : constante manuelle, editable par le PM. */
  marginBatteryTravel: number;
  commissionRate: number;
  vatRate: number;
  /** undefined = valeur suggeree non surchargee. */
  autoConsumptionRate?: number;
  isPublicTender: boolean;
}
