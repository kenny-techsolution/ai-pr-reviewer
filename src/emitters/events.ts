/**
 * Events JSONL emitter — writes one structured line per reviewer run to
 * `artifacts/events.jsonl`. This is the substrate the dashboard reads from
 * and what would feed Snowflake / BigQuery / Slack digests in production.
 *
 * Same schema, multiple consumers — events are the durable interface.
 */

import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { ReviewerEvent } from "../types/index.js";

export interface EventsEmitterResult {
  written: boolean;
  path: string;
  error?: string;
}

const DEFAULT_EVENTS_PATH = "artifacts/events.jsonl";

export function writeEvent(event: ReviewerEvent, eventsPath: string = DEFAULT_EVENTS_PATH): EventsEmitterResult {
  try {
    mkdirSync(dirname(eventsPath), { recursive: true });
    appendFileSync(eventsPath, JSON.stringify(event) + "\n", "utf8");
    return { written: true, path: eventsPath };
  } catch (err) {
    return { written: false, path: eventsPath, error: (err as Error).message };
  }
}
