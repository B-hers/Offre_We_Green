/**
 * Couche d'acces aux donnees : lit le catalogue et les tables de parametres
 * depuis Supabase (source de verite, voir claude/cartographie-et-plan-action.md
 * section 8) et les convertit vers les types du moteur de calcul
 * (src/engine/types.ts). Aucune logique de calcul ici : uniquement de la
 * lecture et un mapping snake_case -> camelCase.
 */

import { supabase } from "../supabaseClient";
import type {
  AutoConsumptionDefault,
  BatteryComposition,
  CableAcOption,
  CableDcOption,
  CablingForfaitTier,
  CarportConfig,
  CvBracket,
  DcAmpacityEntry,
  ElecOptionComponent,
  ElectricalCertificationTier,
  FinancialParameters,
  FlatFeeOption,
  GrdFeeBracket,
  HandlingRate,
  LaborElectricianRate,
  LaborRoofRate,
  MarginCurvePoint,
  Optimizer,
  Product,
  TravelCostRule,
  TrenchRate,
  CommissionSettings,
} from "../engine/types";
import {
  DEFAULT_CABLE_SIZING_PARAMETERS,
  selectCableSection,
  selectDcCableSectionByAmpacity,
  type CableSizingParameters,
} from "../engine/cableEngine";

function requireClient() {
  if (!supabase) {
    throw new Error(
      "Supabase n'est pas configure (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY manquants). " +
        "Voir .env.example.",
    );
  }
  return supabase;
}

export async function fetchProductsByCategory(categoryName: string): Promise<Product[]> {
  const client = requireClient();
  const { data, error } = await client
    .from("products")
    .select(
      "id, model_name, brand, unit_cost, safety_margin_pct, power_kva, power_w, phase_type, specs, datasheet_path, datasheet_filename, product_categories!inner(name)",
    )
    .eq("product_categories.name", categoryName)
    .eq("active", true)
    .order("power_kva", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    id: row.id,
    category: categoryName,
    modelName: row.model_name,
    brand: row.brand,
    unitCost: Number(row.unit_cost),
    safetyMarginPct: row.safety_margin_pct !== null ? Number(row.safety_margin_pct) : undefined,
    powerKva: row.power_kva !== null ? Number(row.power_kva) : null,
    powerW: row.power_w !== null ? Number(row.power_w) : null,
    specs: row.specs ?? {},
    phaseType: row.phase_type ?? null,
    datasheetPath: row.datasheet_path ?? null,
    datasheetFilename: row.datasheet_filename ?? null,
  }));
}

/** Bucket Storage dedie aux fiches techniques PDF des articles du catalogue (decision 50, migration product_datasheets). */
export const PRODUCT_DATASHEETS_BUCKET = "product-datasheets";

/**
 * URL publique d'une fiche technique a partir de son chemin en base
 * (`products.datasheet_path`). Bucket public en lecture (meme principe que la
 * policy `lecture_publique` de la table `products`) : pas de signature
 * necessaire. Retourne null si aucun chemin (rien a afficher).
 */
export function productDatasheetUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  const client = supabase;
  if (!client) return null;
  return client.storage.from(PRODUCT_DATASHEETS_BUCKET).getPublicUrl(path).data.publicUrl;
}

export async function fetchBatteryComposition(productId: string): Promise<BatteryComposition | null> {
  const client = requireClient();
  const { data, error } = await client
    .from("battery_compositions")
    .select("product_id, module_cost, charger_cost, mass_kg, labor_cost, energy_meter_cost, panel_cost")
    .eq("product_id", productId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    productId: data.product_id,
    moduleCost: Number(data.module_cost),
    chargerCost: Number(data.charger_cost),
    massKg: Number(data.mass_kg),
    laborCost: Number(data.labor_cost),
    energyMeterCost: Number(data.energy_meter_cost),
    panelCost: Number(data.panel_cost),
  };
}

