// @vitest-environment jsdom
// The Canvas shell's small-screen behavior (Phase 7). jsdom cannot evaluate a media query, so these prove the RIGHT ELEMENTS exist with
// the classes that hide or show them; whether they really fit at 375px is for the QA checklist (a person on a real screen).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock("./AiChatPanel", () => ({ AiChatPanel: () => <div>assistant</div> }));

import { CanvasShell } from "./CanvasShell";
import { ExportMenu } from "./ExportMenu";

afterEach(cleanup);

const shell = (props: Partial<React.ComponentProps<typeof CanvasShell>> = {}) =>
  render(
    <CanvasShell title="Spring sale" toolbar={<span>tools</span>} actions={<span>actions</span>} layers={<span>layers</span>} properties={<span>properties</span>} {...props}>
      <div>stage</div>
    </CanvasShell>,
  );

describe("below the sm breakpoint", () => {
  it("shows a bar with the design's name and the larger-screen note, and hides it from sm up", () => {
    shell({ onRename: () => {} });
    const bar = screen.getByTestId("small-screen-bar");
    expect(bar.className).toContain("sm:hidden"); // only on a small screen
    expect(within(bar).getByText(/Canvas works best on a larger screen/)).toBeTruthy();
    expect(within(bar).getByText(/You can still edit here/)).toBeTruthy(); // the editor stays usable, the note only says what to expect
    expect((within(bar).getByLabelText("Design name") as HTMLInputElement).value).toBe("Spring sale");
  });

  it("the name there can be renamed (the top bar's own field is hidden below sm)", () => {
    const onRename = vi.fn();
    shell({ onRename });
    const field = within(screen.getByTestId("small-screen-bar")).getByLabelText("Design name") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "Summer sale" } });
    fireEvent.blur(field);
    expect(onRename).toHaveBeenCalledWith("Summer sale");
    // Escape cancels, like the top bar's field
    field.focus(); // jsdom only blurs a focused element, so without this the cancel could be removed and nothing would notice
    fireEvent.change(field, { target: { value: "Nope" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(document.activeElement).not.toBe(field);
    expect(onRename).toHaveBeenCalledTimes(1);
    expect((field as HTMLInputElement).value).toBe("Spring sale"); // the draft is dropped: the field shows the title again
  });

  it("a design that cannot be renamed (a Marketing design's title is fixed) shows the name as text, not a field", () => {
    shell();
    const bar = screen.getByTestId("small-screen-bar");
    expect(within(bar).queryByLabelText("Design name")).toBeNull();
    expect(within(bar).getByText("Spring sale")).toBeTruthy();
  });

  it("the top bar's own name field still exists for sm and up (hidden below)", () => {
    shell({ onRename: () => {} });
    const fields = screen.getAllByLabelText("Design name", { selector: "input" });
    expect(fields).toHaveLength(2); // one per breakpoint; CSS shows exactly one
    const top = fields.find((f) => !screen.getByTestId("small-screen-bar").contains(f))!;
    expect(top.closest("div")!.className).toContain("hidden"); // the wrapper is `hidden ... sm:flex`
    expect(top.closest("div")!.className).toContain("sm:flex");
  });
});

describe("actions give way to their icon below sm, with the words kept for screen readers", () => {
  it("Export keeps its accessible name, and its words are screen-reader-only on a small screen", () => {
    render(<ExportMenu width={1080} height={1080} busy={false} onExport={() => {}} />);
    const button = screen.getByRole("button", { name: "Export" }); // still found by its name
    const words = within(button).getByText("Export");
    expect(words.className).toContain("max-sm:sr-only");
  });
});
