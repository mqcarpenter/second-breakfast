import { beforeEach, describe, expect, it } from "vitest";
import {
  forgetPlaces,
  MAX_RECENT_PLACES,
  readRecentPlaces,
  rememberPlace,
} from "./recentPlaces";

const at = (
  name: string,
  latitude: number | null = null,
  longitude: number | null = null,
) => ({
  place: { name },
  latitude,
  longitude,
});

beforeEach(() => window.localStorage.clear());

describe("recent places", () => {
  it("starts empty", () => {
    expect(readRecentPlaces()).toEqual([]);
  });

  it("keeps the newest first", () => {
    rememberPlace(at("Home"));
    rememberPlace(at("Cafe", 1, 2));
    expect(readRecentPlaces().map((p) => p.place.name)).toEqual([
      "Cafe",
      "Home",
    ]);
  });

  it("moves a repeat to the front instead of duplicating it", () => {
    rememberPlace(at("Home"));
    rememberPlace(at("Cafe", 1, 2));
    rememberPlace(at(" home "));
    expect(readRecentPlaces().map((p) => p.place.name)).toEqual([
      " home ",
      "Cafe",
    ]);
  });

  it("treats the same name at different coordinates as different places", () => {
    rememberPlace(at("Starbucks", 1, 1));
    rememberPlace(at("Starbucks", 2, 2));
    expect(readRecentPlaces()).toHaveLength(2);
  });

  it("caps the list", () => {
    for (let i = 0; i < MAX_RECENT_PLACES + 5; i += 1)
      rememberPlace(at(`P${i}`));
    const places = readRecentPlaces();
    expect(places).toHaveLength(MAX_RECENT_PLACES);
    expect(places[0]?.place.name).toBe(`P${MAX_RECENT_PLACES + 4}`);
  });

  it("ignores corrupt storage rather than throwing", () => {
    window.localStorage.setItem("journiv:capture:places", "{not json");
    expect(readRecentPlaces()).toEqual([]);
    window.localStorage.setItem(
      "journiv:capture:places",
      JSON.stringify([{ place: { name: "" } }, { nope: true }, at("Ok")]),
    );
    expect(readRecentPlaces().map((p) => p.place.name)).toEqual(["Ok"]);
  });

  it("can be cleared", () => {
    rememberPlace(at("Home"));
    forgetPlaces();
    expect(readRecentPlaces()).toEqual([]);
  });
});
