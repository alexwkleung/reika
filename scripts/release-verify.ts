// Checks that a release agrees everywhere it lives: package.json, npm, the Homebrew tap and the
// GitHub release. Run after publishing (RELEASING.md); exits non-zero on any disagreement.
// Hashes are computed from the downloaded bytes rather than trusted from metadata, since the
// point is that every channel serves the one tarball release:check built.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const TAP_FORMULA_API =
  'https://api.github.com/repos/alexwkleung/homebrew-tap/contents/Formula/reika.rb';
const RELEASE_API = 'https://api.github.com/repos/alexwkleung/reika/releases/latest';

// The contents API, not raw.githubusercontent.com, whose CDN serves a stale formula for minutes
// after a push. A token (CI's GITHUB_TOKEN) only lifts the 60-requests-an-hour anonymous limit.
const githubHeaders: Record<string, string> = process.env.GITHUB_TOKEN
  ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
  : {};

async function fetchOk(url: string, headers: Record<string, string> = {}): Promise<Response> {
  const res = await fetch(url, { headers: { 'user-agent': 'reika-release-verify', ...headers } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

async function sha256Of(url: string, headers: Record<string, string> = {}): Promise<string> {
  const bytes = Buffer.from(await (await fetchOk(url, headers)).arrayBuffer());
  return createHash('sha256').update(bytes).digest('hex');
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string;
  version: string;
};

const npmDoc = (await (
  await fetchOk(`https://registry.npmjs.org/${pkg.name.replace('/', '%2f')}`)
).json()) as {
  'dist-tags': { latest: string };
  versions: Record<string, { dist: { tarball: string } }>;
};
const npmVersion = npmDoc['dist-tags'].latest;
const npmTarball = npmDoc.versions[npmVersion].dist.tarball;

const formula = await (
  await fetchOk(TAP_FORMULA_API, { ...githubHeaders, accept: 'application/vnd.github.raw' })
).text();
const tapUrl = formula.match(/^\s*url "([^"]+)"/m)?.[1] ?? '(none)';
const tapSha = formula.match(/^\s*sha256 "([0-9a-f]{64})"/m)?.[1] ?? '(none)';
const tapVersion = tapUrl.match(/-(\d+\.\d+\.\d+[^/]*)\.tgz$/)?.[1] ?? '(none)';

const release = (await (await fetchOk(RELEASE_API, githubHeaders)).json()) as {
  tag_name: string;
  assets: { name: string; browser_download_url: string }[];
};
const releaseAsset = release.assets.find(a => a.name.endsWith('.tgz'));

const [npmSha, releaseSha] = await Promise.all([
  sha256Of(npmTarball),
  releaseAsset ? sha256Of(releaseAsset.browser_download_url) : Promise.resolve('(no .tgz asset)'),
]);

const checks: [string, boolean, string][] = [
  [
    'package.json version is npm latest',
    pkg.version === npmVersion,
    `${pkg.version} vs ${npmVersion}`,
  ],
  ['tap formula is at npm latest', tapVersion === npmVersion, `${tapVersion} vs ${npmVersion}`],
  ['tap url is the npm tarball', tapUrl === npmTarball, tapUrl],
  [
    'tap sha256 is the npm tarball',
    tapSha === npmSha,
    `${tapSha.slice(0, 12)}… vs ${npmSha.slice(0, 12)}…`,
  ],
  [
    'latest GitHub release tags npm latest',
    release.tag_name === `v${npmVersion}`,
    release.tag_name,
  ],
  ['release asset is the npm tarball', releaseSha === npmSha, `${releaseSha.slice(0, 12)}…`],
];

console.log(`${pkg.name}@${npmVersion}  sha256 ${npmSha}\n`);
for (const [label, ok, detail] of checks) console.log(`${ok ? '✓' : '✗'} ${label}  (${detail})`);
const failed = checks.filter(([, ok]) => !ok).length;
console.log(failed ? `\n${failed} out of sync` : '\nin sync');
process.exit(failed ? 1 : 0);
