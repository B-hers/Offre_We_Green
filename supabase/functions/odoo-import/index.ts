/**
 * Edge Function "odoo-import" -- pont technique vers Odoo pour l'application
 * Offre (Phase 3 de claude/cartographie-et-plan-action.md, decisions 43 et 44).
 *
 * Pourquoi une Edge Function et pas un appel direct depuis le navigateur ou
 * une reutilisation du serveur MCP `odoo-wegreen` :
 * - Le serveur MCP `odoo-wegreen` (~/odoo-mcp-wegreen sur le Mac de Ben) est
 *   local-only et parle le protocole MCP : ni accessible depuis un
 *   navigateur, ni prevu pour ca (voir memoire du projet "Odoo intégration
 *   Claude", "Constraint: the MCP server is local-only").
 * - Odoo ne doit jamais recevoir les identifiants API directement depuis le
 *   navigateur d'un utilisateur : ils vivent uniquement comme secrets de
 *   cette fonction (ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY),
 *   jamais dans le bundle front (voir .env.local, meme discipline que les
 *   cles Supabase : anon key cote client, jamais la service role).
 *
 * Protocole : Odoo External API en JSON-RPC 2 (endpoint /jsonrpc), le meme
 * protocole que le serveur MCP existant utilise en XML-RPC -- JSON-RPC est
 * prefere ici car nativement supporte par fetch()/JSON dans Deno, sans
 * bibliotheque XML-RPC tierce.
 *
 * Decision 44 (12/09/2026) : Ben a fourni le code source de l'application
 * Briefing de chantier, qui appelle deja une Edge Function equivalente
 * (`fetch-odoo-order`, sur le projet Supabase du Briefing) depuis longtemps.
 * Deux alignements repris ici depuis cet exemple concret :
 * - **Pas d'authentification utilisateur requise pour appeler cette
 *   fonction** : le Briefing l'appelle avec la seule cle anon/publishable du
 *   projet (deja publique dans tout bundle front de toute facon), sans
 *   session connectee. Le controle d'acces reel reste cote Odoo (la cle API
 *   Odoo, elle, ne quitte jamais le serveur). Aligne ici : la restriction
 *   "connexion requise" ajoutee a la decision 43 est retiree cote front
 *   (voir src/App.tsx) -- elle n'a jamais existe dans le mecanisme
 *   equivalent du Briefing et n'apportait pas de securite reelle
 *   supplementaire (le devis reste protege par la connaissance de sa
 *   reference, pas par un compte applicatif).
 * - **Le "responsable" (vendeur/PM Odoo) et une categorisation des articles
 *   (panneaux/onduleurs/batteries/bornes/green box) sont attendus par le
 *   Briefing.** Sa version code en dur une table nom-vendeur ->
 *   telephone/email (PM_DATA) : ce projet ne reproduit PAS ce choix
 *   (contraire au principe "pas de donnee metier en dur" du projet
 *   Digitalisation Offre We Green) -- le telephone/email du responsable est
 *   plutot lu directement depuis sa fiche Odoo (res.users -> res.partner),
 *   toujours a jour sans liste a maintenir a la main.
 *
 * Decision 46 (12/09/2026) : Ben a fourni le code source complet et exact de
 * `fetch-odoo-order` (fonction `extractProducts`, projet Supabase du
 * Briefing). La categorisation ci-dessous (`cleanLabel` / `extractWc` /
 * `extractKwh` / `categorizeArticles`) est desormais une transcription
 * fidele de cette logique -- memes regex, meme decoupage par mots-cles sur
 * le seul libelle de ligne (le Briefing n'utilise pas la categorie produit
 * Odoo, contrairement a l'heuristique reconstruite de la decision 44 qui
 * s'en servait en complement : cette lecture `product.product.categ_id` est
 * donc retiree, elle n'etait pas fondee et ajoutait un appel Odoo inutile).
 * Deux ecarts assumes, documentes ici plutot que silencieux :
 * - Le Briefing ne categorise pas les optimiseurs (une ligne "optimiseur"
 *   est simplement exclue des onduleurs par son regex `!/optimis|optimizer/`
 *   puis n'apparait nulle part dans sa reponse). Ce projet n'a pas de
 *   categorie "optimiseurs" dediee non plus desormais (alignement exact),
 *   mais toute ligne non reconnue -- optimiseurs inclus -- part dans
 *   `autres` plutot que d'etre perdue, cf. point suivant.
 * - Le Briefing ignore silencieusement les lignes "onduleur"/"borne" a
 *   quantite nulle (lignes d'affichage/section) : ce projet les fait
 *   apparaitre dans `autres` par securite (principe du projet : jamais de
 *   ligne silencieusement invisible), au lieu de les ignorer comme lui.
 *
 * Perimetre (lecture seule, aucune ecriture Odoo) : recuperer un devis
 * (sale.order) par sa reference (ex: "S00123") ou son id numerique, avec le
 * client, l'adresse de facturation, l'adresse de livraison (= adresse de
 * chantier, seulement si differente de la facturation), le responsable
 * (vendeur Odoo), et les lignes du devis categorisees par grand type
 * d'article. Le rapprochement precis entre un article Odoo et un article du
 * catalogue de l'offre (prix/reference exacts) n'existe pas encore (voir
 * section 7 de la cartographie : gouvernance du catalogue produits,
 * correspondance 1 vers plusieurs pas encore construite) -- la
 * categorisation ci-dessous aide au pre-remplissage mais ne remplace pas ce
 * rapprochement fin, jamais une affectation automatique dans le calcul du
 * prix.
 *
 * Deploiement (a faire par Ben, identifiants non detenus par Claude) :
 *   supabase functions deploy odoo-import
 *   supabase secrets set ODOO_URL=https://me-green.odoo.com \
 *     ODOO_DB=me-green-main-4549920 \
 *     ODOO_USERNAME=<utilisateur Odoo dedie ou existant> \
 *     ODOO_API_KEY=<cle API Odoo -- PAS le mot de passe du compte>
 * Une cle API Odoo (Parametres -> Mon profil -> Securite du compte -> Cles
 * API) est preferable au mot de passe : revocable individuellement, sans
 * exposer le mot de passe principal de connexion a Odoo.
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

/** Odoo renvoie `false` (jamais null/"") pour un champ many2one ou texte vide -- normalise ici une bonne fois pour toutes plutot que de repeter le test partout en aval (gotcha deja documente dans la memoire du projet Briefing/Rapport). */
function odooValue<T>(value: T | false): T | null {
  return value === false ? null : value;
}

