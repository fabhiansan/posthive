// @vitest-environment jsdom
// The two separate facts about a design's review (an answer chip, and an "Unsubmitted changes" badge), the editor's Review
// button (it saves first), and the banner the editor shows when its design gets archived.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import type { ReviewSummary } from "@/lib/canvas";
import { REVIEW_LABEL, ReviewChips, ReviewComment, StatusChip } from "./ReviewChips";
import { ReviewAction, reviewHref } from "./ReviewAction";
import { SaveBanner, needsBanner } from "./SaveStatus";

const review = (over: Partial<ReviewSummary> = {}): ReviewSummary => ({
  latestReviewStatus: null, hasChangesSinceSubmitted: false, submissionNumber: null, submittedVersion: null, workingVersion: 1, submittedAt: null, latestReviewId: null, comment: null, decidedAt: null, ...over,
});

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("StatusChip and ReviewChips", () => {
  it("each answer has its own plain words", () => {
    expect(REVIEW_LABEL).toEqual({ pending: "In review", approved: "Approved", changes_requested: "Changes requested", superseded: "Replaced" });
    for (const status of ["pending", "approved", "changes_requested", "superseded"] as const) {
      render(<StatusChip status={status} />);
      expect(screen.getByText(REVIEW_LABEL[status])).toBeTruthy();
      cleanup();
    }
  });

  it("a design never submitted shows nothing at all", () => {
    const { container } = render(<ReviewChips review={review()} />);
    expect(container.innerHTML).toBe("");
  });

  it.each(["pending", "approved", "changes_requested"] as const)("%s with no new work: the chip only", (status) => {
    render(<ReviewChips review={review({ latestReviewStatus: status })} />);
    expect(screen.getByText(REVIEW_LABEL[status])).toBeTruthy();
    expect(screen.queryByText("Unsubmitted changes")).toBeNull();
  });

  it.each(["pending", "approved", "changes_requested"] as const)("%s WITH new work: the chip stays (an edit never clears it) and the badge is a second element beside it", (status) => {
    render(<ReviewChips review={review({ latestReviewStatus: status, hasChangesSinceSubmitted: true })} />);
    const chip = screen.getByText(REVIEW_LABEL[status]);
    const badge = screen.getByText("Unsubmitted changes");
    expect(chip).not.toBe(badge);
    expect(chip.parentElement).toBe(badge.parentElement); // siblings in one row, not one label
  });

  it("an archived design says so, keeps its last answer, and never offers 'Unsubmitted changes' (it can no longer be submitted)", () => {
    render(<ReviewChips review={review({ latestReviewStatus: "approved", hasChangesSinceSubmitted: true })} archived />);
    expect(screen.getByText("Archived")).toBeTruthy();
    expect(screen.getByText("Approved")).toBeTruthy();
    expect(screen.queryByText("Unsubmitted changes")).toBeNull();
  });

  it("the designer's comment shows for changes requested, and for nothing else", () => {
    render(<ReviewComment review={review({ latestReviewStatus: "changes_requested", comment: "Shorter headline" })} />);
    expect(screen.getByText(/Shorter headline/)).toBeTruthy();
    expect(screen.getByText("Changes requested:")).toBeTruthy();
    cleanup();
    for (const r of [review({ latestReviewStatus: "approved", comment: "Nice" }), review({ latestReviewStatus: "pending", comment: "x" }), review({ latestReviewStatus: "changes_requested", comment: null }), review()]) {
      const { container } = render(<ReviewComment review={r} />);
      expect(container.innerHTML).toBe("");
      cleanup();
    }
  });
});

describe("the editor's Review button", () => {
  const flushOk = () => vi.fn(async () => true);

  it("saves first, THEN goes to Compose with the design's id (encoded)", async () => {
    const order: string[] = [];
    const flush = vi.fn(async () => {
      order.push("flush");
      return true;
    });
    h.push.mockImplementation(() => order.push("push"));
    render(<ReviewAction designId="i/1" review={review()} flush={flush} />);
    await userEvent.click(screen.getByRole("button", { name: /Review/ }));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/compose?design=i%2F1"));
    expect(order).toEqual(["flush", "push"]);
    expect(reviewHref("a b")).toBe("/compose?design=a%20b");
  });

  it("if the save cannot be completed it stays on the page (submitting names the saved version, so an unsaved design is not sent)", async () => {
    const flush = vi.fn(async () => false);
    render(<ReviewAction designId="i1" review={review()} flush={flush} />);
    await userEvent.click(screen.getByRole("button", { name: /Review/ }));
    await waitFor(() => expect(flush).toHaveBeenCalled());
    expect(h.push).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: /Review/ }) as HTMLButtonElement).disabled).toBe(false); // and can be tried again
  });

  it("is available when nothing was submitted, or when there is new work; disabled with the reason when not", () => {
    const states: Array<[Partial<ReviewSummary>, boolean]> = [
      [{}, true],
      [{ latestReviewStatus: "pending", hasChangesSinceSubmitted: true }, true],
      [{ latestReviewStatus: "approved", hasChangesSinceSubmitted: true }, true],
      [{ latestReviewStatus: "changes_requested", hasChangesSinceSubmitted: true }, true],
      [{ latestReviewStatus: "pending" }, false],
      [{ latestReviewStatus: "approved" }, false],
      [{ latestReviewStatus: "changes_requested" }, false],
    ];
    for (const [over, can] of states) {
      render(<ReviewAction designId="i1" review={review(over)} flush={flushOk()} />);
      const button = screen.getByRole("button", { name: /Review/ }) as HTMLButtonElement;
      expect(button.disabled, JSON.stringify(over)).toBe(!can);
      if (!can) expect(button.title).toBe("Nothing has changed since you last submitted this design.");
      cleanup();
    }
  });

  it("shows the chips and the designer's comment beside the button", () => {
    render(<ReviewAction designId="i1" review={review({ latestReviewStatus: "changes_requested", hasChangesSinceSubmitted: true, comment: "Fix the date" })} flush={flushOk()} />);
    expect(screen.getByText("Changes requested")).toBeTruthy();
    expect(screen.getByText("Unsubmitted changes")).toBeTruthy();
    expect(screen.getByText(/Fix the date/)).toBeTruthy();
  });
});

describe("the save banner when a design is archived under an open editor", () => {
  it("is a banner state of its own, says archived (not deleted), keeps export and history, and leads back to Canvas", () => {
    expect(needsBanner("archived")).toBe(true);
    render(<SaveBanner state="archived" onReload={() => {}} onRetry={() => {}} />);
    expect(screen.getByText("This design was archived")).toBeTruthy();
    expect(screen.queryByText(/deleted/i)).toBeNull();
    expect(screen.getByText(/You can still export it/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Canvas" }).getAttribute("href")).toBe("/canvas");
  });

  it("the deleted banner is unchanged", () => {
    render(<SaveBanner state="deleted" onReload={() => {}} onRetry={() => {}} />);
    expect(screen.getByText("This design was deleted")).toBeTruthy();
  });
});
