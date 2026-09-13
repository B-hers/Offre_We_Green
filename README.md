# Application Offre - We Green Energy

Premiere version de code de la **Phase 2** (voir `claude/cartographie-et-plan-action.md`,
decision 27, dans le projet Claude "Digitalisation Offre We Green"). Remplace
progressivement le template Excel actuel, avec toutes les donnees (catalogue,
prix, marges, forfaits, regles) en base plutot que codees en dur.

## Etat actuel (09/09/2026)

Fait :
- Port TypeScript fidele des 8 modules du moteur de calcul Python deja valide
  contre l'Excel audite (`src/engine/`), re-verifie par les 16 memes controles
  (`npm run validate:engine`, 16/16 au vert).
- Couche d'acces aux donnees (`src/data/catalog.ts`) qui lit le catalogue et
  les tables de parametres depuis Supabase (aucune donnee codee en dur).
- Premier ecran fonctionnel (`src/App.tsx`) : selection panneau + quantite,
  onduleur, batterie optionnelle, deplacement ; marge suggeree affichee a
  titre informatif (jamais copiee automatiquement) ; marge appliquee (K12/K21)
  et taux de commission editables ; override manuel de prix par ligne avec
  mise en evidence visuelle (fond ambre + badge "modifie").

Pas encore fait (perimetre Phase 2 restant, voir la roadmap dans le projet
Claude) :
- Ecriture en base (creation reelle d'un enregistrement `offers` +
  `offer_lines` ; pour l'instant tout se calcule en memoire, cote client) ;
- Structures/carport, optimiseurs, cablage AC/DC, regime CV et simulation de
  rentabilite 25 ans, cles de repartition marches publics ;
- Fiche client complete (Odoo), generation du document d'offre (PDF),
  versioning ;
- Authentification, back-office.

## Point ouvert a trancher avec Ben

`products.power_kva` contient en realite une puissance en **watts** pour les
panneaux (450, 460, 470...), pas des kVA (voir les valeurs reelles en base).
Le calcul de puissance totale installee dans `App.tsx` (`totalPowerKwc`)
suppose actuellement une conversion W -> kWc directe. A confirmer/corriger une
fois le mapping catalogue definitif tranche (colonne dediee `power_w` plutot
que de reutiliser `power_kva`, ou conversion explicite).

## Demarrage

```bash
npm install
cp .env.example .env.local   # renseigner VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
npm run dev
```

## Verifier le moteur de calcul

```bash
npm run validate:engine
```

Doit afficher `16 verifications reussies, 0 echouees`. A relancer apres toute
modification d'un fichier de `src/engine/`.

## Build de production

```bash
npm run build
```