export async function fetchBebatRatePerKg(): Promise<number> {
  const client = requireClient();
  const { data, error } = await client
    .from("bebat_rate")
    .select("rate_per_kg")
    .order("effective_from", { ascending: false })
    .limit(1)
    .single();
  if (error) throw error;
  return Number(data.rate_per_kg);
}

export async function fetchMarginCurve(): Promise<MarginCurvePoint[]> {
  const client = requireClient();
  // Le bareme est versionne (curve_version) pour permettre a l'administrateur
  // de publier une nouvelle courbe sans perdre l'historique : on ne lit
  // jamais que la version la plus recente.
  const { data: versionRow, error: versionError } = await client
    .from("margin_curve_points")
    .select("curve_version")
    .order("curve_version", { ascending: false })
    .limit(1)
    .single();
  if (versionError) throw versionError;

  const { data, error } = await client
    .from("margin_curve_points")
    .select("power_kwc, suggested_margin_multiplier")
    .eq("curve_version", versionRow.curve_version)
    .order("power_kwc", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    powerKwc: row.power_kwc,
    suggestedMarginMultiplier: Number(row.suggested_margin_multiplier),
  }));
}

export async function fetchCommissionSettings(): Promise<CommissionSettings> {
  const client = requireClient();
  const { data, error } = await client
    .from("commission_settings")
    .select("default_rate, min_rate, max_rate")
    .limit(1)
    .single();
  if (error) throw error;
  return {
    defaultRate: Number(data.default_rate),
    minRate: Number(data.min_rate),
    maxRate: Number(data.max_rate),
  };
}

export async function fetchTravelCostRule(): Promise<TravelCostRule> {
  const client = requireClient();
  const { data, error } = await client
    .from("travel_cost_rules")
    .select("base_fee, distance_threshold_km, distance_surcharge, power_threshold_kwc, power_surcharge")
    .limit(1)
    .single();
  if (error) throw error;
  return {
    baseFee: Number(data.base_fee),
    distanceThresholdKm: Number(data.distance_threshold_km),
    distanceSurcharge: Number(data.distance_surcharge),
    powerThresholdKwc: Number(data.power_threshold_kwc),
    powerSurcharge: Number(data.power_surcharge),
  };
}

export async function fetchDefaultVatRate(): Promise<number> {
  const client = requireClient();
  const { data, error } = await client
    .from("vat_rates")
    .select("rate")
    .eq("applies_by_default", true)
    .limit(1)
    .single();
  if (error) throw error;
  return Number(data.rate);
}

export async function fetchCarportConfigs(): Promise<CarportConfig[]> {
  const client = requireClient();
  const { data, error } = await client
    .from("carport_configs")
    .select("id, brand, row_count, place_count, nb_pv, price")
    .order("nb_pv", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id,
    brand: row.brand,
    rowCount: row.row_count,
    placeCount: row.place_count,
    nbPv: row.nb_pv,
    price: Number(row.price),
  }));
}

export async function fetchOptimizers(): Promise<Optimizer[]> {
  const client = requireClient();
  const { data, error } = await client
    .from("optimizers")
    .select("id, brand, max_power_w, unit_price")
    .order("max_power_w", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id,
    brand: row.brand,
    maxPowerW: Number(row.max_power_w),
    unitPrice: Number(row.unit_price),
  }));
}

/**
 * Catalogue de cables AC (table `elec_components`, component_type='cable_ac').
 * Le calcul de section (cableEngine) reste agnostique du catalogue : c'est ici
 * que la section theorique calculee est rapprochee d'un cable reel avec un
 * prix. Voir src/App.tsx pour le choix de la famille (phases) selon le
 * phase_type de l'onduleur.
 */
export async function fetchCableAcCatalog(): Promise<CableAcOption[]> {
  const client = requireClient();
  const { data, error } = await client
    .from("elec_components")
    .select("id, model_name, specs, unit_price")
    .eq("component_type", "cable_ac");
  if (error) throw error;
  return (data ?? [])
    .map((row: any) => ({
      id: row.id,
      modelName: row.model_name,
      phases: String(row.specs?.phases ?? ""),
      sectionMm2: Number(row.specs?.section_mm2 ?? NaN),
      unitPricePerMeter: Number(row.unit_price),
    }))
    .filter((c) => !Number.isNaN(c.sectionMm2));
}

