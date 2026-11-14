import type { AutoApproveMode } from '../types.js';

// `/approvals`, `/unattended` and `/anon`: three switches a user flips mid-session. This module
// decides what a typed command comes to and what each line says; a front end asks when the bare
// command needs a pick, and the controller flips the switch.

export type ToggleName = 'approvals' | 'unattended' | 'anon';

export type ToggleContext = {
  // The mode approvals run under now, and whether REIKA_AUTO_APPROVE forced it, which shadows
  // the session's own toggle.
  autoApprove: AutoApproveMode;
  autoApproveForced: boolean;
  // What the config itself says, for the status page a forced session gets.
  configAutoApprove: AutoApproveMode | undefined;
  unattended: boolean;
  anon: boolean;
};

export type ToggleCommand =
  | { kind: 'reply'; content: string }
  // The bare command (#625): a user typing it without on/off is reaching for the switch, so they
  // are asked. `currentlyOn` is the row to start on, so Enter alone changes nothing.
  | { kind: 'ask'; toggle: ToggleName; title: string; subtitle: string; currentlyOn: boolean }
  | { kind: 'set'; toggle: ToggleName; on: boolean };

// Null when `name` is not one of the three.
export function resolveToggleCommand(
  name: string,
  args: string,
  ctx: ToggleContext,
): ToggleCommand | null {
  const arg = args.trim().toLowerCase();
  const explicit = arg === 'on' || arg === 'off';
  if (name === 'approvals') {
    if (explicit) {
      if (ctx.autoApproveForced) {
        return {
          kind: 'reply',
          content: `auto-approve is forced to '${ctx.configAutoApprove}' by REIKA_AUTO_APPROVE; session toggle has no effect.`,
        };
      }
      return { kind: 'set', toggle: 'approvals', on: arg === 'on' };
    }
    if (arg) return unknownArgument('approvals', arg);
    if (!ctx.autoApproveForced) {
      return {
        kind: 'ask',
        toggle: 'approvals',
        title: 'Approvals',
        subtitle: `session auto-approve: ${ctx.autoApprove} — toggle on or off?`,
        currentlyOn: ctx.autoApprove === 'safe',
      };
    }
    // A forced session keeps the status page: the toggle is shadowed, so a dialog has nothing
    // to pick.
    const mode = ctx.configAutoApprove ?? 'safe';
    return {
      kind: 'reply',
      content: [
        `auto-approve: ${mode}`,
        mode === 'bypass'
          ? '  bypass — everything runs without confirmation, including dangerous commands'
          : '  safe — ordinary actions auto-run; dangerous commands still prompt',
        `  source: REIKA_AUTO_APPROVE=${ctx.configAutoApprove} (env)`,
        ...(ctx.unattended
          ? ['  unattended: on — anything that would prompt is declined instead (/unattended off)']
          : []),
        '',
        'env REIKA_AUTO_APPROVE forces this; session toggle is shadowed',
      ].join('\n'),
    };
  }
  if (name === 'unattended' || name === 'anon') {
    if (explicit) return { kind: 'set', toggle: name, on: arg === 'on' };
    if (arg) return unknownArgument(name, arg);
    const currentlyOn = name === 'unattended' ? ctx.unattended : ctx.anon;
    return {
      kind: 'ask',
      toggle: name,
      title: name === 'unattended' ? 'Unattended' : 'Anonymize',
      subtitle: `currently ${currentlyOn ? 'on' : 'off'} — toggle on or off?`,
      currentlyOn,
    };
  }
  return null;
}

function unknownArgument(name: ToggleName, arg: string): ToggleCommand {
  return {
    kind: 'reply',
    content: `Unknown argument: ${arg}. Use /${name} on or /${name} off.`,
  };
}

// The line a switch prints once it is flipped. `identity` is what turning anonymize on found.
export function toggleReceipt(
  toggle: ToggleName,
  on: boolean,
  identity?: { names: number; emails: number },
): string {
  if (toggle === 'approvals') return `Session auto-approve: ${on ? 'on' : 'off'}`;
  if (toggle === 'unattended') {
    // ask_user is fixed at launch (the tool list is the cached prefix), so a session that started
    // attended keeps it; while unattended, its questions resolve as "no user available".
    return on
      ? 'unattended: on — anything that would prompt is declined and listed at turn end; questions go unanswered. /unattended off to approve again.'
      : 'unattended: off — approvals and questions prompt again.';
  }
  if (!on) return 'anonymize: off — names, emails and account slugs render verbatim again';
  const names = identity?.names ?? 0;
  const emails = identity?.emails ?? 0;
  return [
    'anonymize: on',
    names + emails === 0
      ? '  no identity found (no git config, no remote) — nothing to substitute'
      : `  substituting ${names} name(s) → <user>, ${emails} email(s) → <email>`,
    // Rows already on screen are not redrawn, while a save re-serializes everything, so it is
    // retroactive. Said here, or the untouched lines above read as a bug.
    '  applies to new output and to /save; run /clear to scrub what is above',
  ].join('\n');
}
