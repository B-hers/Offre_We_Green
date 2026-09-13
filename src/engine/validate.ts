/**
 * Script de validation : rejoue EXACTEMENT le meme cas de reference que
 * moteur-calcul/validate_against_excel.py (memes entrees, memes valeurs Excel
 * attendues) avec le PORT TYPESCRIPT du moteur.
 *
 * Objectif : prouver que le portage Python -> TypeScript n'a introduit aucun
 * ecart (arrondi, ordre des operations, troncature...) avant de brancher ce
 * moteur sur l'application reelle. A rejouer a chaque modification d'un
 * fichier de src/engine/.
 *
 * Lancer avec : npx tsx src/engine/validate.ts
 */

import { RevenueRegime, type MarginCurvePoint, type BatteryComposition, type CvBracket, type TravelCostRule } from "./types";
import { suggestedMarginMultiplier, appliedMarginAmount } from "./marginEngine";
import { priceBattery } from "./batteryEngine";
import { DEFAULT_CABLE_SIZING_PARAMETERS, voltageDropIndex, selectCableSection } from "./cableEngine";
import { projectCashflow, lookupCvRateBruxelles, type RegimeParameters } from "./regimeEngine";
import { travelCost } from "./travelCost";
import { lineWeight, displayedPrice } from "./repartitionEngine";
import {
  roofLaborCost,
  pickElectricianRateTier,
  electricianLaborCost,
  cablingForfaitCost,
  electricalCertificationPrice,
  cabineDecouplagePrice,
  grdFee,
  emsLicenseFee,
  transportTripsForPanels,
} from "./laborEngine";

let checksPassed = 0;
let checksFailed = 0;

function check(label: string, actual: number, expected: number, relTol = 1e-4): void {
  const ok = Math.abs(actual - expected) <= relTol * Math.max(Math.abs(actual), Math.abs(expected), 1e-9);
  const status = ok ? "OK  " : "FAIL";
  console.log(`[${status}] ${label} : calcule=${actual}  attendu(Excel)=${expected}`);
  if (ok) checksPassed++;
  else checksFailed++;
}

console.log("=".repeat(78));
console.log("1. Marge suggeree (bareme degressif, feuille Marge)");
console.log("=".repeat(78));
const curve: MarginCurvePoint[] = [
  { powerKwc: 6, suggestedMarginMultiplier: 1.535 },
  { powerKwc: 7, suggestedMarginMultiplier: 1.525 },
  { powerKwc: 8, suggestedMarginMultiplier: 1.515 },
  { powerKwc: 9, suggestedMarginMultiplier: 1.4983333333333333 },
  { powerKwc: 10, suggestedMarginMultiplier: 1.4816666666666667 },
];
// Calcul du prix!K16 = Marge!H2 = VLOOKUP(ROUNDDOWN(8,24;0);...) = 1,515
check("marge suggeree pour 8,24 kWc", suggestedMarginMultiplier(8.24, curve), 1.515);

console.log();
console.log("=".repeat(78));
console.log("2. Marge appliquee (K12) sur la ligne PV");
console.log("=".repeat(78));
// Calcul detaille!G11 = 1036,798 (cout total PV) ; Calcul du prix!H10 = 311,0394 (marge PV, K12=1,3)
check("marge PV (K12=1,3) sur cout 1036,798", appliedMarginAmount(1036.798, 1.3), 311.0394000000001);

console.log();
console.log("=".repeat(78));
console.log("3. Composition batterie + prime BEBAT (Deye SE-G5.1 5 kWh)");
console.log("=".repeat(78));
const battery: BatteryComposition = {
  productId: "deye-se-g5.1-5kwh",
  moduleCost: 700,
  chargerCost: 0,
  massKg: 45,
  laborCost: 150,
  energyMeterCost: 120,
  panelCost: 40,
};
// Constantes reellement en vigueur dans le classeur audite (K21=1,45 ; commission=10%,
// 'Onduleurs & batteries'!J44) : utilisees ici pour la validation, PAS pour la production
// (ou le taux de commission reel decide par Ben est 25%, borne 10-30%).
const breakdown = priceBattery(battery, 2.89, 1.45, 0.1);
check("prix hors marge (AC4)", breakdown.costBeforeMargin, 1140.05);
check("marge (AD4)", breakdown.marginAmount, 513.0225);
check("prix avec marge (AE4)", breakdown.priceWithMargin, 1653.0725);
check("commission (AF4)", breakdown.commissionAmount, 51.30225000000001);
check("prix final (AG4)", breakdown.finalPrice, 1704.37475);