/**
 * Familles de cable AC compatibles avec un phase_type d'onduleur, par ordre
 * de preference (petites sections gainees d'abord, conducteurs separes en
 * repli si la section theorique depasse ce que la famille gainee couvre).
 *
 * Hypothese de mapping (a confirmer avec Ben si un cas reel la contredit,
 * voir claude/cartographie-et-plan-action.md) : "Mono" -> 3G (3 conducteurs :
 * phase + neutre + terre), "Tri + N" -> 5G (3 phases + neutre + terre) puis
 * 4x pour les grosses sections, "Tri sans N" -> 3x (conducteurs separes,
 * aucune petite section gainee disponible dans ce catalogue pour ce cas).
 * Ce n'etait pas le scenario teste par les 16 verifications deja validees
 * (validate:engine) : seul le dimensionnement lui-meme (cableEngine) l'a ete.
 */
const CABLE_FAMILIES_BY_PHASE_TYPE: Record<string, string[]> = {
  Mono: ["3G"],
  "Tri + N": ["5G", "4x"],
  "Tri sans N": ["3x"],
};

/**
 * Calcule la section theorique minimale (deja fournie par l'appelant via
 * cableEngine.voltageDropIndex), puis choisit, parmi les familles de cable
 * compatibles avec le phase_type de l'onduleur, la plus petite section reelle
 * du catalogue qui convient -- et son option catalogue (prix au metre).
 */
export function pickCableAcOption(
  options: CableAcOption[],
  phaseType: string | null | undefined,
  theoreticalSectionMm2: number,
): CableAcOption {
  const families = CABLE_FAMILIES_BY_PHASE_TYPE[phaseType ?? ""] ?? Object.keys(CABLE_FAMILIES_BY_PHASE_TYPE).flatMap((k) => CABLE_FAMILIES_BY_PHASE_TYPE[k]);
  const candidates = options.filter((o) => families.includes(o.phases));
  if (candidates.length === 0) {
    throw new Error(`Aucun cable AC catalogue pour le type de raccordement "${phaseType}".`);
  }
  const chosenSection = selectCableSection(
    theoreticalSectionMm2,
    candidates.map((c) => c.sectionMm2),
  );
  // Si plusieurs options partagent la meme section (familles qui se
  // chevauchent), on prend la moins chere -- pas de raison metier de
  // preferer l'une a l'autre a section egale.
  const matching = candidates.filter((c) => c.sectionMm2 === chosenSection).sort((a, b) => a.unitPricePerMeter - b.unitPricePerMeter);
  return matching[0];
}

/**
 * Catalogue de cables DC (table `elec_components`, component_type='cable_dc').
 * Seule la gamme "Cca Cu souple 1kV" (circuit +/-) est retenue par defaut :
 * la gamme "vert-jaune" (terre) existe dans le meme catalogue mais n'est pas
 * dimensionnee automatiquement ici (voir CableDcOption dans engine/types.ts).
 */
export async function fetchCableDcCatalog(): Promise<CableDcOption[]> {
  const client = requireClient();
  const { data, error } = await client
    .from("elec_components")
    .select("id, model_name, specs, unit_price")
    .eq("component_type", "cable_dc");
  if (error) throw error;
  return (data ?? [])
    .map((row: any) => ({
      id: row.id,
      modelName: row.model_name,
      gamme: String(row.specs?.gamme ?? ""),
      sectionMm2: Number(row.specs?.section_mm2 ?? NaN),
      unitPricePerMeter: Number(row.unit_price),
    }))
    .filter((c) => !Number.isNaN(c.sectionMm2));
}

/**
 * Table d'ampacite DC (table `elec_components`, component_type='cable_dc_ampacite') :
 * reference technique (courant admissible par section), pas un catalogue
 * d'articles vendables -- unit_price y vaut toujours 0.
 */
