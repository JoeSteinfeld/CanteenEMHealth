import { useEffect, useId, useRef, useState } from "react";

export type ColumnDef<K extends string> = { key: K; label: string };

export type ColumnPrefs<K extends string> = {
  order: K[];
  visible: Record<K, boolean>;
};

type Props<K extends string> = {
  columns: readonly ColumnDef<K>[];
  prefs: ColumnPrefs<K>;
  lockedKeys?: readonly K[];
  onApply: (prefs: ColumnPrefs<K>) => void;
};

function clonePrefs<K extends string>(prefs: ColumnPrefs<K>): ColumnPrefs<K> {
  return {
    order: [...prefs.order],
    visible: { ...prefs.visible },
  };
}

function moveKey<K extends string>(order: K[], fromKey: K, toKey: K): K[] {
  if (fromKey === toKey) return order;
  const from = order.indexOf(fromKey);
  const to = order.indexOf(toKey);
  if (from < 0 || to < 0) return order;
  const next = [...order];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function defaultColumnPrefs<K extends string>(
  columns: readonly ColumnDef<K>[],
  lockedKeys: readonly K[] = [],
): ColumnPrefs<K> {
  const visible = {} as Record<K, boolean>;
  for (const c of columns) visible[c.key] = true;
  for (const k of lockedKeys) visible[k] = true;
  return { order: columns.map((c) => c.key), visible };
}

export function normalizeColumnPrefs<K extends string>(
  columns: readonly ColumnDef<K>[],
  lockedKeys: readonly K[],
  raw: unknown,
): ColumnPrefs<K> {
  const defaults = defaultColumnPrefs(columns, lockedKeys);
  if (!raw || typeof raw !== "object") return defaults;
  const o = raw as { order?: unknown; visible?: unknown };
  const known = new Set(columns.map((c) => c.key));
  const order: K[] = [];
  if (Array.isArray(o.order)) {
    for (const k of o.order) {
      if (typeof k === "string" && known.has(k as K) && !order.includes(k as K)) order.push(k as K);
    }
  }
  for (const c of columns) {
    if (!order.includes(c.key)) order.push(c.key);
  }
  const visible = { ...defaults.visible };
  if (o.visible && typeof o.visible === "object") {
    for (const c of columns) {
      const v = (o.visible as Record<string, unknown>)[c.key];
      if (typeof v === "boolean") visible[c.key] = v;
    }
  }
  for (const k of lockedKeys) visible[k] = true;
  if (!order.some((k) => visible[k])) {
    const fallback = lockedKeys[0] ?? columns[0]?.key;
    if (fallback) visible[fallback] = true;
  }
  return { order, visible };
}

export function visibleColumnsInOrder<K extends string>(
  columns: readonly ColumnDef<K>[],
  prefs: ColumnPrefs<K>,
): ColumnDef<K>[] {
  const byKey = new Map(columns.map((c) => [c.key, c]));
  return prefs.order.filter((k) => prefs.visible[k]).map((k) => byKey.get(k)!).filter(Boolean);
}

export function ColumnPicker<K extends string>({ columns, prefs, lockedKeys = [], onApply }: Props<K>) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => clonePrefs(prefs));
  const [dragKey, setDragKey] = useState<K | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const locked = new Set(lockedKeys);
  const labelByKey = new Map(columns.map((c) => [c.key, c.label]));

  useEffect(() => {
    if (!open) return;
    setDraft(clonePrefs(prefs));
    setDragKey(null);
  }, [open, prefs]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const defaults = defaultColumnPrefs(columns, lockedKeys);

  return (
    <div className="column-picker" ref={rootRef}>
      <button
        type="button"
        className={`column-picker-trigger${open ? " is-open" : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? titleId : undefined}
        title="Show, hide, and reorder columns"
        onClick={() => setOpen((v) => !v)}
      >
        <ColumnsIcon />
        <span className="sr-only">Columns</span>
      </button>
      {open && (
        <div className="column-picker-popover" role="dialog" aria-labelledby={titleId}>
          <div className="column-picker-header" id={titleId}>
            Columns
          </div>
          <ul className="column-picker-list" role="list">
            {draft.order.map((key) => {
              const isLocked = locked.has(key);
              const checked = draft.visible[key];
              return (
                <li
                  key={key}
                  className={`column-picker-item${dragKey === key ? " is-dragging" : ""}${isLocked ? " is-locked" : ""}`}
                  draggable
                  onDragStart={(e) => {
                    setDragKey(key);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", String(key));
                  }}
                  onDragEnd={() => setDragKey(null)}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dragKey && dragKey !== key) {
                      setDraft((prev) => ({ ...prev, order: moveKey(prev.order, dragKey, key) }));
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragKey(null);
                  }}
                >
                  <label className="column-picker-label">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={isLocked}
                      onChange={() => {
                        if (isLocked) return;
                        setDraft((prev) => ({
                          ...prev,
                          visible: { ...prev.visible, [key]: !prev.visible[key] },
                        }));
                      }}
                    />
                    <span>{labelByKey.get(key) ?? key}</span>
                  </label>
                  <span className="column-picker-handle" aria-hidden title="Drag to reorder">
                    <DragHandleIcon />
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="column-picker-footer">
            <button
              type="button"
              className="column-picker-reset"
              onClick={() => setDraft(clonePrefs(defaults))}
            >
              Reset
            </button>
            <div className="column-picker-footer-right">
              <button type="button" className="column-picker-cancel" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="column-picker-apply"
                onClick={() => {
                  const next = clonePrefs(draft);
                  for (const k of lockedKeys) next.visible[k] = true;
                  if (!next.order.some((k) => next.visible[k])) {
                    const fallback = lockedKeys[0] ?? columns[0]?.key;
                    if (fallback) next.visible[fallback] = true;
                  }
                  onApply(next);
                  setOpen(false);
                }}
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ColumnsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.5" y="2" width="3.5" height="12" rx="0.75" fill="currentColor" />
      <rect x="6.25" y="2" width="3.5" height="12" rx="0.75" fill="currentColor" />
      <rect x="11" y="2" width="3.5" height="12" rx="0.75" fill="currentColor" />
    </svg>
  );
}

function DragHandleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M2 4.5h10M2 7h10M2 9.5h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
