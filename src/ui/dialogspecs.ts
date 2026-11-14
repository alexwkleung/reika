import type { SkillMatch } from '../skills/skillmatch.js';

// The dialogs' rows and specs, apart from the Ink components that draw them: headless asks the
// same questions on a terminal line (#872) and must not load Ink to do it.

// The last row declines with a reason the user types into the input box below. Last, not beside
// Decline, so the rows Approval-trained fingers already know keep their places.
export const APPROVAL_OPTIONS = [
  'Approve',
  'Decline',
  'Always (this session)',
  'Decline, and say what to do instead',
] as const;
export const APPROVAL_FEEDBACK_INDEX = 3;

// Row 0 is "send as typed" and starts selected — the inverse of Approval, where Approve is row 0.
// There the model has already committed to an action; here nothing has happened yet and the
// literal prompt is what was asked for. A wrong default that acts costs a turn (or a request
// nobody meant); a wrong default that doesn't costs a keystroke.
export const CONFIRM_DECLINE = 0;
export const CONFIRM_ACCEPT = 1;

// What the harness is asking about. Three askers share the dialog: a strongly matched skill
// (#425), a pasted link the prompt is not obviously about (#448), and the mode /implement runs in
// (#561). Same frame, same keys, row 0 the default — the user learns one widget.
export type ConfirmSpec = {
  // `• <title>` in the tool color, `<subtitle>` beside it in secondary.
  title: string;
  subtitle: string;
  // Muted lines under the header: the matched phrases, the links.
  details: string[];
  options: string[];
  // The footer's "y = <accept>" word, for a yes/no ask whose accepting row is CONFIRM_ACCEPT. A
  // pick among peers has no "yes", so it binds no y/n.
  accept?: string;
};

export function skillConfirmSpec(match: SkillMatch): ConfirmSpec {
  return {
    title: 'Skill',
    subtitle: `/${match.skill.name} — ${match.skill.description}`,
    details: [`matched: ${match.matched.join(', ')}`],
    options: ['Send as typed', `Apply /${match.skill.name}`],
    accept: 'apply',
  };
}

// A long URL wraps the frame; the user just typed it, so the head is enough to recognize it.
const URL_DISPLAY_CHARS = 90;

export function pastedUrlConfirmSpec(urls: string[]): ConfirmSpec {
  const n = urls.length;
  return {
    title: n > 1 ? 'Pasted links' : 'Pasted link',
    subtitle: `the prompt doesn't read as a request to open ${n > 1 ? 'them' : 'it'} — fetch before the turn?`,
    details: urls.map(u =>
      u.length > URL_DISPLAY_CHARS ? `${u.slice(0, URL_DISPLAY_CHARS)}…` : u,
    ),
    options: ['Send as typed', `Fetch ${n > 1 ? `${n} links` : 'the link'}`],
    accept: 'fetch',
  };
}

// The toggle dialogs for /approvals, /unattended and /anon (#625): a bare command without on/off
// asks instead of printing the arg-less default. Row 0 is 'on', row 1 'off', row 2 'Cancel',
// fixed across opens so the digits stay stable; which row starts selected follows the current
// state, so a bare Enter (or the digit for the current state) changes nothing — the same
// default-as-least-action rule as the other picks.
export const TOGGLE_ON = 0;
export const TOGGLE_OFF = 1;
export const TOGGLE_CANCEL = 2;

export function toggleConfirmSpec(opts: { title: string; subtitle: string }): ConfirmSpec {
  return {
    title: opts.title,
    subtitle: opts.subtitle,
    details: [],
    options: ['on', 'off', 'Cancel'],
  };
}
