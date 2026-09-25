import type { ApprovalRequest, AutoApproveMode, Config, ToolContext } from './types.js';

// Whether an approval request runs without asking. The one rule both front-ends share (#52):
// `safe` approves anything the danger scan didn't flag, `off` approves nothing, and `bypass`
// never gets here — a caller in that mode passes no `requestApproval` at all, so the tools skip
// the gate entirely. What a `false` means is the caller's: the TUI opens the prompt, headless
// declines, since there is no one to ask.
export function autoApproves(mode: AutoApproveMode, req: ApprovalRequest): boolean {
  if (mode !== 'safe') return false;
  return !req.warnings || req.warnings.length === 0;
}

// Whether the env var decided the mode: an explicit `safe`/`bypass` shadows the session toggle.
// An explicit `off` does not — the "Always (this session)" choice on a prompt must still be able
// to lift it, exactly as it could before `safe` became the unset default.
export function autoApproveForced(
  config: Pick<Config, 'autoApprove' | 'autoApproveExplicit'>,
): boolean {
  return config.autoApproveExplicit === true && config.autoApprove !== 'off';
}

// The mode the TUI runs under: forced env, else the session toggle, else the config's own
// default. `session` is null until the user toggles it, so a default `safe` stays `safe` and an
// explicit `off` stays `off` without either being copied into React state at load time.
export function effectiveAutoApprove(
  config: Pick<Config, 'autoApprove' | 'autoApproveExplicit'> | null,
  session: boolean | null,
): AutoApproveMode {
  if (!config) return 'off';
  if (autoApproveForced(config)) return config.autoApprove;
  const on = session ?? config.autoApprove === 'safe';
  return on ? 'safe' : 'off';
}

// What a tool reports when its approval came back false. `target` is the tail the summary always
// carried (`: <command>`, ` for <path>`), so the attended wording is unchanged. Unattended (#526)
// the decline is nobody's answer, and saying "by user" makes a model stop or ask again; the
// wording steers it to go on without the step and leave it for the human.
export function declineSummary(
  action: string,
  target: string,
  ctx: Pick<ToolContext, 'unattended'>,
): string {
  if (!ctx.unattended) return `${action} declined by user${target}`;
  return `${action} not run${target} — unattended session, nobody to approve it. Carry on without it, or leave it for the user in your final reply.`;
}
