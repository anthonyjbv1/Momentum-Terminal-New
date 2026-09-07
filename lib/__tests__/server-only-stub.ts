// Vitest alias target for the "server-only" package, which throws when
// imported outside a React Server Components environment. Tests import
// server modules directly, so the guard is replaced with this empty module.
export {};