export async function fetchDcAmpacityTable(): Promise<DcAmpacityEntry[]> {
  const client = requireClient();
  const { data, error } = await client
    .from("elec_components")
    .select("specs")
    .eq("component_type", "cable_dc_ampacite");
  if (error) throw error;
  return (data ?? [])
    .map((row: any) => ({
      sectionMm2: Number(row.specs?.section_mm2 ?? NaN),
      currentMaxA: Number(row.specs?.current_max_a ?? NaN),
    }))
    .filter((e) => !Number.isNaN(e.sectionMm2) && !Number.isNaN(e.currentMaxA));
}

/**
 * Choisit la section DC minimale (par ampacite, cableEngine) puis l'option
 * catalogue "1kV" correspondante (prix au metre). Contrairement au cablage
 * AC, il n'y a qu'une seule gamme de circuit ici : pas de choix de famille.
 *
 * La table d'ampacite est plus fine (1,5 a 35mm²) que le catalogue de prix
 * reellement extrait de l'Excel (4, 6, 10mm² seulement -- les petites
 * sections DC ne semblent pas avoir ete vendues/tarifees separement dans le
 * classeur). Si la section requise par l'ampacite n'a pas de prix, on prend
 * la plus petite section du catalogue qui la couvre quand meme (>=), jamais
 * une section plus fine que necessaire pour l'ampacite calculee.
 */
export function pickCableDcOption(
  options: CableDcOption[],
  ampacityTable: DcAmpacityEntry[],
  currentA: number,
): CableDcOption {
  const circuitOptions = options.filter((o) => o.gamme.toLowerCase().includes("1kv"));
  if (circuitOptions.length === 0) {
    throw new Error('Aucun cable DC "1kV" dans le catalogue.');
  }
  const chosenSection = selectDcCableSectionByAmpacity(currentA, ampacityTable);
  const matching = circuitOptions
    .filter((c) => c.sectionMm2 >= chosenSection)
    .sort((a, b) => a.sectionMm2 - b.sectionMm2 || a.unitPricePerMeter - b.unitPricePerMeter);
  if (matching.length === 0) {
    throw new Error(`Aucun cable DC "1kV" de section >= ${chosenSection}mm² dans le catalogue.`);
  }
  return matching[0];
}

export async function fetchCableSizingParameters(): Promise<CableSizingParameters> {
  const client = requireClient();
  const { data, error } = await client
    .from("cable_sizing_parameters")
    .select("max_voltage_drop_pct, resistivity_cu, resistivity_al, default_cos_phi")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return DEFAULT_CABLE_SIZING_PARAMETERS;
  return {
    maxVoltageDropPct: Number(data.max_voltage_drop_pct),
    resistivityCu: Number(data.resistivity_cu),
    resistivityAl: Number(data.resistivity_al),
    defaultCosPhi: Number(data.default_cos_phi),
  };
}

export async function fetchAutoConsumptionDefault(regionName: string, hasBattery: boolean): Promise<number | null> {
  const client = requireClient();
  const { data, error } = await client
    .from("auto_consumption_defaults")
    .select("default_rate, regions!inner(name)")
    .eq("regions.name", regionName)
    .eq("has_battery", hasBattery)
    .maybeSingle();
  if (error) throw error;
  return data ? Number((data as any).default_rate) : null;
}

export async function fetchFinancialParameters(): Promise<FinancialParameters> {
  const client = requireClient();
  const { data, error } = await client
    .from("financial_parameters")
    .select("network_price_per_kwh, inflation_rate, cv_buyback_price, resale_price_ratio, production_yield_kwh_per_wc")
    .order("effective_from", { ascending: false })
    .limit(1)
    .single();
  if (error) throw error;
  return {
    networkPricePerKwh: Number(data.network_price_per_kwh),
    inflationRate: Number(data.inflation_rate),
    cvBuybackPrice: Number(data.cv_buyback_price),
    resalePriceRatio: Number(data.resale_price_ratio),
    productionYieldKwhPerWc: Number(data.production_yield_kwh_per_wc),
  };
}

