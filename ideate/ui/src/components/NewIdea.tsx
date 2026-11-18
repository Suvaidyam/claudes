import { useEffect, useState } from "react";
import { createIdea, getConfig, type NewIdeaBody, type UiConfig } from "../api";
import { browserStorage, clearSentText, draftKey, loadText, saveText, settleSentText } from "../lib/drafts";
import { ComposerBox } from "./Composer";
import { SettingsPopover, type NewIdeaSettings } from "./SettingsPopover";

const NEW_KEY = draftKey("new");

/** The composer of an empty conversation: the brief typed here starts a new idea. */
export function NewIdea({ onCreated, onError }: { onCreated(id: string): void; onError(message: string): void }) {
  // Kept in localStorage: opening another idea or closing the tab doesn't lose a half-typed brief.
  const [brief, setBrief] = useState(() => loadText(browserStorage(), NEW_KEY));
  const [config, setConfig] = useState<UiConfig>();
  const [settings, setSettings] = useState<NewIdeaSettings>();
  const [sending, setSending] = useState(false);

  useEffect(() => {
    getConfig().then(
      (c) => { setConfig(c); setSettings({ rounds: Math.min(20, c.maxRounds), reviewers: c.secondaries }); },
      () => { /* settings stay hidden: the server's defaults apply */ },
    );
  }, []);
  useEffect(() => saveText(browserStorage(), NEW_KEY, brief), [brief]);

  const send = () => {
    if (!brief.trim() || sending) return;
    const body: NewIdeaBody = { brief };
    // Only what the owner changed: otherwise the config's defaults apply.
    if (config && settings) {
      if (settings.rounds !== Math.min(20, config.maxRounds)) body.rounds = settings.rounds;
      if (settings.reviewers.length !== config.secondaries.length) body.reviewers = settings.reviewers;
    }
    setSending(true);
    createIdea(body).then(
      ({ id }) => {
        // Clear only what was sent: text typed while the request was in flight stays.
        settleSentText(browserStorage(), NEW_KEY, body.brief);
        setBrief((cur) => clearSentText(cur, body.brief));
        setSending(false);
        onCreated(id);
      },
      (e: Error) => { setSending(false); onError(e.message); },
    );
  };

  return (
    <ComposerBox value={brief} onChange={setBrief} onEnter={send} placeholder="Describe the idea…" autoFocus>
      {config && settings && <SettingsPopover config={config} value={settings} onChange={setSettings} />}
      <button type="button" className="send" onClick={send} disabled={!brief.trim() || sending} aria-label="Start">↑</button>
    </ComposerBox>
  );
}
