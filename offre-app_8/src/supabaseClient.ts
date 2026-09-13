import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabaseConfigured = Boolean(url && anonKey && !url.includes("xxxxxxxxxxxx"));

/**
 * Client Supabase cote navigateur. N'utilise jamais que la cle publique
 * (anon/publishable) : la service role reste reservee au futur back-office,
 * jamais exposee ici (voir claude/cartographie-et-plan-action.md, section 8,
 * "Controle d'acces par role").
 */
export const supabase = supabaseConfigured
  ? createClient(url as string, anonKey as string)
  : null;