/**
 * Bareme CV Bruxelles actuellement en vigueur (referentiel section 3). La
 * table `cv_rate_brackets` porte plusieurs baremes historiques (2023, 2024,
 * "a partir du 1er avril 2026") sur les memes paliers de puissance : sans ce
 * filtre, lookupCvRateBruxelles (regimeEngine) recevrait 3 taux differents
 * pour le meme palier et retournerait un resultat arbitraire selon l'ordre
 * de tri. A ajuster ici (pas dans le moteur de calcul) quand un nouveau
 * bareme entre en vigueur.
 */
export const ACTIVE_CV_GRANT_YEAR_LABEL = "à partir du 1er avril 2026";

export async function fetchCvBracketsForRegion(
  regionName: string,
  grantYearLabel: string = ACTIVE_CV_GRANT_YEAR_LABEL,
): Promise<CvBracket[]> {
  const client = requireClient();
  const { data, error } = await client
    .from("cv_rate_brackets")
    .select("power_min_kwc, power_max_kwc, grant_year_label, rate_cv_per_mwh, regions!inner(name)")
    .eq("regions.name", regionName)
    .eq("grant_year_label", grantYearLabel)
    .order("power_min_kwc", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    powerMinKwc: Number(row.power_min_kwc),
    powerMaxKwc: row.power_max_kwc !== null ? Number(row.power_max_kwc) : null,
    grantYearLabel: row.grant_year_label,
    rateCvPerMwh: Number(row.rate_cv_per_mwh),
  }));
}

/**
 * Parite Excel "Calcul du prix" (decision 38) : main-d'oeuvre, tranchees, GRD,
 * provision cablage/matos AC, certification electrique, manutention, forfaits
 * divers, et catalogue des composants electriques optionnels (cabine de
 * decouplage, transformateur, compteurs, EMS). Voir engine/laborEngine.ts
 * pour les formules associees et claude/referentiel-regles-metier-excel.md
 * sections 4.4 a 4.7 et 9 pour l'origine de chaque bareme.
 */

export async function fetchLaborRoofRates(): Promise<LaborRoofRate[]> {
  const client = requireClient();
  const { data, error } = await client
    .from("labor_roof_rates")
    .select("roof_type, fixed_price, threshold_1_units, rate_tier_1, threshold_2_units, rate_tier_2");
  if (error) throw error;
  return (data ?? []).map((row) => ({
    roofType: row.roof_type,
    fixedPrice: Number(row.fixed_price),
    threshold1Units: Number(row.threshold_1_units),
    rateTier1: Number(row.rate_tier_1),
    threshold2Units: Number(row.threshold_2_units),
    rateTier2: Number(row.rate_tier_2),
  }));
}

export async function fetchLaborElectricianRates(): Promise<LaborElectricianRate[]> {
  const client = requireClient();
  const { data, error } = await client
    .from("labor_electrician_rates")
    .select("day_rate, inverter_count_tier, fixed_price, price_per_additional_inverter");
  if (error) throw error;
  return (data ?? []).map((row) => ({
    dayRate: Number(row.day_rate),
    inverterCountTier: row.inverter_count_tier,
    fixedPrice: Number(row.fixed_price),
    pricePerAdditionalInverter: Number(row.price_per_additional_inverter),
  }));
}

export async function fetchTrenchRates(): Promise<TrenchRate[]> {
  const client = requireClient();
  const { data, error } = await client.from("trench_rates").select("soil_type, price_per_meter");
  if (error) throw error;
  return (data ?? []).map((row) => ({ soilType: row.soil_type, pricePerMeter: Number(row.price_per_meter) }));
}

/** Regions (id, name) : necessaire pour rapprocher `Region` (l'enum du moteur, aligne
 * sur `regions.name`) de `grd_fee_schedule.region_id` (uuid), seule table de ce lot
 * qui reference une region par cle etrangere plutot que par nom. */
