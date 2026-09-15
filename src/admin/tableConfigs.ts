/**
 * Configuration des tables editables depuis le back-office (decision 35, cf.
 * claude/cartographie-et-plan-action.md). Chaque entree decrit une table
 * catalogue/parametres (jamais offers/offer_lines/clients/users : ces
 * dernieres sortent du perimetre pour l'instant, cf. decision de Ben du
 * 10/09/2026 de prioriser la construction de la base de donnees plutot que
 * la sauvegarde automatique des offres).
 *
 * AdminTableEditor (src/components/AdminTableEditor.tsx) est generique : il
 * ne connait aucune table par son nom, il se contente d'interpreter cette
 * config pour savoir quels champs afficher, avec quel type d'input, et
 * comment resoudre les cles etrangeres (fk) vers un libelle lisible.
 */

export type AdminColumnType = "text" | "number" | "boolean" | "select-enum" | "select-fk" | "jsonb" | "file-pdf";

export interface AdminColumn {
  key: string;
  label: string;
  type: AdminColumnType;
  step?: number;
  nullable?: boolean;
  enumOptions?: string[];
  /** Reference vers une autre table admin pour peupler un <select>. */
  fk?: { table: string; valueKey: string; labelKey: string };
  /**
   * "file-pdf" uniquement (decision 50, 15/09/2026) : `key` porte la colonne
   * de chemin Storage (ex "datasheet_path"), `filenameKey` la colonne
   * compagnon pour le nom de fichier d'origine (affichage). L'upload/suppression
   * ecrit directement en base (pas via le circuit "Enregistrer" habituel,
   * puisqu'il s'agit d'une operation Storage + DB atomique) -- necessite une
   * ligne deja existante (pas de fiche sur la ligne "Ajouter").
   */
  file?: { bucket: string; filenameKey: string };
}

export interface AdminTableConfig {
  table: string;
  label: string;
  columns: AdminColumn[];
  orderBy?: string;
  pageSize?: number;
  /**
   * Filtre fixe applique a la fois a la lecture (WHERE column = value) et a
   * la creation (valeur injectee automatiquement dans la nouvelle ligne).
   * Sert a decliner une meme table en plusieurs vues admin (ex : "products"
   * separe par categorie -- Panneaux PV / Onduleurs / Batteries, decision 40,
   * 11/09/2026). La valeur (UUID de categorie) est une constante d'affichage,
   * pas une donnee catalogue : coherent avec fkRegion/fkProduct/fkCategory
   * deja codes en dur dans ce fichier.
   */
  fixedFilter?: { column: string; value: string };
  /**
   * Identifiant UI unique (selection dans le menu Back-office), distinct du
   * nom de table SQL quand plusieurs vues partagent la meme table (voir
   * fixedFilter ci-dessus). Retombe sur `table` si absent -- necessaire
   * uniquement pour les entrees qui ne sont pas seules sur leur table.
   */
  id?: string;
  /**
   * Active le bloc de recherche "Importer depuis Odoo" en haut de la vue
   * (decision 50, 15/09/2026) : pre-remplit la ligne "Ajouter" a partir d'un
   * article Odoo trouve par nom/reference. Uniquement pertinent pour les
   * vues `products` (Panneaux PV / Onduleurs / Batteries) pour l'instant.
   */
  odooImportable?: boolean;
}

const num = (key: string, label: string, opts: Partial<AdminColumn> = {}): AdminColumn => ({
  key,
  label,
  type: "number",
  step: 0.01,
  ...opts,
});
const text = (key: string, label: string, opts: Partial<AdminColumn> = {}): AdminColumn => ({
  key,
  label,
  type: "text",
  ...opts,
});
const bool = (key: string, label: string, opts: Partial<AdminColumn> = {}): AdminColumn => ({
  key,
  label,
  type: "boolean",
  ...opts,
});

