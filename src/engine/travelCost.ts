/**
 * Forfait deplacement technicien. Port fidele de moteur-calcul/travel_cost.py.
 *
 * Regle decidee par Ben le 02/09/2026 (remplace le calcul au km trouve dans
 * l'Excel, 0,8 EUR/km) : forfait de base 100 EUR, majore si le chantier est a
 * plus de 50 km de Bruxelles, majore aussi si l'installation depasse 10 kWc.
 * Les deux majorations sont cumulables.
 */

import type { TravelCostRule } from "./types";

export function travelCost(distanceFromBrusselsKm: number, installedPowerKwc: number, rule: TravelCostRule): number {
  let total = rule.baseFee;
  if (distanceFromBrusselsKm > rule.distanceThresholdKm) {
    total += rule.distanceSurcharge;
  }
  if (installedPowerKwc > rule.powerThresholdKwc) {
    total += rule.powerSurcharge;
  }
  return total;
}
