"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { pickMovers, type HomeBoard } from "@/lib/home/board-model";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { SectionHeader } from "@/components/ui/page-header";

import { CategoryFilter } from "./category-filter";
import { PersonCard, PersonRow } from "./person-card";
import { logBoardEvent, usePersonImpressions } from "./use-impressions";

/**
 * The interactive half of Home: category filtering over the people the server
 * already loaded, plus the behavioural logging for the whole board.
 *
 * Filtering is instant because every person is already here — the server sends
 * all 16 and this only decides which to show.
 */
export interface PeopleBoardProps {
  board: HomeBoard;
  /** Behavioural logging runs only for a signed-in user. */
  loggingEnabled: boolean;
}

const SURFACE = "home";

export function PeopleBoard({ board, loggingEnabled }: PeopleBoardProps) {
  const [category, setCategory] = useState("all");
  const listRef = useRef<HTMLDivElement>(null);

  const people = useMemo(
    () => (category === "all" ? board.people : board.people.filter((person) => person.category === category)),
    [board.people, category],
  );

  // Featured people follow the filter, so "Creator" shows the top creators.
  const movers = useMemo(
    () => (category === "all" ? board.movers : pickMovers(people)),
    [board.movers, category, people],
  );

  usePersonImpressions(listRef, {
    enabled: loggingEnabled,
    surface: SURFACE,
    key: `${category}:${people.length}`,
  });

  useEffect(() => {
    logBoardEvent(loggingEnabled, { eventType: "view_feed", metadata: { feed: SURFACE } });
  }, [loggingEnabled]);

  const openPerson = (personId: string) =>
    logBoardEvent(loggingEnabled, { eventType: "view_person", personId, metadata: { source: `${SURFACE}_tap` } });

  return (
    <div ref={listRef} className="flex flex-col gap-10">
      <CategoryFilter options={board.categories} value={category} onChange={setCategory} />

      {people.length === 0 ? (
        <Card tone="ghost">
          <p className="px-6 py-10 text-center text-sm text-fg-muted">No people in this category yet.</p>
        </Card>
      ) : (
        <>
          <section className="flex flex-col gap-4">
            <SectionHeader
              title={board.hasMovement ? "Top movers" : "Leading the board"}
              meta={
                board.hasMovement ? (
                  "Last hour"
                ) : (
                  <Badge tone="warning" dot>
                    Awaiting first tick
                  </Badge>
                )
              }
            />
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              {movers.map((person) => (
                <PersonCard key={person.id} person={person} onOpen={() => openPerson(person.id)} />
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-4">
            <SectionHeader title="People" meta="Ranked by momentum" />
            <Card className="flex flex-col divide-y divide-line">
              {people.map((person) => (
                <PersonRow key={person.id} person={person} onOpen={() => openPerson(person.id)} />
              ))}
            </Card>
          </section>
        </>
      )}
    </div>
  );
}