export async function fetchRegions(): Promise<Array<{ id: string; name: string }>> {
  const client = requireClient();
  const { data, error } = await client.from("regions").select("id, name");
  if (error) throw error;
  return data ?? [];
}

/**
 * Bareme GRD complet (toutes regions) : filtre cote application par
 * `region_id` (voir engine/laborEngine.ts, grdFee). Un seul aller-retour
 * reseau plutot qu'un par region, le bareme entier tient en 27 lignes.
 */
export async function fetchGrdFeeSchedule(): Promise<GrdFeeBracket[]> {
  const client = requireClient();
  const { data, error } = await client.from("grd_fee_schedule").select("region_id, power_threshold_kva, fee");
  if (error) throw error;
  return (data ?? []).map((row) => ({
    regionId: row.region_id,
    powerThresholdKva: Number(row.power_threshold_kva),
    fee: Number(row.fee),
  }));
}

export async function fetchCablingForfaitTiers(): Promise<CablingForfaitTier[]> {
  const client = requireClient();
  const { data, error } = await client
    .from("cabling_forfait_tiers")
    .select("tier_order, power_max_wc, rate_eur_per_wc")
    .order("tier_order", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    tierOrder: row.tier_order,
    powerMaxWc: row.power_max_wc !== null ? Number(row.power_max_wc) : null,
    rateEurPerWc: Number(row.rate_eur_per_wc),
  }));
}

export async function fetchElectricalCertificationTiers(): Promise<ElectricalCertificationTier[]> {
  const client = requireClient();
  const { data, error } = await client
    .from("electrical_certification_rates")
    .select("tier_order, power_threshold_kva, price")
    .order("tier_order", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    tierOrder: row.tier_order,
    powerThresholdKva: row.power_threshold_kva !== null ? Number(row.power_threshold_kva) : null,
    price: Number(row.price),
  }));
}

export async function fetchHandlingRates(): Promise<HandlingRate[]> {
  const client = requireClient();
  const { data, error } = await client.from("handling_rates").select("handling_key, label, price, unit");
  if (error) throw error;
  return (data ?? []).map((row) => ({ handlingKey: row.handling_key, label: row.label, price: Number(row.price), unit: row.unit }));
}

export async function fetchFlatFeeOptions(): Promise<FlatFeeOption[]> {
  const client = requireClient();
  const { data, error } = await client.from("flat_fee_options").select("fee_key, label, price, region_restriction, category");
  if (error) throw error;
  return (data ?? []).map((row) => ({
    feeKey: row.fee_key,
    label: row.label,
    price: Number(row.price),
    regionRestriction: row.region_restriction,
    category: row.category,
  }));
}

/**
 * Constante de calcul isolee (table `misc_calculation_parameters`, cle/valeur
 * -- multiplicateur cablage "complique", panneaux par voyage de transport...).
 * Leve une erreur explicite plutot que de retomber silencieusement sur une
 * valeur par defaut codee en dur si la cle est absente de la base.
 */
export async function fetchMiscCalculationParameter(key: string): Promise<number> {
  const client = requireClient();
  const { data, error } = await client.from("misc_calculation_parameters").select("numeric_value").eq("key", key).single();
  if (error) throw error;
  return Number(data.numeric_value);
}

/**
 * Catalogue `elec_components` generique pour les types autres que le cablage
 * (cabine_decouplage, transformateur, compteur, ems...) : le detail utile
 * (bareme kVA, phase, licence) reste dans `specs`, interprete par le code
 * appelant (voir App.tsx et engine/laborEngine.ts) selon le type demande.
 */
export async function fetchElecComponentsByType(componentType: string): Promise<ElecOptionComponent[]> {
  const client = requireClient();
  const { data, error } = await client
    .from("elec_components")
    .select("id, component_type, model_name, brand, specs, unit_price")
    .eq("component_type", componentType);
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    id: row.id,
    componentType: row.component_type,
    modelName: row.model_name,
    brand: row.brand,
    specs: row.specs ?? {},
    unitPrice: Number(row.unit_price),
  }));
}