/** Un champ many2one Odoo revient sous la forme [id, "Nom affiche"] ou false. */
function odooMany2one(value: [number, string] | false): { id: number; label: string } | null {
  return value === false ? null : { id: value[0], label: value[1] };
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
    // Les messages d'erreur Odoo peuvent porter une trace Python complete
    // (des milliers de caracteres) -- tronque agressivement, meme discipline
    // que le serveur MCP existant (memoire "ways-of-working" du projet Odoo).
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

async function executeKw(creds: OdooCredentials, uid: number, model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}): Promise<unknown> {
  return callOdoo(creds.url, "object", "execute_kw", [creds.db, uid, creds.apiKey, model, method, args, kwargs]);
}

interface OdooPartnerRaw {
  id: number;
  name: string | false;
  street: string | false;
  street2: string | false;
  zip: string | false;
  city: string | false;
  country_id: [number, string] | false;
  phone: string | false;
  mobile: string | false;
  email: string | false;
  vat: string | false;
  is_company: boolean;
}

interface NormalizedAddress {
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

function normalizePartner(p: OdooPartnerRaw): NormalizedAddress {
  return {
    odooPartnerId: p.id,
    nom: odooValue(p.name),
    rue: odooValue(p.street),
    complement: odooValue(p.street2),
    codePostal: odooValue(p.zip),
    ville: odooValue(p.city),
    pays: odooMany2one(p.country_id)?.label ?? null,
    telephone: odooValue(p.phone) ?? odooValue(p.mobile),
    email: odooValue(p.email),
    tva: odooValue(p.vat),
    estSociete: p.is_company,
  };
}

interface OdooOrderLineRaw {
  id: number;
  product_id: [number, string] | false;
  name: string | false;
  product_uom_qty: number;
  price_unit: number;
  price_subtotal: number;
}

interface NormalizedLine {
  odooProductId: number | null;
  libelle: string | null;
  quantite: number;
  prixUnitaire: number;
  sousTotal: number;
}

function normalizeLine(l: OdooOrderLineRaw): NormalizedLine {
  const product = odooMany2one(l.product_id);
  return {
    odooProductId: product?.id ?? null,
    libelle: odooValue(l.name) ?? product?.label ?? null,
    quantite: l.product_uom_qty,
    prixUnitaire: l.price_unit,
    sousTotal: l.price_subtotal,
  };
}

/**
 * Nettoyage d'un libelle de ligne de devis avant affichage (decision 46) --
 * transcription exacte de `clean()` dans `fetch-odoo-order` : retire un SKU
 * entre crochets en tete, un prefixe de categorie ("Panneaux -", "Onduleur:"
 * ...), une quantite trainante en fin de libelle, et ne garde que la
 * premiere ligne du texte.
 */
function cleanLabel(name: string): string {
  return (name ?? "")
    .replace(/^\[[^\]]*\]\s*/, "")
    .replace(/^(Panneaux|Onduleur|Batterie|Borne)\s*[-:]\s*/i, "")
    .replace(/\s+\d+[.,]0+\s*$/, "")
    .split("\n")[0]
    .trim();
}

