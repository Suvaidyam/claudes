/** Pure pieces of the composer: what a draft sends, and how it shows before the server confirms it. */
import type { ChatMessage } from "../../../src/ui/types";
import type { MessageBody } from "../api";

export interface Draft {
  /** Sent as the note. */
  text: string;
  scenarios: string[];
  /** Issue refs to reopen. */
  reopen: string[];
  /** Extra rounds; undefined leaves the default (2 when continuing, none while active). */
  more?: number;
}
export const EMPTY_DRAFT: Draft = { text: "", scenarios: [], reopen: [] };

/** The message a draft sends, or undefined when there is nothing to send. */
export function messageBody(d: Draft): MessageBody | undefined {
  const body: MessageBody = {};
  if (d.text.trim()) body.note = d.text;
  if (d.scenarios.length) body.scenarios = d.scenarios;
  if (d.reopen.length) body.reopen = d.reopen;
  if (d.more !== undefined) body.more = d.more;
  return Object.keys(body).length ? body : undefined;
}

/** Queued bubbles for a message just sent, one per inbox item (as the server will list them). */
export function optimisticMessages(body: MessageBody, round: number, status: string, keyPrefix: string): ChatMessage[] {
  const owners: NonNullable<ChatMessage["owner"]>[] = [];
  if (body.note?.trim()) owners.push({ scenarios: [], reopened: [], note: body.note });
  for (const s of body.scenarios ?? []) owners.push({ scenarios: [`New: ${s}`], reopened: [] });
  for (const r of body.reopen ?? []) owners.push({ scenarios: [], reopened: [r] });
  if (body.more !== undefined) owners.push({ scenarios: [], reopened: [], more: body.more });
  return owners.map((owner, i) => ({ key: `${keyPrefix}-${i}`, speaker: "you", name: "You", round, status, kind: "queued", owner }));
}

/** `pending` goes after the queued items, before the end card. */
export function withOptimistic(messages: ChatMessage[], pending: ChatMessage[]): ChatMessage[] {
  if (!pending.length) return messages;
  const end = messages.findIndex((m) => m.kind === "end");
  const at = end < 0 ? messages.length : end;
  return [...messages.slice(0, at), ...pending, ...messages.slice(at)];
}

/** Within a few lines of the bottom: the thread keeps following new text. */
export const isNearBottom = (el: { scrollTop: number; scrollHeight: number; clientHeight: number }): boolean =>
  el.scrollHeight - el.scrollTop - el.clientHeight < 48;
