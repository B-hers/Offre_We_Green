/**
 * Simulation de rentabilite sur 25 ans. Port fidele de moteur-calcul/regime_engine.py
 * (feuille 'Financement', colonnes AC a AK, partie active du classeur -- le
 * module de pret "Green Load" n'est pas repris, decision de Ben du 04/09/2026).
 *
 * Le classeur Excel dupliquait ce calcul en plusieurs blocs de formules quasi
 * identiques, un par regime regional. Ce module le reecrit comme UNE fonction
 * parametree par regime.
 *
 * Formules confirmees en inspectant directement les cellules du classeur :
 * - rendement(n) = rendement(n-1) - degradation_pct_par_an
 * - production(n) = production_rendement_100 * rendement(n) / 100
 * - prix_reseau(n) = prix_reseau(n-1) * (1 + inflation)
 * - prix_revente(n) = prix_revente(n-1) * (1 + inflation)
 * - revenu_auto_consommation(n) = production(n) * taux_auto_conso * prix_reseau(n)
 * - regime CV_BRACKET (Bruxelles) : + revenu CV + revenu revente de l'excedent
 * - regime RESALE_FLAT (Flandre, Wallonie) : + revenu revente de l'excedent
 *   uniquement, pas de CV, pas de taxe.
 *
 * Correction du 04/09/2026 : le 3e bloc de formules ("taxe prosumer") du
 * classeur n'etait utilise que par la feuille "Offre Wallonie<=10kVA",
 * supprimee du perimetre cible. Aucune taxe prosumer n'est modelisee ici.
 */

import { Region, RevenueRegime, type CvBracket } from "./types";

export interface CashflowYear {
  year: number;
  yieldPct: number;
  productionKwh: number;
  networkPrice: number;
  revenueAutoConsumption: number;
  revenueRegimeSpecific: number;
  cashflowCumulative: number;
}

export interface RegimeParameters {
  regime: RevenueRegime;
  /** Donnees!G16 (0,55 ou 0,80 avec batterie, override possible). */
  autoConsumptionRate: number;
  /** Donnees!F16, 0,03. */
  inflationRate: number;
  /** Depend du modele de panneau choisi. */
  panelDegradationPctPerYear: number;
  /** Donnees!E16, 0,35 EUR/kWh. */
  initialNetworkPrice: number;
  /** Donnees!H16, 25% du prix reseau. */
  initialResalePrice: number;
  /** Requis seulement pour CV_BRACKET. */
  cvRatePerMwh?: number;
  cvPricePerCertificate?: number;
}

export function projectCashflow(
  investment: number,
  productionAt100PctYieldKwh: number,
  params: RegimeParameters,
  years = 25,
): CashflowYear[] {
  const results: CashflowYear[] = [];
  let cumulative = -investment;
  let yieldPct = 100.0;
  let networkPrice = params.initialNetworkPrice;
  let resalePrice = params.initialResalePrice;

  for (let year = 1; year <= years; year++) {
    if (year > 1) {
      yieldPct -= params.panelDegradationPctPerYear;
      networkPrice *= 1 + params.inflationRate;
      resalePrice *= 1 + params.inflationRate;
    }

    const production = (productionAt100PctYieldKwh * yieldPct) / 100;
    const revenueAuto = production * params.autoConsumptionRate * networkPrice;

    let revenueSpecific: number;
    if (params.regime === RevenueRegime.CV_BRACKET) {
      const revenueCv = (production / 1000) * (params.cvRatePerMwh ?? 0) * (params.cvPricePerCertificate ?? 0);
      const revenueResale = (1 - params.autoConsumptionRate) * production * resalePrice;
      revenueSpecific = revenueCv + revenueResale;
    } else if (params.regime === RevenueRegime.RESALE_FLAT) {
      revenueSpecific = (1 - params.autoConsumptionRate) * production * resalePrice;
    } else {
      throw new Error(`Regime non gere : ${params.regime}`);
    }

    cumulative += revenueAuto + revenueSpecific;
    results.push({
      year,
      yieldPct,
      productionKwh: production,
      networkPrice,
      revenueAutoConsumption: revenueAuto,
      revenueRegimeSpecific: revenueSpecific,
      cashflowCumulative: cumulative,
    });
  }
  return results;
}

/**
 * Reproduit XLOOKUP(power_kwc, bornes_superieures, taux, , 1, 1) sur le
 * bareme Bruxelles (feuille Donnees, lignes 3 a 7) : recherche, parmi les
 * bornes superieures de palier (5, 36, 100, 250 kWc), la plus petite qui soit
 * >= a la puissance du projet, et retourne le taux CV/MWh associe.
 */
export function lookupCvRateBruxelles(powerKwc: number, brackets: CvBracket[]): number {
  const sorted = brackets
    .filter((b) => b.powerMaxKwc !== null)
    .sort((a, b) => (a.powerMaxKwc as number) - (b.powerMaxKwc as number));

  // bisect_left : premier index dont powerMaxKwc >= powerKwc.
  let idx = sorted.length;
  for (let i = 0; i < sorted.length; i++) {
    if ((sorted[i].powerMaxKwc as number) >= powerKwc) {
      idx = i;
      break;
    }
  }

  if (idx >= sorted.length) {
    // au-dela du dernier palier borne : on retombe sur le palier ">250" (sans borne haute)
    const unbounded = brackets.filter((b) => b.powerMaxKwc === null);
    if (unbounded.length > 0) return unbounded[0].rateCvPerMwh;
    throw new Error(`Aucun palier CV ne couvre ${powerKwc} kWc.`);
  }
  return sorted[idx].rateCvPerMwh;
}

/**
 * Reproduit le choix de bloc de formules fait implicitement par la region du
 * projet. Bruxelles a son propre regime (Certificats Verts) ; Flandre et
 * Wallonie partagent le meme regime simple, quelle que soit la puissance
 * installee.
 */
export function resolveRegimeForRegion(region: Region): RevenueRegime {
  if (region === Region.BRUXELLES) return RevenueRegime.CV_BRACKET;
  if (region === Region.FLANDRE || region === Region.WALLONIE) return RevenueRegime.RESALE_FLAT;
  throw new Error(`Region non geree : ${region}`);
}
