// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TemplateCover } from "./TemplateCover";

afterEach(cleanup);

describe("TemplateCover", () => {
  it("shows the preview image when there is one", () => {
    const { container } = render(<TemplateCover template={{ category: "Case Study", previewUrl: "/uploads/p.png", slideImages: [{ url: "/uploads/s1.png", label: null }] }} />);
    expect(container.querySelector("img")!.getAttribute("src")).toContain("/uploads/p.png");
  });

  it("falls back to the first slide, so a carousel with no preview still has a face", () => {
    const { container } = render(<TemplateCover template={{ category: "Case Study", previewUrl: null, slideImages: [{ url: "/uploads/s1.png", label: "Cover" }, { url: "/uploads/s2.png", label: null }] }} />);
    expect(container.querySelector("img")!.getAttribute("src")).toContain("/uploads/s1.png");
  });

  it("with neither it is a plain tile with the category, and says there is no preview", () => {
    const { container } = render(<TemplateCover template={{ category: "Case Study", previewUrl: null, slideImages: [] }} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Case Study")).toBeTruthy();
    expect(screen.getByText("No preview")).toBeTruthy();
  });

  it("a caller that has no slide list (a post's reference) still works", () => {
    render(<TemplateCover template={{ category: "Blog Post", previewUrl: null }} />);
    expect(screen.getByText("No preview")).toBeTruthy();
  });
});
