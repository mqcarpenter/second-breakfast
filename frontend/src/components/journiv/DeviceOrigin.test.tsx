import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DeviceOrigin } from "./DeviceOrigin";

describe("DeviceOrigin", () => {
  it("marks an entry the server confirmed from the device queue", () => {
    render(<DeviceOrigin moment={{ client_id: "c-1" }} />);
    expect(screen.getByText("Synced from device")).toBeTruthy();
  });

  it("shows nothing for an ordinary entry or no moment", () => {
    const { container, rerender } = render(
      <DeviceOrigin moment={{ client_id: null }} />,
    );
    expect(container.innerHTML).toBe("");
    rerender(<DeviceOrigin moment={{}} />);
    expect(container.innerHTML).toBe("");
    rerender(<DeviceOrigin />);
    expect(container.innerHTML).toBe("");
  });
});
