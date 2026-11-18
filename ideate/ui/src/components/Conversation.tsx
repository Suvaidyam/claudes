import type { ChatMessage, IdeaDetail } from "../../../src/ui/types";
import type { LiveTurn } from "../lib/liveStream";
import { LiveMessage } from "./LiveMessage";
import { Message, type EndActions } from "./Message";

/** The formatted messages, with the live turns after the last round and before queued input / the end card. */
export function Conversation({ detail, messages: msgs, live, actions }: {
  detail: IdeaDetail;
  /** detail.messages, plus any just-sent (optimistic) ones. */
  messages: ChatMessage[];
  live: LiveTurn[];
  actions: EndActions;
}) {
  const at = msgs.findIndex((m) => m.kind === "queued" || m.kind === "end");
  const split = at < 0 ? msgs.length : at;
  const secondaries = detail.state.secondaries;
  return (
    <>
      {msgs.slice(0, split).map((m) => <Message key={m.key} msg={m} secondaries={secondaries} />)}
      {live.map((t) => <LiveMessage key={`live-${t.call}`} turn={t} secondaries={secondaries} />)}
      {msgs.slice(split).map((m) => <Message key={m.key} msg={m} secondaries={secondaries} actions={actions} />)}
    </>
  );
}
