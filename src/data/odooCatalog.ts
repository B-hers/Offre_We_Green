/**
 * Client cote application pour l'Edge Function "odoo-catalog-search" (voir
 * supabase/functions/odoo-catalog-search/index.ts). Decision 50,
 * 15/09/2026 : recherche d'articles Odoo pour pre-remplir une nouvelle ligne
 * du catalogue produits (back-office) -- jamais d'ecriture vers Odoo.
 */
import { supabase } from "../supabaseClient";

export interface OdooCatalogCandidate {
  odooProductId: number;
  nom: string | null;
  reference: string | null;
  prixVente: number;
  coutStandard: number;
  unite: string | null;
}

export class OdooCatalogSearchError extends Error {}

export async function searchOdooCatalog(query: string): Promise<OdooCatalogCandidate[]> {
  if (!supabase) {
    throw new OdooCatalogSearchError("Application non connectee a Supabase (configuration manquante) : recherche Odoo indisponible.");
  }
  const { data, error } = await supabase.functions.invoke("odoo-catalog-search", {
    body: { query },
  });
  if (error) {
    const detail = (data as { error?: string } | null)?.error ?? error.message;
    throw new OdooCatalogSearchError(detail);
  }
  if (data && typeof data === "object" && "error" in data) {
    throw new OdooCatalogSearchError((data as { error: string }).error);
  }
  return (data as { candidates: OdooCatalogCandidate[] }).candidates;
}

/**
 * Puissance crete en Wc extraite du nom Odoo (panneaux), meme heuristique
 * que `extractWc()` cote Edge Function odoo-import (decision 46) : best
 * effort, jamais une garantie -- l'utilisateur verifie/corrige avant de
 * valider l'ajout au catalogue.
 */
export function extractWcFromName(name: string | null): number | null {
  if (!name) return null;
  const match = name.match(/\b(\d{3,4})\s*[Ww](?:c|p|att)?\b/);
  return match ? Number(match[1]) : null;
}
