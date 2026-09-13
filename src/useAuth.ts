/**
 * Etat de session Supabase Auth, utilise pour gater l'onglet Back-office
 * (decision 35, cf. claude/cartographie-et-plan-action.md). Le reste de
 * l'application (Calcul du prix / Offre / Donnees) reste accessible sans
 * connexion : seule l'ecriture sur les tables catalogue/parametres exige un
 * compte (policies RLS `FOR ALL TO authenticated`, migration
 * 008_backoffice_write_policies.sql).
 */
import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabaseClient";

export function useSupabaseAuth() {
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    if (!supabase) {
      setAuthLoading(false);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthLoading(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  async function signOut() {
    if (!supabase) return;
    await supabase.auth.signOut();
  }

  return { session, authLoading, signOut };
}
