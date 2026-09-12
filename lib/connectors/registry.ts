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
import { youtubeCommentsConnector } from "./youtube-comments";

/**
 * Connector registry: data_sources.name -> implementation.
 *
 * A connector is the code that can talk to a kind of upstream; a SOURCE is a
 * data_sources row (tier, poll interval, metric declarations) plus its
 * credentials in the environment. Adding a source is inserting the row and
 * mapping people to it; removing one is flipping is_active. Neither needs a
 * code change. To support a new kind of upstream: create
 * lib/connectors/<name>.ts implementing DataConnector and add it below.
 */
const ALL_CONNECTORS: readonly DataConnector[] = [
  youtubeConnector,
  youtubeCommentsConnector,
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
