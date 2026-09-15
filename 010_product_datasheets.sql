-- Migration 010 : fiche technique (PDF) par article (decision 51, 15/09/2026)
--
-- Deja appliquee directement sur le projet Supabase "Offre-We-Green"
-- (rorwnacthttwxyqemkgv) via l'outil MCP Supabase le 15/09/2026 ; ce fichier
-- est fourni uniquement pour que le depot GitHub de Ben reste complet et
-- reproductible (ex. pour recreer un environnement de test), aucune action
-- de deploiement n'est necessaire de sa part.
--
-- Deux colonnes sur products (chemin de l'objet dans Storage + nom
-- d'origine pour l'affichage), un bucket Storage public en lecture (memes
-- donnees non sensibles que le catalogue produits), et l'ecriture reservee
-- aux utilisateurs connectes (meme principe que products_authenticated_write,
-- migration 008).

BEGIN;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS datasheet_path text,
  ADD COLUMN IF NOT EXISTS datasheet_filename text;

INSERT INTO storage.buckets (id, name, public)
VALUES ('product-datasheets', 'product-datasheets', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY product_datasheets_public_read
  ON storage.objects FOR SELECT
  TO anon, authenticated
  USING (bucket_id = 'product-datasheets');

CREATE POLICY product_datasheets_authenticated_write
  ON storage.objects FOR ALL
  TO authenticated
  USING (bucket_id = 'product-datasheets')
  WITH CHECK (bucket_id = 'product-datasheets');

COMMIT;
