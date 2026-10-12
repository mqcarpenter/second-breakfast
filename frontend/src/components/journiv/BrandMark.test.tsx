import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BrandMark } from "./BrandMark";

describe("BrandMark", () => {
  it("renders a decorative mark from the shared app icon", () => {
    const { container } = render(<BrandMark />);
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("/pwa-192x192.png");
    expect(img?.getAttribute("alt")).toBe("");
    expect(img?.getAttribute("aria-hidden")).toBe("true");
    // An image, so it cannot follow the --brand accent a user may change.
    expect(container.innerHTML).not.toContain("var(--brand)");
  });

  it("pairs the mark with the Trapper Keeper wordmark for its accessible name", () => {
    const { container, getByText } = render(<BrandMark wordmark />);
    expect(getByText("Trapper Keeper")).toBeTruthy();
    expect(container.querySelector(".jv-brand-lockup")).not.toBeNull();
  });

  it("names a standalone mark from its title", () => {
    const { getByRole } = render(<BrandMark title="Trapper Keeper" />);
    expect(getByRole("img", { name: "Trapper Keeper" })).toBeTruthy();
  });

  it("sizes the mark from the size prop", () => {
    const { container } = render(<BrandMark size={40} />);
    const img = container.querySelector("img");
    expect(img?.getAttribute("width")).toBe("40");
    expect(img?.getAttribute("height")).toBe("40");
  });
});
