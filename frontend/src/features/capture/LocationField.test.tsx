import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ online: true }));
vi.mock("../../app/offline/useOnlineStatus", () => ({
  useOnlineStatus: () => state.online,
}));
vi.mock("../../api/client/api", () => ({
  api: { searchLocation: vi.fn() },
}));

import { api } from "../../api/client/api";
import { type CaptureLocation, LocationField } from "./LocationField";
import { rememberPlace } from "./recentPlaces";

const search = vi.mocked(api.searchLocation);

function Harness({
  onChange,
}: {
  onChange: (v: CaptureLocation | null) => void;
}) {
  const [value, setValue] = useState<CaptureLocation | null>(null);
  return (
    <LocationField
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

const geolocation = {
  getCurrentPosition: vi.fn(),
};

beforeEach(() => {
  state.online = true;
  window.localStorage.clear();
  search.mockReset();
  geolocation.getCurrentPosition.mockReset();
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: geolocation,
  });
});

describe("LocationField", () => {
  it("uses a typed name as-is, with no coordinates and no network", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    await user.type(
      screen.getByLabelText("Or name a place"),
      "  Grandma's porch ",
    );
    await user.click(screen.getByRole("button", { name: "Use this name" }));

    expect(onChange).toHaveBeenCalledWith({
      place: { name: "Grandma's porch" },
      latitude: null,
      longitude: null,
    });
    expect(search).not.toHaveBeenCalled();
    expect(screen.getByText("Grandma's porch")).toBeTruthy();
  });

  it("searches on request and returns coordinates for the chosen result", async () => {
    search.mockResolvedValue({
      provider: "nominatim",
      results: [
        {
          name: "Blue Bottle, Oakland, California",
          latitude: 37.8,
          longitude: -122.27,
          locality: "Oakland",
          admin_area: "California",
          country: "United States",
          timezone: "America/Los_Angeles",
        },
      ],
    } as never);
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    await user.type(screen.getByLabelText("Or name a place"), "blue bottle");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.click(
      await screen.findByRole("button", { name: /Blue Bottle, Oakland/ }),
    );

    expect(search).toHaveBeenCalledWith("blue bottle");
    expect(onChange).toHaveBeenCalledWith({
      place: expect.objectContaining({
        name: "Blue Bottle, Oakland, California",
        locality: "Oakland",
      }),
      latitude: 37.8,
      longitude: -122.27,
    });
  });

  it("does not search until asked, so nothing leaves the network while typing", async () => {
    const user = userEvent.setup();
    render(<Harness onChange={vi.fn()} />);
    await user.type(screen.getByLabelText("Or name a place"), "somewhere");
    expect(search).not.toHaveBeenCalled();
  });

  it("explains a failed search and still lets the name be used", async () => {
    search.mockRejectedValue(new Error("503"));
    const user = userEvent.setup();
    render(<Harness onChange={vi.fn()} />);
    await user.type(screen.getByLabelText("Or name a place"), "cafe");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect((await screen.findByRole("status")).textContent).toMatch(
      /still use the name/i,
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Use this name",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("offline: search is off, Enter saves the name instead", async () => {
    state.online = false;
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    expect(
      (screen.getByRole("button", { name: "Search" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(/Search needs a connection/)).toBeTruthy();
    await user.type(
      screen.getByLabelText("Or name a place"),
      "Trailhead{Enter}",
    );
    expect(onChange).toHaveBeenCalledWith({
      place: { name: "Trailhead" },
      latitude: null,
      longitude: null,
    });
    expect(search).not.toHaveBeenCalled();
  });

  it("offers recent places, including offline, in one tap", async () => {
    state.online = false;
    rememberPlace({ place: { name: "Home" }, latitude: 1, longitude: 2 });
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Home" }));
    expect(onChange).toHaveBeenCalledWith({
      place: { name: "Home" },
      latitude: 1,
      longitude: 2,
    });
  });

  it("uses device GPS as unnamed coordinates, to be named at sync", async () => {
    geolocation.getCurrentPosition.mockImplementation((ok: PositionCallback) =>
      ok({
        coords: { latitude: 40.7128, longitude: -74.006 },
      } as GeolocationPosition),
    );
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Use my location" }));
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        place: { name: "" },
        latitude: 40.7128,
        longitude: -74.006,
      }),
    );
    expect(screen.getByText("40.7128, -74.0060")).toBeTruthy();
  });

  it("says so when GPS is unavailable", async () => {
    geolocation.getCurrentPosition.mockImplementation(
      (_ok: PositionCallback, fail: PositionErrorCallback) =>
        fail({ code: 1 } as GeolocationPositionError),
    );
    const user = userEvent.setup();
    render(<Harness onChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Use my location" }));
    expect((await screen.findByRole("status")).textContent).toMatch(
      /location access/i,
    );
  });

  it("can remove the chosen location", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    await user.type(screen.getByLabelText("Or name a place"), "Park");
    await user.click(screen.getByRole("button", { name: "Use this name" }));
    await user.click(screen.getByRole("button", { name: "Remove location" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByLabelText("Or name a place")).toBeTruthy();
  });
});
