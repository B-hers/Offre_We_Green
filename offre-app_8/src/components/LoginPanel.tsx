import { useState, type FormEvent } from "react";
import { supabase } from "../supabaseClient";

/**
 * Ecran de connexion / creation de compte pour le back-office (decision 35).
 *
 * Contexte important : au 10/09/2026, zero compte Supabase Auth n'existe sur
 * ce projet. Aucun outil disponible cote Claude ne permet de creer un compte
 * autrement que via ce formulaire (pas de cle service_role, pas d'outil
 * d'administration Auth) -- le premier compte cree ici (normalement celui de
 * Ben) devient donc le premier utilisateur "authenticated" pouvant ecrire
 * dans les tables catalogue/parametres.
 *
 * Etape manuelle a faire ensuite par Ben dans le Dashboard Supabase
 * (Authentication > Providers > Email > desactiver "Allow new users to
 * sign up") pour empecher que n'importe qui avec le lien de l'app puisse se
 * creer un compte et modifier le catalogue. Impossible a faire depuis ce
 * projet Claude (aucun outil ne donne acces a ce reglage).
 */
export default function LoginPanel() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!supabase) {
    return <p>Supabase n'est pas configure.</p>;
  }
  const client = supabase;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      if (mode === "signup") {
        const { error: signUpError } = await client.auth.signUp({ email, password });
        if (signUpError) throw signUpError;
        setMessage(
          "Compte cree. Si la confirmation par email est activee sur ce projet Supabase, verifie ta boite mail avant de pouvoir te connecter.",
        );
      } else {
        const { error: signInError } = await client.auth.signInWithPassword({ email, password });
        if (signInError) throw signInError;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wg-panel" style={{ maxWidth: 380 }}>
      <p className="wg-panel-title">{mode === "signin" ? "Connexion back-office" : "Creer un compte back-office"}</p>
      <p className="wg-muted">
        Necessaire uniquement pour modifier les donnees (catalogue, prix, marges...). La consultation des autres
        onglets ne demande pas de connexion.
      </p>
      <form onSubmit={handleSubmit}>
        <label className="wg-field" style={{ marginTop: 8 }}>
          Email
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="wg-field" style={{ marginTop: 10 }}>
          Mot de passe
          <input type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button type="submit" className="wg-btn-primary" disabled={busy} style={{ marginTop: 14 }}>
          {busy ? "..." : mode === "signin" ? "Se connecter" : "Creer le compte"}
        </button>
      </form>
      <button
        className="wg-btn-link"
        style={{ marginTop: 10, display: "inline-block" }}
        onClick={() => {
          setMode(mode === "signin" ? "signup" : "signin");
          setError(null);
          setMessage(null);
        }}
      >
        {mode === "signin" ? "Pas encore de compte ? En creer un" : "Deja un compte ? Se connecter"}
      </button>
      {error && <p className="wg-banner-danger" style={{ marginTop: 8 }}>{error}</p>}
      {message && <p className="wg-banner-success" style={{ marginTop: 8 }}>{message}</p>}
    </div>
  );
}