const fkRegion: AdminColumn["fk"] = { table: "regions", valueKey: "id", labelKey: "name" };
const fkProduct: AdminColumn["fk"] = { table: "products", valueKey: "id", labelKey: "model_name" };
const fkCategory: AdminColumn["fk"] = { table: "product_categories", valueKey: "id", labelKey: "name" };

// UUIDs de product_categories (table de reference, lues une seule fois en
// base le 11/09/2026) -- constantes d'affichage pour separer la vue admin
// "Produits" par type, pas des donnees catalogue en dur (voir fixedFilter,
// meme precedent que fkRegion/fkProduct/fkCategory ci-dessus). Si ces
// categories sont un jour recreees avec d'autres UUIDs, mettre a jour ici.
const CATEGORY_ID_PANNEAUX_PV = "2acc9e43-b2e7-426f-9e7e-7eb83add0cb7";
const CATEGORY_ID_ONDULEURS = "0f230ddf-64e3-4423-8f90-a28ff2ee3fc3";
const CATEGORY_ID_BATTERIES = "a6019875-f681-46ff-9f63-850a2e4f162e";

const productColumns: AdminColumn[] = [
  text("model_name", "Modele"),
  text("brand", "Marque", { nullable: true }),
  num("unit_cost", "Cout unitaire (EUR)"),
  num("safety_margin_pct", "Marge de securite (%)", { step: 0.001 }),
  num("power_kva", "Puissance (kVA, onduleurs)", { nullable: true, step: 0.1 }),
  num("power_w", "Puissance crete (Wc, panneaux)", { nullable: true, step: 1 }),
  text("phase_type", "Type de phase (Mono / Tri + N / Tri sans N)", { nullable: true }),
  num("warranty_years", "Garantie (annees)", { nullable: true, step: 1 }),
  { key: "specs", label: "Caracteristiques additionnelles (JSON)", type: "jsonb" },
  bool("active", "Actif"),
  // Fiche technique PDF par article (decision 50, 15/09/2026, demande de Ben :
  // "pour chaque article, je dois pouvoir ajouter la fiche technique ?") --
  // un PDF joint, pas de champs structures (confirme par Ben).
  {
    key: "datasheet_path",
    label: "Fiche technique (PDF)",
    type: "file-pdf",
    nullable: true,
    file: { bucket: "product-datasheets", filenameKey: "datasheet_filename" },
  },
];