console.log();
console.log("=".repeat(78));
console.log("4. Dimensionnement de cable AC (chute de tension, feuille Elec ligne 4)");
console.log("=".repeat(78));
const y4 = voltageDropIndex(41.669999999999995, 20, false /* V4 = "Tri + N" */, DEFAULT_CABLE_SIZING_PARAMETERS, "Cu");
check("section theorique (Y4)", y4, 3.86443956521739);
check("section normalisee retenue (Z4)", selectCableSection(y4, [1.5, 2.5, 4, 6, 10, 16, 25, 35, 50]), 4);

console.log();
console.log("=".repeat(78));
console.log("5. Palier Certificats Verts Bruxelles (feuille Donnees, taux avril 2026)");
console.log("=".repeat(78));
const bracketsApril2026: CvBracket[] = [
  { powerMinKwc: 0, powerMaxKwc: 5, grantYearLabel: "avril 2026", rateCvPerMwh: 2.055 },
  { powerMinKwc: 5, powerMaxKwc: 36, grantYearLabel: "avril 2026", rateCvPerMwh: 1.739 },
  { powerMinKwc: 36, powerMaxKwc: 100, grantYearLabel: "avril 2026", rateCvPerMwh: 0.559 },
  { powerMinKwc: 100, powerMaxKwc: 250, grantYearLabel: "avril 2026", rateCvPerMwh: 0 },
  { powerMinKwc: 250, powerMaxKwc: null, grantYearLabel: "avril 2026", rateCvPerMwh: 0 },
];
check("taux CV pour 8,24 kWc", lookupCvRateBruxelles(8.24, bracketsApril2026), 1.739);

console.log();
console.log("=".repeat(78));
console.log("6. Simulation de rentabilite 25 ans, annee 1 (regime CV Bruxelles)");
console.log("=".repeat(78));
const regimeParams: RegimeParameters = {
  regime: RevenueRegime.CV_BRACKET,
  autoConsumptionRate: 0.8, // Donnees!G16 (batterie presente dans l'exemple)
  inflationRate: 0.03, // Donnees!F16
  panelDegradationPctPerYear: 0.42, // specifique au panneau Jinko choisi
  initialNetworkPrice: 0.35, // Donnees!E16
  initialResalePrice: 0.0875, // Donnees!H16 (25% du prix reseau)
  cvRatePerMwh: 1.739,
  cvPricePerCertificate: 85, // Donnees!C16
};
const years = projectCashflow(9230.3574 /* Calcul du prix!I46 */, 6723.839999999999 /* Donnees!I16 */, regimeParams, 1);
const year1 = years[0];
check("production annee 1 (AE9)", year1.productionKwh, 6723.839999999999);
check("revenu auto-consommation annee 1 (AG9)", year1.revenueAutoConsumption, 1882.6752);
check("revenu total (CV + revente) annee 1 (AH9+AI9)", year1.revenueRegimeSpecific, 993.8844095999999 + 117.66719999999995);
check("cashflow cumule fin annee 1 (AK9)", year1.cashflowCumulative, -6236.130590400001);

console.log();
console.log("=".repeat(78));
console.log("7. Cles de repartition marches publics (feuille Calcul detaille, ligne PV)");
console.log("=".repeat(78));
// Calcul détaillé!G11=1036,798 (cout PV) ; M11=K12=1,3 ; J66=9230,3574 (prix total projet) ;
// Q17=0,29644301747189117 (poids masque total, deja lu dans le classeur pour cet exemple).
const w11 = lineWeight(1036.798, 1.3, 9230.3574);
check("poids de la ligne PV (I11)", w11, 0.14602223311526377);
const j11 = displayedPrice(1036.798, 1.3, 0.29644301747189117);
check("prix affiche de la ligne PV, redistribue (J11)", j11, 1915.7473146763216);

console.log();
console.log("=".repeat(78));
console.log("8. Regles nouvelles (Ben, 02/09/2026) : non comparables a l'Excel,");
console.log("   verification de coherence uniquement");
console.log("=".repeat(78));
const rule: TravelCostRule = {
  baseFee: 100,
  distanceThresholdKm: 50,
  distanceSurcharge: 50,
  powerThresholdKwc: 10,
  powerSurcharge: 30,
};
console.log(`forfait deplacement, chantier proche, petite installation : ${travelCost(20, 6, rule)} EUR (attendu 100)`);
console.log(`forfait deplacement, chantier loin, grande installation   : ${travelCost(80, 15, rule)} EUR (attendu 180)`);

console.log();
console.log("=".repeat(78));
console.log("9. Main-d'oeuvre et postes electriques (decision 38, 10/09/2026)");
console.log("   Meme cas de reference que les sections precedentes : 16 panneaux");
console.log("   Jinko 515W (8240 Wc), Huawei SUN2000 25kW KTL-MB0 (27,5 kVA),");
console.log("   toiture plate, Bruxelles-Capitale. Valeurs lues directement dans");
console.log("   les cellules du classeur Excel (feuille Calcul du prix, lignes 18-40).");
console.log("=".repeat(78));

