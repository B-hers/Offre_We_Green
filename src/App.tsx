import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { supabaseConfigured } from "./supabaseClient";
import { useSupabaseAuth } from "./useAuth";
import LoginPanel from "./components/LoginPanel";
import AdminTableEditor from "./components/AdminTableEditor";
import { ADMIN_TABLES } from "./admin/tableConfigs";
import {
  fetchProductsByCategory,
  fetchBatteryComposition,
  fetchBebatRatePerKg,
  fetchMarginCurve,
  fetchCommissionSettings,
  fetchTravelCostRule,
  fetchDefaultVatRate,
  fetchCarportConfigs,
  fetchOptimizers,
  fetchCableAcCatalog,
  fetchCableDcCatalog,
  fetchDcAmpacityTable,
  fetchCableSizingParameters,
  fetchAutoConsumptionDefault,
  fetchFinancialParameters,
  fetchCvBracketsForRegion,
  pickCableAcOption,
  pickCableDcOption,
  fetchLaborRoofRates,
  fetchLaborElectricianRates,
  fetchTrenchRates,
  fetchRegions,
  fetchGrdFeeSchedule,
  fetchCablingForfaitTiers,
  fetchElectricalCertificationTiers,
  fetchHandlingRates,
  fetchFlatFeeOptions,
  fetchMiscCalculationParameter,
  fetchElecComponentsByType,
  productDatasheetUrl,
} from "./data/catalog";
import {
  loadArcheliosPdf,
  renderPageToDataUrl,
  detectAndRenderCalepinage,
  ArcheliosPdfError,
  type ArcheliosPdfDocument,
  type ArcheliosSourceType,
} from "./pdf/archeliosPdf";
import { Region, RevenueRegime, newOfferLine, lineTotalPrice, lineTotalCost } from "./engine/types";
import type {
  Product,
  BatteryComposition,
  MarginCurvePoint,
  CommissionSettings,
  TravelCostRule,
  OfferLine,
  CarportConfig,
  Optimizer,
  CableAcOption,
  CableDcOption,
  DcAmpacityEntry,
  FinancialParameters,
  CvBracket,
  LaborRoofRate,
  LaborElectricianRate,
  TrenchRate,
  GrdFeeBracket,
  CablingForfaitTier,
  ElectricalCertificationTier,
  HandlingRate,
  FlatFeeOption,
  ElecOptionComponent,
} from "./engine/types";
import { suggestedMarginMultiplier } from "./engine/marginEngine";
import { bebatPremium } from "./engine/batteryEngine";
import { computeOfferTotals, CATEGORIES_MARGIN_BATTERY_TRAVEL } from "./engine/pricingEngine";
import { travelCost } from "./engine/travelCost";
import { voltageDropIndex, DEFAULT_CABLE_SIZING_PARAMETERS, type CableSizingParameters } from "./engine/cableEngine";
import { resolveRegimeForRegion, lookupCvRateBruxelles, projectCashflow, type CashflowYear } from "./engine/regimeEngine";
import { applyRepartition } from "./engine/repartitionEngine";
import {
  roofLaborCost,
  pickElectricianRateTier,
  electricianLaborCost,
  trenchCost,
  grdFee,
  cablingForfaitCost,
  electricalCertificationPrice,
  cabineDecouplagePrice,
  emsLicenseFee,
  transportTripsForPanels,
} from "./engine/laborEngine";
import { OFFER_LITERATURE_COMPLETE, OFFER_LITERATURE_BATTERY, WE_GREEN_COMPANY_INFO } from "./content/offerLiterature";
import {
  importOdooQuote,
  OdooImportError,
  type OdooImportResult,
  type OdooAddress,
  type OdooArticles,
  type OdooArticle,
} from "./data/odooImport";

/**
 * Selection generique d'un produit + quantite, utilisee pour les panneaux PV
 * et les onduleurs (decision 40, 11/09/2026) : Ben a demande de pouvoir
 * combiner plusieurs modeles differents dans une meme offre (ex : panneaux
 * Jinko 515W + panneaux Jinko 450W en complement de toiture), comme le
 * permettait deja l'Excel. `key` est un identifiant stable cote UI (pas en
 * base : ces lignes ne sont pas persistees, hors perimetre pour l'instant),
 * necessaire pour editer/supprimer une ligne sans perturber React.
 */
interface ProductSelection {
  key: string;
  productId: string;
  qty: number;
}

let selectionKeySeq = 0;
function nextSelectionKey(): string {
  selectionKeySeq += 1;
  return `sel-${selectionKeySeq}`;
}

/**
 * Formatage des montants EUR affiches dans l'offre client (decision 54,
 * 15/09/2026, demande de Ben : "un separateur des milliers pour que ce soit
 * plus digeste et plus lisible"). Convention belge francophone : espace
 * fine insecable comme separateur de milliers, virgule comme separateur
 * decimal (ex. "12 345,67 EUR"). Formateur unique reutilise, pas
 * reinstancie a chaque appel.
 */
const EUR_FORMATTER = new Intl.NumberFormat("fr-BE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function formatEur(value: number): string {
  return `${EUR_FORMATTER.format(value)} EUR`;
}

/**
 * Rapprochement des articles Odoo (BDC = devis client confirme, sale.order,
 * decision 49) avec le catalogue de l'offre, pour pre-remplir "Calcul du
 * prix" (panneaux/onduleurs/batterie) sans ressaisie manuelle. Best-effort,
 * aucune table de correspondance codee en dur : panneaux rapproches par
 * puissance crete (Wc, tolerance 5%), onduleurs et batteries par texte
 * normalise (libelle Odoo vs marque+modele catalogue), batterie egalement
 * par capacite kWh quand elle est lisible dans le libelle catalogue. Tout
 * article sans correspondance fiable est renvoye a part (jamais ignore
 * silencieusement) pour que l'utilisateur l'ajoute lui-meme. Decision 50,
 * 15/09/2026.
 */
function normalizeMatchText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findPanelByPower(article: OdooArticle, catalog: Product[]): Product | null {
  if (!article.wc) return findByLabel(article, catalog);
  let best: Product | null = null;
  let bestDiff = Infinity;
  for (const p of catalog) {
    if (!p.powerW) continue;
    const diff = Math.abs(p.powerW - article.wc);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = p;
    }
  }
  if (best && best.powerW && bestDiff / article.wc <= 0.05) return best;
  return findByLabel(article, catalog);
}

