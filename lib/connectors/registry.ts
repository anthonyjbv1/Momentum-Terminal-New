import { apisportsConnector } from "./apisports";
import { billboardConnector } from "./billboard";
import { finnhubConnector } from "./finnhub";
import { forbesConnector } from "./forbes";
import { newsdataConnector } from "./newsdata";
import { rssConnector } from "./rss";
import { spotifyConnector } from "./spotify";
import { twitchConnector } from "./twitch";
import type { DataConnector } from "./types";
import { youtubeConnector } from "./youtube";

/**
 * Connector registry: data_sources.name -> implementation.
 *
 * To add a source: create lib/connectors/<name>.ts implementing DataConnector,
 * add it to the list below, insert a data_sources row with the same name, map
 * people to it in person_data_sources, then flip is_active. The runner picks
 * it up on the next run with no other code changes.
 */
const ALL_CONNECTORS: readonly DataConnector[] = [
  youtubeConnector,
  twitchConnector,
  spotifyConnector,
  forbesConnector,
  finnhubConnector,
  newsdataConnector,
  billboardConnector,
  apisportsConnector,
  rssConnector,
];

export type ConnectorRegistry = ReadonlyMap<string, DataConnector>;

export function buildRegistry(connectors: readonly DataConnector[]): ConnectorRegistry {
  const registry = new Map<string, DataConnector>();
  for (const connector of connectors) {
    if (registry.has(connector.name)) {
      throw new Error(`Duplicate connector registered for source "${connector.name}"`);
    }
    registry.set(connector.name, connector);
  }
  return registry;
}

export const connectorRegistry: ConnectorRegistry = buildRegistry(ALL_CONNECTORS);

/** Look up the connector for a data_sources.name, or undefined when none is registered. */
export function getConnector(name: string): DataConnector | undefined {
  return connectorRegistry.get(name);
}

export function listConnectorNames(): string[] {
  return [...connectorRegistry.keys()];
}