/** Puissance crete en Wc (panneaux), transcription exacte de `extractWc()` dans `fetch-odoo-order`. */
function extractWc(text: string): number | null {
  let match = text.match(/\b(\d{3,4})\s*[Ww](?:c|p|att)?\b/);
  if (match) return Number(match[1]);
  match = text.match(/[-\s](\d{3,4})[-\s]/);
  if (match && Number(match[1]) >= 100 && Number(match[1]) <= 999) return Number(match[1]);
  return null;
}

/** Capacite en kWh (batteries), transcription exacte de `extractKwh()` dans `fetch-odoo-order`. */
function extractKwh(text: string): number | null {
  const match = text.match(/\b(\d+(?:[.,]\d+)?)\s*kWh/i);
  return match ? Number(match[1].replace(",", ".")) : null;
}

interface NormalizedArticle {
  odooProductId: number | null;
  produit: string | null;
  quantite: number;
  wc: number | null;
  kwh: number | null;
}

interface CategorizedArticles {
  panneaux: NormalizedArticle[];
  onduleurs: NormalizedArticle[];
  batteries: NormalizedArticle[];
  bornes: NormalizedArticle[];
  greenbox: boolean;
  /** Toute ligne non reconnue par les regex ci-dessus (optimiseurs, cablage, main d'oeuvre, transport, lignes a quantite nulle...) : jamais silencieusement perdue, contrairement au Briefing qui les ignore (voir note de decision 46 en tete de fichier). */
  autres: NormalizedArticle[];
}

/**
 * Categorisation d'une ligne de devis par grand type d'article (decision 46)
 * -- transcription exacte de `extractProducts()` dans `fetch-odoo-order`
 * (regex identiques, sur le seul libelle de ligne, sans categorie produit
 * Odoo). Seul ajout par rapport a l'original : toute ligne qui ne matche
 * aucune regex (ou qui matche mais est exclue, ex. onduleur/borne a
 * quantite nulle) part dans `autres` au lieu d'etre silencieusement
 * ignoree.
 */
