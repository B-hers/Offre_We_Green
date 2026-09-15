/**
 * Moteur de marge. Port fidele de moteur-calcul/margin_engine.py.
 *
 * Reproduit le mecanisme trouve dans 'Calcul du prix' + 'Marge' :
 * - une marge SUGGEREE, fonction degressive de la puissance totale installee
 *   (bareme a paliers, editable par l'administrateur) ;
 * - une marge APPLIQUEE, une constante saisie/modifiable par le PM (K12 pour
 *   PV/electricite, K21 pour batterie/deplacement), independante de la marge
 *   suggeree (ecart confirme volontaire par Ben le 02/09/2026).
 *
 * Les deux valeurs sont toujours calculees et exposees ensemble : rien ne doit
 * jamais copier automatiquement la marge suggeree dans la marge appliquee.
 */

import type { MarginCurvePoint } from "./types";

/**
 * Reproduit VLOOKUP(ROUNDDOWN(power_kwc, 0), A2:B1502, 2, 0) de la feuille Marge :
 * la marge suggeree ne depend que de la puissance totale installee, arrondie a
 * l'entier inferieur, recherchee dans le bareme (courbe croissante en
 * puissance : "dernier palier <= a la valeur").
 */
export function suggestedMarginMultiplier(powerKwc: number, curve: MarginCurvePoint[]): number {
  if (curve.length === 0) {
    throw new Error("La courbe de marge est vide : rien a suggerer.");
  }

  const sorted = [...curve].sort((a, b) => a.powerKwc - b.powerKwc);
  const target = Math.trunc(powerKwc); // ROUNDDOWN(power_kwc, 0)

  // bisect_right(powers, target) - 1 : dernier index dont powerKwc <= target.
  let idx = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].powerKwc <= target) {
      idx = i;
    } else {
      break;
    }
  }
  if (idx < 0) {
    // puissance inferieure au premier palier connu : on retient le premier palier
    idx = 0;
  }
  return sorted[idx].suggestedMarginMultiplier;
}

/**
 * Reproduit H = (G * K) - G de 'Calcul du prix' : la marge en euros generee
 * par un cout de ligne et un multiplicateur applique (K12 ou K21).
 */
export function appliedMarginAmount(cost: number, appliedMultiplier: number): number {
  return cost * appliedMultiplier - cost;
}

/**
 * Commission PM calculee sur le total des marges du projet, au taux decide
 * par Ben (25% par defaut, ajustable entre 10% et 30%).
 */
export function commissionAmount(totalMargin: number, commissionRate: number): number {
  return totalMargin * commissionRate;
}
