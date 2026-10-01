import { describe, expect, it } from "vitest";

import { storyRecords, storyRecordsPayload } from "./story-records";

describe("the story record a tick hands the database (Part B)", () => {
  it("keeps every cluster that confirmed at least one copy, with the leader, the headline and the members' matches", () => {
    const records = storyRecords("p-zuck", [
      { leaderId: "s1", leader: "recent", headline: "Loses $9 billion", members: [{ id: "s2", similarity: 0.353, anchor: "9 billion", fullImpact: -1.1, impact: -0.15 }] },
      { leaderId: "s3", leader: "tick", headline: "Alone", members: [] },
    ]);
    expect(records).toEqual([{ personId: "p-zuck", leaderId: "s1", headline: "Loses $9 billion", members: [{ id: "s2", similarity: 0.353, anchor: "9 billion" }] }]);
    expect(storyRecordsPayload(records)).toEqual([{ person_id: "p-zuck", leader_id: "s1", headline: "Loses $9 billion", members: [{ id: "s2", similarity: 0.353, anchor: "9 billion" }] }]);
  });
});
