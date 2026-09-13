import { useEffect, useState } from "react";
import { supabase } from "../supabaseClient";
import type { AdminColumn, AdminTableConfig } from "../admin/tableConfigs";

/**
 * Editeur generique de table admin (decision 35). Ne connait aucune table
 * par son nom : tout vient de la config (src/admin/tableConfigs.ts). Utilise
 * pour les tables catalogue/parametres uniquement -- jamais pour
 * offers/offer_lines (hors perimetre, sauvegarde automatique des offres
 * deprioritisee par Ben le 10/09/2026).
 *
 * Ecriture protegee par les policies RLS `FOR ALL TO authenticated`
 * (migration 008_backoffice_write_policies.sql) : necessite une session
 * Supabase Auth active (voir useAuth.ts / LoginPanel.tsx).
 */
type Row = Record<string, any>;
type FkOptionsMap = Record<string, { value: string; label: string }[]>;

export default function AdminTableEditor({ config }: { config: AdminTableConfig }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [fkOptions, setFkOptions] = useState<FkOptionsMap>({});

  const [edited, setEdited] = useState<Record<string, Row>>({});
  const [jsonText, setJsonText] = useState<Record<string, Record<string, string>>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  const [newDraft, setNewDraft] = useState<Row>({});
  const [newJsonText, setNewJsonText] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const pageSize = config.pageSize ?? 50;
  // Identifiant stable de cette vue admin : distinct du nom de table SQL
  // quand plusieurs vues partagent la meme table (ex : "products" separe par
  // categorie, decision 40, 11/09/2026 -- voir AdminTableConfig.fixedFilter).
  const configKey = `${config.id ?? config.table}:${config.fixedFilter?.column ?? ""}:${config.fixedFilter?.value ?? ""}`;

  useEffect(() => {
    setPage(0);
    setEdited({});
    setJsonText({});
    setNewDraft({});
    setNewJsonText({});
    setCreateError(null);
    setRowError({});
  }, [configKey]);

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        let query = supabase!.from(config.table).select("*", { count: "exact" });
        if (config.fixedFilter) query = query.eq(config.fixedFilter.column, config.fixedFilter.value);
        if (config.orderBy) query = query.order(config.orderBy, { ascending: true });
        const from = page * pageSize;
        const to = from + pageSize - 1;
        const { data, error, count } = await query.range(from, to);
        if (error) throw error;
        if (!cancelled) {
          setRows(data ?? []);
          setTotalCount(count ?? null);
        }
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey, config.table, config.orderBy, page, pageSize]);

  // Options des selects "cle etrangere" (une requete par table referencee).
  useEffect(() => {
    if (!supabase) return;
    const fks = new Map<string, NonNullable<AdminColumn["fk"]>>();
    config.columns.forEach((c) => {
      if (c.fk) fks.set(c.fk.table, c.fk);
    });
    if (fks.size === 0) {
      setFkOptions({});
      return;
    }
    (async () => {
      const next: FkOptionsMap = {};
      for (const fk of fks.values()) {
        const { data } = await supabase!
          .from(fk.table)
          .select(`${fk.valueKey}, ${fk.labelKey}`)
          .order(fk.labelKey, { ascending: true });
        next[fk.table] = (data ?? []).map((r: any) => ({ value: r[fk.valueKey], label: String(r[fk.labelKey]) }));
      }
      setFkOptions(next);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey]);

  function fieldValue(col: AdminColumn, row: Row | null, isNew: boolean) {
    if (isNew) return newDraft[col.key];
    const patch = row ? edited[row.id] : undefined;
    if (patch && col.key in patch) return patch[col.key];
    return row ? row[col.key] : undefined;
  }

  function setFieldValue(col: AdminColumn, row: Row | null, isNew: boolean, value: unknown) {
    if (isNew) {
      setNewDraft((prev) => ({ ...prev, [col.key]: value }));
      return;
    }
    if (!row) return;
    setEdited((prev) => ({ ...prev, [row.id]: { ...(prev[row.id] ?? {}), [col.key]: value } }));
  }

  function renderInput(col: AdminColumn, row: Row | null, isNew: boolean) {
    const value = fieldValue(col, row, isNew);

    if (col.type === "boolean") {
      return (
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => setFieldValue(col, row, isNew, e.target.checked)} />
      );
    }
    if (col.type === "number") {
      return (
        <input
          type="number"
          step={col.step ?? 1}
          value={value === null || value === undefined ? "" : value}
          onChange={(e) => {
            const raw = e.target.value;
            setFieldValue(col, row, isNew, raw === "" ? (col.nullable ? null : 0) : Number(raw));
          }}
          style={{ width: 100 }}
        />
      );
    }
    if (col.type === "select-enum") {
      return (
        <select value={value ?? ""} onChange={(e) => setFieldValue(col, row, isNew, e.target.value)}>
          {col.nullable && <option value="">-</option>}
          {!value && !col.nullable && <option value="" disabled>-- choisir --</option>}
          {(col.enumOptions ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );
    }
    if (col.type === "select-fk") {
      const options = col.fk ? fkOptions[col.fk.table] ?? [] : [];
      return (
        <select
          value={value ?? ""}
          onChange={(e) => setFieldValue(col, row, isNew, e.target.value === "" ? null : e.target.value)}
        >
          {(col.nullable || !value) && <option value="">-- choisir --</option>}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      );
    }
    if (col.type === "jsonb") {
      const textMap = isNew ? newJsonText : jsonText[row?.id ?? ""] ?? {};
      const textValue = col.key in textMap ? textMap[col.key] : JSON.stringify(value ?? {}, null, 2);
      const setText = (t: string) => {
        if (isNew) {
          setNewJsonText((prev) => ({ ...prev, [col.key]: t }));
        } else if (row) {
          setJsonText((prev) => ({ ...prev, [row.id]: { ...(prev[row.id] ?? {}), [col.key]: t } }));
        }
      };
      return (
        <textarea
          value={textValue}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          style={{ width: 220, fontFamily: "monospace", fontSize: 12 }}
        />
      );
    }
    // text
    return (
      <input
        type="text"
        value={value ?? ""}
        onChange={(e) => setFieldValue(col, row, isNew, e.target.value === "" && col.nullable ? null : e.target.value)}
        style={{ width: 140 }}
      />
    );
  }

  function resolveJsonPatch(col: AdminColumn, row: Row | null, isNew: boolean): { ok: true; value?: unknown } | { ok: false; message: string } {
    const textMap = isNew ? newJsonText : jsonText[row?.id ?? ""] ?? {};
    if (!(col.key in textMap)) return { ok: true };
    const raw = textMap[col.key];
    try {
      return { ok: true, value: raw.trim() === "" ? {} : JSON.parse(raw) };
    } catch {
      return { ok: false, message: `JSON invalide pour "${col.label}"` };
    }
  }

  async function saveRow(row: Row) {
    if (!supabase) return;
    const patch: Row = { ...(edited[row.id] ?? {}) };
    for (const col of config.columns) {
      if (col.type !== "jsonb") continue;
      const result = resolveJsonPatch(col, row, false);
      if (!result.ok) {
        setRowError((prev) => ({ ...prev, [row.id]: result.message }));
        return;
      }
      if ("value" in result) patch[col.key] = result.value;
    }
    if (Object.keys(patch).length === 0) return;
    setSavingId(row.id);
    setRowError((prev) => ({ ...prev, [row.id]: "" }));
    try {
      const { error } = await supabase.from(config.table).update(patch).eq("id", row.id);
      if (error) throw error;
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, ...patch } : r)));
      setEdited((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
      setJsonText((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
    } catch (e) {
      setRowError((prev) => ({ ...prev, [row.id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSavingId(null);
    }
  }

  async function deleteRow(row: Row) {
    if (!supabase) return;
    if (!window.confirm(`Supprimer cette ligne de "${config.label}" ? Cette action est irreversible.`)) return;
    setSavingId(row.id);
    try {
      const { error } = await supabase.from(config.table).delete().eq("id", row.id);
      if (error) throw error;
      setRows((prev) => prev.filter((r) => r.id !== row.id));
    } catch (e) {
      setRowError((prev) => ({ ...prev, [row.id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSavingId(null);
    }
  }

  async function createRow() {
    if (!supabase) return;
    const payload: Row = { ...newDraft };
    // Injecte automatiquement le filtre fixe (ex : category_id de la vue
    // "Panneaux PV"/"Onduleurs"/"Batteries") : l'utilisateur ne le choisit
    // pas, il est implicite a la vue admin ouverte (decision 40).
    if (config.fixedFilter) payload[config.fixedFilter.column] = config.fixedFilter.value;
    for (const col of config.columns) {
      if (col.type !== "jsonb") continue;
      const result = resolveJsonPatch(col, null, true);
      if (!result.ok) {
        setCreateError(result.message);
        return;
      }
      if ("value" in result) payload[col.key] = result.value;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const { data, error } = await supabase.from(config.table).insert(payload).select().single();
      if (error) throw error;
      setRows((prev) => [...prev, data]);
      setTotalCount((prev) => (prev !== null ? prev + 1 : prev));
      setNewDraft({});
      setNewJsonText({});
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  function isDirty(rowId: string) {
    return Boolean(edited[rowId] && Object.keys(edited[rowId]).length > 0) || Boolean(jsonText[rowId] && Object.keys(jsonText[rowId]).length > 0);
  }

  if (!supabase) return <p className="wg-muted">Supabase n'est pas configure.</p>;
  if (loading) return <p className="wg-muted">Chargement de "{config.label}"...</p>;
  if (loadError) {
    return (
      <p className="wg-banner-danger">
        Erreur de chargement ({config.label}) : {loadError}
      </p>
    );
  }

  const from = page * pageSize;
  const to = from + rows.length;
  const hasNext = totalCount !== null ? to < totalCount : rows.length === pageSize;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <p className="wg-muted" style={{ margin: 0 }}>
          {totalCount !== null ? `${totalCount} ligne(s)` : `${rows.length} ligne(s) chargee(s)`} -- affichage {from + 1} a {to}
        </p>
        <div>
          <button disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            Precedent
          </button>
          <button disabled={!hasNext} onClick={() => setPage((p) => p + 1)} style={{ marginLeft: 6 }}>
            Suivant
          </button>
        </div>
      </div>

      <div className="wg-table-wrap">
        <table className="wg-sheet">
          <thead>
            <tr>
              {config.columns.map((col) => (
                <th key={col.key}>{col.label}</th>
              ))}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={isDirty(row.id) ? "wg-row-edited" : undefined}>
                {config.columns.map((col) => (
                  <td key={col.key}>{renderInput(col, row, false)}</td>
                ))}
                <td style={{ whiteSpace: "nowrap" }}>
                  <button className="wg-btn-primary" disabled={savingId === row.id || !isDirty(row.id)} onClick={() => saveRow(row)}>
                    {savingId === row.id ? "..." : "Enregistrer"}
                  </button>
                  <button className="wg-btn-danger" disabled={savingId === row.id} style={{ marginLeft: 6 }} onClick={() => deleteRow(row)}>
                    Supprimer
                  </button>
                  {rowError[row.id] && <div className="wg-banner-danger" style={{ marginTop: 4, padding: "2px 6px" }}>{rowError[row.id]}</div>}
                </td>
              </tr>
            ))}
            <tr className="wg-row-new">
              {config.columns.map((col) => (
                <td key={col.key}>{renderInput(col, null, true)}</td>
              ))}
              <td style={{ whiteSpace: "nowrap" }}>
                <button className="wg-btn-primary" disabled={creating} onClick={createRow}>
                  {creating ? "..." : "Ajouter"}
                </button>
                {createError && <div className="wg-banner-danger" style={{ marginTop: 4, padding: "2px 6px" }}>{createError}</div>}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