function findByLabel(article: OdooArticle, catalog: Product[]): Product | null {
  const needle = normalizeMatchText(article.produit ?? "");
  if (!needle) return null;
  let best: Product | null = null;
  let bestScore = 0;
  for (const p of catalog) {
    const hay = normalizeMatchText(`${p.brand} ${p.modelName}`);
    if (!hay) continue;
    let score = 0;
    if (needle.includes(hay) || hay.includes(needle)) {
      score = Math.min(hay.length, needle.length);
    } else {
      const hayTokens = hay.split(" ").filter((t) => t.length > 2);
      const matchedTokens = hayTokens.filter((t) => needle.includes(t));
      if (hayTokens.length > 0 && matchedTokens.length >= Math.max(1, Math.ceil(hayTokens.length * 0.6))) {
        score = matchedTokens.join("").length;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

function findBatteryByKwh(article: OdooArticle, catalog: Product[]): Product | null {
  if (article.kwh != null) {
    let best: Product | null = null;
    let bestDiff = Infinity;
    for (const p of catalog) {
      const match = `${p.brand} ${p.modelName}`.match(/(\d+(?:[.,]\d+)?)\s*kWh/i);
      const kwh = match ? Number(match[1].replace(",", ".")) : null;
      if (kwh == null) continue;
      const diff = Math.abs(kwh - article.kwh);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = p;
      }
    }
    if (best && bestDiff <= 0.5) return best;
  }
  return findByLabel(article, catalog);
}

interface OdooArticleMatchResult {
  panelSelections: ProductSelection[];
  inverterSelections: ProductSelection[];
  batteryId: string;
  unmatched: string[];
}

function matchOdooArticlesToCatalog(
  articles: OdooArticles,
  panels: Product[],
  inverters: Product[],
  batteries: Product[],
): OdooArticleMatchResult {
  const unmatched: string[] = [];

  const panelSelections: ProductSelection[] = [];
  for (const art of articles.panneaux) {
    const product = findPanelByPower(art, panels);
    if (product) {
      const existing = panelSelections.find((s) => s.productId === product.id);
      if (existing) existing.qty += art.quantite;
      else panelSelections.push({ key: nextSelectionKey(), productId: product.id, qty: art.quantite });
    } else {
      unmatched.push(
        `Panneau "${art.produit ?? "?"}" (${art.quantite} pcs${art.wc ? `, ${art.wc} Wc` : ""}) : aucune correspondance dans le catalogue.`,
      );
    }
  }

  const inverterSelections: ProductSelection[] = [];
  for (const art of articles.onduleurs) {
    const product = findByLabel(art, inverters);
    if (product) {
      const existing = inverterSelections.find((s) => s.productId === product.id);
      if (existing) existing.qty += art.quantite;
      else inverterSelections.push({ key: nextSelectionKey(), productId: product.id, qty: art.quantite });
    } else {
      unmatched.push(`Onduleur "${art.produit ?? "?"}" (${art.quantite}) : aucune correspondance dans le catalogue.`);
    }
  }

  let batteryId = "";
  if (articles.batteries.length > 0) {
    const art = articles.batteries[0];
    const product = findBatteryByKwh(art, batteries);
    if (product) batteryId = product.id;
    else unmatched.push(`Batterie "${art.produit ?? "?"}" : aucune correspondance dans le catalogue.`);
    if (articles.batteries.length > 1) {
      unmatched.push(`${articles.batteries.length - 1} ligne(s) batterie supplementaire(s) ignoree(s) (une seule batterie geree par offre).`);
    }
  }

  if (articles.autres.length > 0) {
    unmatched.push(
      `${articles.autres.length} ligne(s) non classee(s) par Odoo (ni panneau, ni onduleur, ni batterie, ni borne) : a ajouter manuellement si pertinent.`,
    );
  }

  return { panelSelections, inverterSelections, batteryId, unmatched };
}

/**
 * En-tete de colonnes pour les listes de lignes "type Excel" du panneau
 * "Calcul du prix" (decision 42, 12/09/2026, demande de Ben : "on doit voir a
 * droite le produit, puis les quantites et puis ensuite le prix unitaire la
 * marge et le prix client"). Partage le meme grid-template-columns que
 * `.wg-calc-line-row` (voir styles.css) : premiere colonne = article/controle
 * (select, description...), les 7 suivantes = les cellules produites par
 * CalcLinePreview -- pas de grille imbriquee, les deux sont des lignes
 * distinctes de la meme grille CSS, donc les colonnes s'alignent verticalement
 * quel que soit le nombre de lignes de la section. Composant au niveau module
 * (pas imbrique dans App) pour eviter tout remount a chaque rendu.
 */
function CalcLineHeader({ articleLabel = "Article" }: { articleLabel?: string }) {
  return (
    <div className="wg-calc-line-header">
      <span>{articleLabel}</span>
      <span>Puissance</span>
      <span>Qte</span>
      <span>Prix unitaire</span>
      <span>Prix de revient</span>
      <span>Marge</span>
      <span>Multipl.</span>
      <span>Prix client</span>
      <span>Actions</span>
    </div>
  );
}

/**
 * Cellules numeriques d'une ligne "type Excel" (7 colonnes : puissance, qte,
 * prix unitaire, prix de revient, marge, multiplicateur de marge, prix
 * client) -- rendues en React.Fragment (pas de div englobante) pour rester
 * des enfants directs de la grille CSS `.wg-calc-line-row`, alignees avec
 * CalcLineHeader ci-dessus. La 1ere colonne (article/controle) est fournie
 * par l'appelant, cote a cote dans le meme `.wg-calc-line-row`.
 *
 * Ne recalcule rien : `line` porte deja son `unitPrice` et son
 * `marginAppliedAmount` a jour, calcules par computeOfferTotals() au meme
 * rendu (priceOfferLine mute les objets in place, voir pricingEngine.ts) --
 * ce composant ne fait que les mettre en forme.
 *
 * `powerLabel` est fourni par l'appelant (ex : `${product.powerW} Wc`) car
 * OfferLine ne porte pas de puissance -- volontairement, pour ne pas toucher
 * au moteur de calcul valide pour une simple info d'affichage.
 */
function CalcLinePreview({ line, powerLabel, marginBatteryTravel, marginPvElectrical, actions }: {
  line: OfferLine;
  powerLabel?: string;
  marginPvElectrical: number;
  marginBatteryTravel: number;
  actions?: ReactNode;
}) {
  const multiplier = CATEGORIES_MARGIN_BATTERY_TRAVEL.has(line.category) ? marginBatteryTravel : marginPvElectrical;
  return (
    <>
      <span>{powerLabel ?? "-"}</span>
      <span>{line.quantity}</span>
      <span>{formatEur(line.unitCost)}</span>
      <span>{formatEur(lineTotalCost(line))}</span>
      <span>{formatEur(line.marginAppliedAmount)}</span>
      <span>x{multiplier.toFixed(3)}</span>
      <span className="wg-calc-line-price">
        {formatEur(lineTotalPrice(line))}
        {line.manuallyOverridden && <span className="wg-badge wg-badge-modified">modifie</span>}
      </span>
      <span className="wg-calc-line-actions">{actions}</span>
    </>
  );
}

/**
 * Meme 7 cellules que CalcLinePreview, mais pour un poste optionnel pas (ou
 * plus) actif (case decochee, select sur "Aucun"...) : garde la ligne visible
 * dans le tableau avec des tirets plutot que de la faire disparaitre, sur le
 * modele de l'Excel audite (ou une option desactivee reste une ligne du
 * tableau avec des "-" plutot que d'etre retiree). Evite que la grille se
 * desaligne selon l'etat de chaque case a cocher (decision 49, 15/09/2026:
 * "il faudrait que tout soit sous forme de tableau").
 */
function CalcLineEmpty() {
  return (
    <>
      <span>-</span>
      <span>-</span>
      <span>-</span>
      <span>-</span>
      <span>-</span>
      <span>-</span>
      <span>-</span>
      <span></span>
    </>
  );
}

/** CalcLinePreview si le poste est actif (ligne presente dans `bySlot`), CalcLineEmpty sinon -- voir CalcLineEmpty. */
function CalcLineSlot({ line, powerLabel, marginPvElectrical, marginBatteryTravel, actions }: {
  line: OfferLine | undefined;
  powerLabel?: string;
  marginPvElectrical: number;
  marginBatteryTravel: number;
  actions?: ReactNode;
}) {
  if (!line) return <CalcLineEmpty />;
  return (
    <CalcLinePreview
      line={line}
      powerLabel={powerLabel}
      marginPvElectrical={marginPvElectrical}
      marginBatteryTravel={marginBatteryTravel}
      actions={actions}
    />
  );
}

/**
 * Sous-total d'une section du panneau "Calcul du prix" (decision 55,
 * 15/09/2026, demande de Ben : "qu'il y ait une somme de chacun des postes
 * contenus dans chacune des sections", au moins prix de revient/marge/prix
 * client). Pur agregat d'affichage sur les lignes deja calculees (mêmes
 * lignes que celles rendues par les CalcLinePreview/CalcLineSlot de la
 * section, jamais un recalcul) -- une section sans ligne active ne montre
 * rien plutot qu'un sous-total a 0.
 */
function SectionSubtotal({ lines }: { lines: OfferLine[] }) {
  if (lines.length === 0) return null;
  const cost = lines.reduce((sum, l) => sum + lineTotalCost(l), 0);
  const margin = lines.reduce((sum, l) => sum + l.marginAppliedAmount, 0);
  const price = lines.reduce((sum, l) => sum + lineTotalPrice(l), 0);
  return (
    <div className="wg-section-subtotal">
      <span className="wg-section-subtotal-label">Sous-total section</span>
      <span>
        Prix de revient <strong>{formatEur(cost)}</strong>
      </span>
      <span>
        Marge <strong>{formatEur(margin)}</strong>
      </span>
      <span>
        Prix client <strong>{formatEur(price)}</strong>
      </span>
    </div>
  );
}

/**
 * Premier ecran reel de la Phase 2 : le meme cas de reference que le
 * prototype abandonne (decision 25 du 04/09/2026), mais cette fois branche
 * sur le vrai catalogue Supabase au lieu de donnees codees en dur.
 *
 * Etat au 10/09/2026 (decision 33) : structures/carport, optimiseurs,
 * cablage AC, regime CV/rentabilite 25 ans et cles de repartition marches
 * publics sont branches (moteur deja valide 16/16, cf.
 * claude/cartographie-et-plan-action.md).
 *
 * Etat au 10/09/2026 (decision 34) : cablage DC ajoute au moteur (choix par
 * ampacite, pas de formule de chute de tension documentee pour le DC -- voir
 * engine/cableEngine.ts). L'ecran est desormais divise en 3 sections
 * (onglets), sur le modele des feuilles Excel : "Donnees" (parametres de
 * reference actifs, lecture seule), "Calcul du prix" (saisie + detail ligne
 * par ligne, ex Calcul du prix/Calcul detaille) et "Offre" (vue finale :
 * totaux, rentabilite 25 ans, metre marche public -- ex feuilles de
 * presentation Offre Bruxelles/Wallonie-Flandre). Un mode secondaire "Offre
 * batterie uniquement" masque tout ce qui est specifique au PV (panneaux,
 * onduleur, structure, optimiseurs, cablage AC/DC, region/regime CV,
 * rentabilite) pour ne garder que la ligne batterie et le deplacement,
 * sur le modele de l'onglet Excel "Offre Batterie".
 *
 * Etat au 10/09/2026 (decision 35) : quatrieme onglet "Back-office", gate par
 * une connexion Supabase Auth (email/mot de passe -- aucun compte n'existait
 * avant cette decision, le premier compte cree via ce formulaire devient de
 * fait le premier utilisateur autorise a ecrire). Permet d'editer les tables
 * catalogue/parametres (produits, marges, commission, deplacement, cablage,
 * regions, CV, main-d'oeuvre...) via un editeur generique (AdminTableEditor)
 * pilote par config (src/admin/tableConfigs.ts), au lieu de passer par SQL.
 * Explicitement hors perimetre pour l'instant (priorite de Ben, 10/09/2026) :
 * la sauvegarde automatique des offres elles-memes (tables offers/offer_lines
 * restent vides, aucune ecriture depuis l'app cote "Calcul"/"Offre").
 *
 * Etat au 10/09/2026 (decision 36) : passe de mise en forme visuelle,
 * demandee par Ben apres le premier retour terrain ("ca ne ressemble pas
 * encore a grand chose"). Nouvelle feuille de style partagee (styles.css,
 * classes prefixees wg-) inspiree de la grille Excel : onglets en forme de
 * feuille de classeur, tableaux avec quadrillage et alignement numerique a
 * droite, panneaux de section marques, bloc totaux mis en evidence. Purement
 * presentationnel : aucune logique de calcul ni d'acces aux donnees modifiee.
 *
 * Etat au 11/09/2026 (decision 38) : parite Excel demandee par Ben ("100% du
 * contenu doit s'y retrouver, dans le calcul du prix... dans les donnees...
 * dans l'offre et dans la base de donnees"). Nouveau panneau "Main-d'oeuvre
 * et options electriques" (mode "offre complete" uniquement) qui ajoute
 * jusqu'a une quinzaine de lignes auparavant absentes du moteur : main-
 * d'oeuvre toiture/electricien, tranchee, redevance GRD (a notre charge,
 * toggle), provision cablage/matos AC, certification electrique (toujours
 * active), cabine de decouplage (auto au-dela de 30 kVA), transformateur,
 * compteurs (Energy Meter / Compteur vert), EMS (+ licence optionnelle,
 * formule presente dans l'Excel mais jamais reliee a aucune ligne -- voir
 * engine/laborEngine.ts emsLicenseFee), manutention (lift/nacelle/transport
 * auto/enlevement/grue) et forfaits divers (Green Box, certification Brugel,
 * etude de stabilite). Chaque ligne porte desormais un `lineType`
 * (marchandise / main_doeuvre / service, cf. engine/types.ts) qui
 * differencie en base la main-d'oeuvre des marchandises, comme demande.
 * L'onglet "Offre" reste generique (il boucle sur `lines`) : ces nouvelles
 * lignes y apparaissent automatiquement, sans code specifique.
 *
 * Etat au 11/09/2026 (decision 40) : lot de retours terrain de Ben apres le
 * premier essai. (1) Multi-panneaux et multi-onduleurs : plusieurs modeles
 * differents par offre (type ProductSelection), chacun avec sa quantite ;
 * toutes les formules basees sur la puissance onduleur (MO electricien, GRD,
 * certification electrique, cabine de decouplage, licence EMS) utilisent
 * desormais la somme des kVA de tous les onduleurs selectionnes, et la
 * puissance crete PV la somme des Wc de tous les panneaux -- confirme par
 * Ben. Le cablage AC produit une ligne par modele d'onduleur (longueur
 * commune x quantite du modele, simplification documentee). La liste des
 * onduleurs est triee par marque. (2) La ligne "Batterie" est decomposee en
 * sous-lignes visibles (module, chargeur, tableau electrique, main-d'oeuvre,
 * prime BEBAT), chacune gardant category: "Batterie" pour que la marge K21
 * et le filtre "sans batterie" continuent de fonctionner sans changement du
 * moteur. (3) Affichage de la marge enrichi dans "Calcul du prix" : colonnes
 * "Marge unitaire"/"Marge (ligne)" sur chaque ligne, marge totale affichee
 * dans le panneau Marge (repositionne juste au-dessus du tableau), et
 * nouveau bloc de synthese en tete d'onglet (prix client TTC, prix HTVA
 * avec/sans batterie, prix/Wc dans ses differentes variantes -- calcule via
 * un second appel a computeOfferTotals sur les lignes hors category
 * "Batterie"). (4) Onglet "Offre" : decomposition masquee par defaut (seuls
 * les totaux sont visibles), avec un selecteur pour reveler le detail "par
 * section" (sous-totaux par categorie) ou "par ligne" (comportement
 * historique) -- une offre marche public force toujours le detail ligne par
 * ligne, sans selecteur. (5) Litterature commerciale (description generale,
 * conditions de vente, garanties, avantages, signatures) extraite du
 * classeur Excel audite et integree a l'onglet Offre (src/content/
 * offerLiterature.ts) -- texte de presentation, pas une donnee catalogue,
 * volontairement hors base de donnees pour l'instant. (6) Onglet "Donnees" :
 * parametres financiers (prix reseau, inflation, prix CV, ratio de revente,
 * rendement de production, auto-consommation) desormais presentes comme
 * modifiables par offre (overrides, memes valeurs que dans "Calcul du
 * prix") ; ajout de deux emplacements "a venir" (import Odoo -- clients,
 * onduleurs, PV, batteries, modules PM, optimiseurs -- et import Archelios/
 * Helioscope par glisser-deposer) : uniquement visuels, aucun backend
 * branche (decision explicite de Ben : "placeholders seulement"). (7) Back-
 * office : la table `products` (jusque-la une seule vue melant panneaux/
 * onduleurs/batteries) est desormais presentee en 3 vues separees par
 * categorie (Panneaux PV / Onduleurs / Batteries), chacune triee par marque
 * -- voir AdminTableConfig.fixedFilter (src/admin/tableConfigs.ts) et son
 * application dans AdminTableEditor.tsx.
 *
 * Restent hors perimetre : generation PDF, versioning, ecriture des offres
 * (offers/offer_lines), integration Odoo, gestion fine des roles
 * (admin/configurateur/pm/commercial -- V1 : tout compte connecte peut tout
 * modifier dans le back-office).
 *
 * Etat au 11/09/2026 (decision 41) : reorganisation demandee par Ben apres
 * le lot precedent. (1) Ordre des onglets change en Donnees -> Calcul du
 * prix -> Offre -> Back-office (onglet par defaut desormais "Donnees"),
 * pour suivre le flux de travail reel plutot que l'ordre de developpement.
 * (2) Onglet "Donnees" recentre : retrait de tous les recapitulatifs
 * catalogue/baremes lies a l'installation (panneaux, onduleurs, MO,
 * cablage, manutention...), qui n'ont plus leur place ici puisque les choix
 * d'installation se font dans "Calcul du prix" -- sur le modele de la
 * feuille "Donnees" de l'Excel, qui ne porte que la fiche client et les
 * parametres globaux, jamais le detail d'une installation. A la place :
 * nouvelle fiche client (type particulier/societe, nom, adresse, langue de
 * l'offre -- champs d'etat locaux, non persistes en base, l'ecriture reelle
 * des offres restant hors perimetre), et les parametres modifiables
 * regroupes par theme (Production et auto-consommation ; Certificats Verts
 * et revente ; Prix de l'energie), plus les deux emplacements "a venir"
 * (Odoo, Archelios/Helioscope) deja en place. Nouveau : le taux CV
 * (CV/MWh, Bruxelles) suit desormais le meme mecanisme suggere/applique que
 * la marge -- propose automatiquement selon la puissance installee
 * (cv_rate_brackets), mais modifiable manuellement (cvRateOverride) --
 * demande explicite de Ben ("meme si a terme il peut etre pique
 * automatiquement, il peut etre modifie manuellement"). Le taux
 * d'auto-consommation et le rendement de production restent modifiables
 * uniquement dans "Donnees" desormais (retires du panneau "Region et regime
 * de revenus" de "Calcul du prix", qui n'affiche plus que la region -- avec
 * un rappel en lecture seule des valeurs en vigueur -- pour coller a la
 * position de ces champs dans la feuille Excel). (3) Onglet "Calcul du
 * prix" : panneau "Main-d'oeuvre et options electriques" reorganise dans
 * l'ordre des lignes 18 a 40 de la feuille Excel (toiture/tranchee,
 * cablage/matos AC, certifications et compteurs, Energy Meter/EMS/
 * transformateur, manutention, etudes complementaires), chaque select
 * desormais regroupe avec sa case a cocher associee plutot que tous les
 * selects puis toutes les cases comme precedemment -- aucune formule
 * modifiee, uniquement la disposition. (4) Onglet "Offre" enrichi : nouvelle
 * page de garde (nom/adresse client, langue, date, prix TTC bien en
 * evidence) reprenant la fiche client de "Donnees", et nouvelle section
 * "Contenu de l'offre" listant les produits reellement selectionnes
 * (panneaux, onduleurs, structure, optimiseurs, batterie -- avec marque,
 * modele et quantite), equivalent des lignes descriptives generees par
 * CONCATENATE/VLOOKUP dans les feuilles de presentation Excel (referentiel,
 * section 12), jamais un texte generique fige. Nouvelles classes CSS
 * dediees (wg-offer-cover, wg-offer-bullets) et wg-subsection-title pour le
 * regroupement des champs dans "Calcul du prix" (src/styles.css). Aucune
 * formule du moteur de calcul modifiee dans ce lot (npm run validate:engine
 * reste a 25/25) : uniquement de l'agregation d'affichage et de la
 * reorganisation d'ecran.
 */
export default function App() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [panels, setPanels] = useState<Product[]>([]);
  const [inverters, setInverters] = useState<Product[]>([]);
  const [batteries, setBatteries] = useState<Product[]>([]);
  const [marginCurve, setMarginCurve] = useState<MarginCurvePoint[]>([]);
  const [commissionSettings, setCommissionSettings] = useState<CommissionSettings | null>(null);
  const [travelRule, setTravelRule] = useState<TravelCostRule | null>(null);
  const [vatRate, setVatRate] = useState<number>(0.06);
  const [bebatRate, setBebatRate] = useState<number>(0);
  const [carportConfigs, setCarportConfigs] = useState<CarportConfig[]>([]);
  const [optimizers, setOptimizers] = useState<Optimizer[]>([]);
  const [cableAcCatalog, setCableAcCatalog] = useState<CableAcOption[]>([]);
  const [cableDcCatalog, setCableDcCatalog] = useState<CableDcOption[]>([]);
  const [dcAmpacityTable, setDcAmpacityTable] = useState<DcAmpacityEntry[]>([]);
  const [cableSizingParams, setCableSizingParams] = useState<CableSizingParameters>(DEFAULT_CABLE_SIZING_PARAMETERS);
  const [financialParams, setFinancialParams] = useState<FinancialParameters | null>(null);
  const [cvBrackets, setCvBrackets] = useState<CvBracket[]>([]);
  const [suggestedAutoConsumption, setSuggestedAutoConsumption] = useState<number | null>(null);

  // Multi-panneaux / multi-onduleurs (decision 40, 11/09/2026) : plusieurs
  // modeles differents par offre, chacun avec sa propre quantite -- remplace
  // les anciens panelId/panelQty/inverterId (un seul modele possible).
  const [panelSelections, setPanelSelections] = useState<ProductSelection[]>([]);
  const [inverterSelections, setInverterSelections] = useState<ProductSelection[]>([]);
  // Quantites totales brutes (avant rapprochement catalogue) : utilisees par
  // des effets qui s'executent avant le chargement complet du catalogue.
  const totalPanelQty = panelSelections.reduce((sum, s) => sum + (s.qty > 0 ? s.qty : 0), 0);
  const totalInverterCount = inverterSelections.reduce((sum, s) => sum + (s.qty > 0 ? s.qty : 0), 0);
  const [batteryId, setBatteryId] = useState<string>("");
  // Composition complete (pas seulement le total AC) : necessaire pour
  // decomposer la ligne "Batterie" en sous-lignes visibles (decision 40,
  // demande explicite de Ben "bien decomposer les prix des batteries").
  const [batteryComposition, setBatteryComposition] = useState<BatteryComposition | null>(null);
  const [carportConfigId, setCarportConfigId] = useState<string>("");
  const [optimizerId, setOptimizerId] = useState<string>("");
  const [optimizerQty, setOptimizerQty] = useState<number>(0);
  const [cableLengthM, setCableLengthM] = useState<number>(10);
  // Cablage DC : pas de courant panneau (Isc/Impp) dans le catalogue produits
  // (voir specs des panneaux, engine/types.ts), donc saisie manuelle plutot
  // qu'une valeur deduite -- 12A par defaut (ordre de grandeur Isc courant
  // pour un panneau residentiel 450-620Wc). A ajuster par offre.
  const [dcCurrentA, setDcCurrentA] = useState<number>(12);
  const [dcCableLengthM, setDcCableLengthM] = useState<number>(15);
  const [dcCircuitCount, setDcCircuitCount] = useState<number>(1);

  const [marginPvElectrical, setMarginPvElectrical] = useState<number>(1.3); // K12
  const [marginBatteryTravel, setMarginBatteryTravel] = useState<number>(1.45); // K21
  const [commissionRate, setCommissionRate] = useState<number>(0.25);
  const [distanceKm, setDistanceKm] = useState<number>(20);
  const [overriddenLines, setOverriddenLines] = useState<Record<string, number>>({});

  const [region, setRegion] = useState<Region>(Region.BRUXELLES);
  const [autoConsumptionOverride, setAutoConsumptionOverride] = useState<number | null>(null);
  const [productionYieldOverride, setProductionYieldOverride] = useState<number | null>(null);
  // Parametres financiers modifiables par offre (decision 40, 11/09/2026,
  // demande de Ben : prix reseau/inflation/prix CV/ratio de revente
  // presentes comme modifiables dans l'onglet Donnees, sur le meme principe
  // que l'auto-consommation et le rendement de production ci-dessus).
  // undefined = valeur de reference chargee depuis financial_parameters, non
  // surchargee -- ces overrides ne modifient jamais la base, uniquement le
  // calcul de cette offre.
  const [networkPriceOverride, setNetworkPriceOverride] = useState<number | null>(null);
  const [inflationRateOverride, setInflationRateOverride] = useState<number | null>(null);
  const [cvBuybackPriceOverride, setCvBuybackPriceOverride] = useState<number | null>(null);
  const [resalePriceRatioOverride, setResalePriceRatioOverride] = useState<number | null>(null);
  // Taux de Certificats Verts (CV/MWh, Bruxelles) : automatiquement propose
  // selon la puissance installee (bareme cv_rate_brackets, meme mecanisme que
  // la marge suggeree), mais modifiable manuellement offre par offre
  // (decision 41, demande explicite de Ben : "meme si a terme il peut etre
  // pique automatiquement, il peut etre modifie manuellement").
  const [cvRateOverride, setCvRateOverride] = useState<number | null>(null);
  // Fiche client minimale (feuille "Donnees" de l'Excel, decision 41,
  // 11/09/2026) : type de client, nom, adresse, langue de l'offre. Saisie
  // pour l'offre en cours, non persistee en base pour l'instant (l'ecriture
  // reelle des offres reste hors perimetre -- voir decision 34/35 de la
  // cartographie).
  const [clientType, setClientType] = useState<"particulier" | "societe">("particulier");
  const [clientName, setClientName] = useState<string>("");
  const [clientAddress, setClientAddress] = useState<string>("");
  const [offerLanguage, setOfferLanguage] = useState<"FR" | "NL">("FR");
  const [isPublicTender, setIsPublicTender] = useState<boolean>(false);

  // Import Odoo en lecture (Phase 3 de la cartographie, decision 43,
  // 12/09/2026) : pre-remplit la fiche client depuis un devis Odoo existant.
  // Les lignes du devis sont conservees a titre de reference uniquement --
  // aucun rapprochement automatique avec le catalogue de l'offre (voir
  // avertissement renvoye par l'Edge Function odoo-import).
  const [odooReference, setOdooReference] = useState<string>("");
  const [odooLoading, setOdooLoading] = useState(false);
  const [odooError, setOdooError] = useState<string | null>(null);
  const [odooResult, setOdooResult] = useState<OdooImportResult | null>(null);
  // Confirmation d'ecrasement avant d'appliquer les articles Odoo dans
  // "Calcul du prix" (decision 50, 15/09/2026, demande explicite de Ben :
  // "si articles deja existants, mettre un pop up ou un bouton demandant si
  // on veut ecraser les marchandises existantes"). Pas de window.confirm
  // natif : on reste sur le pattern d'alerte deja utilise dans l'app
  // (wg-banner-warning), avec un bouton de confirmation explicite.
  const [odooOverwriteConfirm, setOdooOverwriteConfirm] = useState(false);
  const [odooApplyMessage, setOdooApplyMessage] = useState<string | null>(null);

  // Responsable / PM We Green (decision 50, 15/09/2026) : contrairement a la
  // version precedente (affichage informatif uniquement dans le panneau
  // d'import Odoo), c'est desormais un champ reel de l'offre, pre-rempli par
  // l'import mais modifiable et repris dans l'onglet "Offre" -- sur le meme
  // principe que la fiche client (clientName/clientAddress ci-dessus).
  const [responsableNom, setResponsableNom] = useState<string>("");
  const [responsableTelephone, setResponsableTelephone] = useState<string>("");
  const [responsableEmail, setResponsableEmail] = useState<string>("");

  // Import Archelios / Helioscope (decision 53/54, chantier 4 de la roadmap
  // de la decision 49) : extraction cote client (pdf.js, voir
  // src/pdf/archeliosPdf.ts) de l'image de calepinage/implantation depuis le
  // rapport PDF, pour l'inserer dans l'offre. Rien n'est envoye a un
  // serveur. Detection automatique de la page par defaut (decision 54,
  // algorithme repris du Briefing de chantier existant, a la demande de
  // Ben), avec un navigateur manuel de secours si la detection se trompe.
  const archeliosDocRef = useRef<ArcheliosPdfDocument | null>(null);
  const [archeliosFilename, setArcheliosFilename] = useState<string | null>(null);
  const [archeliosNumPages, setArcheliosNumPages] = useState(0);
  const [archeliosCurrentPage, setArcheliosCurrentPage] = useState(1);
  const [archeliosPreviewDataUrl, setArcheliosPreviewDataUrl] = useState<string | null>(null);
  const [archeliosBrowsing, setArcheliosBrowsing] = useState(false);
  const [archeliosLoading, setArcheliosLoading] = useState(false);
  const [archeliosError, setArcheliosError] = useState<string | null>(null);
  const [archeliosImage, setArcheliosImage] = useState<{
    dataUrl: string;
    sourceFilename: string;
    pageNumber: number;
    numPages: number;
    sourceType: ArcheliosSourceType;
    auto: boolean;
  } | null>(null);

  function removeArcheliosImage() {
    archeliosDocRef.current = null;
    setArcheliosFilename(null);
    setArcheliosNumPages(0);
    setArcheliosCurrentPage(1);
    setArcheliosPreviewDataUrl(null);
    setArcheliosBrowsing(false);
    setArcheliosError(null);
    setArcheliosImage(null);
  }

  async function handleArcheliosFile(file: File) {
    setArcheliosError(null);
    setArcheliosLoading(true);
    setArcheliosBrowsing(false);
    try {
      const doc = await loadArcheliosPdf(file);
      const result = await detectAndRenderCalepinage(doc);
      archeliosDocRef.current = doc;
      setArcheliosFilename(file.name);
      setArcheliosNumPages(result.numPages);
      setArcheliosCurrentPage(result.pageNumber);
      setArcheliosImage({
        dataUrl: result.dataUrl,
        sourceFilename: file.name,
        pageNumber: result.pageNumber,
        numPages: result.numPages,
        sourceType: result.sourceType,
        auto: true,
      });
    } catch (err) {
      archeliosDocRef.current = null;
      setArcheliosFilename(null);
      setArcheliosNumPages(0);
      setArcheliosImage(null);
      setArcheliosError(err instanceof ArcheliosPdfError ? err.message : "Erreur inattendue lors de la lecture du PDF.");
    } finally {
      setArcheliosLoading(false);
    }
  }

  function openArcheliosBrowser() {
    if (!archeliosDocRef.current) return;
    setArcheliosError(null);
    setArcheliosCurrentPage(archeliosImage?.pageNumber ?? 1);
    setArcheliosPreviewDataUrl(archeliosImage?.dataUrl ?? null);
    setArcheliosBrowsing(true);
  }

  async function goToArcheliosPage(pageNumber: number) {
    if (!archeliosDocRef.current || pageNumber < 1 || pageNumber > archeliosNumPages) return;
    setArcheliosLoading(true);
    setArcheliosError(null);
    try {
      const dataUrl = await renderPageToDataUrl(archeliosDocRef.current, pageNumber);
      setArcheliosCurrentPage(pageNumber);
      setArcheliosPreviewDataUrl(dataUrl);
    } catch (err) {
      setArcheliosError(
        err instanceof ArcheliosPdfError ? err.message : "Erreur inattendue lors de l'affichage de cette page.",
      );
    } finally {
      setArcheliosLoading(false);
    }
  }

  function confirmArcheliosBrowsedPage() {
    if (!archeliosPreviewDataUrl || !archeliosFilename) return;
    setArcheliosImage({
      dataUrl: archeliosPreviewDataUrl,
      sourceFilename: archeliosFilename,
      pageNumber: archeliosCurrentPage,
      numPages: archeliosNumPages,
      sourceType: archeliosImage?.sourceType ?? "PDF",
      auto: false,
    });
    setArcheliosBrowsing(false);
  }

  function formatOdooAddress(address: OdooAddress | null): string {
    if (!address) return "";
    const line2 = [address.codePostal, address.ville].filter(Boolean).join(" ");
    return [address.rue, address.complement, line2, address.pays].filter(Boolean).join("\n");
  }

  /** Resume court des articles detectes, sur le modele du message "found.join(...)" du Briefing de chantier (decision 44). */
  function summarizeOdooArticles(articles: OdooImportResult["articles"]): string[] {
    const totalQty = (list: { quantite: number }[]) => list.reduce((sum, a) => sum + (a.quantite || 0), 0);
    const parts: string[] = [];
    if (articles.panneaux.length) parts.push(`panneaux (${totalQty(articles.panneaux)} pcs)`);
    if (articles.onduleurs.length) parts.push(`onduleurs (${articles.onduleurs.length})`);
    if (articles.batteries.length) parts.push("batterie");
    if (articles.bornes.length) parts.push("borne");
    if (articles.greenbox) parts.push("green box");
    if (articles.autres.length) parts.push(`${articles.autres.length} autre(s) ligne(s) non classee(s)`);
    return parts;
  }

  async function handleImportOdoo() {
    setOdooLoading(true);
    setOdooError(null);
    setOdooOverwriteConfirm(false);
    setOdooApplyMessage(null);
    try {
      const result = await importOdooQuote(odooReference);
      setOdooResult(result);
      if (result.client) {
        setClientName(result.client.nom ?? "");
        setClientAddress(formatOdooAddress(result.adresseFacturation ?? result.client));
        setClientType(result.client.estSociete ? "societe" : "particulier");
      }
      if (result.responsable) {
        setResponsableNom(result.responsable.nom ?? "");
        setResponsableTelephone(result.responsable.telephone ?? "");
        setResponsableEmail(result.responsable.email ?? "");
      }
    } catch (err) {
      setOdooResult(null);
      setOdooError(err instanceof OdooImportError ? err.message : "Erreur inattendue lors de l'import Odoo.");
    } finally {
      setOdooLoading(false);
    }
  }

  // Rapprochement Odoo -> catalogue, recalcule uniquement quand le devis
  // importe ou les catalogues changent (pas a chaque rendu) : sert a la fois
  // a l'apercu affiche dans le panneau d'import et a l'application reelle
  // (applyOdooArticlesToCalcul ci-dessous), pour garantir que l'un et
  // l'autre montrent exactement le meme rapprochement.
  const odooArticleMatch = useMemo(
    () => (odooResult ? matchOdooArticlesToCatalog(odooResult.articles, panels, inverters, batteries) : null),
    [odooResult, panels, inverters, batteries],
  );

  /**
   * Applique les articles Odoo rapproches (odooArticleMatch) dans "Calcul du
   * prix" : remplace panelSelections/inverterSelections/batteryId. Decision
   * 50 : n'est jamais appelee directement depuis un select non vide sans
   * confirmation prealable -- voir odooOverwriteConfirm et le bouton
   * correspondant dans l'onglet "Donnees".
   */
  function applyOdooArticlesToCalcul() {
    if (!odooArticleMatch) return;
    const match = odooArticleMatch;
    if (match.panelSelections.length > 0) setPanelSelections(match.panelSelections);
    if (match.inverterSelections.length > 0) setInverterSelections(match.inverterSelections);
    if (match.batteryId) setBatteryId(match.batteryId);
    const applied: string[] = [];
    if (match.panelSelections.length > 0) applied.push(`${match.panelSelections.length} modele(s) de panneau`);
    if (match.inverterSelections.length > 0) applied.push(`${match.inverterSelections.length} modele(s) d'onduleur`);
    if (match.batteryId) applied.push("1 batterie");
    setOdooApplyMessage(
      applied.length > 0
        ? `Applique dans "Calcul du prix" : ${applied.join(", ")}.${match.unmatched.length ? " Voir les articles non rapproches ci-dessous." : ""}`
        : "Aucun article rapproche automatiquement au catalogue -- rien n'a ete applique.",
    );
    setOdooOverwriteConfirm(false);
  }

  function handleUseOdooArticlesClick() {
    const hasExisting = panelSelections.some((s) => s.qty > 0) || inverterSelections.some((s) => s.qty > 0) || Boolean(batteryId);
    if (hasExisting) {
      setOdooOverwriteConfirm(true);
    } else {
      applyOdooArticlesToCalcul();
    }
  }
  const [repartitionOverrides, setRepartitionOverrides] = useState<Record<string, boolean>>({});
  // Niveau de detail affiche dans l'onglet "Offre" (decision 40, 11/09/2026) :
  // masque par defaut (totaux uniquement) pour les offres hors marche public,
  // avec possibilite de reveler le detail par section (sous-totaux par
  // categorie) ou par ligne (comportement historique). Ignore en marche
  // public : le detail ligne par ligne reste toujours force (cles de
  // repartition), comportement inchange.
  const [priceDetailLevel, setPriceDetailLevel] = useState<"totaux" | "section" | "ligne">("totaux");

  // Parite Excel "Calcul du prix" (decision 38, 11/09/2026) : main-d'oeuvre,
  // tranchees, GRD, provision cablage/matos AC, certification electrique,
  // cabine de decouplage, transformateur, compteurs, EMS, manutention,
  // forfaits divers. Reference/catalogue charges une fois au demarrage.
  const [laborRoofRates, setLaborRoofRates] = useState<LaborRoofRate[]>([]);
  const [laborElectricianRates, setLaborElectricianRates] = useState<LaborElectricianRate[]>([]);
  const [trenchRates, setTrenchRates] = useState<TrenchRate[]>([]);
  const [regionsMap, setRegionsMap] = useState<Record<string, string>>({});
  const [grdSchedule, setGrdSchedule] = useState<GrdFeeBracket[]>([]);
  const [cablingForfaitTiers, setCablingForfaitTiers] = useState<CablingForfaitTier[]>([]);
  const [cablingComplexityMultiplier, setCablingComplexityMultiplier] = useState<number>(1.5);
  const [transportPanelsPerTrip, setTransportPanelsPerTrip] = useState<number>(72);
  const [electricalCertificationTiers, setElectricalCertificationTiers] = useState<ElectricalCertificationTier[]>([]);
  const [handlingRates, setHandlingRates] = useState<HandlingRate[]>([]);
  const [flatFeeOptions, setFlatFeeOptions] = useState<FlatFeeOption[]>([]);
  const [cabineDecouplageCatalog, setCabineDecouplageCatalog] = useState<ElecOptionComponent[]>([]);
  const [transformateurCatalog, setTransformateurCatalog] = useState<ElecOptionComponent[]>([]);
  const [compteurCatalog, setCompteurCatalog] = useState<ElecOptionComponent[]>([]);
  const [emsCatalog, setEmsCatalog] = useState<ElecOptionComponent[]>([]);

  // Constante "pas de tranchee" (donnee `trench_rates`, tarif 0) : evite de
  // coder en dur une valeur qui pourrait changer d'orthographe en base.
  const NO_TRENCH_LABEL = "Non (pas de tranchee)";

  const [roofType, setRoofType] = useState<string>("");
  const [trenchSoilType, setTrenchSoilType] = useState<string>(NO_TRENCH_LABEL);
  const [trenchLengthM, setTrenchLengthM] = useState<number>(0);
  const [grdChargeToUs, setGrdChargeToUs] = useState<boolean>(false);
  const [cablingComplique, setCablingComplique] = useState<boolean>(false);
  const [matosAcComplique, setMatosAcComplique] = useState<boolean>(false);
  const [certificationElectriqueEnabled, setCertificationElectriqueEnabled] = useState<boolean>(true);
  const [transformateurId, setTransformateurId] = useState<string>("");
  const [energyMeterEnabled, setEnergyMeterEnabled] = useState<boolean>(false);
  const [energyMeterPhase, setEnergyMeterPhase] = useState<string>("Monophasé");
  const [compteurVertEnabled, setCompteurVertEnabled] = useState<boolean>(false);
  const [compteurVertPhase, setCompteurVertPhase] = useState<string>("Monophasé");
  const [emsId, setEmsId] = useState<string>("");
  // Cf. laborEngine.ts emsLicenseFee : formule presente dans l'Excel (Elec!
  // M49/M50) mais jamais additionnee dans aucune ligne de "Calcul du prix" --
  // vraisemblablement un oubli du classeur source. Ajoutee ici comme ligne
  // optionnelle, desactivee par defaut, pour ne pas alterer silencieusement
  // le total par rapport a l'Excel tant que Ben n'a pas tranche.
  const [emsLicenseBillingEnabled, setEmsLicenseBillingEnabled] = useState<boolean>(false);
  const [liftEnabled, setLiftEnabled] = useState<boolean>(false);
  const [nacelleDays, setNacelleDays] = useState<number>(0);
  const [enlevementEnabled, setEnlevementEnabled] = useState<boolean>(false);
  const [grueChoice, setGrueChoice] = useState<string>("");
  const [greenBoxEnabled, setGreenBoxEnabled] = useState<boolean>(false);
  const [brugelEnabled, setBrugelEnabled] = useState<boolean>(false);
  const [stabilityStudyEnabled, setStabilityStudyEnabled] = useState<boolean>(false);

  // Sections (ex feuilles Excel) et mode "offre batterie uniquement" (ex
  // onglet Excel "Offre Batterie", cf. decision 34). "backoffice" ajoute par
  // la decision 35 (edition des tables catalogue/parametres).
  // Ordre des onglets aligne sur le flux de travail demande par Ben
  // (decision 41, 11/09/2026) : Donnees (client, adresse, parametres
  // modifiables) d'abord, puis Calcul du prix, puis Offre.
  const [activeTab, setActiveTab] = useState<"donnees" | "calcul" | "offre" | "backoffice">("donnees");
  const [offerMode, setOfferMode] = useState<"complete" | "batterie">("complete");
  // Export PDF de l'offre (decision 51, 15/09/2026, point 2 de la decision 49
  // -- "pouvoir exporter l'offre en PDF", en s'inspirant visuellement de
  // l'offre PDF reelle de Ben) : s'appuie sur l'impression navigateur
  // ("Enregistrer en PDF"), avec une feuille de style @media print dediee
  // (styles.css) qui reprend la mise en page de l'onglet "Offre" -- pas de
  // bibliotheque PDF supplementaire, la source du document imprime est la
  // meme que celle affichee a l'ecran (jamais deux templates a maintenir).
  // Si un autre onglet est actif au moment du clic, on bascule d'abord sur
  // "Offre" puis on attend son rendu avant d'ouvrir l'impression.
  const [pendingPrint, setPendingPrint] = useState(false);

  // Attend que l'onglet "Offre" soit effectivement rendu (changement
  // d'activeTab asynchrone) avant d'ouvrir la boite de dialogue d'impression
  // -- sinon window.print() capturerait encore le contenu de l'onglet
  // precedent.
  useEffect(() => {
    if (pendingPrint && activeTab === "offre") {
      setPendingPrint(false);
      const id = requestAnimationFrame(() => window.print());
      return () => cancelAnimationFrame(id);
    }
  }, [pendingPrint, activeTab]);

  function handleExportPdf() {
    if (activeTab !== "offre") {
      setActiveTab("offre");
      setPendingPrint(true);
    } else {
      window.print();
    }
  }

  const { session, authLoading, signOut } = useSupabaseAuth();
  const [selectedAdminTable, setSelectedAdminTable] = useState<string>(ADMIN_TABLES[0]?.id ?? ADMIN_TABLES[0]?.table ?? "");

  useEffect(() => {
    if (!supabaseConfigured) {
      setLoading(false);
      setError(
        "Supabase n'est pas encore configure (voir .env.example). " +
          "Renseigne VITE_SUPABASE_URL et VITE_SUPABASE_ANON_KEY une fois le projet cree.",
      );
      return;
    }
    (async () => {
      try {
        const [
          p,
          i,
          b,
          curve,
          commission,
          travel,
          vat,
          carports,
          opts,
          cableCatalog,
          cableDc,
          dcAmpacity,
          cableParams,
          financial,
          roofRates,
          electricianRates,
          trench,
          regionsList,
          grd,
          cablingTiers,
          cablingMultiplier,
          panelsPerTrip,
          certifTiers,
          handling,
          flatFees,
          cabineDecouplage,
          transformateurs,
          compteurs,
          ems,
        ] = await Promise.all([
          fetchProductsByCategory("Panneaux PV"),
          fetchProductsByCategory("Onduleurs"),
          fetchProductsByCategory("Batteries"),
          fetchMarginCurve(),
          fetchCommissionSettings(),
          fetchTravelCostRule(),
          fetchDefaultVatRate(),
          fetchCarportConfigs(),
          fetchOptimizers(),
          fetchCableAcCatalog(),
          fetchCableDcCatalog(),
          fetchDcAmpacityTable(),
          fetchCableSizingParameters(),
          fetchFinancialParameters(),
          fetchLaborRoofRates(),
          fetchLaborElectricianRates(),
          fetchTrenchRates(),
          fetchRegions(),
          fetchGrdFeeSchedule(),
          fetchCablingForfaitTiers(),
          fetchMiscCalculationParameter("cabling_complexity_multiplier"),
          fetchMiscCalculationParameter("transport_panels_per_trip"),
          fetchElectricalCertificationTiers(),
          fetchHandlingRates(),
          fetchFlatFeeOptions(),
          fetchElecComponentsByType("cabine_decouplage"),
          fetchElecComponentsByType("transformateur"),
          fetchElecComponentsByType("compteur"),
          fetchElecComponentsByType("ems"),
        ]);
        setPanels(p);
        // Tri par marque (demande de Ben, 11/09/2026) : la liste d'onduleurs
        // grandit avec plusieurs modeles par offre desormais, plus lisible
        // triee par marque que par kVA.
        const sortedInverters = [...i].sort(
          (a, b2) => a.brand.localeCompare(b2.brand) || a.modelName.localeCompare(b2.modelName),
        );
        setInverters(sortedInverters);
        setBatteries(b);
        setMarginCurve(curve);
        setCommissionSettings(commission);
        setCommissionRate(commission.defaultRate);
        setTravelRule(travel);
        setVatRate(vat);
        setPanelSelections(p[0] ? [{ key: nextSelectionKey(), productId: p[0].id, qty: 16 }] : []);
        setInverterSelections(sortedInverters[0] ? [{ key: nextSelectionKey(), productId: sortedInverters[0].id, qty: 1 }] : []);
        setCarportConfigs(carports);
        setOptimizers(opts);
        setCableAcCatalog(cableCatalog);
        setCableDcCatalog(cableDc);
        setDcAmpacityTable(dcAmpacity);
        setCableSizingParams(cableParams);
        setFinancialParams(financial);
        setLaborRoofRates(roofRates);
        setRoofType(roofRates.find((r) => r.roofType === "Toiture plate")?.roofType ?? roofRates[0]?.roofType ?? "");
        setLaborElectricianRates(electricianRates);
        setTrenchRates(trench);
        setRegionsMap(Object.fromEntries(regionsList.map((r) => [r.name, r.id])));
        setGrdSchedule(grd);
        setCablingForfaitTiers(cablingTiers);
        setCablingComplexityMultiplier(cablingMultiplier);
        setTransportPanelsPerTrip(panelsPerTrip);
        setElectricalCertificationTiers(certifTiers);
        setHandlingRates(handling);
        setFlatFeeOptions(flatFees);
        setCabineDecouplageCatalog(cabineDecouplage);
        setTransformateurCatalog(transformateurs);
        setCompteurCatalog(compteurs);
        setEmsCatalog(ems);
        setEmsId(ems.find((e) => e.modelName === "Non")?.id ?? "");
        const bebat = await fetchBebatRatePerKg();
        setBebatRate(bebat);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Quantite d'optimiseurs par defaut = nombre de panneaux (1 optimiseur par
  // panneau, cas le plus courant), tant que l'utilisateur n'a pas encore
  // choisi d'optimiseur ; reste ensuite editable independamment.
  useEffect(() => {
    if (optimizerId && optimizerQty === 0) {
      setOptimizerQty(totalPanelQty);
    }
  }, [optimizerId, optimizerQty, totalPanelQty]);

  // Bareme CV Bruxelles (uniquement necessaire pour ce regime) et taux
  // d'auto-consommation suggere : dependent de la region et de la presence
  // d'une batterie, recharges a chaque changement.
  useEffect(() => {
    if (!supabaseConfigured) return;
    (async () => {
      try {
        const [brackets, suggested] = await Promise.all([
          region === Region.BRUXELLES ? fetchCvBracketsForRegion(region) : Promise.resolve([]),
          fetchAutoConsumptionDefault(region, Boolean(batteryId)),
        ]);
        setCvBrackets(brackets);
        setSuggestedAutoConsumption(suggested);
      } catch {
        setCvBrackets([]);
        setSuggestedAutoConsumption(null);
      }
    })();
  }, [region, batteryId]);

  // Recharge la composition batterie (module/chargeur/tableau/MO/compteur) a
  // chaque changement de selection -- plus seulement son total agrege.
  useEffect(() => {
    if (!batteryId) {
      setBatteryComposition(null);
      return;
    }
    (async () => {
      const composition = await fetchBatteryComposition(batteryId);
      setBatteryComposition(composition);
    })();
  }, [batteryId]);

  // Resolution des selections multi-produits (decision 40) : chaque ligne
  // {productId, qty} rapprochee du catalogue charge, en ignorant les lignes
  // dont le produit n'existe plus ou dont la quantite est nulle/negative.
  const resolvedPanelSelections = useMemo(
    () =>
      panelSelections
        .map((s) => ({ ...s, product: panels.find((p) => p.id === s.productId) }))
        .filter((s): s is ProductSelection & { product: Product } => Boolean(s.product) && s.qty > 0),
    [panelSelections, panels],
  );
  const resolvedInverterSelections = useMemo(
    () =>
      inverterSelections
        .map((s) => ({ ...s, product: inverters.find((p) => p.id === s.productId) }))
        .filter((s): s is ProductSelection & { product: Product } => Boolean(s.product) && s.qty > 0),
    [inverterSelections, inverters],
  );
  const selectedCarport = carportConfigs.find((c) => c.id === carportConfigId);
  const selectedOptimizer = optimizers.find((o) => o.id === optimizerId);
  // Puissance crete en watts par panneau (colonne dediee products.power_w,
  // voir migrations/007_products_power_w.sql). power_kva ne s'applique qu'aux
  // onduleurs (kVA) et est toujours NULL pour un panneau. Nulle en mode
  // "offre batterie uniquement" (decision 34) : pas de PV dans ce mode. Somme
  // sur tous les modeles selectionnes (decision 40, plusieurs modeles de
  // panneaux possibles dans une meme offre).
  const totalPowerKwc =
    offerMode === "complete"
      ? resolvedPanelSelections.reduce((sum, s) => sum + ((s.product.powerW ?? 0) * s.qty) / 1000, 0)
      : 0;
  // Puissance onduleur en kVA : base de calcul commune a plusieurs formules
  // "Calcul du prix" (MO electricien, redevance GRD, certification
  // electrique, cabine de decouplage, licence EMS) -- pas la puissance crete
  // PV (kWc), voir engine/laborEngine.ts. Reponse confirmee par Ben le
  // 11/09/2026 : somme des kVA de tous les onduleurs selectionnes.
  const totalInverterPowerKva = resolvedInverterSelections.reduce((sum, s) => sum + (s.product.powerKva ?? 0) * s.qty, 0);

  // Dimensionnement du cable AC : courant max de l'onduleur (specs.imax_a),
  // longueur saisie, chute de tension max (cable_sizing_parameters), section
  // theorique (cableEngine) puis rapprochement catalogue (pickCableAcOption).
  // Decision 39 (11/09/2026) : une ligne de cable par modele d'onduleur
  // selectionne (longueur commune saisie x quantite de ce modele) --
  // simplification documentee (pas de longueur differenciee par modele pour
  // l'instant), a affiner si Ben la remet en cause.
  const cableAc = useMemo(() => {
    const lines: OfferLine[] = [];
    const errors: string[] = [];
    if (cableAcCatalog.length === 0) return { lines, errors };
    for (const sel of resolvedInverterSelections) {
      const currentA = Number(sel.product.specs?.imax_a ?? NaN);
      if (Number.isNaN(currentA)) {
        errors.push(
          `Courant max (imax_a) manquant pour ${sel.product.brand} ${sel.product.modelName} : cablage AC non calcule pour cet onduleur.`,
        );
        continue;
      }
      try {
        const isMono = sel.product.phaseType === "Mono";
        const theoretical = voltageDropIndex(currentA, cableLengthM, isMono, cableSizingParams);
        const option = pickCableAcOption(cableAcCatalog, sel.product.phaseType, theoretical);
        lines.push(
          newOfferLine({
            category: "Elec",
            description: `Cable AC ${option.modelName} (${option.sectionMm2}mm², ${sel.product.brand} ${sel.product.modelName} x${sel.qty}, ${cableLengthM}m/u, ${currentA.toFixed(1)}A)`,
            quantity: cableLengthM * sel.qty,
            unitCost: option.unitPricePerMeter,
          }),
        );
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    return { lines, errors };
  }, [resolvedInverterSelections, cableAcCatalog, cableLengthM, cableSizingParams]);

  // Dimensionnement du cable DC (panneaux -> onduleur) : choix par ampacite
  // (pas de chute de tension documentee pour le DC, voir cableEngine.ts).
  // Courant saisi manuellement (pas de donnee Isc/Impp au catalogue) ;
  // quantite = nombre de circuits x 2 (positif + negatif, cables separes,
  // pas de gaine multi-conducteurs comme en AC) x longueur -- hypothese a
  // confirmer avec Ben, non testee par les 16 verifications validate:engine.
  const cableDc = useMemo(() => {
    if (offerMode !== "complete" || totalPowerKwc <= 0 || totalInverterCount === 0 || cableDcCatalog.length === 0 || dcAmpacityTable.length === 0) {
      return { line: null as OfferLine | null, error: null as string | null };
    }
    try {
      const option = pickCableDcOption(cableDcCatalog, dcAmpacityTable, dcCurrentA);
      const meters = dcCircuitCount * 2 * dcCableLengthM;
      return {
        line: newOfferLine({
          category: "Elec",
          description: `Cable DC ${option.modelName} (${option.sectionMm2}mm², ${dcCircuitCount} circuit(s) x 2 x ${dcCableLengthM}m, ${dcCurrentA}A)`,
          quantity: meters,
          unitCost: option.unitPricePerMeter,
        }),
        error: null,
      };
    } catch (e) {
      return { line: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [offerMode, totalPowerKwc, totalInverterCount, cableDcCatalog, dcAmpacityTable, dcCurrentA, dcCableLengthM, dcCircuitCount]);

  const regionId = regionsMap[region];

  // Parite Excel "Calcul du prix" (decision 38) : jusqu'a une quinzaine de
  // lignes auparavant absentes (main-d'oeuvre, tranchee, GRD, cablage/matos
  // AC, certification electrique, cabine de decouplage, transformateur,
  // compteurs, EMS, manutention, forfaits divers). Chaque ligne reproduit une
  // formule documentee dans laborEngine.ts / referentiel-regles-metier-excel.md
  // sections 4.4 a 4.7 et 9 -- jamais une regle devinee.
  const laborAndOptionsLines = useMemo(() => {
    const result: OfferLine[] = [];
    const errors: string[] = [];
    // Table "type Excel" (decision 49, demande de Ben : "je ne vois pas
    // directement le budget prevu... il faudrait que tout soit sous forme de
    // tableau, avec ... les sous totaux comme dans un tableur excel") --
    // chaque poste est marque d'une cle stable (`__slot`, propriete hors du
    // type OfferLine, ignoree par le moteur de calcul) pour que la JSX du
    // panneau 6 puisse retrouver, DANS `lines` (une fois les prix appliques
    // par computeOfferTotals, cf. `laborOptionsBySlot` plus bas), la ligne
    // exacte a afficher a cote de chaque case a cocher/select -- plutot que
    // de garder une reference vers l'objet non-encore-price construit ici
    // (le prix/la marge ne seraient pas a jour : computeOfferTotals mute les
    // objets de `lines`, pas ceux-ci directement avant leur fusion dans
    // `lines`).
    const push = (slot: string, line: OfferLine) => {
      (line as OfferLine & { __slot?: string }).__slot = slot;
      result.push(line);
    };
    if (offerMode !== "complete") return { lines: result, errors };

    if (totalPanelQty > 0 && roofType) {
      const rate = laborRoofRates.find((r) => r.roofType === roofType);
      if (rate) {
        push(
          "toiture",
          newOfferLine({
            category: "Main-d'oeuvre",
            description: `Main-d'oeuvre pose panneaux (${roofType}, ${totalPanelQty} panneaux)`,
            quantity: 1,
            unitCost: roofLaborCost(totalPanelQty, rate),
            lineType: "main_doeuvre",
          }),
        );
      }
    }

    if (totalInverterCount > 0 && laborElectricianRates.length > 0) {
      try {
        const tier = pickElectricianRateTier(totalInverterPowerKva, laborElectricianRates);
        push(
          "electricien",
          newOfferLine({
            category: "Main-d'oeuvre",
            description: `Main-d'oeuvre electricien (${tier.inverterCountTier}, ${totalInverterCount} onduleur(s))`,
            quantity: 1,
            unitCost: electricianLaborCost(totalInverterCount, tier),
            lineType: "main_doeuvre",
          }),
        );
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }

    if (trenchLengthM > 0 && trenchSoilType && trenchSoilType !== NO_TRENCH_LABEL) {
      const rate = trenchRates.find((r) => r.soilType === trenchSoilType);
      if (rate) {
        push(
          "tranchee",
          newOfferLine({
            category: "Terrassement",
            description: `Tranchee (${trenchSoilType}, ${trenchLengthM}m)`,
            quantity: 1,
            unitCost: trenchCost(trenchLengthM, rate),
            lineType: "main_doeuvre",
          }),
        );
      }
    }

    if (grdChargeToUs && totalInverterCount > 0 && regionId && grdSchedule.length > 0) {
      try {
        push(
          "grd",
          newOfferLine({
            category: "GRD",
            description: "Etude GRD a notre charge",
            quantity: 1,
            unitCost: grdFee(totalInverterPowerKva, regionId, grdSchedule),
            lineType: "service",
          }),
        );
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }

    if (totalPowerKwc > 0 && cablingForfaitTiers.length > 0) {
      try {
        const wc = totalPowerKwc * 1000;
        push(
          "cablageProvision",
          newOfferLine({
            category: "Cablage",
            description: `Cablage (provision, ${wc.toFixed(0)}Wc${cablingComplique ? ", complique" : ""})`,
            quantity: 1,
            unitCost: cablingForfaitCost(wc, cablingForfaitTiers, cablingComplique, cablingComplexityMultiplier),
            lineType: "marchandise",
          }),
        );
        push(
          "matosAc",
          newOfferLine({
            category: "Cablage",
            description: `Matos AC (provision, ${wc.toFixed(0)}Wc${matosAcComplique ? ", complique" : ""})`,
            quantity: 1,
            unitCost: cablingForfaitCost(wc, cablingForfaitTiers, matosAcComplique, cablingComplexityMultiplier),
            lineType: "marchandise",
          }),
        );
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }

    if (certificationElectriqueEnabled && totalInverterCount > 0 && electricalCertificationTiers.length > 0) {
      try {
        push(
          "certification",
          newOfferLine({
            category: "Certification",
            description: "Certification electrique",
            quantity: 1,
            unitCost: electricalCertificationPrice(totalInverterPowerKva, electricalCertificationTiers),
            lineType: "service",
          }),
        );
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }

    if (totalInverterCount > 0 && cabineDecouplageCatalog.length > 0) {
      try {
        const price = cabineDecouplagePrice(totalInverterPowerKva, cabineDecouplageCatalog);
        if (price > 0) {
          push(
            "cabineDecouplage",
            newOfferLine({
              category: "Cabine de decouplage",
              description: `Cabine de decouplage (${totalInverterPowerKva.toFixed(1)} kVA)`,
              quantity: 1,
              unitCost: price,
              lineType: "marchandise",
            }),
          );
        }
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }

    if (transformateurId) {
      const t = transformateurCatalog.find((c) => c.id === transformateurId);
      if (t) {
        push(
          "transformateur",
          newOfferLine({
            category: "Transformateur",
            description: `Transformateur ${t.modelName}`,
            quantity: 1,
            unitCost: t.unitPrice,
            lineType: "marchandise",
          }),
        );
      }
    }

    if (energyMeterEnabled) {
      const c = compteurCatalog.find((x) => x.modelName === "Energy Meter" && x.specs?.phase_type === energyMeterPhase);
      if (c) {
        push(
          "energyMeter",
          newOfferLine({
            category: "Compteur",
            description: `Energy Meter (${energyMeterPhase})`,
            quantity: 1,
            unitCost: c.unitPrice,
            lineType: "marchandise",
          }),
        );
      }
    }

    if (compteurVertEnabled) {
      const c = compteurCatalog.find((x) => x.modelName === "Compteur vert" && x.specs?.phase_type === compteurVertPhase);
      if (c) {
        push(
          "compteurVert",
          newOfferLine({
            category: "Compteur",
            description: `Compteur vert (${compteurVertPhase})`,
            quantity: 1,
            unitCost: c.unitPrice,
            lineType: "marchandise",
          }),
        );
      }
    }

    if (emsId) {
      const ems = emsCatalog.find((x) => x.id === emsId);
      if (ems && ems.modelName !== "Non") {
        push(
          "ems",
          newOfferLine({
            category: "EMS",
            description: `EMS ${ems.modelName}`,
            quantity: 1,
            unitCost: ems.unitPrice,
            lineType: "marchandise",
          }),
        );
        if (emsLicenseBillingEnabled && totalInverterCount > 0) {
          const fee = emsLicenseFee(totalInverterPowerKva, ems);
          if (fee > 0) {
            push(
              "emsLicense",
              newOfferLine({
                category: "EMS",
                description: `Licence EMS ${ems.modelName} (optionnel -- formule Excel jamais reliee a une ligne, voir engine/laborEngine.ts)`,
                quantity: 1,
                unitCost: fee,
                lineType: "service",
              }),
            );
          }
        }
      }
    }

    const handlingByKey = (key: string) => handlingRates.find((h) => h.handlingKey === key);
    if (liftEnabled) {
      const h = handlingByKey("lift");
      if (h) push("lift", newOfferLine({ category: "Manutention", description: h.label, quantity: 1, unitCost: h.price, lineType: "service" }));
    }
    if (nacelleDays > 0) {
      const h = handlingByKey("nacelle");
      if (h) {
        push(
          "nacelle",
          newOfferLine({
            category: "Manutention",
            description: `${h.label} (${nacelleDays} jour(s))`,
            quantity: nacelleDays,
            unitCost: h.price,
            lineType: "service",
          }),
        );
      }
    }
    if (enlevementEnabled) {
      const h = handlingByKey("enlevement_existant");
      if (h) push("enlevement", newOfferLine({ category: "Manutention", description: h.label, quantity: 1, unitCost: h.price, lineType: "service" }));
    }
    if (grueChoice) {
      const h = handlingByKey(grueChoice);
      if (h) push("grue", newOfferLine({ category: "Manutention", description: h.label, quantity: 1, unitCost: h.price, lineType: "service" }));
    }
    if (totalPanelQty > 0 && transportPanelsPerTrip > 0) {
      const trips = transportTripsForPanels(totalPanelQty, transportPanelsPerTrip);
      const h = handlingByKey("transport");
      if (h && trips > 0) {
        push(
          "transport",
          newOfferLine({
            category: "Manutention",
            description: `${h.label} (${trips} voyage(s), ${totalPanelQty} panneaux)`,
            quantity: trips,
            unitCost: h.price,
            lineType: "service",
          }),
        );
      }
    }

    const flatFeeByKey = (key: string) => flatFeeOptions.find((f) => f.feeKey === key);
    if (greenBoxEnabled) {
      const f = flatFeeByKey("green_box");
      if (f) push("greenBox", newOfferLine({ category: "Divers", description: f.label, quantity: 1, unitCost: f.price, lineType: f.category }));
    }
    if (brugelEnabled) {
      const f = flatFeeByKey("certification_brugel");
      if (f && (!f.regionRestriction || f.regionRestriction === region)) {
        push("brugel", newOfferLine({ category: "Divers", description: f.label, quantity: 1, unitCost: f.price, lineType: f.category }));
      }
    }
    if (stabilityStudyEnabled) {
      const f = flatFeeByKey("stability_study");
      if (f) push("stabilityStudy", newOfferLine({ category: "Divers", description: f.label, quantity: 1, unitCost: f.price, lineType: f.category }));
    }

    return { lines: result, errors };
  }, [
    offerMode,
    totalPanelQty,
    roofType,
    laborRoofRates,
    totalInverterCount,
    laborElectricianRates,
    totalInverterPowerKva,
    trenchLengthM,
    trenchSoilType,
    trenchRates,
    grdChargeToUs,
    regionId,
    grdSchedule,
    totalPowerKwc,
    cablingForfaitTiers,
    cablingComplique,
    matosAcComplique,
    cablingComplexityMultiplier,
    certificationElectriqueEnabled,
    electricalCertificationTiers,
    cabineDecouplageCatalog,
    transformateurId,
    transformateurCatalog,
    energyMeterEnabled,
    energyMeterPhase,
    compteurVertEnabled,
    compteurVertPhase,
    compteurCatalog,
    emsId,
    emsCatalog,
    emsLicenseBillingEnabled,
    handlingRates,
    liftEnabled,
    nacelleDays,
    enlevementEnabled,
    grueChoice,
    transportPanelsPerTrip,
    flatFeeOptions,
    greenBoxEnabled,
    brugelEnabled,
    stabilityStudyEnabled,
    region,
  ]);

  const suggestedMargin = useMemo(() => {
    if (marginCurve.length === 0 || totalPowerKwc <= 0) return null;
    try {
      return suggestedMarginMultiplier(totalPowerKwc, marginCurve);
    } catch {
      return null;
    }
  }, [marginCurve, totalPowerKwc]);

  const lines: OfferLine[] = useMemo(() => {
    const result: OfferLine[] = [];
    const isComplete = offerMode === "complete";
    // En mode "offre batterie uniquement" (decision 34), tout ce qui est
    // specifique au PV (panneaux, onduleur, structure, optimiseurs, cablage
    // AC/DC) est omis, sur le modele de l'onglet Excel "Offre Batterie".
    // Batterie et deplacement restent communs aux deux modes.
    if (isComplete) {
      for (const sel of resolvedPanelSelections) {
        result.push(
          newOfferLine({
            category: "PV",
            description: `${sel.product.brand} ${sel.product.modelName} x${sel.qty}`,
            quantity: sel.qty,
            unitCost: sel.product.unitCost,
          }),
        );
      }
    }
    if (isComplete) {
      for (const sel of resolvedInverterSelections) {
        result.push(
          newOfferLine({
            category: "Onduleur",
            description: `${sel.product.brand} ${sel.product.modelName} x${sel.qty}`,
            quantity: sel.qty,
            unitCost: sel.product.unitCost,
          }),
        );
      }
    }
    if (isComplete && selectedCarport) {
      result.push(
        newOfferLine({
          category: "Structure",
          description: `Carport ${selectedCarport.brand} ${selectedCarport.rowCount} rangee(s) x ${selectedCarport.placeCount} place(s) (${selectedCarport.nbPv} PV)`,
          quantity: 1,
          unitCost: selectedCarport.price,
        }),
      );
    }
    if (isComplete && selectedOptimizer && optimizerQty > 0) {
      result.push(
        newOfferLine({
          category: "Optimiseur",
          description: `${selectedOptimizer.brand} optimiseur (max ${selectedOptimizer.maxPowerW}W) x${optimizerQty}`,
          quantity: optimizerQty,
          unitCost: selectedOptimizer.unitPrice,
        }),
      );
    }
    if (batteryId && batteryComposition) {
      const b = batteries.find((x) => x.id === batteryId);
      const batteryLabel = b ? `${b.brand} ${b.modelName}` : "Batterie";
      // Decomposition demandee par Ben le 11/09/2026 ("bien decomposer les
      // prix des batteries") : chaque composante de battery_compositions
      // devient sa propre ligne visible (au lieu d'un seul total agrege).
      // Chaque sous-ligne garde category: "Batterie" pour que la marge K21
      // (CATEGORIES_MARGIN_BATTERY_TRAVEL, pricingEngine.ts) et le filtre
      // "totaux sans batterie" (Calcul du prix) continuent de fonctionner
      // sans aucune modification du moteur de calcul.
      if (batteryComposition.moduleCost > 0) {
        result.push(
          newOfferLine({ category: "Batterie", description: `${batteryLabel} - module`, quantity: 1, unitCost: batteryComposition.moduleCost }),
        );
      }
      if (batteryComposition.chargerCost > 0) {
        result.push(
          newOfferLine({ category: "Batterie", description: `${batteryLabel} - chargeur`, quantity: 1, unitCost: batteryComposition.chargerCost }),
        );
      }
      if (batteryComposition.panelCost > 0) {
        result.push(
          newOfferLine({
            category: "Batterie",
            description: `${batteryLabel} - tableau electrique`,
            quantity: 1,
            unitCost: batteryComposition.panelCost,
          }),
        );
      }
      if (batteryComposition.energyMeterCost > 0) {
        result.push(
          newOfferLine({
            category: "Batterie",
            description: `${batteryLabel} - compteur d'energie`,
            quantity: 1,
            unitCost: batteryComposition.energyMeterCost,
          }),
        );
      }
      if (batteryComposition.laborCost > 0) {
        result.push(
          newOfferLine({
            category: "Batterie",
            description: `${batteryLabel} - main-d'oeuvre`,
            quantity: 1,
            unitCost: batteryComposition.laborCost,
            lineType: "main_doeuvre",
          }),
        );
      }
      const bebat = bebatPremium(batteryComposition.massKg, bebatRate);
      if (bebat > 0) {
        result.push(
          newOfferLine({
            category: "Batterie",
            description: `${batteryLabel} - prime BEBAT (${batteryComposition.massKg} kg)`,
            quantity: 1,
            unitCost: bebat,
            lineType: "service",
          }),
        );
      }
    }
    if (isComplete) {
      result.push(...cableAc.lines);
    }
    if (isComplete && cableDc.line) {
      result.push(cableDc.line);
    }
    if (isComplete) {
      result.push(...laborAndOptionsLines.lines);
    }
    if (travelRule) {
      result.push(
        newOfferLine({
          category: "Deplacement",
          description: "Forfait deplacement technicien",
          quantity: 1,
          unitCost: travelCost(distanceKm, totalPowerKwc, travelRule),
        }),
      );
    }
    // Applique les overrides manuels (prix fixe, toggle "Poste ?" marche
    // public) avant le calcul des totaux.
    return result.map((line, idx) => {
      const key = `${line.category}-${idx}`;
      const priceOverride = overriddenLines[key];
      const repartitionOverride = repartitionOverrides[key];
      return {
        ...line,
        ...(priceOverride !== undefined ? { manuallyOverridden: true, unitPrice: priceOverride } : {}),
        ...(repartitionOverride !== undefined ? { repartitionPoste: repartitionOverride } : {}),
      };
    });
  }, [
    offerMode,
    resolvedPanelSelections,
    resolvedInverterSelections,
    selectedCarport,
    selectedOptimizer,
    optimizerQty,
    batteryId,
    batteryComposition,
    bebatRate,
    batteries,
    cableAc.lines,
    cableDc.line,
    laborAndOptionsLines.lines,
    travelRule,
    distanceKm,
    totalPowerKwc,
    overriddenLines,
    repartitionOverrides,
  ]);

  const totals = useMemo(() => {
    if (lines.length === 0) return null;
    return computeOfferTotals(
      { region, lines: [...lines], marginPvElectrical, marginBatteryTravel, commissionRate, vatRate, isPublicTender },
      commissionRate,
    );
  }, [lines, region, marginPvElectrical, marginBatteryTravel, commissionRate, vatRate, isPublicTender]);

  // Totaux hors batterie (decision 40, resume en tete de "Calcul du prix") :
  // meme calcul que `totals`, sur le sous-ensemble des lignes qui ne sont pas
  // de category "Batterie" -- categorie qui reste vraie pour chacune des
  // sous-lignes issues de la decomposition (module, chargeur, MO, BEBAT...),
  // donc ce filtre continue de fonctionner sans changement supplementaire.
  const totalsWithoutBattery = useMemo(() => {
    const nonBatteryLines = lines.filter((l) => l.category !== "Batterie");
    if (nonBatteryLines.length === 0) return null;
    return computeOfferTotals(
      { region, lines: [...nonBatteryLines], marginPvElectrical, marginBatteryTravel, commissionRate, vatRate, isPublicTender },
      commissionRate,
    );
  }, [lines, region, marginPvElectrical, marginBatteryTravel, commissionRate, vatRate, isPublicTender]);

  // Cles de repartition marches publics : poids et prix redistribue par
  // ligne visible, uniquement significatif en mode marche public.
  const repartitionResults = useMemo(() => {
    if (!isPublicTender || !totals || lines.length === 0) return null;
    return applyRepartition(lines, marginPvElectrical, totals.totalTtc);
  }, [isPublicTender, totals, lines, marginPvElectrical]);

  // Sous-totaux par categorie (ex PV, Onduleur, Batterie, Main-d'oeuvre...),
  // pour le niveau de detail "par section" de l'onglet Offre (decision 40).
  const categorySubtotals = useMemo(() => {
    const order: string[] = [];
    const totalsByCategory = new Map<string, number>();
    for (const line of lines) {
      if (!totalsByCategory.has(line.category)) {
        order.push(line.category);
        totalsByCategory.set(line.category, 0);
      }
      totalsByCategory.set(line.category, (totalsByCategory.get(line.category) ?? 0) + lineTotalPrice(line));
    }
    return order.map((category) => ({ category, totalPrice: totalsByCategory.get(category) ?? 0 }));
  }, [lines]);

  // Marche public : detail ligne par ligne toujours force (cles de
  // repartition), quel que soit le choix de l'utilisateur.
  const effectivePriceDetailLevel = isPublicTender ? "ligne" : priceDetailLevel;

  const effectiveAutoConsumption = autoConsumptionOverride ?? suggestedAutoConsumption ?? 0.55;
  const effectiveProductionYield = productionYieldOverride ?? financialParams?.productionYieldKwhPerWc ?? 0.816;
  const effectiveNetworkPrice = networkPriceOverride ?? financialParams?.networkPricePerKwh ?? 0;
  const effectiveInflationRate = inflationRateOverride ?? financialParams?.inflationRate ?? 0;
  const effectiveCvBuybackPrice = cvBuybackPriceOverride ?? financialParams?.cvBuybackPrice ?? 0;
  const effectiveResalePriceRatio = resalePriceRatioOverride ?? financialParams?.resalePriceRatio ?? 0;

  // Taux CV suggere (bareme par puissance, Bruxelles uniquement) vs. taux
  // effectivement utilise pour le calcul -- meme principe suggere/applique
  // que la marge (decision 41) : override manuel possible, jamais recopie
  // automatiquement.
  let suggestedCvRatePerMwh: number | null = null;
  if (region === Region.BRUXELLES && cvBrackets.length > 0 && totalPowerKwc > 0) {
    try {
      suggestedCvRatePerMwh = lookupCvRateBruxelles(totalPowerKwc, cvBrackets);
    } catch {
      suggestedCvRatePerMwh = null;
    }
  }
  const effectiveCvRatePerMwh = cvRateOverride ?? suggestedCvRatePerMwh;

  // Simulation de rentabilite 25 ans (regimeEngine), uniquement calculable
  // une fois l'investissement total connu (totals.totalTtc) et une puissance
  // installee positive.
  const cashflow: CashflowYear[] | null = useMemo(() => {
    if (!totals || !financialParams || totalPowerKwc <= 0) return null;
    const regime = resolveRegimeForRegion(region);
    if (regime === RevenueRegime.CV_BRACKET && effectiveCvRatePerMwh === null) return null;
    // Degradation annuelle ponderee par quantite quand plusieurs modeles de
    // panneaux sont selectionnes (decision 40) -- simplification documentee :
    // le moteur ne gerait qu'un seul modele de panneau avant ce lot.
    const degradation =
      totalPanelQty > 0
        ? resolvedPanelSelections.reduce((sum, s) => sum + Number(s.product.specs?.annual_degradation_pct ?? 0.42) * s.qty, 0) /
          totalPanelQty
        : 0.42;
    const productionAt100 = totalPowerKwc * 1000 * effectiveProductionYield;
    return projectCashflow(totals.totalTtc, productionAt100, {
      regime,
      autoConsumptionRate: effectiveAutoConsumption,
      inflationRate: effectiveInflationRate,
      panelDegradationPctPerYear: degradation,
      initialNetworkPrice: effectiveNetworkPrice,
      initialResalePrice: effectiveNetworkPrice * effectiveResalePriceRatio,
      cvRatePerMwh: effectiveCvRatePerMwh ?? undefined,
      cvPricePerCertificate: effectiveCvBuybackPrice,
    });
  }, [
    totals,
    financialParams,
    totalPowerKwc,
    region,
    resolvedPanelSelections,
    totalPanelQty,
    effectiveAutoConsumption,
    effectiveProductionYield,
    effectiveNetworkPrice,
    effectiveInflationRate,
    effectiveCvBuybackPrice,
    effectiveResalePriceRatio,
    effectiveCvRatePerMwh,
  ]);

  const paybackYear = cashflow?.find((y) => y.cashflowCumulative >= 0)?.year ?? null;

  if (loading) return <p className="wg-app wg-muted">Chargement du catalogue...</p>;

  if (error) {
    return (
      <div className="wg-app">
        <div className="wg-header">
          <h1>Application Offre - We Green Energy</h1>
        </div>
        <p className="wg-banner-warning">{error}</p>
      </div>
    );
  }

  const regionLabels: Record<Region, string> = {
    [Region.BRUXELLES]: "Bruxelles-Capitale (Certificats Verts)",
    [Region.WALLONIE]: "Wallonie (revente simple)",
    [Region.FLANDRE]: "Flandre (revente simple)",
  };
  const regimeLabel = resolveRegimeForRegion(region) === RevenueRegime.CV_BRACKET ? "Certificats Verts" : "revente simple";
  const isComplete = offerMode === "complete";

  // Regroupements par categorie pour la vue "type Excel" du panneau "Calcul
  // du prix" (decision 42, 12/09/2026, demande de Ben : "que ça ressemble
  // plus vraiment a l'Excel"). Pur filtrage d'affichage sur les lignes deja
  // calculees par computeOfferTotals (aucun recalcul, aucune modification du
  // moteur) -- categories telles qu'assignees par newOfferLine() plus haut.
  const pvLines = lines.filter((l) => l.category === "PV");
  const inverterLines = lines.filter((l) => l.category === "Onduleur");
  // resolvedPanelSelections/resolvedInverterSelections omettent les lignes
  // non resolues (qty<=0 ou produit introuvable, voir plus haut) : leur ordre
  // ne correspond donc pas forcement, index a index, a panelSelections /
  // inverterSelections (qui, elles, gardent toutes les lignes pour l'edition,
  // y compris une ligne a qty=0 en cours de saisie). resolvedPanelSelections
  // et pvLines sont en revanche construites en iterant le meme tableau dans
  // le meme ordre (voir la boucle "for (const sel of resolvedPanelSelections)"
  // du useMemo `lines`), donc l'appariement par cle via cette Map reste
  // correct meme quand une ligne intermediaire est filtree.
  const pvLineByKey = new Map(resolvedPanelSelections.map((sel, i) => [sel.key, pvLines[i]]));
  const inverterLineByKey = new Map(resolvedInverterSelections.map((sel, i) => [sel.key, inverterLines[i]]));
  const optimizerLines = lines.filter((l) => l.category === "Optimiseur");
  const batteryLines = lines.filter((l) => l.category === "Batterie");
  const structureLines = lines.filter((l) => l.category === "Structure");
  // Postes "Cablage (provision)" / "Matos AC (provision)" desormais affiches
  // en ligne dans le panneau 5, via laborOptionsBySlot -- seul le cablage
  // AC/DC calcule automatiquement (categorie "Elec", pas de case a cocher
  // associee) reste liste ici (decision 49, 15/09/2026).
  const cableAutoLines = lines.filter((l) => l.category === "Elec");
  // Retrouve, pour chaque poste optionnel du panneau 6 (et les 2 postes
  // cablage du panneau 5), sa ligne CORRECTEMENT PRICEE (`unitPrice`/
  // `marginAppliedAmount` a jour) dans `lines` -- c'est `lines` (pas
  // `laborAndOptionsLines.lines`) que `totals`/`nonBatteryTotals` mutent via
  // computeOfferTotals ci-dessus ; lire directement `laborAndOptionsLines`
  // exposerait les objets tels que construits AVANT ce calcul (prix/marge a
  // 0). Marquage par `__slot`, pose par `push()` dans laborAndOptionsLines.
  const laborOptionsBySlot: Record<string, OfferLine> = {};
  for (const l of lines) {
    const slot = (l as OfferLine & { __slot?: string }).__slot;
    if (slot) laborOptionsBySlot[slot] = l;
  }
  const travelLines = lines.filter((l) => l.category === "Deplacement");

  // Actions par ligne (modifier le prix / marche public) directement dans
  // chaque section 1 a 7, remplace l'ancien tableau separe "Detail complet
  // des lignes" en bas de page (decision 55, 15/09/2026, demande de Ben :
  // "le bouton modifier le prix se trouve directement dans les differentes
  // sections"). La cle `${category}-${idx}` doit rester identique a celle
  // utilisee par overriddenLines/repartitionOverrides plus haut (voir le
  // useMemo `lines`) : idx est ici retrouve par reference dans `lines`
  // (memes objets que ceux filtres/regroupes ci-dessus), pas recalcule.
  const lineIndexMap = new Map<OfferLine, number>();
  lines.forEach((l, i) => lineIndexMap.set(l, i));
  const renderLineActions = (line: OfferLine | undefined): ReactNode => {
    if (!line) return null;
    const idx = lineIndexMap.get(line);
    if (idx === undefined) return null;
    const key = `${line.category}-${idx}`;
    const repartitionResult = repartitionResults?.[idx];
    return (
      <div className="wg-line-actions">
        <button
          type="button"
          className="wg-btn-link"
          onClick={() => {
            const value = window.prompt("Nouveau prix unitaire (EUR) :", line.unitPrice.toFixed(2));
            if (value === null) return;
            const parsed = Number(value);
            if (!Number.isNaN(parsed)) {
              setOverriddenLines((prev) => ({ ...prev, [key]: parsed }));
            }
          }}
        >
          Modifier le prix
        </button>
        {line.manuallyOverridden && (
          <button
            type="button"
            className="wg-btn-link"
            onClick={() =>
              setOverriddenLines((prev) => {
                const next = { ...prev };
                delete next[key];
                return next;
              })
            }
          >
            Annuler
          </button>
        )}
        {isPublicTender && (
          <label className="wg-line-actions-tender">
            <input
              type="checkbox"
              checked={line.repartitionPoste}
              onChange={(e) => setRepartitionOverrides((prev) => ({ ...prev, [key]: e.target.checked }))}
            />
            Poste marche public
            <span className="wg-muted">
              {repartitionResult?.displayedPrice !== null && repartitionResult?.displayedPrice !== undefined
                ? `${formatEur(repartitionResult.displayedPrice)} affiche`
                : "masque"}
            </span>
          </label>
        )}
      </div>
    );
  };

  // ---- Derives pour l'onglet "Offre" (decision 42, 12/09/2026) : rebatie sur
  // le modele des offres PDF reelles fournies par Ben. Aucune de ces valeurs
  // ne recalcule le moteur -- pur agregat d'affichage sur `lines`/`cashflow`
  // deja calcules.
  const selectedEms = emsId ? emsCatalog.find((e) => e.id === emsId) : undefined;
  const emsIncluded = Boolean(selectedEms && selectedEms.modelName !== "Non");
  const cabineDecouplageIncluded = lines.some((l) => l.category === "Cabine de decouplage");
  const bebatLine = lines.find((l) => l.category === "Batterie" && l.description.includes("BEBAT"));
  const demarchesAdminIncluded = greenBoxEnabled || brugelEnabled;
  const offerTitleText = isComplete
    ? `Installation photovoltaique ${totalPowerKwc.toFixed(2)} kWc${batteryId ? " avec batterie de stockage" : ""}`
    : "Installation d'une batterie de stockage";

  // Cumuls de revenus a 1/10/25 ans pour le tableau "Resume des revenus"
  // (section 5.1 des offres PDF reelles) -- somme des `CashflowYear` deja
  // valides (referentiel section 6), jusqu'a l'annee N incluse. Interpretation
  // du tableau du PDF non retestee formule a formule contre l'Excel (ce
  // tableau de synthese n'existe pas dans les 25 verifications
  // validate:engine) : a confirmer avec Ben.
  const revenueSummaryAt = (years: number) => {
    if (!cashflow) return null;
    const slice = cashflow.filter((y) => y.year <= years);
    if (slice.length === 0) return null;
    const auto = slice.reduce((sum, y) => sum + y.revenueAutoConsumption, 0);
    const specific = slice.reduce((sum, y) => sum + y.revenueRegimeSpecific, 0);
    return { auto, specific, total: auto + specific };
  };
  const revenueSummary1An = revenueSummaryAt(1);
  const revenueSummary10Ans = revenueSummaryAt(10);
  const revenueSummary25Ans = revenueSummaryAt(25);

  // Cout du kWh sur 25 ans (section 5.3, "Energie verte et stable") :
  // investissement total HTVA / production cumulee sur 25 ans. Meme
  // reserve que ci-dessus : agregat de presentation, pas une formule
  // Excel revalidee independamment.
  const totalProduction25Ans = cashflow ? cashflow.reduce((sum, y) => sum + y.productionKwh, 0) : null;
  const costPerKwh25Ans = totalProduction25Ans && totals ? totals.totalHtva / totalProduction25Ans : null;

  // CO2 evite sur 25 ans (section 6.1, "Avantages ecologiques") : les offres
  // PDF reelles affichent un tonnage precis (ex : "environ 1340 tonnes de
  // CO2" pour 301,65 kWc), mais aucun facteur d'emission n'est documente
  // dans le referentiel de regles metier ni teste par validate:engine.
  // CO2_KG_PER_KWH_ESTIMATE est une hypothese (moyenne indicative reseau,
  // PAS une valeur du classeur Excel) -- affichee avec une mention explicite
  // "estimation" dans l'UI, a confirmer/remplacer par Ben avant tout usage
  // commercial engageant.
  const CO2_KG_PER_KWH_ESTIMATE = 0.212;
  const co2AvoidedTonnes25Ans = totalProduction25Ans !== null ? (totalProduction25Ans * CO2_KG_PER_KWH_ESTIMATE) / 1000 : null;

  return (
    <div className={`wg-app${activeTab === "calcul" ? " wg-app--wide" : ""}`}>
      <div className="wg-header">
        <h1>Application Offre - We Green Energy</h1>
        <p>
          Catalogue lu depuis Supabase en direct. Moteur de calcul valide contre l'Excel audite (16/16, voir
          `src/engine/validate.ts`).
        </p>
      </div>

      {/* Sections (ex feuilles Excel) et mode "offre batterie uniquement", decision 34.
          Ordre Donnees -> Calcul du prix -> Offre -> Back-office (decision 41, 11/09/2026). */}
      <nav className="wg-tabs">
        <button className={`wg-tab${activeTab === "donnees" ? " active" : ""}`} onClick={() => setActiveTab("donnees")}>
          Donnees
        </button>
        <button className={`wg-tab${activeTab === "calcul" ? " active" : ""}`} onClick={() => setActiveTab("calcul")}>
          Calcul du prix
        </button>
        <button className={`wg-tab${activeTab === "offre" ? " active" : ""}`} onClick={() => setActiveTab("offre")}>
          Offre
        </button>
        <button className={`wg-tab${activeTab === "backoffice" ? " active" : ""}`} onClick={() => setActiveTab("backoffice")}>
          Back-office{session ? "" : " (connexion requise)"}
        </button>
        <label className="wg-tab-spacer">
          <input
            type="checkbox"
            checked={offerMode === "batterie"}
            onChange={(e) => setOfferMode(e.target.checked ? "batterie" : "complete")}
          />
          Offre batterie uniquement
          <button type="button" className="wg-btn-primary" style={{ marginLeft: 4 }} onClick={handleExportPdf}>
            Exporter en PDF
          </button>
        </label>
      </nav>

      {activeTab === "calcul" && (
        <div className="wg-calc-layout">
          <div className="wg-calc-main">
            {/* 1. Panneaux solaires */}
            {isComplete && (
              <div className="wg-panel">
                <p className="wg-panel-title">
                  <span className="wg-step-badge">1</span>Panneaux solaires
                </p>
                {panelSelections.length > 0 && <CalcLineHeader articleLabel="Modele de panneau" />}
                {panelSelections.map((sel) => {
                  const product = panels.find((p) => p.id === sel.productId);
                  const previewLine = pvLineByKey.get(sel.key);
                  return (
                    <div key={sel.key} className="wg-calc-line-row">
                      <div className="wg-calc-line-controls">
                        <select
                          value={sel.productId}
                          onChange={(e) =>
                            setPanelSelections((prev) => prev.map((s) => (s.key === sel.key ? { ...s, productId: e.target.value } : s)))
                          }
                          style={{ flex: "1 1 200px" }}
                        >
                          {panels.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.brand} {p.modelName} - {formatEur(p.unitCost)}
                            </option>
                          ))}
                        </select>
                        <input
                          type="number"
                          min={0}
                          value={sel.qty}
                          onChange={(e) =>
                            setPanelSelections((prev) => prev.map((s) => (s.key === sel.key ? { ...s, qty: Number(e.target.value) } : s)))
                          }
                          className="wg-input-qty"
                        />
                        <button
                          type="button"
                          className="wg-btn-remove"
                          title="Retirer ce modele"
                          disabled={panelSelections.length <= 1}
                          onClick={() => setPanelSelections((prev) => prev.filter((s) => s.key !== sel.key))}
                        >
                          Retirer
                        </button>
                        {product?.datasheetPath && (
                          <a
                            href={productDatasheetUrl(product.datasheetPath) ?? undefined}
                            target="_blank"
                            rel="noreferrer"
                            className="wg-btn-link"
                            style={{ fontSize: 12 }}
                          >
                            Fiche technique (PDF)
                          </a>
                        )}
                      </div>
                      {previewLine && (
                        <CalcLinePreview
                          line={previewLine}
                          powerLabel={product?.powerW ? `${product.powerW} Wc` : undefined}
                          marginPvElectrical={marginPvElectrical}
                          marginBatteryTravel={marginBatteryTravel}
                          actions={renderLineActions(previewLine)}
                        />
                      )}
                    </div>
                  );
                })}
                <button
                  type="button"
                  className="wg-btn-link"
                  onClick={() => setPanelSelections((prev) => [...prev, { key: nextSelectionKey(), productId: panels[0]?.id ?? "", qty: 1 }])}
                  style={{ marginTop: 8, display: "inline-block" }}
                >
                  + Ajouter un modele de panneau
                </button>
                <p className="wg-muted" style={{ marginTop: 8 }}>
                  Total : {totalPanelQty} panneau(x) - {totalPowerKwc.toFixed(2)} kWc
                </p>
                <SectionSubtotal lines={pvLines} />
              </div>
            )}

            {/* 2. Onduleurs et optimiseurs */}
            {isComplete && (
              <div className="wg-panel">
                <p className="wg-panel-title">
                  <span className="wg-step-badge">2</span>Onduleurs et optimiseurs
                </p>
                {inverterSelections.length > 0 && <CalcLineHeader articleLabel="Modele d'onduleur" />}
                {inverterSelections.map((sel) => {
                  const product = inverters.find((p) => p.id === sel.productId);
                  const previewLine = inverterLineByKey.get(sel.key);
                  return (
                    <div key={sel.key} className="wg-calc-line-row">
                      <div className="wg-calc-line-controls">
                        <select
                          value={sel.productId}
                          onChange={(e) =>
                            setInverterSelections((prev) => prev.map((s) => (s.key === sel.key ? { ...s, productId: e.target.value } : s)))
                          }
                          style={{ flex: "1 1 200px" }}
                        >
                          {inverters.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.brand} {p.modelName} - {formatEur(p.unitCost)}
                            </option>
                          ))}
                        </select>
                        <input
                          type="number"
                          min={0}
                          value={sel.qty}
                          onChange={(e) =>
                            setInverterSelections((prev) => prev.map((s) => (s.key === sel.key ? { ...s, qty: Number(e.target.value) } : s)))
                          }
                          className="wg-input-qty"
                        />
                        <button
                          type="button"
                          className="wg-btn-remove"
                          title="Retirer ce modele"
                          disabled={inverterSelections.length <= 1}
                          onClick={() => setInverterSelections((prev) => prev.filter((s) => s.key !== sel.key))}
                        >
                          Retirer
                        </button>
                        {product?.datasheetPath && (
                          <a
                            href={productDatasheetUrl(product.datasheetPath) ?? undefined}
                            target="_blank"
                            rel="noreferrer"
                            className="wg-btn-link"
                            style={{ fontSize: 12 }}
                          >
                            Fiche technique (PDF)
                          </a>
                        )}
                      </div>
                      {previewLine && (
                        <CalcLinePreview
                          line={previewLine}
                          powerLabel={product?.powerKva ? `${product.powerKva} kVA` : undefined}
                          marginPvElectrical={marginPvElectrical}
                          marginBatteryTravel={marginBatteryTravel}
                          actions={renderLineActions(previewLine)}
                        />
                      )}
                    </div>
                  );
                })}
                <button
                  type="button"
                  className="wg-btn-link"
                  onClick={() =>
                    setInverterSelections((prev) => [...prev, { key: nextSelectionKey(), productId: inverters[0]?.id ?? "", qty: 1 }])
                  }
                  style={{ marginTop: 8, marginBottom: 8, display: "inline-block" }}
                >
                  + Ajouter un modele d'onduleur
                </button>
                <p className="wg-muted">
                  Total : {totalInverterCount} onduleur(s) - {totalInverterPowerKva.toFixed(1)} kVA cumules
                </p>

                <p className="wg-subsection-title">Optimiseurs (ajoutes aux onduleurs, optionnels)</p>
                <div className="wg-calc-line-row">
                  <div className="wg-calc-line-controls">
                    <select value={optimizerId} onChange={(e) => setOptimizerId(e.target.value)} style={{ flex: "1 1 200px" }}>
                      <option value="">Aucun</option>
                      {optimizers.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.brand} (max {o.maxPowerW}W) - {formatEur(o.unitPrice)}/u
                        </option>
                      ))}
                    </select>
                    {optimizerId && (
                      <input
                        type="number"
                        min={0}
                        value={optimizerQty}
                        onChange={(e) => setOptimizerQty(Number(e.target.value))}
                        className="wg-input-qty"
                      />
                    )}
                  </div>
                  {optimizerLines[0] && (
                    <CalcLinePreview
                      line={optimizerLines[0]}
                      powerLabel={selectedOptimizer ? `${selectedOptimizer.maxPowerW} W` : undefined}
                      marginPvElectrical={marginPvElectrical}
                      marginBatteryTravel={marginBatteryTravel}
                      actions={renderLineActions(optimizerLines[0])}
                    />
                  )}
                </div>
                <SectionSubtotal lines={[...inverterLines, ...optimizerLines]} />
              </div>
            )}

            {/* 3. Batterie de stockage */}
            <div className="wg-panel">
              <p className="wg-panel-title">
                <span className="wg-step-badge">3</span>Batterie de stockage
              </p>
              <label className="wg-field" style={{ maxWidth: 360, marginBottom: 10 }}>
                Batterie {isComplete ? "(optionnelle)" : ""}
                <select value={batteryId} onChange={(e) => setBatteryId(e.target.value)}>
                  <option value="">Aucune</option>
                  {batteries.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.brand} {p.modelName}
                    </option>
                  ))}
                </select>
              </label>
              {(() => {
                const selectedBattery = batteries.find((p) => p.id === batteryId);
                const url = selectedBattery ? productDatasheetUrl(selectedBattery.datasheetPath) : null;
                return url ? (
                  <a href={url} target="_blank" rel="noreferrer" className="wg-btn-link" style={{ fontSize: 12, display: "inline-block", marginBottom: 10 }}>
                    Fiche technique (PDF)
                  </a>
                ) : null;
              })()}
              {batteryLines.length > 0 && (
                <>
                  <CalcLineHeader articleLabel="Poste batterie (decompose, decision 40)" />
                  {batteryLines.map((line, idx) => (
                    <div key={`battery-${idx}`} className="wg-calc-line-row">
                      <span>{line.description}</span>
                      <CalcLinePreview
                        line={line}
                        marginPvElectrical={marginPvElectrical}
                        marginBatteryTravel={marginBatteryTravel}
                        actions={renderLineActions(line)}
                      />
                    </div>
                  ))}
                </>
              )}
              <SectionSubtotal lines={batteryLines} />
            </div>

            {/* 4. Structure de montage -- reorganisee le 15/09/2026 (decision
                55, demande de Ben : "cette section doit contenir les postes
                concernant la toiture... et eventuellement la tranchee").
                Toiture et tranchee, auparavant dans la section 6, sont
                deplacees ici ; le carport reste bien identifie comme une
                structure alternative optionnelle (pas la seule option de la
                section, comme le signalait Ben : "les structures de montage
                que tu as mises sont uniquement les carports"). Aucun calcul
                deplace, seulement l'emplacement dans l'ecran -- les memes
                lignes laborOptionsBySlot.toiture/tranchee qu'avant. */}
            {isComplete && (
              <div className="wg-panel">
                <p className="wg-panel-title">
                  <span className="wg-step-badge">4</span>Structure de montage
                </p>

                <p className="wg-subsection-title" style={{ marginTop: 2, paddingTop: 0, borderTop: "none" }}>
                  Toiture
                </p>
                {laborRoofRates.length > 0 && laborRoofRates.length < 6 && (
                  <p className="wg-banner-warning">
                    Bareme actuel limite a {laborRoofRates.length} type(s) de toiture ({laborRoofRates.map((r) => r.roofType).join(", ")}).
                    L'Excel audite en distingue davantage (toiture inclinee en tuiles, en ardoise, en tuillettes, en panneaux
                    sandwich/tole, toiture plate sud, toiture plate est-ouest) : il manque les tarifs (prix fixe + paliers par
                    panneau) de ces types pour completer fidelement le bareme <code>labor_roof_rates</code>. A fournir par Ben.
                  </p>
                )}
                <CalcLineHeader articleLabel="Poste" />
                <div className="wg-calc-line-row">
                  <div className="wg-calc-line-controls">
                    <span className="wg-muted">Toiture :</span>
                    <select value={roofType} onChange={(e) => setRoofType(e.target.value)}>
                      {laborRoofRates.map((r) => (
                        <option key={r.roofType} value={r.roofType}>
                          {r.roofType}
                        </option>
                      ))}
                    </select>
                  </div>
                  <CalcLineSlot
                    line={laborOptionsBySlot.toiture}
                    marginPvElectrical={marginPvElectrical}
                    marginBatteryTravel={marginBatteryTravel}
                    actions={renderLineActions(laborOptionsBySlot.toiture)}
                  />
                </div>

                <p className="wg-subsection-title">Tranchee (optionnelle)</p>
                <div className="wg-calc-line-row">
                  <div className="wg-calc-line-controls">
                    <select value={trenchSoilType} onChange={(e) => setTrenchSoilType(e.target.value)}>
                      {trenchRates.map((r) => (
                        <option key={r.soilType} value={r.soilType}>
                          {r.soilType}
                        </option>
                      ))}
                    </select>
                    {trenchSoilType !== NO_TRENCH_LABEL && (
                      <input
                        type="number"
                        min={0}
                        value={trenchLengthM}
                        onChange={(e) => setTrenchLengthM(Number(e.target.value))}
                        className="wg-input-qty"
                        title="Longueur de tranchee (m)"
                      />
                    )}
                  </div>
                  <CalcLineSlot
                    line={laborOptionsBySlot.tranchee}
                    marginPvElectrical={marginPvElectrical}
                    marginBatteryTravel={marginBatteryTravel}
                    actions={renderLineActions(laborOptionsBySlot.tranchee)}
                  />
                </div>

                <p className="wg-subsection-title">Structure alternative (carport, optionnel)</p>
                <label className="wg-field" style={{ maxWidth: 360, marginBottom: 10 }}>
                  Carport (remplace la toiture pour la pose des panneaux concernes)
                  <select value={carportConfigId} onChange={(e) => setCarportConfigId(e.target.value)}>
                    <option value="">Aucun</option>
                    {carportConfigs.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.brand} {c.rowCount}x{c.placeCount} places, {c.nbPv} PV - {formatEur(c.price)}
                      </option>
                    ))}
                  </select>
                </label>
                {structureLines[0] && (
                  <>
                    <CalcLineHeader articleLabel="Structure" />
                    <div className="wg-calc-line-row">
                      <span>{structureLines[0].description}</span>
                      <CalcLinePreview
                        line={structureLines[0]}
                        marginPvElectrical={marginPvElectrical}
                        marginBatteryTravel={marginBatteryTravel}
                        actions={renderLineActions(structureLines[0])}
                      />
                    </div>
                  </>
                )}
                <SectionSubtotal
                  lines={[laborOptionsBySlot.toiture, laborOptionsBySlot.tranchee, ...structureLines].filter(
                    (l): l is OfferLine => Boolean(l),
                  )}
                />
              </div>
            )}

            {/* 5. Cablage */}
            {isComplete && (
              <div className="wg-panel">
                <p className="wg-panel-title">
                  <span className="wg-step-badge">5</span>Cablage
                </p>
                <div className="wg-grid-2">
                  <label className="wg-field">
                    Longueur cable AC onduleur -&gt; tableau (m)
                    <input type="number" min={0} value={cableLengthM} onChange={(e) => setCableLengthM(Number(e.target.value))} />
                  </label>
                  <label className="wg-field">
                    Courant DC par circuit (A, saisie manuelle)
                    <input type="number" min={0} value={dcCurrentA} onChange={(e) => setDcCurrentA(Number(e.target.value))} />
                  </label>
                  <label className="wg-field">
                    Longueur cable DC panneaux -&gt; onduleur (m)
                    <input type="number" min={0} value={dcCableLengthM} onChange={(e) => setDcCableLengthM(Number(e.target.value))} />
                  </label>
                  <label className="wg-field">
                    Nombre de circuits DC (strings)
                    <input type="number" min={1} value={dcCircuitCount} onChange={(e) => setDcCircuitCount(Number(e.target.value))} />
                  </label>
                </div>
                <p className="wg-subsection-title">Cablage et matos AC (provision forfaitaire par tranche de puissance)</p>
                <CalcLineHeader articleLabel="Poste" />
                <div className="wg-calc-line-row">
                  <label className="wg-inline-field wg-calc-line-controls">
                    <input type="checkbox" checked={cablingComplique} onChange={(e) => setCablingComplique(e.target.checked)} />
                    Cablage complique
                  </label>
                  <CalcLineSlot
                    line={laborOptionsBySlot.cablageProvision}
                    marginPvElectrical={marginPvElectrical}
                    marginBatteryTravel={marginBatteryTravel}
                    actions={renderLineActions(laborOptionsBySlot.cablageProvision)}
                  />
                </div>
                <div className="wg-calc-line-row">
                  <label className="wg-inline-field wg-calc-line-controls">
                    <input type="checkbox" checked={matosAcComplique} onChange={(e) => setMatosAcComplique(e.target.checked)} />
                    Matos AC complique
                  </label>
                  <CalcLineSlot
                    line={laborOptionsBySlot.matosAc}
                    marginPvElectrical={marginPvElectrical}
                    marginBatteryTravel={marginBatteryTravel}
                    actions={renderLineActions(laborOptionsBySlot.matosAc)}
                  />
                </div>

                {cableAc.errors.map((err, idx) => (
                  <p key={idx} className="wg-banner-warning">
                    Cablage AC : {err}
                  </p>
                ))}
                {cableDc.error && <p className="wg-banner-warning">Cablage DC : {cableDc.error}</p>}

                {cableAutoLines.length > 0 && (
                  <>
                    <p className="wg-subsection-title">Cablage AC/DC (calcule automatiquement selon les onduleurs et panneaux ci-dessus)</p>
                    <CalcLineHeader articleLabel="Poste cablage" />
                    {cableAutoLines.map((line, idx) => (
                      <div key={`cabling-${idx}`} className="wg-calc-line-row">
                        <span>{line.description}</span>
                        <CalcLinePreview
                          line={line}
                          marginPvElectrical={marginPvElectrical}
                          marginBatteryTravel={marginBatteryTravel}
                          actions={renderLineActions(line)}
                        />
                      </div>
                    ))}
                  </>
                )}
                <SectionSubtotal
                  lines={[laborOptionsBySlot.cablageProvision, laborOptionsBySlot.matosAc, ...cableAutoLines].filter(
                    (l): l is OfferLine => Boolean(l),
                  )}
                />
              </div>
            )}

            {/* 6. Main-d'oeuvre, electricite et administratif (parite Excel
                decisions 38/41 -- reorganise dans l'ordre des lignes 18 a 40
                de la feuille Excel "Calcul du prix", chaque select regroupe
                avec sa case a cocher associee). Toiture et tranchee ont ete
                deplacees dans la section 4 "Structure de montage" le
                15/09/2026 (decision 55, demande de Ben). */}
            {isComplete && (
              <div className="wg-panel">
                <p className="wg-panel-title">
                  <span className="wg-step-badge">6</span>Main-d'oeuvre, electricite et administratif
                </p>
                <p className="wg-muted">
                  Parite Excel (decision 38) : main-d'oeuvre electricien, redevance GRD, certification electrique,
                  cabine de decouplage, transformateur, compteurs, EMS, manutention et forfaits divers.
                </p>

                {laborAndOptionsLines.errors.map((err, idx) => (
                  <p key={idx} className="wg-banner-warning">
                    {err}
                  </p>
                ))}

                {/* Chaque poste ci-dessous est une ligne de tableau (comme dans
                    l'Excel) : le controle (select/case a cocher) et le prix/la
                    marge resultants sont dans la MEME ligne, plus besoin de
                    descendre jusqu'au recapitulatif du bas pour voir le budget
                    d'un poste qu'on vient de cocher (decision 49, 15/09/2026,
                    demande de Ben). Un poste desactive reste visible avec des
                    "-" (CalcLineSlot / CalcLineEmpty) plutot que de disparaitre. */}

                <p className="wg-subsection-title" style={{ marginTop: 2, paddingTop: 0, borderTop: "none" }}>
                  Electricien et cabine de decouplage
                </p>
                <CalcLineHeader articleLabel="Poste" />
                <div className="wg-calc-line-row">
                  <span className="wg-muted">Main-d'oeuvre electricien (auto, selon kVA total)</span>
                  <CalcLineSlot
                    line={laborOptionsBySlot.electricien}
                    marginPvElectrical={marginPvElectrical}
                    marginBatteryTravel={marginBatteryTravel}
                    actions={renderLineActions(laborOptionsBySlot.electricien)}
                  />
                </div>
                <div className="wg-calc-line-row">
                  <span className="wg-muted">Cabine de decouplage (auto, au-dela de 30 kVA)</span>
                  <CalcLineSlot
                    line={laborOptionsBySlot.cabineDecouplage}
                    marginPvElectrical={marginPvElectrical}
                    marginBatteryTravel={marginBatteryTravel}
                    actions={renderLineActions(laborOptionsBySlot.cabineDecouplage)}
                  />
                </div>

                <p className="wg-subsection-title">Certifications et compteurs</p>
                <CalcLineHeader articleLabel="Poste" />
                <div className="wg-calc-line-row">
                  <label className="wg-inline-field wg-calc-line-controls">
                    <input
                      type="checkbox"
                      checked={certificationElectriqueEnabled}
                      onChange={(e) => setCertificationElectriqueEnabled(e.target.checked)}
                    />
                    Certification electrique
                  </label>
                  <CalcLineSlot
                    line={laborOptionsBySlot.certification}
                    marginPvElectrical={marginPvElectrical}
                    marginBatteryTravel={marginBatteryTravel}
                    actions={renderLineActions(laborOptionsBySlot.certification)}
                  />
                </div>
                <div className="wg-calc-line-row">
                  <label className="wg-inline-field wg-calc-line-controls">
                    <input type="checkbox" checked={greenBoxEnabled} onChange={(e) => setGreenBoxEnabled(e.target.checked)} />
                    Green Box
                  </label>
                  <CalcLineSlot
                    line={laborOptionsBySlot.greenBox}
                    marginPvElectrical={marginPvElectrical}
                    marginBatteryTravel={marginBatteryTravel}
                    actions={renderLineActions(laborOptionsBySlot.greenBox)}
                  />
                </div>
                {region === Region.BRUXELLES && (
                  <div className="wg-calc-line-row">
                    <label className="wg-inline-field wg-calc-line-controls">
                      <input type="checkbox" checked={brugelEnabled} onChange={(e) => setBrugelEnabled(e.target.checked)} />
                      Certification Brugel
                    </label>
                    <CalcLineSlot
                      line={laborOptionsBySlot.brugel}
                      marginPvElectrical={marginPvElectrical}
                      marginBatteryTravel={marginBatteryTravel}
                      actions={renderLineActions(laborOptionsBySlot.brugel)}
                    />
                  </div>
                )}
                <div className="wg-calc-line-row">
                  <div className="wg-calc-line-controls">
                    <label className="wg-inline-field">
                      <input type="checkbox" checked={compteurVertEnabled} onChange={(e) => setCompteurVertEnabled(e.target.checked)} />
                      Compteur vert
                    </label>
                    {compteurVertEnabled && (
                      <select value={compteurVertPhase} onChange={(e) => setCompteurVertPhase(e.target.value)}>
                        {compteurCatalog
                          .filter((c) => c.modelName === "Compteur vert")
                          .map((c) => (
                            <option key={c.id} value={String(c.specs?.phase_type ?? "")}>
                              {String(c.specs?.phase_type ?? "")} - {formatEur(c.unitPrice)}
                            </option>
                          ))}
                      </select>
                    )}
                  </div>
                  <CalcLineSlot
                    line={laborOptionsBySlot.compteurVert}
                    marginPvElectrical={marginPvElectrical}
                    marginBatteryTravel={marginBatteryTravel}
                    actions={renderLineActions(laborOptionsBySlot.compteurVert)}
                  />
                </div>

                <p className="wg-subsection-title">Energy Meter, EMS, transformateur</p>
                <CalcLineHeader articleLabel="Poste" />
                <div className="wg-calc-line-row">
                  <div className="wg-calc-line-controls">
                    <label className="wg-inline-field">
                      <input type="checkbox" checked={energyMeterEnabled} onChange={(e) => setEnergyMeterEnabled(e.target.checked)} />
                      Energy Meter
                    </label>
                    {energyMeterEnabled && (
                      <select value={energyMeterPhase} onChange={(e) => setEnergyMeterPhase(e.target.value)}>
                        {compteurCatalog
                          .filter((c) => c.modelName === "Energy Meter")
                          .map((c) => (
                            <option key={c.id} value={String(c.specs?.phase_type ?? "")}>
                              {String(c.specs?.phase_type ?? "")} - {formatEur(c.unitPrice)}
                            </option>
                          ))}
                      </select>
                    )}
                  </div>
                  <CalcLineSlot
                    line={laborOptionsBySlot.energyMeter}
                    marginPvElectrical={marginPvElectrical}
                    marginBatteryTravel={marginBatteryTravel}
                    actions={renderLineActions(laborOptionsBySlot.energyMeter)}
                  />
                </div>
                <div className="wg-calc-line-row">
                  <div className="wg-calc-line-controls">
                    <span className="wg-muted">EMS :</span>
                    <select value={emsId} onChange={(e) => setEmsId(e.target.value)}>
                      <option value="">Aucun</option>
                      {emsCatalog.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.modelName} - {formatEur(e.unitPrice)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <CalcLineSlot
                    line={laborOptionsBySlot.ems}
                    marginPvElectrical={marginPvElectrical}
                    marginBatteryTravel={marginBatteryTravel}
                    actions={renderLineActions(laborOptionsBySlot.ems)}
                  />
                </div>
                {emsId && emsCatalog.find((e) => e.id === emsId)?.specs?.requires_license === true && (
                  <div className="wg-calc-line-row">
                    <label className="wg-inline-field wg-calc-line-controls">
                      <input
                        type="checkbox"
                        checked={emsLicenseBillingEnabled}
                        onChange={(e) => setEmsLicenseBillingEnabled(e.target.checked)}
                      />
                      Licence EMS (hors Excel actif, voir note)
                    </label>
                    <CalcLineSlot
                      line={laborOptionsBySlot.emsLicense}
                      marginPvElectrical={marginPvElectrical}
                      marginBatteryTravel={marginBatteryTravel}
                      actions={renderLineActions(laborOptionsBySlot.emsLicense)}
                    />
                  </div>
                )}
                <div className="wg-calc-line-row">
                  <div className="wg-calc-line-controls">
                    <span className="wg-muted">Transformateur :</span>
                    <select value={transformateurId} onChange={(e) => setTransformateurId(e.target.value)}>
                      <option value="">Aucun</option>
                      {transformateurCatalog.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.modelName} - {formatEur(t.unitPrice)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <CalcLineSlot
                    line={laborOptionsBySlot.transformateur}
                    marginPvElectrical={marginPvElectrical}
                    marginBatteryTravel={marginBatteryTravel}
                    actions={renderLineActions(laborOptionsBySlot.transformateur)}
                  />
                </div>

                <p className="wg-subsection-title">Manutention</p>
                <CalcLineHeader articleLabel="Poste" />
                <div className="wg-calc-line-row">
                  <label className="wg-inline-field wg-calc-line-controls">
                    <input type="checkbox" checked={liftEnabled} onChange={(e) => setLiftEnabled(e.target.checked)} />
                    Lift
                  </label>
                  <CalcLineSlot
                    line={laborOptionsBySlot.lift}
                    marginPvElectrical={marginPvElectrical}
                    marginBatteryTravel={marginBatteryTravel}
                    actions={renderLineActions(laborOptionsBySlot.lift)}
                  />
                </div>
                <div className="wg-calc-line-row">
                  <div className="wg-calc-line-controls">
                    <label className="wg-inline-field">
                      <input type="checkbox" checked={nacelleDays > 0} onChange={(e) => setNacelleDays(e.target.checked ? 1 : 0)} />
                      Nacelle
                    </label>
                    {nacelleDays > 0 && (
                      <input
                        type="number"
                        min={0}
                        value={nacelleDays}
                        onChange={(e) => setNacelleDays(Number(e.target.value))}
                        className="wg-input-qty"
                        title="Nombre de jours"
                      />
                    )}
                  </div>
                  <CalcLineSlot
                    line={laborOptionsBySlot.nacelle}
                    marginPvElectrical={marginPvElectrical}
                    marginBatteryTravel={marginBatteryTravel}
                    actions={renderLineActions(laborOptionsBySlot.nacelle)}
                  />
                </div>
                <div className="wg-calc-line-row">
                  <label className="wg-inline-field wg-calc-line-controls">
                    <input type="checkbox" checked={enlevementEnabled} onChange={(e) => setEnlevementEnabled(e.target.checked)} />
                    Enlevement installation existante
                  </label>
                  <CalcLineSlot
                    line={laborOptionsBySlot.enlevement}
                    marginPvElectrical={marginPvElectrical}
                    marginBatteryTravel={marginBatteryTravel}
                    actions={renderLineActions(laborOptionsBySlot.enlevement)}
                  />
                </div>
                <div className="wg-calc-line-row">
                  <div className="wg-calc-line-controls">
                    <span className="wg-muted">Grue :</span>
                    <select value={grueChoice} onChange={(e) => setGrueChoice(e.target.value)}>
                      <option value="">Aucune</option>
                      {handlingRates
                        .filter((h) => h.handlingKey === "grue_1_jour" || h.handlingKey === "grue_manitou_semaine")
                        .map((h) => (
                          <option key={h.handlingKey} value={h.handlingKey}>
                            {h.label} - {formatEur(h.price)}
                          </option>
                        ))}
                    </select>
                  </div>
                  <CalcLineSlot
                    line={laborOptionsBySlot.grue}
                    marginPvElectrical={marginPvElectrical}
                    marginBatteryTravel={marginBatteryTravel}
                    actions={renderLineActions(laborOptionsBySlot.grue)}
                  />
                </div>
                <div className="wg-calc-line-row">
                  <span className="wg-muted">Transport (auto, deduit du nombre de panneaux)</span>
                  <CalcLineSlot
                    line={laborOptionsBySlot.transport}
                    marginPvElectrical={marginPvElectrical}
                    marginBatteryTravel={marginBatteryTravel}
                    actions={renderLineActions(laborOptionsBySlot.transport)}
                  />
                </div>

                <p className="wg-subsection-title">Etudes complementaires</p>
                <CalcLineHeader articleLabel="Poste" />
                <div className="wg-calc-line-row">
                  <label className="wg-inline-field wg-calc-line-controls">
                    <input type="checkbox" checked={stabilityStudyEnabled} onChange={(e) => setStabilityStudyEnabled(e.target.checked)} />
                    Etude de stabilite
                  </label>
                  <CalcLineSlot
                    line={laborOptionsBySlot.stabilityStudy}
                    marginPvElectrical={marginPvElectrical}
                    marginBatteryTravel={marginBatteryTravel}
                    actions={renderLineActions(laborOptionsBySlot.stabilityStudy)}
                  />
                </div>
                <div className="wg-calc-line-row">
                  <label className="wg-inline-field wg-calc-line-controls">
                    <input type="checkbox" checked={grdChargeToUs} onChange={(e) => setGrdChargeToUs(e.target.checked)} />
                    Etude GRD a notre charge
                  </label>
                  <CalcLineSlot
                    line={laborOptionsBySlot.grd}
                    marginPvElectrical={marginPvElectrical}
                    marginBatteryTravel={marginBatteryTravel}
                    actions={renderLineActions(laborOptionsBySlot.grd)}
                  />
                </div>
                <SectionSubtotal
                  lines={[
                    laborOptionsBySlot.electricien,
                    laborOptionsBySlot.cabineDecouplage,
                    laborOptionsBySlot.certification,
                    laborOptionsBySlot.greenBox,
                    laborOptionsBySlot.brugel,
                    laborOptionsBySlot.compteurVert,
                    laborOptionsBySlot.energyMeter,
                    laborOptionsBySlot.ems,
                    laborOptionsBySlot.emsLicense,
                    laborOptionsBySlot.transformateur,
                    laborOptionsBySlot.lift,
                    laborOptionsBySlot.nacelle,
                    laborOptionsBySlot.enlevement,
                    laborOptionsBySlot.grue,
                    laborOptionsBySlot.transport,
                    laborOptionsBySlot.stabilityStudy,
                    laborOptionsBySlot.grd,
                  ].filter((l): l is OfferLine => Boolean(l))}
                />
              </div>
            )}

            {/* 7. Deplacement */}
            <div className="wg-panel">
              <p className="wg-panel-title">
                <span className="wg-step-badge">7</span>Deplacement
              </p>
              <label className="wg-field" style={{ maxWidth: 320, marginBottom: 10 }}>
                Distance chantier depuis Bruxelles (km)
                <input type="number" min={0} value={distanceKm} onChange={(e) => setDistanceKm(Number(e.target.value))} />
              </label>
              {travelLines[0] && (
                <>
                  <CalcLineHeader articleLabel="Poste deplacement" />
                  <div className="wg-calc-line-row">
                    <span>{travelLines[0].description}</span>
                    <CalcLinePreview
                      line={travelLines[0]}
                      marginPvElectrical={marginPvElectrical}
                      marginBatteryTravel={marginBatteryTravel}
                      actions={renderLineActions(travelLines[0])}
                    />
                  </div>
                </>
              )}
              <SectionSubtotal lines={travelLines} />
            </div>

            {/* Le tableau "Detail complet des lignes", auparavant une section a
                part entiere en bas de page, a ete supprime le 15/09/2026
                (decision 55, demande de Ben : "la section detail complet des
                lignes ne doit pas etre une section a part entiere en bas").
                Chaque ligne reste modifiable (bouton "Modifier le prix") et,
                en mode marche public, redistribuable (case "Poste marche
                public") directement depuis sa section d'origine (1 a 7)
                ci-dessus, via renderLineActions -- aucune capacite perdue,
                juste deplacee au plus pres de chaque poste. */}

            {totals && (
              <div className="wg-panel wg-totals">
                <p className="wg-panel-title">Resume des prix</p>
                <div className="wg-totals-row wg-total-main">
                  <span>Prix client (TTC)</span>
                  <span>{formatEur(totals.totalTtc)}</span>
                </div>
                <div className="wg-totals-row">
                  <span>Prix HTVA avec batterie</span>
                  <span>
                    {formatEur(totals.totalHtva)}
                    {totalPowerKwc > 0 && (
                      <span className="wg-muted" style={{ marginLeft: 8, fontWeight: 400 }}>
                        ({(totals.totalHtva / (totalPowerKwc * 1000)).toFixed(3)} EUR/Wc)
                      </span>
                    )}
                  </span>
                </div>
                <div className="wg-totals-row">
                  <span>Prix HTVA sans batterie</span>
                  <span>
                    {totalsWithoutBattery ? formatEur(totalsWithoutBattery.totalHtva) : "-"}
                    {totalPowerKwc > 0 && totalsWithoutBattery && (
                      <span className="wg-muted" style={{ marginLeft: 8, fontWeight: 400 }}>
                        ({(totalsWithoutBattery.totalHtva / (totalPowerKwc * 1000)).toFixed(3)} EUR/Wc)
                      </span>
                    )}
                  </span>
                </div>
                <div className="wg-totals-row">
                  <span>Prix/Wc TTC</span>
                  <span>{totalPowerKwc > 0 ? `${(totals.totalTtc / (totalPowerKwc * 1000)).toFixed(3)} EUR/Wc` : "-"}</span>
                </div>
              </div>
            )}
          </div>

          <div className="wg-calc-sidebar">
            {/* Region et regime de revenus (K8 dans l'Excel) : reste dans
                "Calcul du prix" (choix qui determine le regime CV/GRD
                utilise pour cette ligne de calcul), contrairement au taux
                d'auto-consommation et au rendement de production qui sont
                deplaces dans l'onglet "Donnees" (decision 41) -- affiches
                ici en lecture seule pour le contexte. Deplace dans la
                colonne laterale (decision 42, 12/09/2026, demande de Ben :
                "le ratio de marge pourrait etre un peu plus a droite de la
                configuration"). */}
            {isComplete && (
              <div className="wg-panel">
                <p className="wg-panel-title">Region et regime</p>
                <label className="wg-field">
                  Region
                  <select value={region} onChange={(e) => setRegion(e.target.value as Region)}>
                    {Object.values(Region).map((r) => (
                      <option key={r} value={r}>
                        {regionLabels[r]}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="wg-muted" style={{ marginTop: 8 }}>
                  Auto-consommation : <strong>{(effectiveAutoConsumption * 100).toFixed(0)}%</strong>
                  <br />
                  Ratio de production : <strong>{effectiveProductionYield.toFixed(3)} kWh/Wc/an</strong>
                  {region === Region.BRUXELLES && (
                    <>
                      <br />
                      Taux CV : <strong>{effectiveCvRatePerMwh !== null ? `${effectiveCvRatePerMwh.toFixed(3)} CV/MWh` : "-"}</strong>
                    </>
                  )}
                  <br />
                  <em>modifiables dans l'onglet "Donnees".</em>
                </p>
              </div>
            )}

            <div className="wg-panel">
              <p className="wg-panel-title">Marge et commission</p>
              <p className="wg-muted">
                Puissance totale : <strong>{totalPowerKwc.toFixed(2)} kWc</strong>
                <br />
                Marge suggeree : <strong>{suggestedMargin ? suggestedMargin.toFixed(4) : "-"}</strong>
                <br />
                <em>(information seule, jamais copiee automatiquement)</em>
              </p>
              <label className="wg-field" style={{ marginBottom: 8 }}>
                Marge PV / electricite (K12)
                <input type="number" step={0.01} value={marginPvElectrical} onChange={(e) => setMarginPvElectrical(Number(e.target.value))} />
              </label>
              <label className="wg-field" style={{ marginBottom: 8 }}>
                Marge batterie / deplacement (K21)
                <input type="number" step={0.01} value={marginBatteryTravel} onChange={(e) => setMarginBatteryTravel(Number(e.target.value))} />
              </label>
              <label className="wg-field">
                Commission ({((commissionSettings?.minRate ?? 0.1) * 100).toFixed(0)}% -{" "}
                {((commissionSettings?.maxRate ?? 0.3) * 100).toFixed(0)}%)
                <input
                  type="number"
                  step={0.01}
                  min={commissionSettings?.minRate ?? 0.1}
                  max={commissionSettings?.maxRate ?? 0.3}
                  value={commissionRate}
                  onChange={(e) => setCommissionRate(Number(e.target.value))}
                />
              </label>
              {totals && (
                <p className="wg-muted" style={{ marginTop: 10, fontWeight: 700 }}>
                  Marge totale We Green : {formatEur(totals.totalMargin)}
                  <br />
                  Commission ({(commissionRate * 100).toFixed(0)}%) : {formatEur(totals.commission)}
                  <br />
                  <em style={{ fontWeight: 400 }}>
                    Information interne, jamais reprise dans l'offre envoyee au client (decision 54).
                  </em>
                </p>
              )}
            </div>

            <div className="wg-panel">
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <input type="checkbox" checked={isPublicTender} onChange={(e) => setIsPublicTender(e.target.checked)} />
                Offre marche public (cles de repartition)
              </label>
            </div>
          </div>
        </div>
      )}

      {activeTab === "offre" && (
        <>
          {/* Page de garde : refaite decision 42 (12/09/2026) sur le modele
              des offres PDF reelles fournies par Ben ("Offre PV - BOS9" et
              "Offre PV Batterie - BOS9", 08.09) -- logo + coordonnees We
              Green, fiche client grisee, prix HTVA, ROI, date, validite. */}
          <div className="wg-panel">
            <div className="wg-offer-cover-header">
              <img src="/we-green-logo.png" alt="We Green" className="wg-offer-logo" />
              <div className="wg-offer-cover-company">
                <strong>We Green Energy</strong>
                <br />
                {WE_GREEN_COMPANY_INFO.address}
                <br />
                Tel {WE_GREEN_COMPANY_INFO.phone}
                <br />
                {WE_GREEN_COMPANY_INFO.email}
                <br />
                TVA {WE_GREEN_COMPANY_INFO.vat}
              </div>
            </div>

            <div className="wg-offer-cover" style={{ marginTop: 16, boxShadow: "none" }}>
              <div className="wg-offer-cover-client">
                <p className="wg-offer-client-name">{clientName || "Client a renseigner (onglet Donnees)"}</p>
                {clientAddress && <p style={{ whiteSpace: "pre-line" }}>{clientAddress}</p>}
                {batteryId &&
                  (() => {
                    const b = batteries.find((p) => p.id === batteryId);
                    return (
                      <p>
                        Batterie : {b ? `${b.brand} ${b.modelName}` : "-"}
                        {emsIncluded && selectedEms ? ` · EMS ${selectedEms.modelName}` : ""}
                      </p>
                    );
                  })()}
                <p>
                  <strong>Titre de l'offre :</strong> {offerTitleText}
                </p>
                <p className="wg-muted">
                  {clientType === "societe" ? "Societe" : "Particulier"} · Offre en{" "}
                  {offerLanguage === "NL" ? "neerlandais" : "francais"}
                </p>
                {responsableNom && (
                  <p className="wg-muted">
                    Responsable We Green : {responsableNom}
                    {responsableTelephone ? ` · ${responsableTelephone}` : ""}
                    {responsableEmail ? ` · ${responsableEmail}` : ""}
                  </p>
                )}
              </div>
              {totals && (
                <div className="wg-offer-cover-price">
                  <p className="wg-offer-price-label">Prix (HTVA)</p>
                  <p className="wg-offer-price-value">{formatEur(totals.totalHtva)}</p>
                  <p className="wg-muted">Retour sur investissement : {paybackYear ? `annee ${paybackYear}` : "au-dela de 25 ans"}</p>
                  <p className="wg-muted">Date : {new Date().toLocaleDateString("fr-BE")}</p>
                  <p className="wg-muted">Validite de l'offre : {OFFER_LITERATURE_COMPLETE.validiteOffre}</p>
                </div>
              )}
            </div>
          </div>

          <div className="wg-panel">
            <p className="wg-panel-title">Table des matieres</p>
            <ol className="wg-offer-toc">
              <li>Votre installation photovoltaique</li>
              <li>Choix des composants</li>
              <li>Cout du projet</li>
              <li>Conditions de vente</li>
              <li>Avantages financiers estimes</li>
              <li>Autres avantages</li>
              <li>Signatures</li>
            </ol>
          </div>

          {/* 2. Votre installation photovoltaique */}
          <div className="wg-panel">
            <p className="wg-panel-title">2. Votre installation photovoltaique</p>
            <p className="wg-subsection-title">2.1 Description generale</p>
            {isComplete ? (
              <>
                <p>
                  {OFFER_LITERATURE_COMPLETE.descriptionGenerale} Solution recommandee : {totalPowerKwc.toFixed(2)} kWc, soit{" "}
                  {totalPanelQty} panneau(x) photovoltaique(s){resolvedPanelSelections.length > 1 ? " (plusieurs modeles)" : ""}.
                </p>
                <p>{OFFER_LITERATURE_COMPLETE.descriptionGeneraleSuite}</p>
              </>
            ) : (
              <p>{OFFER_LITERATURE_BATTERY.description}</p>
            )}

            {archeliosImage && (
              <div className="wg-offer-archelios-image">
                <img src={archeliosImage.dataUrl} alt="Calepinage / implantation photovoltaique (Archelios / Helioscope)" />
              </div>
            )}

            <p className="wg-subsection-title">2.2 Choix des composants</p>
            <div className="wg-table-wrap" style={{ marginTop: 0 }}>
              <table className="wg-sheet">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Type</th>
                    <th>Composants</th>
                    <th>Marque</th>
                    <th className="wg-num">Quantite</th>
                    <th>Statut</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    type CompRow = { type: string; composant: string; marque: string; quantite: string; included: boolean };
                    const rows: CompRow[] = [];
                    const pushRow = (type: string, composant: string, marque: string, quantite: string, included: boolean) =>
                      rows.push({ type, composant, marque, quantite, included });

                    if (isComplete) {
                      resolvedPanelSelections.forEach((s) =>
                        pushRow("Panneaux solaires", `${s.product.brand} ${s.product.modelName}`, s.product.brand, `${s.qty}`, true),
                      );
                      resolvedInverterSelections.forEach((s) =>
                        pushRow("Onduleur", `${s.product.brand} ${s.product.modelName}`, s.product.brand, `${s.qty}`, true),
                      );
                      if (selectedOptimizer && optimizerQty > 0) {
                        pushRow("Optimiseurs", `Optimiseur ${selectedOptimizer.brand}`, selectedOptimizer.brand, `${optimizerQty}`, true);
                      }
                    }
                    if (batteryId) {
                      const b = batteries.find((p) => p.id === batteryId);
                      pushRow("Batterie de stockage", b ? `${b.brand} ${b.modelName}` : "Batterie", b?.brand ?? "-", "1", true);
                      if (bebatLine) {
                        pushRow("Prime de recyclage batterie", "Prime BEBAT", "-", "-", true);
                      }
                    }
                    if (emsIncluded && selectedEms) {
                      pushRow("EMS", selectedEms.modelName, "-", "1", true);
                    }
                    pushRow("Monitoring", "Suivi en direct via l'onduleur connecte", "-", "-", true);
                    if (isComplete) {
                      pushRow(
                        "Structures de montage",
                        selectedCarport ? `Carport ${selectedCarport.brand}` : "Fixation toiture standard",
                        selectedCarport?.brand ?? "-",
                        selectedCarport ? "1" : "-",
                        true,
                      );
                      pushRow("Travaux electriques", "Raccordement au tableau et mise en place des protections", "-", "-", true);
                      if (cabineDecouplageIncluded) {
                        pushRow("Cabine de decouplage", "Cabine de decouplage", "-", "1", true);
                      }
                      pushRow("Certification electrique", "Certification RGIE / Rescert", "-", "-", certificationElectriqueEnabled);
                      pushRow("Etude de stabilite", "Etude de stabilite de la toiture", "-", "-", stabilityStudyEnabled);
                      pushRow("Frais du gestionnaire de reseau", "Etude/redevance GRD", "-", "-", grdChargeToUs);
                    }
                    pushRow("Demarches administratives", "Green Box / certification Brugel selon region", "-", "-", demarchesAdminIncluded);

                    return rows.map((r, i) => (
                      <tr key={`comp-${i}`}>
                        <td>{i + 1}</td>
                        <td>{r.type}</td>
                        <td>{r.composant}</td>
                        <td>{r.marque}</td>
                        <td className="wg-num">{r.quantite}</td>
                        <td>
                          <span className={`wg-badge ${r.included ? "wg-badge-included" : "wg-badge-excluded"}`}>
                            {r.included ? "Inclus" : "Non inclus - a charge du client"}
                          </span>
                        </td>
                      </tr>
                    ));
                  })()}
                </tbody>
              </table>
            </div>
            <p className="wg-offer-estimate-note">
              Tableau aligne sur la presentation des offres PDF actuelles (postes commerciaux principaux) -- le detail
              exhaustif ligne par ligne reste disponible ci-dessous et dans l'onglet "Calcul du prix".
            </p>
          </div>

          {/* 3. Cout du projet */}
          <div className="wg-panel">
            <p className="wg-panel-title">3. Cout du projet</p>
            {totals && (
              <p>
                <strong>
                  Le prix total de votre projet s'eleve a {formatEur(totals.totalHtva)} HTVA ({formatEur(totals.totalTtc)} TTC).
                </strong>
              </p>
            )}
            <p className="wg-muted">{OFFER_LITERATURE_COMPLETE.mentionTva}</p>

            {!isPublicTender && (
              <label className="wg-inline-field wg-print-hide" style={{ marginTop: 10 }}>
                Niveau de detail affiche (usage interne)
                <select
                  value={priceDetailLevel}
                  onChange={(e) => setPriceDetailLevel(e.target.value as "totaux" | "section" | "ligne")}
                  style={{ width: 260 }}
                >
                  <option value="totaux">Totaux uniquement</option>
                  <option value="section">Detail par section (sous-totaux)</option>
                  <option value="ligne">Detail par ligne (complet)</option>
                </select>
              </label>
            )}

            {effectivePriceDetailLevel === "section" && (
              <div className="wg-table-wrap">
                <table className="wg-sheet">
                  <thead>
                    <tr>
                      <th>Section</th>
                      <th className="wg-num">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {categorySubtotals.map((c) => (
                      <tr key={c.category}>
                        <td>{c.category}</td>
                        <td className="wg-num">{formatEur(c.totalPrice)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {effectivePriceDetailLevel === "ligne" && (
              <div className="wg-table-wrap">
                <table className="wg-sheet">
                  <thead>
                    <tr>
                      <th>Ligne</th>
                      <th className="wg-num">Qte</th>
                      <th className="wg-num">{isPublicTender ? "Prix affiche" : "Prix unitaire"}</th>
                      <th className="wg-num">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, idx) => {
                      const repartitionResult = repartitionResults?.[idx];
                      const displayed =
                        isPublicTender && repartitionResult
                          ? repartitionResult.displayedPrice !== null
                            ? formatEur(repartitionResult.displayedPrice)
                            : "masque"
                          : formatEur(line.unitPrice);
                      return (
                        <tr key={`${line.category}-${idx}`}>
                          <td>{line.description}</td>
                          <td className="wg-num">{line.quantity}</td>
                          <td className="wg-num">{displayed}</td>
                          <td className="wg-num">{formatEur(lineTotalPrice(line))}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Uniquement les totaux client (decision 54, 15/09/2026) : "Cout total",
                "Marge totale" et "Commission" sont des informations internes,
                jamais destinees a un document client -- deplacees dans le
                panneau "Marge et commission" de l'onglet "Calcul du prix". */}
            {totals && (
              <div className="wg-panel wg-totals" style={{ marginTop: 14 }}>
                <div className="wg-totals-row">
                  <span>Total HTVA</span>
                  <span>{formatEur(totals.totalHtva)}</span>
                </div>
                <div className="wg-totals-row">
                  <span>TVA ({(vatRate * 100).toFixed(0)}%)</span>
                  <span>{formatEur(totals.vatAmount)}</span>
                </div>
                <div className="wg-totals-row wg-total-main">
                  <span>Total TTC</span>
                  <span>{formatEur(totals.totalTtc)}</span>
                </div>
              </div>
            )}
          </div>

          {/* 4. Conditions de vente */}
          <div className="wg-panel">
            <p className="wg-panel-title">4. Conditions de vente</p>
            <p className="wg-subsection-title">4.1 Conditions de paiement</p>
            <p>{(isComplete ? OFFER_LITERATURE_COMPLETE.conditionsPaiement : OFFER_LITERATURE_BATTERY.conditionsPaiement).join(" · ")}</p>

            <p className="wg-subsection-title">4.2 Delai de livraison</p>
            <p>{isComplete ? OFFER_LITERATURE_COMPLETE.delaiLivraison(clientType) : OFFER_LITERATURE_BATTERY.delaiLivraison(clientType)}</p>

            <p className="wg-subsection-title">4.3 Assurance qualite technique</p>
            <p>{isComplete ? OFFER_LITERATURE_COMPLETE.assuranceQualite : OFFER_LITERATURE_BATTERY.assuranceQualite}</p>

            <p className="wg-subsection-title">4.4 Acces</p>
            <p>{isComplete ? OFFER_LITERATURE_COMPLETE.zoneAcces : OFFER_LITERATURE_BATTERY.zoneAcces}</p>

            <p className="wg-subsection-title">4.5 Securite</p>
            <p>{(isComplete ? OFFER_LITERATURE_COMPLETE.securite : OFFER_LITERATURE_BATTERY.securite).join(" · ")}</p>

            <p className="wg-subsection-title">4.6 Garanties We Green</p>
            {isComplete ? (
              <>
                <p>Onduleur(s) : {OFFER_LITERATURE_COMPLETE.garantiesOnduleur}</p>
                <p>Panneaux solaires : {OFFER_LITERATURE_COMPLETE.garantiesPanneaux.join(" · ")}</p>
                <p>{OFFER_LITERATURE_COMPLETE.garantiesMontage}</p>
              </>
            ) : (
              <p className="wg-muted">
                {OFFER_LITERATURE_BATTERY.garantie ??
                  "Non renseigne dans le classeur source (cellule vide/formule cassee) -- a completer avec Ben."}
              </p>
            )}
          </div>

          {/* 5. Avantages financiers estimes */}
          {isComplete && cashflow && (
            <div className="wg-panel">
              <p className="wg-panel-title">5. Avantages financiers estimes</p>

              <p className="wg-subsection-title">5.1 Resume des revenus</p>
              <div className="wg-table-wrap" style={{ marginTop: 0 }}>
                <table className="wg-sheet">
                  <thead>
                    <tr>
                      <th>Revenus</th>
                      <th className="wg-num">1 an</th>
                      <th className="wg-num">10 ans</th>
                      <th className="wg-num">25 ans</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Revenus lies a l'auto-consommation</td>
                      <td className="wg-num">{revenueSummary1An ? formatEur(revenueSummary1An.auto) : "-"}</td>
                      <td className="wg-num">{revenueSummary10Ans ? formatEur(revenueSummary10Ans.auto) : "-"}</td>
                      <td className="wg-num">{revenueSummary25Ans ? formatEur(revenueSummary25Ans.auto) : "-"}</td>
                    </tr>
                    <tr>
                      <td>Revente energie non auto-consommee (ou CV a Bruxelles)</td>
                      <td className="wg-num">{revenueSummary1An ? formatEur(revenueSummary1An.specific) : "-"}</td>
                      <td className="wg-num">{revenueSummary10Ans ? formatEur(revenueSummary10Ans.specific) : "-"}</td>
                      <td className="wg-num">{revenueSummary25Ans ? formatEur(revenueSummary25Ans.specific) : "-"}</td>
                    </tr>
                    <tr className="wg-row-new">
                      <td>Revenus totaux effectues</td>
                      <td className="wg-num">{revenueSummary1An ? formatEur(revenueSummary1An.total) : "-"}</td>
                      <td className="wg-num">{revenueSummary10Ans ? formatEur(revenueSummary10Ans.total) : "-"}</td>
                      <td className="wg-num">{revenueSummary25Ans ? formatEur(revenueSummary25Ans.total) : "-"}</td>
                    </tr>
                    <tr>
                      <td>Retour sur investissement (ROI)</td>
                      <td className="wg-num" colSpan={3}>
                        {paybackYear ? `Annee ${paybackYear}` : "Au-dela de 25 ans"}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="wg-offer-estimate-note">
                Tableau de synthese inspire des offres PDF actuelles -- cumuls calcules a partir de la simulation de
                rentabilite validee (referentiel section 6), mais ce format de tableau n'est pas lui-meme teste
                formule a formule contre l'Excel : a confirmer avec Ben.
              </p>

              <p className="wg-subsection-title">5.2 Tableau de rentabilite detaille ({regimeLabel})</p>
              <p className="wg-muted">
                Investissement (Total HTVA) : <strong>{totals ? formatEur(totals.totalHtva) : "-"}</strong>
                {" · "}
                Auto-consommation utilisee : {(effectiveAutoConsumption * 100).toFixed(0)}%
              </p>
              <div className="wg-table-wrap" style={{ maxHeight: 360, overflowY: "auto" }}>
                <table className="wg-sheet">
                  <thead>
                    <tr>
                      <th>Annee</th>
                      <th className="wg-num">Rendement panneaux</th>
                      <th className="wg-num">Production (kWh)</th>
                      <th className="wg-num">Prix elec (EUR/kWh)</th>
                      <th className="wg-num">Auto-consommation</th>
                      <th className="wg-num">Revente / CV</th>
                      <th className="wg-num">Gain financier annuel</th>
                      <th className="wg-num">Cashflow cumule</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cashflow.map((y) => (
                      <tr key={y.year} className={y.year === paybackYear ? "wg-row-new" : undefined}>
                        <td>{y.year}</td>
                        <td className="wg-num">{y.yieldPct.toFixed(1)}%</td>
                        <td className="wg-num">{y.productionKwh.toFixed(0)}</td>
                        <td className="wg-num">{y.networkPrice.toFixed(4)}</td>
                        <td className="wg-num">{formatEur(y.revenueAutoConsumption)}</td>
                        <td className="wg-num">{formatEur(y.revenueRegimeSpecific)}</td>
                        <td className="wg-num">{formatEur(y.revenueAutoConsumption + y.revenueRegimeSpecific)}</td>
                        <td className="wg-num">{formatEur(y.cashflowCumulative)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="wg-subsection-title">5.3 Energie verte et stable</p>
              <p>
                {OFFER_LITERATURE_COMPLETE.avantageEnergieVerte}{" "}
                {costPerKwh25Ans !== null && (
                  <>
                    Cout de revient estime sur 25 ans : <strong>{costPerKwh25Ans.toFixed(3)} EUR/kWh</strong>.
                  </>
                )}
              </p>
              <p className="wg-offer-estimate-note">
                Cout au kWh = investissement HTVA / production cumulee sur 25 ans -- indicateur de presentation, pas
                une formule Excel revalidee independamment.
              </p>
            </div>
          )}

          {/* 6. Autres avantages */}
          <div className="wg-panel">
            <p className="wg-panel-title">6. Autres avantages</p>
            <p className="wg-subsection-title">6.1 Avantages ecologiques</p>
            <p>{OFFER_LITERATURE_COMPLETE.avantagesEcologiques.join(" ")}</p>
            {isComplete && co2AvoidedTonnes25Ans !== null && (
              <>
                <p>
                  Sur 25 ans, votre installation permettrait d'eviter environ{" "}
                  <strong>{co2AvoidedTonnes25Ans.toFixed(0)} tonnes de CO2</strong>, soit environ{" "}
                  {(co2AvoidedTonnes25Ans / 25).toFixed(1)} tonnes chaque annee.
                </p>
                <p className="wg-offer-estimate-note">
                  Estimation basee sur un facteur d'emission indicatif de {CO2_KG_PER_KWH_ESTIMATE} kg CO2/kWh
                  (hypothese non issue du classeur Excel ni du referentiel de regles metier valide) -- a confirmer ou
                  remplacer par Ben avant tout usage commercial engageant.
                </p>
              </>
            )}

            <p className="wg-subsection-title">6.2 La valeur ajoutee de We Green</p>
            <p>{OFFER_LITERATURE_COMPLETE.valeurAjouteeWeGreen.join(" ")}</p>
          </div>

          {/* 7. Signatures */}
          <div className="wg-panel">
            <p className="wg-panel-title">7. Signatures</p>
            <p className="wg-muted">
              {OFFER_LITERATURE_COMPLETE.clauseSignature} {clientName ? `(${clientName})` : ""}
            </p>
            <div className="wg-grid-2" style={{ marginTop: 20 }}>
              <div>
                <p>___________________________</p>
                <p>Signature du Client</p>
              </div>
              <div>
                <p>Nous, We Green, proposons le cadre de travail decrit ci-dessus</p>
                <p>___________________________</p>
                <p>Signature de We Green</p>
              </div>
            </div>
            <p className="wg-muted" style={{ marginTop: 16, textAlign: "center" }}>
              {WE_GREEN_COMPANY_INFO.website}
            </p>
          </div>
        </>
      )}

      {/* Onglet "Donnees" recentre sur la fiche client et les parametres
          modifiables non lies a l'installation (decision 41, 11/09/2026,
          demande explicite de Ben) -- sur le modele de la feuille "Donnees"
          de l'Excel (fiche client + parametres CV/reseau/auto-consommation),
          par opposition a la feuille "Calcul du prix" qui porte les choix
          d'installation (panneaux, onduleurs, batterie, options electriques).
          Les recapitulatifs de catalogue/baremes charges (installation) ont
          ete retires d'ici : ils vivent desormais uniquement dans l'onglet
          "Calcul du prix", la ou les choix se font. */}
      {activeTab === "donnees" && (
        <>
          <p className="wg-muted" style={{ marginTop: 16 }}>
            Donnees modifiables pour cette offre, hors choix d'installation (ceux-ci se font dans l'onglet "Calcul du
            prix") : fiche client et adresse, ratio de production et taux d'auto-consommation, Certificats Verts et
            prix de l'energie. Chaque valeur est suggeree automatiquement quand c'est possible, mais reste modifiable
            manuellement pour cette offre.
          </p>

          <div className="wg-data-grid">
            <div className="wg-panel wg-data-card">
              <h2>Client</h2>
              <label className="wg-field" style={{ marginBottom: 8 }}>
                Type de client
                <select value={clientType} onChange={(e) => setClientType(e.target.value as "particulier" | "societe")}>
                  <option value="particulier">Particulier (delai affiche : 1 mois)</option>
                  <option value="societe">Societe (delai affiche : 3 mois)</option>
                </select>
              </label>
              <label className="wg-field" style={{ marginBottom: 8 }}>
                Nom du client
                <input type="text" value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="Nom / raison sociale" />
              </label>
              <label className="wg-field" style={{ marginBottom: 8 }}>
                Adresse
                <textarea
                  value={clientAddress}
                  onChange={(e) => setClientAddress(e.target.value)}
                  rows={3}
                  placeholder="Rue, numero, code postal, ville"
                  style={{ resize: "vertical", fontFamily: "inherit" }}
                />
              </label>
              <label className="wg-field">
                Langue de l'offre
                <select value={offerLanguage} onChange={(e) => setOfferLanguage(e.target.value as "FR" | "NL")}>
                  <option value="FR">Francais</option>
                  <option value="NL">Nederlands</option>
                </select>
              </label>
            </div>

            {/* Responsable / PM We Green (decision 50, 15/09/2026) : champ
                reel de l'offre (pas juste un affichage informatif de l'import
                Odoo), pre-rempli automatiquement par "Importer depuis Odoo"
                ci-dessous mais modifiable et repris dans l'onglet "Offre". */}
            <div className="wg-panel wg-data-card">
              <h2>Responsable / PM We Green</h2>
              <label className="wg-field" style={{ marginBottom: 8 }}>
                Nom
                <input
                  type="text"
                  value={responsableNom}
                  onChange={(e) => setResponsableNom(e.target.value)}
                  placeholder="Pre-rempli par l'import Odoo, ou saisie manuelle"
                />
              </label>
              <label className="wg-field" style={{ marginBottom: 8 }}>
                Telephone
                <input type="text" value={responsableTelephone} onChange={(e) => setResponsableTelephone(e.target.value)} />
              </label>
              <label className="wg-field">
                Email
                <input type="text" value={responsableEmail} onChange={(e) => setResponsableEmail(e.target.value)} />
              </label>
            </div>

            <div className="wg-panel wg-data-card">
              <h2>Production et auto-consommation</h2>
              <label className="wg-field" style={{ marginBottom: 10 }}>
                Ratio de production (kWh/Wc/an)
                <input
                  type="number"
                  step={0.001}
                  min={0}
                  value={effectiveProductionYield}
                  onChange={(e) => setProductionYieldOverride(Number(e.target.value))}
                  className="wg-input-sm"
                />
              </label>
              <label className="wg-field">
                Taux d'auto-consommation (0 a 1, suggere :{" "}
                {suggestedAutoConsumption !== null ? `${(suggestedAutoConsumption * 100).toFixed(0)}%` : "-"})
                <input
                  type="number"
                  step={0.01}
                  min={0}
                  max={1}
                  value={effectiveAutoConsumption}
                  onChange={(e) => setAutoConsumptionOverride(Number(e.target.value))}
                  className="wg-input-sm"
                />
              </label>
              <p className="wg-muted" style={{ marginTop: 10 }}>
                Le ratio de production se renseigne ici manuellement, y compris depuis un rapport Archelios ou
                Helioscope (voir "Import Archelios / Helioscope" ci-dessous pour recuperer l'image de calepinage).
              </p>
            </div>

            <div className="wg-panel wg-data-card">
              <h2>Certificats Verts et revente</h2>
              {region === Region.BRUXELLES ? (
                <label className="wg-field" style={{ marginBottom: 10 }}>
                  Taux CV (CV/MWh, suggere : {suggestedCvRatePerMwh !== null ? suggestedCvRatePerMwh.toFixed(3) : "-"} pour{" "}
                  {totalPowerKwc.toFixed(2)} kWc)
                  <input
                    type="number"
                    step={0.001}
                    min={0}
                    value={effectiveCvRatePerMwh ?? 0}
                    onChange={(e) => setCvRateOverride(Number(e.target.value))}
                    className="wg-input-sm"
                  />
                </label>
              ) : (
                <p className="wg-muted" style={{ marginBottom: 10 }}>
                  Regime revente simple actif pour {regionLabels[region]} (pas de Certificats Verts).
                </p>
              )}
              <label className="wg-field">
                Prix de rachat CV (EUR)
                <input
                  type="number"
                  step={0.01}
                  value={effectiveCvBuybackPrice}
                  onChange={(e) => setCvBuybackPriceOverride(Number(e.target.value))}
                  className="wg-input-sm"
                />
              </label>
            </div>

            <div className="wg-panel wg-data-card">
              <h2>Prix de l'energie</h2>
              <label className="wg-field" style={{ marginBottom: 10 }}>
                Prix reseau (EUR/kWh)
                <input
                  type="number"
                  step={0.0001}
                  value={effectiveNetworkPrice}
                  onChange={(e) => setNetworkPriceOverride(Number(e.target.value))}
                  className="wg-input-sm"
                />
              </label>
              <label className="wg-field" style={{ marginBottom: 10 }}>
                Inflation annuelle (0 a 1)
                <input
                  type="number"
                  step={0.001}
                  value={effectiveInflationRate}
                  onChange={(e) => setInflationRateOverride(Number(e.target.value))}
                  className="wg-input-sm"
                />
              </label>
              {/* Deplace depuis "Certificats Verts et revente" (decision 42,
                  12/09/2026, demande de Ben) : le ratio de revente/injection
                  est une donnee de prix de l'energie, pas specifique aux CV
                  (s'applique aussi en Wallonie/Flandre, sans CV). Libelle
                  clarifie a sa demande : peut se lire comme un pourcentage du
                  prix d'achat reseau, ou etre remplace par une valeur libre
                  (ex : tarif d'injection contractuel connu). */}
              <label className="wg-field">
                Ratio prix de revente / injection (% du prix d'achat, ou valeur libre)
                <input
                  type="number"
                  step={0.01}
                  value={effectiveResalePriceRatio}
                  onChange={(e) => setResalePriceRatioOverride(Number(e.target.value))}
                  className="wg-input-sm"
                />
              </label>
            </div>

            <div className="wg-panel wg-data-card">
              <h2>Import Odoo</h2>
              <p className="wg-muted">
                Phase 3 (decisions 43/44, 12/09/2026) : recupere le client, l'adresse de facturation, l'adresse de
                chantier (livraison, si differente), le responsable (vendeur Odoo) et les articles d'un devis Odoo
                existant, sur le meme principe que l'import deja utilise dans le Briefing de chantier. Necessite que
                l'Edge Function <code>odoo-import</code> soit deployee avec ses secrets Odoo cote Ben -- voir le
                commentaire d'en-tete de <code>supabase/functions/odoo-import/index.ts</code>. Aucune connexion
                requise (aligne sur le mecanisme du Briefing : la cle anon suffit, la cle API Odoo ne quitte jamais
                le serveur).
              </p>
              <div className="wg-inline-group" style={{ marginBottom: 8 }}>
                <label className="wg-field">
                  Reference du devis Odoo
                  <input
                    type="text"
                    value={odooReference}
                    onChange={(e) => setOdooReference(e.target.value)}
                    placeholder="Ex : S00123"
                  />
                </label>
                <button
                  type="button"
                  className="wg-btn-primary"
                  disabled={odooLoading || !odooReference.trim()}
                  onClick={handleImportOdoo}
                >
                  {odooLoading ? "Import en cours..." : "Importer depuis Odoo"}
                </button>
              </div>

              {odooError && (
                <p className="wg-muted" style={{ color: "var(--wg-danger, #b3261e)", marginTop: 8 }}>
                  {odooError}
                </p>
              )}

              {odooResult && (
                <div style={{ marginTop: 12 }}>
                  <p>
                    Devis <strong>{odooResult.devis.reference}</strong> ({odooResult.devis.statut}) --{" "}
                    <a href={odooResult.devis.lienOdoo} target="_blank" rel="noreferrer">
                      ouvrir dans Odoo
                    </a>
                  </p>
                  {odooResult.adresseLivraison && (
                    <p className="wg-muted">
                      Adresse de chantier distincte de la facturation :{" "}
                      {formatOdooAddress(odooResult.adresseLivraison).replace(/\n/g, ", ")}
                    </p>
                  )}
                  {odooResult.responsable && (
                    <p className="wg-muted">
                      Responsable (vendeur Odoo) : {odooResult.responsable.nom ?? "?"}
                      {odooResult.responsable.telephone ? ` · ${odooResult.responsable.telephone}` : ""}
                      {odooResult.responsable.email ? ` · ${odooResult.responsable.email}` : ""} -- repris dans la fiche
                      "Responsable / PM We Green" ci-dessus (modifiable si besoin).
                    </p>
                  )}
                  {summarizeOdooArticles(odooResult.articles).length > 0 && (
                    <p className="wg-muted">Detecte : {summarizeOdooArticles(odooResult.articles).join(" · ")}</p>
                  )}
                  <p className="wg-muted" style={{ fontStyle: "italic" }}>
                    {odooResult.avertissement}
                  </p>

                  {/* Rapprochement articles Odoo -> catalogue de l'offre
                      (decision 50, 15/09/2026) : BDC = devis client confirme
                      (sale.order), meme objet que l'import ci-dessus -- pas
                      de source de donnees supplementaire a interroger. */}
                  {odooArticleMatch && (
                    <div style={{ marginTop: 10 }}>
                      <p style={{ marginBottom: 4 }}>
                        <strong>Rapprochement avec le catalogue :</strong>
                      </p>
                      <ul style={{ margin: "4px 0 8px 18px", fontSize: 13 }}>
                        {odooArticleMatch.panelSelections.map((sel) => {
                          const p = panels.find((x) => x.id === sel.productId);
                          return (
                            <li key={`pv-${sel.key}`}>
                              Panneaux : {sel.qty}x {p ? `${p.brand} ${p.modelName}` : sel.productId}
                            </li>
                          );
                        })}
                        {odooArticleMatch.inverterSelections.map((sel) => {
                          const p = inverters.find((x) => x.id === sel.productId);
                          return (
                            <li key={`inv-${sel.key}`}>
                              Onduleur : {sel.qty}x {p ? `${p.brand} ${p.modelName}` : sel.productId}
                            </li>
                          );
                        })}
                        {odooArticleMatch.batteryId &&
                          (() => {
                            const b = batteries.find((x) => x.id === odooArticleMatch.batteryId);
                            return <li>Batterie : {b ? `${b.brand} ${b.modelName}` : odooArticleMatch.batteryId}</li>;
                          })()}
                        {odooArticleMatch.panelSelections.length === 0 &&
                          odooArticleMatch.inverterSelections.length === 0 &&
                          !odooArticleMatch.batteryId && <li>Aucun article rapproche automatiquement.</li>}
                      </ul>
                      {odooArticleMatch.unmatched.length > 0 && (
                        <p className="wg-banner-warning" style={{ fontSize: 13 }}>
                          {odooArticleMatch.unmatched.map((msg, i) => (
                            <span key={i} style={{ display: "block" }}>
                              {msg}
                            </span>
                          ))}
                        </p>
                      )}

                      {!odooOverwriteConfirm && (
                        <button type="button" className="wg-btn-primary" onClick={handleUseOdooArticlesClick}>
                          Utiliser ces articles dans le calcul du prix
                        </button>
                      )}

                      {odooOverwriteConfirm && (
                        <div className="wg-banner-warning" style={{ marginTop: 6 }}>
                          <p style={{ margin: "0 0 8px" }}>
                            Des panneaux, onduleurs ou une batterie sont deja selectionnes dans "Calcul du prix". Les
                            remplacer par les articles detectes dans ce devis Odoo ?
                          </p>
                          <div style={{ display: "flex", gap: 8 }}>
                            <button type="button" className="wg-btn-primary" onClick={applyOdooArticlesToCalcul}>
                              Ecraser et appliquer
                            </button>
                            <button type="button" className="wg-btn-link" onClick={() => setOdooOverwriteConfirm(false)}>
                              Annuler
                            </button>
                          </div>
                        </div>
                      )}

                      {odooApplyMessage && (
                        <p className="wg-muted" style={{ marginTop: 6 }}>
                          {odooApplyMessage}
                        </p>
                      )}
                    </div>
                  )}

                  {odooResult.lignes.length > 0 && (
                    <table className="wg-sheet" style={{ marginTop: 6 }}>
                      <thead>
                        <tr>
                          <th>Ligne du devis Odoo</th>
                          <th>Qte</th>
                          <th>Prix unitaire</th>
                          <th>Sous-total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {odooResult.lignes.map((l, i) => (
                          <tr key={i}>
                            <td>{l.libelle ?? "(sans libelle)"}</td>
                            <td className="wg-num">{l.quantite}</td>
                            <td className="wg-num">{l.prixUnitaire.toFixed(2)} EUR</td>
                            <td className="wg-num">{l.sousTotal.toFixed(2)} EUR</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>

            <div className="wg-panel wg-data-card">
              <h2>Import Archelios / Helioscope</h2>
              <p className="wg-muted">
                Deposez le rapport PDF Archelios ou Helioscope : la page de calepinage / implantation est detectee et
                extraite automatiquement (meme mecanisme que dans le Briefing de chantier), et reprise dans l'offre.
                Vous pouvez choisir une autre page si la detection ne correspond pas. Le ratio de production reste a
                renseigner manuellement ci-dessus.
              </p>

              {archeliosError && <p className="wg-banner-warning">{archeliosError}</p>}

              {!archeliosImage && (
                <label
                  className="wg-dropzone"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const file = e.dataTransfer.files?.[0];
                    if (file) void handleArcheliosFile(file);
                  }}
                >
                  {archeliosLoading ? (
                    "Analyse du PDF..."
                  ) : (
                    <>
                      Glissez-deposez le rapport PDF Archelios / Helioscope ici, ou cliquez pour parcourir
                      <br />
                      <strong>Fichier PDF uniquement</strong>
                    </>
                  )}
                  <input
                    type="file"
                    accept="application/pdf"
                    hidden
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void handleArcheliosFile(file);
                      e.target.value = "";
                    }}
                  />
                </label>
              )}

              {archeliosImage && !archeliosBrowsing && (
                <div>
                  <img
                    src={archeliosImage.dataUrl}
                    alt="Calepinage / implantation photovoltaique"
                    style={{ maxWidth: 320, border: "1px solid #d7e0da", borderRadius: 8, display: "block", marginBottom: 10 }}
                  />
                  <p className="wg-muted">
                    {archeliosImage.auto
                      ? `${archeliosImage.sourceType} detecte automatiquement -- page ${archeliosImage.pageNumber}/${archeliosImage.numPages} de ${archeliosImage.sourceFilename}.`
                      : `Page ${archeliosImage.pageNumber}/${archeliosImage.numPages} choisie manuellement dans ${archeliosImage.sourceFilename}.`}{" "}
                    Inseree dans l'offre, section "Votre installation photovoltaique".
                  </p>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button type="button" disabled={archeliosLoading} onClick={openArcheliosBrowser}>
                      Choisir une autre page
                    </button>
                    <button type="button" className="wg-btn-link" onClick={removeArcheliosImage}>
                      Retirer / deposer un autre fichier
                    </button>
                  </div>
                </div>
              )}

              {archeliosBrowsing && (
                <div>
                  <p className="wg-muted">
                    {archeliosFilename} -- page {archeliosCurrentPage} / {archeliosNumPages}. Choisissez la page
                    contenant le calepinage ou le rendu d'implantation.
                  </p>
                  {archeliosPreviewDataUrl && (
                    <img
                      src={archeliosPreviewDataUrl}
                      alt={`Apercu page ${archeliosCurrentPage}`}
                      style={{ maxWidth: 320, border: "1px solid #d7e0da", borderRadius: 8, display: "block", marginBottom: 10 }}
                    />
                  )}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      disabled={archeliosLoading || archeliosCurrentPage <= 1}
                      onClick={() => void goToArcheliosPage(archeliosCurrentPage - 1)}
                    >
                      Page precedente
                    </button>
                    <button
                      type="button"
                      disabled={archeliosLoading || archeliosCurrentPage >= archeliosNumPages}
                      onClick={() => void goToArcheliosPage(archeliosCurrentPage + 1)}
                    >
                      Page suivante
                    </button>
                    <button
                      type="button"
                      className="wg-btn-primary"
                      disabled={archeliosLoading}
                      onClick={confirmArcheliosBrowsedPage}
                    >
                      Utiliser cette page
                    </button>
                    <button type="button" className="wg-btn-link" onClick={() => setArcheliosBrowsing(false)}>
                      Annuler
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {activeTab === "backoffice" && (
        <>
          <p className="wg-muted" style={{ marginTop: 16 }}>
            Edition directe des tables catalogue/parametres (produits, marges, commission, deplacement, cablage,
            regions, CV, main-d'oeuvre...). Necessite une connexion. Hors perimetre ici : les offres elles-memes
            (offers/offer_lines), pas encore sauvegardees en base.
          </p>

          {authLoading && <p className="wg-muted">Verification de la session...</p>}

          {!authLoading && !session && <LoginPanel />}

          {!authLoading && session && (
            <div className="wg-panel">
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
                <span className="wg-banner-success">Connecte : {session.user.email}</span>
                <button onClick={() => void signOut()}>Se deconnecter</button>
              </div>
              <label className="wg-field" style={{ maxWidth: 420 }}>
                Table a editer
                <select value={selectedAdminTable} onChange={(e) => setSelectedAdminTable(e.target.value)}>
                  {ADMIN_TABLES.map((t) => (
                    <option key={t.id ?? t.table} value={t.id ?? t.table}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>
              <div style={{ marginTop: 16 }}>
                {ADMIN_TABLES.filter((t) => (t.id ?? t.table) === selectedAdminTable).map((t) => (
                  <AdminTableEditor key={t.id ?? t.table} config={t} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
