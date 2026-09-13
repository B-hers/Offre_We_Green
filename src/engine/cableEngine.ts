/**
 * Dimensionnement de cable AC par chute de tension. Port fidele de
 * moteur-calcul/cable_engine.py (feuille 'Elec', colonnes S a AC).
 *
 * Le catalogue de sections (modele/reference/prix au metre) reste une donnee
 * de base de donnees (table `elec_components`, component_type='cable_ac') :
 * ce module ne fait que le calcul, jamais le choix arbitraire d'une section.
 */

export interface CableSizingParameters {
  maxVoltageDropPct: number; // AD3, defaut 0.02
  resistivityCu: number; // AD4 si cuivre, defaut 0.0237
  resistivityAl: number; // AD4 si aluminium, defaut 0.0376
  defaultCosPhi: number; // AF3, defaut 0.9
}

export const DEFAULT_CABLE_SIZING_PARAMETERS: CableSizingParameters = {
  maxVoltageDropPct: 0.02,
  resistivityCu: 0.0237,
  resistivityAl: 0.0376,
  defaultCosPhi: 0.9,
};

/**
 * Reproduit Y4 = (X4*W4*$AD$4*$AF$3*IF(V4="Mono",2,1)/($AD$3*230)) / PRODUCT($AE$6:$AE$8).
 * Le resultat est une "section theorique minimale" a comparer, via
 * selectCableSection, a la table des sections normalisees disponibles.
 */
export function voltageDropIndex(
  currentA: number,
  lengthM: number,
  isMono: boolean,
  params: CableSizingParameters,
  conductor: "Cu" | "Al" = "Cu",
  correctionKm = 1.0,
  correctionKn = 1.0,
  correctionKt = 1.0,
): number {
  const rho = conductor === "Cu" ? params.resistivityCu : params.resistivityAl;
  const phaseFactor = isMono ? 2 : 1;
  const numerator = currentA * lengthM * rho * params.defaultCosPhi * phaseFactor;
  const denominator = params.maxVoltageDropPct * 230 * (correctionKm * correctionKn * correctionKt);
  return numerator / denominator;
}

/**
 * Reproduit le XLOOKUP(Y4, sections, sections, , 1, 1) : la plus petite
 * section normalisee superieure ou egale a la section theorique calculee.
 */
export function selectCableSection(theoreticalSection: number, availableSectionsMm2: number[]): number {
  const candidates = availableSectionsMm2.filter((s) => s >= theoreticalSection).sort((a, b) => a - b);
  if (candidates.length === 0) {
    throw new Error(
      `Aucune section disponible >= ${theoreticalSection.toFixed(2)} mm² : catalogue de cables a completer.`,
    );
  }
  return candidates[0];
}

/**
 * Cablage DC (panneaux -> onduleur) : contrairement au cablage AC, le
 * referentiel des regles metier (section 8) ne documente aucune formule de
 * chute de tension pour le DC, seulement une "table de prix au metre par
 * gamme/section" (table `elec_components`, component_type='cable_dc') et
 * une "table d'ampacite (courant admissible en fonction de la section)"
 * (component_type='cable_dc_ampacite'). Le dimensionnement DC est donc un
 * choix par ampacite (section normalisee minimale dont le courant admissible
 * couvre le courant reel), pas un calcul de chute de tension comme pour l'AC.
 *
 * Reproduit XLOOKUP(courant, ampacites, sections, , 1, 1) : la plus petite
 * section normalisee dont le courant admissible est >= au courant reel.
 */
export function selectDcCableSectionByAmpacity(
  currentA: number,
  ampacityTable: Array<{ sectionMm2: number; currentMaxA: number }>,
): number {
  const candidates = ampacityTable
    .filter((entry) => entry.currentMaxA >= currentA)
    .sort((a, b) => a.sectionMm2 - b.sectionMm2);
  if (candidates.length === 0) {
    throw new Error(
      `Aucune section DC disponible pour un courant de ${currentA.toFixed(1)}A : table d'ampacite a completer.`,
    );
  }
  return candidates[0].sectionMm2;
}
