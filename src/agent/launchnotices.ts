import type { Config, Message, Mode } from '../types.js';

// What the session found at boot that the user has to see, in the session's own words.
export type LaunchFacts = {
  // The model the session opened on.
  model: string;
  limitsNotice?: string;
  windowNotice?: string;
  budgetWarning?: string;
  offline: boolean;
  searchNotice?: string;
  mcpNotices: string[];
};

const OFFLINE_NOTICE =
  'No network — search and fetch_url tools are off for this session. Restart Reika once you are back online to get them back.';

// The lines a front end prints under the splash, in order. Every one is `skipAutosave`: they
// describe this launch, and a resume would replay and stack them.
export function buildLaunchNotices(input: {
  facts: LaunchFacts;
  config: Pick<Config, 'modeModelErrors' | 'projectEnvNotice'>;
  mode: Mode;
  defaultMode: Mode;
  profile: string;
}): Message[] {
  const { facts, config, mode, defaultMode, profile } = input;
  const notices: Message[] = [];
  const say = (content: string, tone?: 'info' | 'warn'): void => {
    notices.push({ role: 'system', content, ...(tone ? { tone } : {}), skipAutosave: true });
  };
  // Opening somewhere other than where the env alone would put the session is a fact the user has
  // to see — a plan-mode start answers a task with a plan, not edits — so it gets a persistent
  // line, not just the status-bar tag.
  const resumed = [
    ...(mode !== defaultMode ? [`${mode} mode`] : []),
    ...(profile !== 'default' ? [`profile '${profile}' (${facts.model})`] : []),
  ];
  if (resumed.length > 0) say(`Resumed ${resumed.join(' and ')} from the last session.`);
  if (facts.limitsNotice) say(facts.limitsNotice);
  if (facts.windowNotice) say(facts.windowNotice, 'warn');
  // A window/reserve split that leaves too little room degrades silently — reads truncated every
  // round, the model re-reading the same file (#262).
  if (facts.budgetWarning) say(facts.budgetWarning, 'warn');
  if (facts.offline) say(OFFLINE_NOTICE, 'warn');
  if (facts.searchNotice) say(facts.searchNotice, 'info');
  // A REIKA_MODE_MODELS entry that named nothing the config has (#616): the mode keeps the
  // session's model, which reads as the feature not working unless the typo is named.
  for (const problem of config.modeModelErrors ?? []) say(problem, 'warn');
  if (config.projectEnvNotice) say(config.projectEnvNotice, 'warn');
  // The healthy MCP summary is the only good news (#265). Keying on the failure wording instead
  // would miss `REIKA_MCP_SERVERS: …`, the case where no server started at all.
  for (const notice of facts.mcpNotices) say(notice, notice.startsWith('MCP: ') ? 'info' : 'warn');
  return notices;
}
