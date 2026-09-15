/**
 * Orchestrateur de prix d'offre. Port fidele de moteur-calcul/pricing_engine.py
 * (equivalent generalise de la feuille 'Calcul du prix').
 *
 * Chaque ligne d'offre porte deja son cout et son prix de vente calcules par
 * le module competent :
 * - lignes standard (PV, onduleur, structure, MO, electricite...) : cout x K12
 * - lignes batterie / deplacement : cout x K21 (voir batteryEngine, travelCost)
 */

import type { Offer, OfferLine } from "./types";
import { lineTotalCost } from "./types";

export interface OfferTotals {
  totalCost: number;
  totalMargin: number;
  subtotalWithMargin: number;
  commission: number;
  totalHtva: number;
  vatAmount: number;
  totalTtc: number;
}

export const CATEGORIES_MARGIN_BATTERY_TRAVEL = new Set(["Batterie", "Deplacement", "Déplacement"]);

/**
 * Applique la marge appropriee a une ligne (K12 pour la plupart des postes,
 * K21 pour batterie et deplacement), sauf si le prix a deja ete fixe
 * manuellement par le PM (manuallyOverridden = true) : dans ce cas le prix
 * n'est jamais recalcule, seule sa mise en evidence visuelle est un probleme
 * d'interface, pas de moteur de calcul.
 */
export function priceOfferLine(line: OfferLine, marginPvElectrical: number, marginBatteryTravel: number): OfferLine {
  if (line.manuallyOverridden) return line;

  const multiplier = CATEGORIES_MARGIN_BATTERY_TRAVEL.has(line.category) ? marginBatteryTravel : marginPvElectrical;
  const cost = lineTotalCost(line);
  const marginAmount = cost * multiplier - cost;
  line.marginAppliedAmount = marginAmount;
  line.unitPrice = line.quantity ? (cost + marginAmount) / line.quantity : 0;
  return line;
}

export function computeOfferTotals(offer: Offer, commissionRate: number): OfferTotals {
  for (const line of offer.lines) {
    priceOfferLine(line, offer.marginPvElectrical, offer.marginBatteryTravel);
  }

  const totalCost = offer.lines.reduce((sum, l) => sum + lineTotalCost(l), 0);
  const totalMargin = offer.lines.reduce((sum, l) => sum + l.marginAppliedAmount, 0);
  const subtotalWithMargin = totalCost + totalMargin;
  const commission = totalMargin * commissionRate;
  const totalHtva = subtotalWithMargin + commission;
  const vatAmount = totalHtva * offer.vatRate;
  const totalTtc = totalHtva + vatAmount;

  return { totalCost, totalMargin, subtotalWithMargin, commission, totalHtva, vatAmount, totalTtc };
}
