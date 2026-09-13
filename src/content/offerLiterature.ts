/**
 * "Litterature" commerciale extraite du classeur Excel source (feuilles de
 * presentation "Offre Bruxelles avec CV - FR", "Offre Flandre & Wallonie -
 * FR" et "Offre Batterie - FR" de NEWTemplate_Offre_WG_BE_28.08.26_V2,
 * decision 40, 11/09/2026 -- demande explicite de Ben : "extraire du
 * classeur maintenant", pas plus tard). Texte de vente standard (conditions,
 * garanties, avantages) : ce n'est PAS une donnee catalogue/prix
 * (contrairement aux tables Supabase, seule source de verite pour
 * articles/prix/marges/regles de calcul) -- conserve ici en constante de
 * presentation plutot qu'en base de donnees. A reconsiderer si Ben veut un
 * jour l'editer sans redeploiement (ex : future table `content_blocks`,
 * hors perimetre pour l'instant).
 *
 * Le wording est quasi identique (reformulations mineures pres) entre les
 * feuilles "Offre Bruxelles avec CV - FR" et "Offre Flandre & Wallonie -
 * FR" du classeur : la version Bruxelles (legerement plus detaillee) sert
 * de texte commun aux deux regions ci-dessous -- l'app differencie deja
 * Bruxelles/Wallonie-Flandre ailleurs (regime CV vs revente simple), il n'y
 * a pas de raison metier de dupliquer ce texte quasi identique.
 */

/**
 * Coordonnees d'entete We Green (page de garde de l'offre). Type "papier a
 * en-tete" : exception documentee au principe general "pas de donnee metier
 * en dur" (voir instructions du projet Claude "Digitalisation Offre We
 * Green") -- extrait tel quel de la page de garde des offres PDF reelles
 * fournies par Ben le 12/09/2026 ("Offre PV - BOS9 -08.09.pdf" et "Offre PV
 * Batterie - BOS9 - 08.09.pdf", decision 42). Le logo associe est
 * public/we-green-logo.png (copie du fichier fourni par Ben).
 */
export const WE_GREEN_COMPANY_INFO = {
  address: "Ikaroslaan 83, 1930 Zaventem",
  phone: "+32 2 476 00 76",
  email: "info@we-green.be",
  vat: "BE07 1995 4388",
  website: "www.we-green.be",
};

/**
 * Delai de livraison affiche : "1 mois" pour un particulier, "3 mois" pour
 * une societe -- convention deja utilisee ailleurs dans l'app (select "Type
 * de client" de l'onglet Donnees). La feuille Excel auditee ("Offre
 * Bruxelles avec CV - FR") n'affichait que le cas particulier ("3 mois" y
 * etait en realite la valeur par defaut du classeur, jamais recalculee par
 * type de client) : fonction plutot que constante figee pour corriger cette
 * incoherence, repere en comparant aux offres PDF reelles fournies par Ben
 * le 12/09/2026 (decision 42) -- le PDF particulier affichait "1 mois".
 */
function delaiLivraisonComplete(clientType: "particulier" | "societe"): string {
  const months = clientType === "societe" ? 3 : 1;
  return `Le projet sera livre dans les ${months} mois apres la reception du premier paiement. Si ce delai n'est pas respecte du a un contretemps du cote du client (ex : renovation de toiture, maison en construction), le prix pourra etre renegocie entre les parties.`;
}

function delaiLivraisonBattery(clientType: "particulier" | "societe"): string {
  const months = clientType === "societe" ? 3 : 1;
  return `Le projet sera livre dans les ${months} mois apres la reception du premier paiement, sous reserve de livraison de la part de notre fournisseur. Si ce delai n'est pas respecte du a un contretemps du cote du client (ex : renovation electrique, maison en construction), le prix pourra etre renegocie entre les parties.`;
}

