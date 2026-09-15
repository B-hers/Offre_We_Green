/**
 * Extraction cote client de l'image de calepinage/implantation depuis un
 * rapport PDF Archelios ou Helioscope (decision 53/54, 15/09/2026, chantier
 * 4 de la roadmap de la decision 49).
 *
 * Fonctionnement : tout se passe dans le navigateur via pdf.js, aucun
 * upload serveur. L'image choisie reste en memoire au meme titre que le
 * reste de l'offre, qui n'est elle-meme pas encore persistee en base (voir
 * cartographie, section back-office).
 *
 * Detection automatique de la page (decision 54) : algorithme repris a
 * l'identique du Briefing de chantier existant (`index_26.html`, fonction
 * `extractCalepinage`), a la demande explicite de Ben ("les champs ont deja
 * ete determines... reproduire ce mecanisme plutot que d'inventer autre
 * chose"). Le texte de chaque page est lu via `getTextContent()` (pas de
 * lecture IA/LLM : un simple filtrage par mots-cles, entierement
 * deterministe) pour reperer la page "Detailed Layout"/"Design Render"
 * (HelioScope) ou "Illustrations du projet" (Archelios), avec un score de
 * repli generique si le format n'est reconnu ni comme l'un ni comme
 * l'autre. Un navigateur manuel de secours (renderPageToDataUrl, utilise
 * par App.tsx) reste disponible si la detection se trompe : le Briefing
 * n'en a pas, mais la cartographie du projet est explicite sur ce point
 * ("les valeurs detectees doivent rester modifiables manuellement") --
 * c'est un ajout, pas un ecart avec le mecanisme repris.
 *
 * Entree volontairement limitee au PDF (contrairement au Briefing, qui
 * accepte aussi une image/HEIC en secours pour un usage terrain) : Ben a
 * explicitement confirme ce perimetre pour l'offre (decision 49, "un
 * rapport PDF complet... pas un simple screenshot/PNG").
 *
 * pdf.js est charge en `import()` dynamique (et non en import statique) :
 * la librairie et son worker pesent plus d'1 Mo a eux deux, et l'immense
 * majorite des offres ne s'en servent jamais. Charger statiquement aurait
 * alourdi le bundle initial de toute l'application -- au chargement de
 * chaque onglet, meme sans jamais toucher a l'import Archelios -- ce qui va
 * a l'encontre du chantier "version mobile" (roadmap, decision 50) plutot
 * que de l'aider. Le telechargement ne se declenche qu'au premier fichier
 * depose.
 */
import type * as PdfjsLib from "pdfjs-dist";

export class ArcheliosPdfError extends Error {}

export type ArcheliosPdfDocument = PdfjsLib.PDFDocumentProxy;

export type ArcheliosSourceType = "Archelios" | "Helioscope" | "PDF";

export interface ArcheliosDetectionResult {
  dataUrl: string;
  pageNumber: number;
  numPages: number;
  sourceType: ArcheliosSourceType;
}

const MAX_FILE_SIZE_BYTES = 60 * 1024 * 1024; // 60 Mo, genereux pour un rapport PDF avec images
// Echelle et qualite JPEG reprises a l'identique du Briefing de chantier
// (extractCalepinage) : valeurs deja eprouvees en production sur le meme
// type de contenu (rendu 3D / calepinage), pas re-choisies ici.
const RENDER_SCALE = 3.5;
const JPEG_QUALITY = 0.95;

let pdfjsLibPromise: Promise<typeof PdfjsLib> | null = null;

function loadPdfjsLib(): Promise<typeof PdfjsLib> {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = (async () => {
      const lib = await import("pdfjs-dist");
      // Vite resoud "?url" vers l'URL finale du fichier worker apres build.
      const workerModule = await import("pdfjs-dist/build/pdf.worker.mjs?url");
      lib.GlobalWorkerOptions.workerSrc = workerModule.default;
      return lib;
    })();
  }
  return pdfjsLibPromise;
}

export async function loadArcheliosPdf(file: File): Promise<ArcheliosPdfDocument> {
  const looksLikePdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (!looksLikePdf) {
    throw new ArcheliosPdfError("Le fichier doit etre le PDF du rapport Archelios ou Helioscope (pas une image).");
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new ArcheliosPdfError("Ce PDF depasse 60 Mo, il ne peut pas etre lu ici.");
  }
  const buffer = await file.arrayBuffer();
  try {
    const pdfjsLib = await loadPdfjsLib();
    return await pdfjsLib.getDocument({ data: buffer }).promise;
  } catch {
    throw new ArcheliosPdfError("Impossible de lire ce PDF (fichier corrompu ou protege par mot de passe).");
  }
}

