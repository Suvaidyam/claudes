/**
 * Unsent text survives navigation, reloads and a closed tab: drafts live in localStorage, one per
 * idea ("new" for the new-idea composer). Storage may be missing or throw (private mode, quota),
 * so every access is guarded and the app works without it. After a send only what was sent is
 * cleared: anything typed while the request was in flight stays.
 */
import { EMPTY_DRAFT, type Draft } from "./composer";

export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const draftKey = (id: string) => `ideate.draft.${id}`;

/** window.localStorage when the browser allows it. */
export function browserStorage(): DraftStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function read(store: DraftStorage | undefined, key: string): unknown {
  try {
    const raw = store?.getItem(key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

function write(store: DraftStorage | undefined, key: string, value: unknown, empty: boolean): void {
  try {
    if (empty) store?.removeItem(key);
    else store?.setItem(key, JSON.stringify(value));
  } catch {
    /* no storage: the draft lives only in memory */
  }
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export function loadDraft(store: DraftStorage | undefined, key: string): Draft {
  const v = read(store, key) as Partial<Draft> | undefined;
  if (!v || typeof v.text !== "string" || !strings(v.scenarios) || !strings(v.reopen)) return EMPTY_DRAFT;
  const more = typeof v.more === "number" && Number.isInteger(v.more) && v.more > 0 ? v.more : undefined;
  return { text: v.text, scenarios: v.scenarios, reopen: v.reopen, ...(more !== undefined ? { more } : {}) };
}

const isEmptyDraft = (d: Draft) => !d.text && !d.scenarios.length && !d.reopen.length && d.more === undefined;

export const saveDraft = (store: DraftStorage | undefined, key: string, d: Draft): void =>
  write(store, key, d, isEmptyDraft(d));

export function loadText(store: DraftStorage | undefined, key: string): string {
  const v = read(store, key);
  return typeof v === "string" ? v : "";
}

export const saveText = (store: DraftStorage | undefined, key: string, text: string): void =>
  write(store, key, text, !text);

/** `current` without what `sent` carried; text edited since the send is kept whole. */
export function clearSent(current: Draft, sent: Draft): Draft {
  const scenarios = [...current.scenarios];
  for (const s of sent.scenarios) {
    const i = scenarios.indexOf(s);
    if (i >= 0) scenarios.splice(i, 1);
  }
  const more = current.more === sent.more ? undefined : current.more;
  return {
    text: clearSentText(current.text, sent.text),
    scenarios,
    reopen: current.reopen.filter((r) => !sent.reopen.includes(r)),
    ...(more !== undefined ? { more } : {}),
  };
}

export const clearSentText = (current: string, sent: string): string => (current === sent ? "" : current);

/** Clears what was sent from the stored draft (the composer may have been unmounted meanwhile). */
export const settleSent = (store: DraftStorage | undefined, key: string, sent: Draft): void =>
  saveDraft(store, key, clearSent(loadDraft(store, key), sent));

export const settleSentText = (store: DraftStorage | undefined, key: string, sent: string): void =>
  saveText(store, key, clearSentText(loadText(store, key), sent));