export const OFFER_LITERATURE_COMPLETE = {
  descriptionGenerale:
    "L'installation d'un systeme photovoltaique permet de reduire votre facture energetique et votre empreinte carbone. Apres avoir analyse le profil de consommation et la surface disponible, nous recommandons la solution decrite ci-dessous.",
  descriptionGeneraleSuite:
    "Les panneaux choisis sont fiables et de grande qualite : ils sont repertories Tier 1, et classes dans le top 10 du celebre classement Bloomberg.",
  conditionsPaiement: [
    "A la signature du contrat : 20%",
    "A la livraison des marchandises et l'ouverture du chantier : 60%",
    "A la cloture du chantier et a la reception par l'organisme de controle : 20%",
  ],
  delaiLivraison: delaiLivraisonComplete,
  /** Feuilles de presentation Excel, cellule "Validite de l'offre". */
  validiteOffre: "2 semaines",
  assuranceQualite:
    "Tous les materiaux et services sont conformes aux normes internationales en vigueur et aux normes RGIE. We Green est certifiee Rescert (equivalent Qualiwall) pour les 3 regions en Belgique.",
  zoneAcces:
    "Une zone de securite pour le stockage des produits doit etre prevue pendant la periode d'installation. De plus, un acces pour l'equipe We Green doit etre fourni. La zone d'installation de l'onduleur doit etre accessible et degagee.",
  securite: [
    "We Green fonctionne selon les procedures ZERO RISK.",
    "Une zone restreinte de 3 metres de largeur a l'interieur de la zone d'installation sera fermee pour des raisons de securite.",
    "Un chemin de securite pour le personnel et l'equipement sera installe si necessaire.",
  ],
  // Feuille source : "Onduleur(s) Huawei : 5 ans de garantie contre les
  // defauts de fabrication avec possibilite d'extension de 15 ans." --
  // generalise ici (la marque d'onduleur varie desormais par offre,
  // decision 40, plusieurs modeles possibles).
  garantiesOnduleur:
    "5 ans de garantie contre les defauts de fabrication, avec possibilite d'extension a 15 ans (garantie constructeur, peut varier selon la marque -- voir fiche produit).",
  garantiesPanneaux: [
    "25 ans contre les defauts de fabrication",
    "30 ans sur le rendement : 87,4% de la production est assuree pendant cette periode",
  ],
  garantiesMontage: "Montage et fixations : 10 ans.",
  avantageEnergieVerte:
    "Avec l'energie verte, vous beneficiez d'un cout de production maitrise et garanti contre l'inflation energetique : le cout de revient du kWh produit par votre installation reste stable sur toute sa duree de vie, car il depend uniquement de son amortissement -- contrairement aux fluctuations des prix de l'electricite issue des sources conventionnelles.",
  avantagesEcologiques: [
    "Reduction de la pollution : sur 25 ans, un systeme photovoltaique permet d'epargner plusieurs tonnes de CO2 a la planete (estimation variable selon la puissance installee).",
    "Production propre d'electricite, en tenant compte de la degradation naturelle des panneaux sur la duree de vie de l'installation.",
  ],
  valeurAjouteeWeGreen: [
    "2 ans de maintenance, incluant des rapports personnalises sur la consommation et la production solaire sur demande du client.",
    "Un suivi en direct de la part de nos techniciens grace a l'onduleur connecte : au moindre probleme, nous sommes avertis en ligne et pouvons intervenir dans les plus brefs delais.",
  ],
  mentionTva:
    "Le taux de TVA de 6% est d'application pour les installations chez des particuliers si le logement a plus de 10 ans, 21% si le logement a moins de 10 ans. Pour les entreprises, la TVA est en autoliquidation.",
  clauseSignature: "Je soussigne, accepte la proposition de We Green decrite dans cette offre, ainsi que ses conditions generales de vente.",
};

export const OFFER_LITERATURE_BATTERY = {
  description: "Placement d'une batterie domestique.",
  conditionsPaiement: OFFER_LITERATURE_COMPLETE.conditionsPaiement,
  delaiLivraison: delaiLivraisonBattery,
  validiteOffre: OFFER_LITERATURE_COMPLETE.validiteOffre,
  assuranceQualite: "Tous les materiaux et services sont conformes aux normes internationales en vigueur.",
  zoneAcces:
    "Une zone de securite pour le stockage des produits doit etre prevue pendant la periode d'installation. De plus, un acces pour l'equipe We Green doit etre fourni.",
  securite: OFFER_LITERATURE_COMPLETE.securite,
  // Cellule "Garantie" vide (#N/A, formule cassee) dans la feuille source
  // "Offre Batterie - FR" (cellule A89) : aucun texte de garantie batterie
  // specifique n'etait disponible dans le classeur audite -- null plutot
  // qu'un texte invente, a completer avec Ben quand l'information existera.
  garantie: null as string | null,
  mentionTva: OFFER_LITERATURE_COMPLETE.mentionTva,
  clauseSignature: OFFER_LITERATURE_COMPLETE.clauseSignature,
};