/** Rendu d'une page du PDF en image JPEG (data URL), a la demande (navigateur manuel de secours). */
export async function renderPageToDataUrl(doc: ArcheliosPdfDocument, pageNumber: number): Promise<string> {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: RENDER_SCALE });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const canvasContext = canvas.getContext("2d");
  if (!canvasContext) {
    throw new ArcheliosPdfError("Le rendu PDF n'est pas disponible dans ce navigateur.");
  }
  try {
    await page.render({ canvasContext, viewport }).promise;
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  } catch {
    throw new ArcheliosPdfError("Impossible d'afficher cette page du PDF.");
  }
}

async function extractLowerCaseTextPerPage(doc: ArcheliosPdfDocument): Promise<string[]> {
  const pageTexts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const textContent = await page.getTextContent();
    pageTexts.push(
      textContent.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .toLowerCase(),
    );
  }
  return pageTexts;
}

/**
 * Detection de la page de calepinage/implantation, algorithme identique a
 * celui du Briefing de chantier (voir en-tete de fichier) : type de rapport
 * detecte par mots-cles, puis page ciblee selon le type, avec un score de
 * repli generique. Retourne la page par defaut (derniere page) si rien de
 * plus pertinent n'est trouve -- jamais une erreur, la detection reste une
 * aide, jamais bloquante.
 */
function detectTargetPage(pageTexts: string[]): { pageNumber: number; sourceType: ArcheliosSourceType } {
  const numPages = pageTexts.length;
  const allText = pageTexts.join(" ");

  const isHelioScope = /helioscope|aurora solar|detailed layout|design render/i.test(allText);
  const isArchelios = /archelios|illustrations du projet/i.test(allText);
  const isAnnualProductionReport = /annual production report/i.test(allText);

  let targetPage = numPages; // repli par defaut : derniere page

  if (isHelioScope || isAnnualProductionReport) {
    let found = false;
    for (let i = 1; i <= numPages; i++) {
      if (/detailed layout/i.test(pageTexts[i - 1])) {
        targetPage = i;
        found = true;
        break;
      }
    }
    if (!found) {
      for (let i = 1; i <= numPages; i++) {
        if (/design render/i.test(pageTexts[i - 1])) {
          targetPage = i;
          break;
        }
      }
    }
    return { pageNumber: targetPage, sourceType: "Helioscope" };
  }

  if (isArchelios) {
    for (let i = 1; i <= numPages; i++) {
      if (/illustrations du projet/i.test(pageTexts[i - 1])) {
        targetPage = i;
        break;
      }
    }
    return { pageNumber: targetPage, sourceType: "Archelios" };
  }

  // Generique : score par mots-cles, prefere les pages de calepinage/rendu,
  // penalise les pages de carte/localisation.
  let bestScore = -999;
  let bestPage = numPages;
  for (let i = 1; i <= numPages; i++) {
    const txt = pageTexts[i - 1];
    let score = 0;
    if (/illustration|detailed layout|calepinage|layout plan|design render/.test(txt)) score += 15;
    if (/toiture|roof|panneaux|string|mppt/.test(txt)) score += 5;
    if (/google|maps?|satellite|localisation|location|meteo|irradiation/.test(txt)) score -= 20;
    if (score >= bestScore) {
      bestScore = score;
      bestPage = i;
    }
  }
  return { pageNumber: bestPage, sourceType: "PDF" };
}

/**
 * Detection + rendu en une seule etape : c'est la fonction appelee au
 * depot d'un fichier (comportement par defaut, comme dans le Briefing).
 */
export async function detectAndRenderCalepinage(doc: ArcheliosPdfDocument): Promise<ArcheliosDetectionResult> {
  const pageTexts = await extractLowerCaseTextPerPage(doc);
  const { pageNumber, sourceType } = detectTargetPage(pageTexts);
  const dataUrl = await renderPageToDataUrl(doc, pageNumber);
  return { dataUrl, pageNumber, numPages: doc.numPages, sourceType };
}
