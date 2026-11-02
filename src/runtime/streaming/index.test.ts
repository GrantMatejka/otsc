import { describe, expect, it } from "vitest";
import { parseSse } from "./index.js";

describe("SSE event IDs", () => {
  it("persists IDs across events and ID-only blocks, and supports resetting them", async () => {
    const encoder = new TextEncoder();
    async function* chunks() {
      for (const chunk of [
        "id: first\r", "\ndata: one\r\n\r\ndata: two\n\n",
        "id: second\n\ndata: three\n\nid: bad\0id\n\ndata: four\n\n",
        "id:\n\ndata: five\n\ndata: incomplete",
      ]) yield encoder.encode(chunk);
    }

    const events = [];
    for await (const event of parseSse(chunks())) events.push(event);
    expect(events).toEqual([
      { data: "one", id: "first" },
      { data: "two", id: "first" },
      { data: "three", id: "second" },
      { data: "four", id: "second" },
      { data: "five", id: "" },
    ]);
  });
});
