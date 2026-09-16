// Single source of truth for the UI palette. Tweak here to retheme.
// Pattern across the app: accent = brand/focus, secondary = muted, warning = wait,
// error = problem, success = additions.

export const theme = {
  accent: '#d68cd6', // soft orchid magenta — pastel but luminous enough to read as focus/selection
  inlineCode: '#d7a8d7', // soft magenta echoing the accent, readable in prose
  tool: '#c8c8c8',
  info: 'cyan',
  secondary: '#a0a0a0',
  muted: '#808080',
  reasoning: '#6495ed', // cornflower blue: thinking-block bar, dimmer than the accent
  warning: '#e5d49a', // soft pastel yellow — luminous but easy on the eyes, matches the other accents
  queued: '#e8b87a', // soft pastel orange — `next ›` label on the queued list, complements the yellow warning
  // The `▎` bar on a nested (subagent) user bubble. `▎` is a legend, not decoration: the same
  // glyph marks the Thinking block (reasoning) and the user speaking (accent), so the color IS
  // the attribution. This is deliberately NOT `queued` — that orange marks the user's own words
  // waiting to be sent, and a queued message sits in the chrome while a subagent runs, so the two
  // would collide on the exact axis #172 exists to disambiguate. Apricot instead: it echoes the
  // syntax theme's number/literal tone (highlight.ts), which makes no claim about who is speaking.
  subagent: '#e0b48f',
  // The `auto approve` badge in the status line. A standing mode, not a warning event, so it
  // does not take `warning`: the context gauge in the same line turns yellow at 80% fill and
  // the two were indistinguishable side by side. Soft coral — one step below the `bypass
  // approvals` red on the same severity ladder, and off the `queued` orange that also lives
  // in the chrome.
  autoApprove: '#e8a090',
  error: 'red',
  success: 'green',
  userBg: '#303030',
  // Status-line mode tags. Every mode gets its own soft hue so the tag reads at a glance
  // (none of them near the yellow warning); the heavily-used modes take the brighter pastels
  // and the secondary ones sit a step back in saturation.
  modeAgent: '#d7a8d7', // soft magenta, echoes inlineCode — the default workhorse
  modePlan: '#8fd0c8', // soft teal-cyan; also the plan-checklist header (PlanProgress) — teal = plan everywhere
  modeVibe: '#b4aee0', // soft periwinkle between plan teal and agent magenta — vibe runs both phases
  // Heather: a desaturated violet, greyer and darker than the vibe periwinkle and agent magenta
  // on either side of it in hue. Purple-tinted so it no longer reads as a disabled/grey chip
  // (#380), but the low saturation keeps it a secondary mode that recedes next to the two
  // pastel workhorses.
  modeChat: '#a892c4',
  modeShell: '#9fd49f', // soft green, tied to the $ prompt
} as const;