function categorizeArticles(lines: NormalizedLine[]): CategorizedArticles {
  const result: CategorizedArticles = { panneaux: [], onduleurs: [], batteries: [], bornes: [], greenbox: false, autres: [] };
  for (const line of lines) {
    const texte = (line.libelle ?? "").trim();
    const quantite = Math.round(line.quantite || 0);
    let matched = false;

    if (/panneaux/i.test(texte)) {
      result.panneaux.push({ odooProductId: line.odooProductId, produit: cleanLabel(texte), quantite, wc: extractWc(texte), kwh: null });
      matched = true;
    } else if (/onduleur/i.test(texte) && !/optimis|optimizer/i.test(texte)) {
      if (quantite > 0) {
        result.onduleurs.push({ odooProductId: line.odooProductId, produit: cleanLabel(texte), quantite, wc: null, kwh: null });
        matched = true;
      }
    } else if (/batterie/i.test(texte) && !/chargeur|power module|recyclage/i.test(texte)) {
      result.batteries.push({ odooProductId: line.odooProductId, produit: cleanLabel(texte), quantite, wc: null, kwh: extractKwh(texte) });
      matched = true;
    } else if (/\bborne\b/i.test(texte)) {
      if (quantite > 0) {
        result.bornes.push({ odooProductId: line.odooProductId, produit: cleanLabel(texte), quantite, wc: null, kwh: null });
        matched = true;
      }
    }

    if (/greenbox/i.test(texte)) {
      result.greenbox = true;
      matched = true;
    }

    if (!matched) {
      result.autres.push({ odooProductId: line.odooProductId, produit: line.libelle, quantite: line.quantite, wc: null, kwh: null });
    }
  }
  return result;
}