// Calcul du prix!G18 = 603,75 (MO toiture plate, 16 panneaux)
check(
  "MO toiture plate, 16 panneaux (G18)",
  roofLaborCost(16, { roofType: "Toiture plate", fixedPrice: 525, threshold1Units: 13, rateTier1: 26.25, threshold2Units: 100, rateTier2: 23.1 }),
  603.75,
);

// Calcul du prix!G20 = 550 (MO electricien, 1 onduleur de 27,5 kVA -> palier "> 10 kVA")
const electricianRates = [
  { dayRate: 350, inverterCountTier: "< 10 kVA", fixedPrice: 325, pricePerAdditionalInverter: 150 },
  { dayRate: 350, inverterCountTier: "> 10 kVA", fixedPrice: 550, pricePerAdditionalInverter: 250 },
  { dayRate: 350, inverterCountTier: "> 30 kVA", fixedPrice: 1750, pricePerAdditionalInverter: 550 },
];
const pickedTier = pickElectricianRateTier(27.5, electricianRates);
check('palier electricien retenu pour 27,5 kVA (doit etre "> 10 kVA")', pickedTier.fixedPrice, 550);
check("MO electricien, 1 onduleur 27,5 kVA (G20)", electricianLaborCost(1, pickedTier), 550);

// Calcul du prix!G23 = G24 = 164,8 (provision Cablage / Matos AC, 8240 Wc, "Normal")
const cablingTiers = [
  { tierOrder: 1, powerMaxWc: 7700, rateEurPerWc: 0.03 },
  { tierOrder: 2, powerMaxWc: 25000, rateEurPerWc: 0.02 },
  { tierOrder: 3, powerMaxWc: null, rateEurPerWc: 0.015 },
];
check("provision Cablage/Matos AC, 8240 Wc, Normal (G23/G24)", cablingForfaitCost(8240, cablingTiers, false, 1.5), 164.8);

// Calcul du prix!G25 = 250 (certification electrique, 27,5 kVA > 10 kVA)
const certificationTiers = [
  { tierOrder: 1, powerThresholdKva: 10, price: 115 },
  { tierOrder: 2, powerThresholdKva: null, price: 250 },
];
check("certification electrique, 27,5 kVA (G25)", electricalCertificationPrice(27.5, certificationTiers), 250);

// Calcul du prix!G22 = 0 (cabine de decouplage, 27,5 kVA < 30 kVA : premier palier, prix 0)
const cabineCatalog = [
  { id: "1", componentType: "cabine_decouplage", modelName: "Max 30 kVA", brand: null, specs: { power_threshold_from_kva: 0 }, unitPrice: 0 },
  { id: "2", componentType: "cabine_decouplage", modelName: "Max 45 kVA", brand: null, specs: { power_threshold_from_kva: 30.001 }, unitPrice: 5670 },
];
check("cabine de decouplage, 27,5 kVA (G22)", cabineDecouplagePrice(27.5, cabineCatalog), 0);

// Calcul du prix!F40 / MO!O12 = 0 (redevance GRD, Bruxelles, 27,5 kVA -> palier 25 kVA, fee 0)
const grdSchedule = [
  { regionId: "bxl", powerThresholdKva: 0, fee: 0 },
  { regionId: "bxl", powerThresholdKva: 5, fee: 0 },
  { regionId: "bxl", powerThresholdKva: 10, fee: 0 },
  { regionId: "bxl", powerThresholdKva: 25, fee: 0 },
  { regionId: "bxl", powerThresholdKva: 30, fee: 0 },
  { regionId: "bxl", powerThresholdKva: 56, fee: 838 },
];
check("redevance GRD, Bruxelles, 27,5 kVA (MO!O12)", grdFee(27.5, "bxl", grdSchedule), 0);

// Elec!M49 = Elec!M50 = 206,25 (frais de licence EMS Nexxtlab/ENIRIS, 5 x 1,5 x 27,5 kVA)
check(
  "frais de licence EMS, 27,5 kVA (Elec!M49/M50)",
  emsLicenseFee(27.5, { id: "1", componentType: "ems", modelName: "Nexxtlab Smart Master Home", brand: null, specs: { requires_license: true, license_fee_per_kwc: 7.5 }, unitPrice: 315 }),
  206.25,
);

// Calcul du prix!C36 = 0 (transport, QUOTIENT(16, 72) = 0 voyage)
check("voyages de transport, 16 panneaux (C36)", transportTripsForPanels(16, 72), 0);

console.log();
console.log("=".repeat(78));
console.log(`RESULTAT : ${checksPassed} verifications reussies, ${checksFailed} echouees`);
console.log("=".repeat(78));

if (checksFailed > 0) {
  process.exit(1);
}
