/**
 * Moteur de composition des batteries. Port fidele de moteur-calcul/battery_engine.py.
 *
 * Confirme par Ben le 02/09/2026 : ce mecanisme (module + chargeur eventuel +
 * prime BEBAT au poids) est un cas unique aux batteries, pas de logique
 * generique a prevoir pour les autres familles de produits.
 */

import type { BatteryComposition } from "./types";

export interface BatteryPriceBreakdown {
  /** AC : somme des composants (module, chargeur, BEBAT, MO, ...). */
  costBeforeMargin: number;
  /** AD : (AC * K21) - AC. */
  marginAmount: number;
  /** AE : AC + AD. */
  priceWithMargin: number;
  /** AF : AD * taux de commission. */
  commissionAmount: number;
  /** AG : AE + AF. */
  finalPrice: number;
}

/** Prime BEBAT = masse (kg) x taux (2,89 EUR/kg par defaut, parametre en base). */
export function bebatPremium(massKg: number, bebatRatePerKg: number): number {
  return massKg * bebatRatePerKg;
}

/**
 * Reproduit AC4 = SUM(W4:AB4) : cout module + cout chargeur + prime BEBAT
 * + main-d'oeuvre + energy meter + tableau/disjoncteur.
 */
export function batteryCostBeforeMargin(composition: BatteryComposition, bebatRatePerKg: number): number {
  return (
    composition.moduleCost +
    composition.chargerCost +
    bebatPremium(composition.massKg, bebatRatePerKg) +
    composition.laborCost +
    composition.energyMeterCost +
    composition.panelCost
  );
}

export function priceBattery(
  composition: BatteryComposition,
  bebatRatePerKg: number,
  marginBatteryTravel: number, // K21
  commissionRate: number,
): BatteryPriceBreakdown {
  const cost = batteryCostBeforeMargin(composition, bebatRatePerKg);
  const margin = cost * marginBatteryTravel - cost;
  const priceWithMargin = cost + margin;
  const commission = margin * commissionRate;
  const finalPrice = priceWithMargin + commission;
  return {
    costBeforeMargin: cost,
    marginAmount: margin,
    priceWithMargin,
    commissionAmount: commission,
    finalPrice,
  };
}