interface NormalizedResponsable {
  odooUserId: number;
  nom: string | null;
  telephone: string | null;
  email: string | null;
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
          "Integration Odoo non configuree : secrets ODOO_URL / ODOO_DB / ODOO_USERNAME / ODOO_API_KEY manquants sur cette fonction. Voir le commentaire d'en-tete de supabase/functions/odoo-import/index.ts pour la procedure.",
      },
      501,
    );
  }

  let reference: string | undefined;
  try {
    const body = await req.json();
    reference = typeof body?.reference === "string" ? body.reference.trim() : undefined;
  } catch {
    return jsonResponse({ error: "Corps de requete invalide, attendu : { \"reference\": \"S00123\" }" }, 400);
  }
  if (!reference) {
    return jsonResponse({ error: "Le champ 'reference' (numero de devis Odoo, ex: S00123) est requis." }, 400);
  }

  try {
    const uid = await authenticate(creds);

    const isNumeric = /^\d+$/.test(reference);
    const domain = isNumeric
      ? ["|", ["id", "=", Number(reference)], ["name", "=", reference]]
      : [["name", "=", reference]];

    const orders = (await executeKw(creds, uid, "sale.order", "search_read", [domain], {
      fields: ["id", "name", "state", "date_order", "amount_total", "partner_id", "partner_invoice_id", "partner_shipping_id", "user_id", "order_line"],
      limit: 1,
    })) as Array<{
      id: number;
      name: string;
      state: string;
      date_order: string | false;
      amount_total: number;
      partner_id: [number, string] | false;
      partner_invoice_id: [number, string] | false;
      partner_shipping_id: [number, string] | false;
      user_id: [number, string] | false;
      order_line: number[];
    }>;

    if (orders.length === 0) {
      return jsonResponse({ error: `Aucun devis Odoo trouve pour la reference "${reference}".` }, 404);
    }
    const order = orders[0];

    // Responsable (vendeur/PM Odoo, sale.order.user_id) : pas de table
    // nom -> telephone/email codee en dur (contrairement au Briefing,
    // PM_DATA) -- son partner_id est lu dans le meme lot que les autres
    // adresses ci-dessous pour recuperer telephone/email a jour.
    const salespersonUserId = odooMany2one(order.user_id)?.id;
    let salespersonPartnerId: number | undefined;
    let salespersonName: string | null = null;
    if (salespersonUserId) {
      const users = (await executeKw(creds, uid, "res.users", "read", [[salespersonUserId]], {
        fields: ["name", "partner_id"],
      })) as Array<{ name: string | false; partner_id: [number, string] | false }>;
      if (users.length) {
        salespersonName = odooValue(users[0].name);
        salespersonPartnerId = odooMany2one(users[0].partner_id)?.id;
      }
    }

    const partnerFields = ["name", "street", "street2", "zip", "city", "country_id", "phone", "mobile", "email", "vat", "is_company"];
    const partnerIds = Array.from(
      new Set(
        [order.partner_id, order.partner_invoice_id, order.partner_shipping_id]
          .map((f) => odooMany2one(f as [number, string] | false)?.id)
          .concat(salespersonPartnerId)
          .filter((id): id is number => typeof id === "number"),
      ),
    );
    const partnersRaw = partnerIds.length
      ? ((await executeKw(creds, uid, "res.partner", "read", [partnerIds], { fields: partnerFields })) as OdooPartnerRaw[])
      : [];
    const partnersById = new Map(partnersRaw.map((p) => [p.id, normalizePartner(p)]));

    const clientId = odooMany2one(order.partner_id)?.id;
    const facturationId = odooMany2one(order.partner_invoice_id)?.id ?? clientId;
    const livraisonId = odooMany2one(order.partner_shipping_id)?.id ?? clientId;

    const client = clientId ? partnersById.get(clientId) ?? null : null;
    const adresseFacturation = facturationId ? partnersById.get(facturationId) ?? null : null;
    const livraisonDiffereDeFacturation = livraisonId !== undefined && livraisonId !== facturationId;
    // adresseLivraison = adresse de chantier pour cette activite (installation sur site) -- voir cartographie, section 4.
    const adresseLivraison = livraisonDiffereDeFacturation && livraisonId ? partnersById.get(livraisonId) ?? null : null;

    const responsable: NormalizedResponsable | null = salespersonUserId
      ? {
          odooUserId: salespersonUserId,
          nom: salespersonName,
          telephone: salespersonPartnerId ? partnersById.get(salespersonPartnerId)?.telephone ?? null : null,
          email: salespersonPartnerId ? partnersById.get(salespersonPartnerId)?.email ?? null : null,
        }
      : null;

    const linesRaw = order.order_line.length
      ? ((await executeKw(creds, uid, "sale.order.line", "read", [order.order_line], {
          fields: ["product_id", "name", "product_uom_qty", "price_unit", "price_subtotal"],
        })) as OdooOrderLineRaw[])
      : [];
    const lignes = linesRaw.map(normalizeLine);
    const articles = categorizeArticles(lignes);

    return jsonResponse({
      devis: {
        odooOrderId: order.id,
        reference: order.name,
        statut: order.state,
        date: odooValue(order.date_order),
        montantTotal: order.amount_total,
        lienOdoo: `${creds.url.replace(/\/$/, "")}/web#id=${order.id}&model=sale.order&view_type=form`,
      },
      client,
      adresseFacturation,
      adresseLivraison, // null si identique a la facturation -- ne pas demander de saisie separee dans ce cas (principe deja documente, section 4 de la cartographie)
      responsable,
      lignes,
      articles,
      avertissement:
        "Lignes et articles importes a titre de reference. La categorisation par type (panneaux/onduleurs/batteries/bornes) reprend la logique du Briefing de chantier, mais n'est pas une correspondance exacte avec le catalogue de l'offre (voir cartographie, section 7) : rapprochez-les manuellement avant de les ajouter au calcul du prix.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur inconnue lors de l'appel a Odoo.";
    return jsonResponse({ error: message }, 502);
  }
});
