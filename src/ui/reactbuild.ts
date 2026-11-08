// React, its JSX runtime and Ink's reconciler each pick a build from NODE_ENV when first loaded, so
// the TUI ran the development ones (~12% slower resume, ~10% more CPU). Scoped to the load because
// bash and every other child inherit process.env: `npm install` under production skips
// devDependencies. An explicit NODE_ENV is the user's and is left alone.
export async function loadWithProductionReact<T>(load: () => Promise<T>): Promise<T> {
  if (process.env.NODE_ENV !== undefined) return load();
  process.env.NODE_ENV = 'production';
  try {
    return await load();
  } finally {
    delete process.env.NODE_ENV;
  }
}
