/**
 * Cles de repartition pour les marches publics. Port fidele de
 * moteur-calcul/repartition_engine.py (feuille 'Calcul detaille', colonnes
 * I/J/K, et feuille 'Offre metre detaille').
 *
 *     poids(ligne)      = (cout(ligne) * marge) / prix_total_projet
 *     poids_masque      = somme des poids(ligne) pour les lignes au toggle "Poste ?" = NON
 *     prix_affiche(ligne, si OUI) = cout(ligne) * marge / (1 - poids_masque)
 *
 * Le classeur utilise systematiquement la marge PV/electricite (K12) dans ce
 * calcul, quelle que soit la categorie reelle de la ligne : simplification
 * deja presente dans l'Excel, reproduite ici telle quelle.
 */

import type { OfferLine } from "./types";
import { lineTotalCost } from "./types";

export interface RepartitionLineResult {
  line: OfferLine;
  /** Part de cette ligne dans le prix total du projet. */
  weight: number;
  /** null si la ligne est masquee (repartitionPoste = false). */
  displayedPrice: number | null;
}

/** Reproduit I_row = (G_row * marge) / J66. */
export function lineWeight(lineCost: number, marginMultiplier: number, totalProjectPrice: number): number {
  if (totalProjectPrice === 0) return 0;
  return (lineCost * marginMultiplier) / totalProjectPrice;
}

/** Reproduit Q17 = SUMIF(D:D, "=NON", I:I). */
export function hiddenWeight(weightsOfHiddenLines: number[]): number {
  return weightsOfHiddenLines.reduce((a, b) => a + b, 0);
}

/**
 * Reproduit J_row = G_row * marge * (1 + (Q17/(1-Q17))), algebriquement egal
 * a G_row * marge / (1 - Q17) : la ligne visible absorbe, au prorata de son
 * propre poids, tout le poids des lignes masquees.
 */
export function displayedPrice(lineCost: number, marginMultiplier: number, hiddenWeightTotal: number): number {
  if (hiddenWeightTotal >= 1) {
    throw new Error("Le poids masque total atteint ou depasse 100% du projet : impossible de redistribuer.");
  }
  return lineCost * marginMultiplier * (1 + hiddenWeightTotal / (1 - hiddenWeightTotal));
}

/**
 * Calcule, pour chaque ligne d'une offre marchee "marche public", son poids
 * dans le projet et, si elle est visible (repartitionPoste = true), son prix
 * affiche redistribue.
 *
 * Verification de coherence attendue par l'appelant : la somme des
 * displayedPrice non-null doit etre egale au prix total reel du projet (aux
 * arrondis pres).
 */
export function applyRepartition(
  lines: OfferLine[],
  marginMultiplier: number,
  totalProjectPrice: number,
): RepartitionLineResult[] {
  const weights = lines.map((l) => lineWeight(lineTotalCost(l), marginMultiplier, totalProjectPrice));
  const hidden = hiddenWeight(weights.filter((_, i) => !lines[i].repartitionPoste));

  return lines.map((line, i) => {
    const weight = weights[i];
    if (!line.repartitionPoste) {
      return { line, weight, displayedPrice: null };
    }
    const price = displayedPrice(lineTotalCost(line), marginMultiplier, hidden);
    return { line, weight, displayedPrice: price };
  });
}
