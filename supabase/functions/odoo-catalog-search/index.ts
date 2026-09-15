/**
 * Edge Function "odoo-catalog-search" -- recherche d'articles dans le
 * catalogue produits Odoo, pour alimenter l'import catalogue du back-office
 * (decision 50 de claude/cartographie-et-plan-action.md, chantier 2 :
 * "Dans la BASE de donnee, je dois pouvoir importer des articles de Odoo,
 * non ?").
 *
 * Perimetre (lecture seule, aucune ecriture Odoo, meme discipline que
 * `odoo-import`) : recherche par nom/reference dans `product.product` et
 * renvoie une liste de candidats (nom, reference, prix de vente, cout
 * standard). Le rapprochement avec une ligne du catalogue de l'offre
 * (creation ou mise a jour d'un `products`, plus une entree
 * `product_odoo_links` pour tracer le lien) reste une decision de
 * l'utilisateur cote client (src/components/AdminTableEditor.tsx) : cette
 * fonction ne cree ni ne modifie rien en base Supabase, elle se contente
 * d'interroger Odoo.
 *
 * Duplique volontairement les memes petits utilitaires que
 * `supabase/functions/odoo-import/index.ts` (CORS, JSON-RPC, authentification
 * Odoo...) : chaque Edge Function Supabase est deployee comme un module
 * independant, pas de partage de code entre fonctions dans ce projet.
 * Utilise les 4 memes secrets deja configures par Ben (ODOO_URL, ODOO_DB,
 * ODOO_USERNAME, ODOO_API_KEY) -- aucune configuration supplementaire a
 * faire pour deployer celle-ci.
 *
 * Deploiement : supabase functions deploy odoo-catalog-search
 * (memes secrets que odoo-import, deja en place).
 */

interface OdooJsonRpcError {
  code: number;
  message: string;
  data?: { name?: string; debug?: string; message?: string };
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function odooValue<T>(value: T | false): T | null {
  return value === false ? null : value;
}

async function callOdoo(odooUrl: string, service: string, method: string, args: unknown[]): Promise<unknown> {
  const response = await fetch(`${odooUrl.replace(/\/$/, "")}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "call",
      params: { service, method, args },
      id: Math.floor(Math.random() * 1_000_000),
    }),
  });

  if (!response.ok) {
    throw new Error(`Odoo a repondu HTTP ${response.status} sur ${service}.${method}`);
  }

  const payload = (await response.json()) as { result?: unknown; error?: OdooJsonRpcError };
  if (payload.error) {
    const detail = payload.error.data?.message ?? payload.error.message ?? "erreur inconnue";
    throw new Error(`Odoo (${service}.${method}) : ${detail.slice(0, 300)}`);
  }
  return payload.result;
}

interface OdooCredentials {
  url: string;
  db: string;
  username: string;
  apiKey: string;
}

function loadCredentials(): OdooCredentials | null {
  const url = Deno.env.get("ODOO_URL");
  const db = Deno.env.get("ODOO_DB");
  const username = Deno.env.get("ODOO_USERNAME");
  const apiKey = Deno.env.get("ODOO_API_KEY");
  if (!url || !db || !username || !apiKey) return null;
  return { url, db, username, apiKey };
}

async function authenticate(creds: OdooCredentials): Promise<number> {
  const uid = await callOdoo(creds.url, "common", "login", [creds.db, creds.username, creds.apiKey]);
  if (typeof uid !== "number") {
    throw new Error("Authentification Odoo refusee (identifiants/cle API invalides ou compte desactive).");
  }
  return uid;
}

async function executeKw(
  creds: OdooCredentials,
  uid: number,
  model: string,
  method: string,
  args: unknown[],
  kwargs: Record<string, unknown> = {},
): Promise<unknown> {
  return callOdoo(creds.url, "object", "execute_kw", [creds.db, uid, creds.apiKey, model, method, args, kwargs]);
}

interface OdooProductRaw {
  id: number;
  name: string | false;
  default_code: string | false;
  list_price: number;
  standard_price: number;
  uom_id: [number, string] | false;
}

interface OdooCatalogCandidate {
  odooProductId: number;
  nom: string | null;
  reference: string | null;
  prixVente: number;
  coutStandard: number;
  unite: string | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Methode non supportee, utiliser POST." }, 405);
  }

  const creds = loadCredentials();
  if (!creds) {
    return jsonResponse(
      {
        error:
          "Integration Odoo non configuree : secrets ODOO_URL / ODOO_DB / ODOO_USERNAME / ODOO_API_KEY manquants sur cette fonction (les memes que odoo-import).",
      },
      501,
    );
  }

  let query: string | undefined;
  try {
    const body = await req.json();
    query = typeof body?.query === "string" ? body.query.trim() : undefined;
  } catch {
    return jsonResponse({ error: 'Corps de requete invalide, attendu : { "query": "texte a rechercher" }' }, 400);
  }
  if (!query || query.length < 2) {
    return jsonResponse({ error: "Le champ 'query' doit contenir au moins 2 caracteres." }, 400);
  }

  try {
    const uid = await authenticate(creds);

    const domain = ["|", ["name", "ilike", query], ["default_code", "ilike", query]];
    const productsRaw = (await executeKw(creds, uid, "product.product", "search_read", [domain], {
      fields: ["name", "default_code", "list_price", "standard_price", "uom_id"],
      limit: 25,
      order: "name asc",
    })) as OdooProductRaw[];

    const candidates: OdooCatalogCandidate[] = productsRaw.map((p) => ({
      odooProductId: p.id,
      nom: odooValue(p.name),
      reference: odooValue(p.default_code),
      prixVente: p.list_price,
      coutStandard: p.standard_price,
      unite: p.uom_id ? p.uom_id[1] : null,
    }));

    return jsonResponse({
      candidates,
      avertissement:
        "Resultats Odoo bruts (nom, reference, cout standard) : verifiez et completez toujours manuellement (marque, puissance, marge de securite...) avant d'ajouter au catalogue de l'offre.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur inconnue lors de l'appel a Odoo.";
    return jsonResponse({ error: message }, 502);
  }
});