export const ADMIN_TABLES: AdminTableConfig[] = [
  // Table `products` separee par categorie (decision 40, 11/09/2026, demande
  // de Ben : "separer panneaux/onduleurs/batteries par type puis par
  // marque") -- trois vues admin sur la meme table plutot qu'une liste
  // unique melangeant les trois familles de produits.
  {
    id: "products_panneaux_pv",
    table: "products",
    label: "Produits -- Panneaux PV",
    orderBy: "brand",
    pageSize: 100,
    fixedFilter: { column: "category_id", value: CATEGORY_ID_PANNEAUX_PV },
    columns: productColumns,
    odooImportable: true,
  },
  {
    id: "products_onduleurs",
    table: "products",
    label: "Produits -- Onduleurs",
    orderBy: "brand",
    pageSize: 100,
    fixedFilter: { column: "category_id", value: CATEGORY_ID_ONDULEURS },
    columns: productColumns,
    odooImportable: true,
  },
  {
    id: "products_batteries",
    table: "products",
    label: "Produits -- Batteries",
    orderBy: "brand",
    pageSize: 100,
    fixedFilter: { column: "category_id", value: CATEGORY_ID_BATTERIES },
    columns: productColumns,
    odooImportable: true,
  },
  {
    table: "product_categories",
    label: "Categories de produits",
    orderBy: "name",
    columns: [
      text("name", "Nom"),
      { key: "parent_category_id", label: "Categorie parente", type: "select-fk", fk: fkCategory, nullable: true },
    ],
  },
  {
    table: "elec_components",
    label: "Composants electriques (cables AC/DC, ampacite...)",
    orderBy: "component_type",
    pageSize: 150,
    columns: [
      text("component_type", "Type (cable_ac / cable_dc / cable_dc_ampacite...)"),
      text("model_name", "Modele"),
      text("brand", "Marque", { nullable: true }),
      { key: "specs", label: "Caracteristiques (JSON : section_mm2, phases, gamme, current_max_a...)", type: "jsonb" },
      num("unit_price", "Prix unitaire (EUR)"),
    ],
  },
  {
    table: "battery_compositions",
    label: "Composition des batteries (couts detailles)",
    orderBy: "product_id",
    columns: [
      { key: "product_id", label: "Produit (batterie)", type: "select-fk", fk: fkProduct },
      num("module_cost", "Cout module"),
      num("charger_cost", "Cout chargeur"),
      num("mass_kg", "Masse (kg)", { step: 0.1 }),
      num("labor_cost", "Cout main-d'oeuvre"),
      num("energy_meter_cost", "Cout compteur d'energie"),
      num("panel_cost", "Cout panneau"),
    ],
  },
  {
    table: "backup_modules",
    label: "Modules de secours (backup batterie)",
    orderBy: "brand_compatibility",
    columns: [
      { key: "product_id", label: "Produit associe", type: "select-fk", fk: fkProduct, nullable: true },
      text("brand_compatibility", "Compatibilite marque"),
      num("module_cost", "Cout module"),
      num("breaker_diff_cost", "Cout disjoncteur differentiel"),
      num("inverter_switch_cost", "Cout commutateur onduleur"),
      num("panel_cost", "Cout panneau"),
      num("wiring_cost", "Cout cablage"),
      num("misc_cost", "Cout divers"),
      num("labor_cost", "Cout main-d'oeuvre"),
      num("certification_supplement", "Supplement certification"),
      num("delayed_install_supplement", "Supplement installation differee"),
    ],
  },
  {
    table: "carport_configs",
    label: "Configurations carport",
    orderBy: "nb_pv",
    columns: [
      text("brand", "Marque"),
      num("row_count", "Nombre de rangees", { step: 1 }),
      num("place_count", "Nombre de places", { step: 1 }),
      num("nb_pv", "Nombre de PV", { step: 1 }),
      num("price", "Prix (EUR)"),
    ],
  },
  {
    table: "optimizers",
    label: "Optimiseurs",
    orderBy: "max_power_w",
    columns: [text("brand", "Marque"), num("max_power_w", "Puissance max (W)", { step: 1 }), num("unit_price", "Prix unitaire (EUR)")],
  },
  {
    table: "cable_sizing_parameters",
    label: "Parametres de dimensionnement cable (RGIE)",
    columns: [
      num("max_voltage_drop_pct", "Chute de tension max (%)", { step: 0.001 }),
      num("resistivity_cu", "Resistivite cuivre", { step: 0.0001 }),
      num("resistivity_al", "Resistivite aluminium", { step: 0.0001 }),
      num("default_cos_phi", "Cos phi par defaut", { step: 0.01 }),
    ],
  },
  {
    table: "margin_curve_points",
    label: "Bareme de marge suggeree (courbe degressive)",
    orderBy: "power_kwc",
    pageSize: 50,
    columns: [
      num("curve_version", "Version du bareme", { step: 1 }),
      num("power_kwc", "Puissance (kWc)", { step: 1 }),
      num("suggested_margin_multiplier", "Multiplicateur de marge suggere", { step: 0.0001 }),
      text("effective_from", "En vigueur depuis (ISO)"),
    ],
  },
  {
    table: "commission_settings",
    label: "Parametres de commission",
    columns: [
      num("default_rate", "Taux par defaut", { step: 0.01 }),
      num("min_rate", "Taux minimum", { step: 0.01 }),
      num("max_rate", "Taux maximum", { step: 0.01 }),
    ],
  },
  {
    table: "travel_cost_rules",
    label: "Regle de forfait deplacement",
    columns: [
      num("base_fee", "Forfait de base (EUR)"),
      num("distance_threshold_km", "Seuil de distance (km)", { step: 1 }),
      num("distance_surcharge", "Supplement distance (EUR)"),
      num("power_threshold_kwc", "Seuil de puissance (kWc)", { step: 0.1 }),
      num("power_surcharge", "Supplement puissance (EUR)"),
    ],
  },
  {
    table: "vat_rates",
    label: "Taux de TVA",
    columns: [text("label", "Libelle"), num("rate", "Taux (0 a 1)", { step: 0.01 }), bool("applies_by_default", "Applique par defaut")],
  },
  {
    table: "financial_parameters",
    label: "Parametres financiers (rentabilite 25 ans)",
    orderBy: "effective_from",
    columns: [
      num("network_price_per_kwh", "Prix reseau (EUR/kWh)", { step: 0.0001 }),
      num("inflation_rate", "Taux d'inflation annuel", { step: 0.001 }),
      num("cv_buyback_price", "Prix de rachat CV (EUR)", { step: 0.01 }),
      num("resale_price_ratio", "Ratio prix de revente", { step: 0.01 }),
      text("effective_from", "En vigueur depuis (ISO)"),
      num("production_yield_kwh_per_wc", "Rendement de production (kWh/Wc/an)", { step: 0.001 }),
    ],
  },
  {
    table: "bebat_rate",
    label: "Taux BEBAT (recyclage batteries)",
    columns: [num("rate_per_kg", "Taux (EUR/kg)", { step: 0.01 }), text("effective_from", "En vigueur depuis (ISO)")],
  },
  {
    table: "regions",
    label: "Regions",
    orderBy: "name",
    columns: [
      text("name", "Nom"),
      text("grd_name", "Nom du GRD"),
      { key: "revenue_regime", label: "Regime de revenus", type: "select-enum", enumOptions: ["cv_bracket", "resale_flat"] },
      bool("active", "Active"),
    ],
  },
  {
    table: "cv_rate_brackets",
    label: "Paliers Certificats Verts (Bruxelles)",
    orderBy: "power_min_kwc",
    pageSize: 50,
    columns: [
      { key: "region_id", label: "Region", type: "select-fk", fk: fkRegion },
      num("power_min_kwc", "Puissance min (kWc)", { step: 0.1 }),
      num("power_max_kwc", "Puissance max (kWc)", { nullable: true, step: 0.1 }),
      text("grant_year_label", "Bareme (annee/periode)"),
      num("rate_cv_per_mwh", "Taux CV (EUR/MWh)"),
    ],
  },
  {
    table: "cv_flat_rates",
    label: "Taux CV forfaitaires",
    columns: [
      { key: "region_id", label: "Region", type: "select-fk", fk: fkRegion },
      num("power_threshold_kva", "Seuil de puissance (kVA)", { step: 0.1 }),
      num("rate_cv_per_mwh", "Taux CV (EUR/MWh)"),
    ],
  },
  {
    table: "auto_consumption_defaults",
    label: "Taux d'auto-consommation suggeres",
    columns: [
      { key: "region_id", label: "Region", type: "select-fk", fk: fkRegion },
      bool("has_battery", "Avec batterie"),
      num("default_rate", "Taux par defaut (0 a 1)", { step: 0.01 }),
    ],
  },
  {
    table: "grd_fee_schedule",
    label: "Bareme redevance GRD",
    orderBy: "power_threshold_kva",
    pageSize: 50,
    columns: [
      { key: "region_id", label: "Region", type: "select-fk", fk: fkRegion },
      num("power_threshold_kva", "Seuil de puissance (kVA)", { step: 0.1 }),
      num("fee", "Redevance (EUR)"),
    ],
  },
  {
    table: "labor_roof_rates",
    label: "Tarifs main-d'oeuvre toiture",
    columns: [
      text("roof_type", "Type de toiture"),
      num("fixed_price", "Prix fixe (EUR)"),
      num("threshold_1_units", "Seuil 1 (unites)", { step: 1 }),
      num("rate_tier_1", "Taux palier 1"),
      num("threshold_2_units", "Seuil 2 (unites)", { step: 1 }),
      num("rate_tier_2", "Taux palier 2"),
    ],
  },
  {
    table: "labor_electrician_rates",
    label: "Tarifs main-d'oeuvre electricien",
    columns: [
      num("day_rate", "Taux journalier (EUR)"),
      text("inverter_count_tier", "Palier nombre d'onduleurs"),
      num("fixed_price", "Prix fixe (EUR)"),
      num("price_per_additional_inverter", "Prix par onduleur supplementaire"),
    ],
  },
  {
    table: "labor_task_estimates",
    label: "Estimations de temps par tache",
    columns: [text("task_name", "Nom de la tache"), num("estimated_hours", "Heures estimees", { step: 0.1 })],
  },
  {
    table: "labor_subcontractor_flat_rates",
    label: "Forfaits sous-traitance",
    columns: [text("task_name", "Nom de la tache"), num("flat_price", "Prix forfaitaire (EUR)")],
  },
  {
    table: "trench_rates",
    label: "Tarifs tranchee (par type de sol)",
    columns: [text("soil_type", "Type de sol"), num("price_per_meter", "Prix au metre (EUR)")],
  },
  {
    table: "legal_entities",
    label: "Entites juridiques",
    columns: [text("name", "Nom"), text("country", "Pays"), bool("active", "Active")],
  },
  {
    table: "product_odoo_links",
    label: "Liens produits <-> Odoo",
    columns: [
      { key: "product_id", label: "Produit", type: "select-fk", fk: fkProduct },
      num("odoo_product_id", "ID produit Odoo", { step: 1 }),
      bool("is_primary", "Lien principal"),
    ],
  },
  // Decision 38 (10/09/2026) : parite Excel "Calcul du prix" -- provision
  // cablage/matos AC, certification electrique, manutention, forfaits divers.
  // Voir engine/laborEngine.ts et referentiel des regles metier, sections 4.4-4.7.
  {
    table: "cabling_forfait_tiers",
    label: "Provision cablage/matos AC (paliers au Wc)",
    orderBy: "tier_order",
    columns: [
      num("tier_order", "Ordre du palier", { step: 1 }),
      num("power_max_wc", "Puissance max du palier (Wc, vide = dernier palier)", { nullable: true, step: 1 }),
      num("rate_eur_per_wc", "Taux (EUR/Wc)", { step: 0.001 }),
    ],
  },
  {
    table: "misc_calculation_parameters",
    label: "Constantes de calcul diverses",
    orderBy: "key",
    columns: [text("key", "Cle (technique, ne pas modifier)"), text("label", "Libelle"), num("numeric_value", "Valeur", { step: 0.01 })],
  },
  {
    table: "electrical_certification_rates",
    label: "Tarifs certification electrique",
    orderBy: "tier_order",
    columns: [
      num("tier_order", "Ordre du palier", { step: 1 }),
      num("power_threshold_kva", "Seuil de puissance (kVA, vide = dernier palier)", { nullable: true, step: 0.1 }),
      num("price", "Prix (EUR)"),
    ],
  },
  {
    table: "handling_rates",
    label: "Forfaits manutention (lift, nacelle, transport, grue...)",
    orderBy: "handling_key",
    columns: [
      text("handling_key", "Cle (technique, ne pas modifier)"),
      text("label", "Libelle"),
      num("price", "Prix (EUR)"),
      text("unit", "Unite (forfait / jour / voyage)"),
    ],
  },
  {
    table: "flat_fee_options",
    label: "Forfaits divers (Green Box, certification Brugel, etude stabilite)",
    orderBy: "fee_key",
    columns: [
      text("fee_key", "Cle (technique, ne pas modifier)"),
      text("label", "Libelle"),
      num("price", "Prix (EUR)"),
      text("region_restriction", "Region requise (vide = toutes)", { nullable: true }),
      { key: "category", label: "Categorie", type: "select-enum", enumOptions: ["marchandise", "main_doeuvre", "service"] },
    ],
  },
];
