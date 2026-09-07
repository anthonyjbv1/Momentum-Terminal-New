import type { DataConnector } from "./types";

/**
 * Interface-compliant connector that fetches nothing. Used for sources that
 * are registered in data_sources but not implemented yet, so that activating
 * a source later is just: fill in fetchForPerson, flip is_active.
 */
export function createStubConnector(name: string): DataConnector {
  return {
    name,
    async fetchForPerson() {
      return [];
    },
  };
}
