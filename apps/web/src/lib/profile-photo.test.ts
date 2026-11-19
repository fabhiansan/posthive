// What a chosen photo is checked for in the browser: type, weight, then pixels. Same numbers and words as the API.
import { describe, expect, it } from "vitest";
import { PHOTO_MAX_BYTES, photoFileProblem, photoSizeProblem } from "./profile-photo";

describe("photoFileProblem", () => {
  it("a JPG, PNG or WebP of up to 5 MB can be the photo", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp"]) expect(photoFileProblem({ type, size: 1000 })).toBeNull();
    expect(photoFileProblem({ type: "image/png", size: PHOTO_MAX_BYTES })).toBeNull(); // exactly 5 MB is allowed
  });

  it("anything else is refused by its type, with the words the API uses", () => {
    for (const type of ["image/gif", "image/svg+xml", "application/pdf", "text/plain", ""]) {
      expect(photoFileProblem({ type, size: 1000 })).toBe("That file isn't a JPG, PNG or WebP picture.");
    }
  });

  it("a file over 5 MB is refused by its weight", () => {
    expect(photoFileProblem({ type: "image/png", size: PHOTO_MAX_BYTES + 1 })).toBe("The picture is larger than 5 MB.");
  });

  it("the type is looked at first: a huge PDF is not a picture, and is told so", () => {
    expect(photoFileProblem({ type: "application/pdf", size: PHOTO_MAX_BYTES * 3 })).toBe("That file isn't a JPG, PNG or WebP picture.");
  });
});

describe("photoSizeProblem", () => {
  it("400 x 400 or more on both sides is enough", () => {
    expect(photoSizeProblem(400, 400)).toBeNull();
    expect(photoSizeProblem(4000, 3000)).toBeNull();
  });

  it("a picture that is small on either side is refused, with the size in the words", () => {
    const words = "The picture is smaller than 400 × 400 px. Use a bigger one.";
    expect(photoSizeProblem(399, 400)).toBe(words);
    expect(photoSizeProblem(400, 399)).toBe(words);
    expect(photoSizeProblem(100, 5000)).toBe(words);
  });
});
