// React, its JSX runtime and Ink's reconciler each pick a build from NODE_ENV when first loaded, so
// the TUI ran the development ones (~12% slower resume, ~10% more CPU). Scoped to the load because
// bash and every other child inherit process.env: `npm install` under production skips
// devDependencies. An explicit NODE_ENV is the user's and is left alone. This is the source (tsx)
// path: the bundle fixes NODE_ENV at build time (scripts/build.mjs), and `env` is aliased so that
// substitution leaves these reads and writes as the real variable.
export async function loadWithProductionReact<T>(load: () => Promise<T>): Promise<T> {
  const env = process.env;
  if (env.NODE_ENV !== undefined) return load();
  env.NODE_ENV = 'production';
  try {
    return await load();
  } finally {
    delete env.NODE_ENV;
  }
}
