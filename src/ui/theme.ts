// Single source of truth for the UI palette. Tweak here to retheme.
// Pattern across the app: accent = brand/focus, secondary = muted, warning = wait,
// error = problem, success = additions.

export const theme = {
  accent: '#d68cd6', // soft orchid magenta — pastel but luminous enough to read as focus/selection
  // Soft lilac: the one purple slot the palette had free — redder and brighter than the vibe
  // periwinkle, far off the link blue, lighter and more saturated than the chat heather, and a
  // clear step back from the orchid accent so code in prose no longer reads as a pink highlight.
  // Unbolded on purpose: code recurs several times a line, and bold stacked on the hue (and
  // brightened by some terminals) made it outweigh the prose it sits in.
  inlineCode: '#d5afee',
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
  modeAgent: '#d7a8d7', // soft magenta, echoes the accent — the default workhorse
  modePlan: '#8fd0c8', // soft teal-cyan; also the plan-checklist header (PlanProgress) — teal = plan everywhere
  modeVibe: '#b4aee0', // soft periwinkle between plan teal and agent magenta — vibe runs both phases
  // Heather: a desaturated violet, greyer and darker than the vibe periwinkle and agent magenta
  // on either side of it in hue. Purple-tinted so it no longer reads as a disabled/grey chip
  // (#380), but the low saturation keeps it a secondary mode that recedes next to the two
  // pastel workhorses.
  // Minimal: a desaturated slate, deliberately the quietest of the work-mode tags — the mode is
  // the harness doing LESS, and the chip should not read as louder than agent's.
  modeMinimal: '#9aa8b8',
  modeChat: '#a892c4',
  modeShell: '#9fd49f', // soft green, tied to the $ prompt
  // URLs in the model's prose: bare ones and the `(href)` of a markdown link. They were
  // chalk.dim, which on a light-on-dark terminal is a fainter white — indistinguishable from
  // the surrounding sentence (#397). A creamy lavender-blue: bluer and paler than the vibe
  // periwinkle so a link never reads as a mode tag, and well off the reasoning cornflower
  // that marks the Thinking bar. Underlined only on terminals that take OSC 8 hyperlinks
  // (markdown.ts): an underline promises a click, and elsewhere there is none to deliver.
  link: '#aac0f0',
} as const;
