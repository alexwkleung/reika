// Display-only redaction of code-signing & notarization secrets that surface in
// build output (electron-builder, codesign, notarytool, `security`). Like
// scrubPaths, this NEVER touches what's sent to the model — only the rendered
// strings in scrollback/summary.
//
// Deliberately conservative and KEY-ANCHORED: we redact values attached to known
// signing/notarization keys (or the distinctive Apple identity phrase), never a
// blanket hex/secret sweep. A bare 40-hex token elsewhere in build output (a git
// SHA, a build id) is left untouched — over-scrubbing legitimate output would be
// worse than the leak it prevents.
const REDACTED = '<redacted>';

// Apple certificate-type prefixes that precede a "Name (TEAMID)" identity.
const CERT_TYPES =
  'Apple Development|Apple Distribution|Developer ID Application|Developer ID Installer|Mac Developer|iPhone Developer|iPhone Distribution';

const RULES: Array<[RegExp, string]> = [
  // Bare cert SHA-1 immediately preceding a quoted signing identity, e.g.
  // `security find-identity` → `  1) <40hex> "Developer ID …"`. The lookahead
  // keeps this from matching git SHAs and other bare hashes. Must run BEFORE the
  // phrase rule below, which would otherwise rewrite the quoted identity and
  // break this lookahead.
  [/\b[0-9A-Fa-f]{40}\b(?=\s+"(?:Apple|Developer|Mac|iPhone))/g, REDACTED],
  // Signing-identity phrase: "Developer ID Application: Jane Dev (AB12CD34EF)".
  // Covers identityName=…, quoted forms, and `security find-identity` output.
  [new RegExp(`(?:${CERT_TYPES}): [^"()]*\\([A-Z0-9]{10}\\)`, 'g'), REDACTED],
  // identityHash=<40hex>
  [/(identityHash=)[0-9A-Fa-f]{40}/g, `$1${REDACTED}`],
  // Apple app-specific password: xxxx-xxxx-xxxx-xxxx (lowercase letters).
  [/\b[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}\b/g, REDACTED],
  // provisioningProfile=<name|path>. Left visible for the harmless non-values
  // null/none so we don't add confusing noise.
  [/(provisioningProfile=)(?!(?:null|none)\b)\S+/gi, `$1${REDACTED}`],
  // Notarization / signing key=value fields (electron-builder log style). The
  // bare `identity=`/`identityName=` keys cover electron-builder's `signing`
  // line, whose value is a single-token fingerprint or short name that the
  // identity-phrase rule above (which needs a "(TEAMID)" parenthetical) misses.
  [
    /\b(appleId|appleIdPassword|appleApiKey|appleApiKeyId|appleApiIssuer|teamId|ascProvider|identity|identityName|installerIdentity)=\S+/gi,
    `$1=${REDACTED}`,
  ],
  // Notarization CLI flags: --apple-id <v>, --team-id=<v>, etc. The (?!-) guard
  // avoids swallowing a following flag when a value is absent.
  [
    /(--(?:apple-id|apple-id-password|apple-api-key|apple-api-key-id|apple-api-issuer|team-id|asc-provider))([= ]+)(?!-)\S+/g,
    `$1$2${REDACTED}`,
  ],
];

export function redactSecrets(s: string): string {
  let out = s;
  for (const [re, repl] of RULES) out = out.replace(re, repl);
  return out;
}
