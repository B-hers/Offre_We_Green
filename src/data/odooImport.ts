/**
 * Client cote application pour l'Edge Function "odoo-import" (voir
 * supabase/functions/odoo-import/index.ts). Phase 3 de
 * claude/cartographie-et-plan-action.md (decision 43) : lecture seule,
 * aucune ecriture vers Odoo depuis l'application.
 *
 * N'appelle jamais Odoo directement depuis le navigateur : les identifiants
 * Odoo ne vivent que comme secrets de l'Edge Function, jamais dans ce
 * bundle cote client.
 */
import { supabase } from "../supabaseClient";

export interface OdooAddress {
  odooPartnerId: number;
  nom: string | null;
  rue: string | null;
  complement: string | null;
  codePostal: string | null;
  ville: string | null;
  pays: string | null;
  telephone: string | null;
  email: string | null;
  tva: string | null;
  estSociete: boolean;
}

export interface OdooImportedLine {
  odooProductId: number | null;
  libelle: string | null;
  quantite: number;
  prixUnitaire: number;
  sousTotal: number;
}

export interface OdooResponsable {
  odooUserId: number;
  nom: string | null;
  telephone: string | null;
  email: string | null;
}

export interface OdooArticle {
  odooProductId: number | null;
  produit: string | null;
  quantite: number;
  /** Puissance crete en Wc, extraite du libelle -- panneaux uniquement. */
  wc: number | null;
  /** Capacite en kWh, extraite du libelle -- batteries uniquement. */
  kwh: number | null;
}

/**
 * Categorisation par mots-cles (decision 46 : transcription exacte de
 * `extractProducts()` dans `fetch-odoo-order`, l'Edge Function equivalente
 * du Briefing de chantier) : aide au pre-remplissage, ne remplace pas le
 * rapprochement fin avec le catalogue de l'offre (section 7 de la
 * cartographie). Pas de categorie "optimiseurs" dediee (le Briefing n'en a
 * pas non plus) : ces lignes, comme toute ligne non reconnue, atterrissent
 * dans `autres` -- jamais silencieusement perdues, contrairement au
 * Briefing qui les ignore.
 */
export interface OdooArticles {
  panneaux: OdooArticle[];
  onduleurs: OdooArticle[];
  batteries: OdooArticle[];
  bornes: OdooArticle[];
  greenbox: boolean;
  autres: OdooArticle[];
}

export interface OdooImportResult {
  devis: {
    odooOrderId: number;
    reference: string;
    statut: string;
    date: string | null;
    montantTotal: number;
    lienOdoo: string;
  };
  client: OdooAddress | null;
  adresseFacturation: OdooAddress | null;
  /** null si identique a l'adresse de facturation : ne jamais redemander la saisie dans ce cas (voir cartographie, section 4). Correspond a l'"adresse de chantier" du Briefing. */
  adresseLivraison: OdooAddress | null;
  /** Vendeur/PM Odoo (sale.order.user_id). Pas de champ dedie dans l'offre pour l'instant : affiche a titre informatif (decision 44). */
  responsable: OdooResponsable | null;
  lignes: OdooImportedLine[];
  articles: OdooArticles;
  avertissement: string;
}

export class OdooImportError extends Error {}

export async function importOdooQuote(reference: string): Promise<OdooImportResult> {
  if (!supabase) {
    throw new OdooImportError("Application non connectee a Supabase (configuration manquante) : import Odoo indisponible.");
  }
  const { data, error } = await supabase.functions.invoke("odoo-import", {
    body: { reference },
  });
  if (error) {
    // Le corps d'erreur renvoye par la fonction (voir index.ts) porte un
    // message clair dans `error` ; supabase-js expose parfois le detail
    // dans error.context, parfois seulement error.message selon le code HTTP.
    const detail = (data as { error?: string } | null)?.error ?? error.message;
    throw new OdooImportError(detail);
  }
  if (data && typeof data === "object" && "error" in data) {
    throw new OdooImportError((data as { error: string }).error);
  }
  return data as OdooImportResult;
}
