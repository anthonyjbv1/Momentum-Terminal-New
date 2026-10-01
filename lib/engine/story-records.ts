import type { StoryCluster } from "./stories";

/**
 * THE STORY RECORD (Feed upgrade, Part B). What a tick hands the database
 * about the stories it confirmed: for each cluster with at least one
 * confirming member, the person, the leader signal, the leader's headline and
 * the members with the similarity and anchor they matched on. The database
 * (`record_story_clusters`) turns these into `stories` and `story_signals`
 * rows, idempotently. A cluster with no members is not a story yet and is
 * not sent.
 */
export interface StoryClusterRecord {
  personId: string;
  leaderId: string;
  headline: string;
  members: Array<{ id: string; similarity: number; anchor: string | null }>;
}

export function storyRecords(personId: string, clusters: readonly StoryCluster[]): StoryClusterRecord[] {
  return clusters
    .filter((cluster) => cluster.members.length > 0)
    .map((cluster) => ({
      personId,
      leaderId: cluster.leaderId,
      headline: cluster.headline,
      members: cluster.members.map((member) => ({ id: member.id, similarity: member.similarity, anchor: member.anchor })),
    }));
}

/** The RPC's argument shape, snake-cased. */
export function storyRecordsPayload(records: readonly StoryClusterRecord[]): Array<Record<string, unknown>> {
  return records.map((record) => ({
    person_id: record.personId,
    leader_id: record.leaderId,
    headline: record.headline,
    members: record.members.map((member) => ({ id: member.id, similarity: member.similarity, anchor: member.anchor })),
  }));
}
