// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  login: vi.fn(),
  loginWithCode: vi.fn(),
  refresh: vi.fn(async () => {}),
  replace: vi.fn(),
  search: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: h.replace, push: vi.fn() }),
  useSearchParams: () => h.search,
}));
vi.mock("../../context/AuthContext", () => ({ useAuth: () => ({ refresh: h.refresh }) }));
vi.mock("../../lib/auth", async (orig) => ({ ...(await orig<typeof import("../../lib/auth")>()), login: h.login, loginWithCode: h.loginWithCode }));

import LoginPage from "./page";

beforeEach(() => {
  h.login.mockReset();
  h.login.mockResolvedValue({ user: {} }); // what login() answers when the person is in
  h.loginWithCode.mockReset();
  h.loginWithCode.mockResolvedValue({});
  h.replace.mockReset();
  h.search = new URLSearchParams();
});

afterEach(cleanup);

async function fill(email = "puteri@example.com", password = "S3cret-pass!") {
  await userEvent.type(screen.getByLabelText("Email"), email);
  await userEvent.type(document.getElementById("password") as HTMLInputElement, password);
}

describe("login page", () => {
  it("the email field is the underline input of the dark panel", () => {
    render(<LoginPage />);
    const email = screen.getByLabelText("Email");
    expect(email.className).toContain("field-line");
    expect(email.getAttribute("type")).toBe("email");
    expect(email.getAttribute("autocomplete")).toBe("email");
    expect((email as HTMLInputElement).required).toBe(true);
  });

  it("'Keep me logged in' starts on", () => {
    render(<LoginPage />);
    expect(screen.getByRole("checkbox", { name: "Keep me logged in" }).getAttribute("aria-checked")).toBe("true");
  });

  it("logs in with remember = true by default and goes to /dashboard", async () => {
    render(<LoginPage />);
    await fill();
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    await waitFor(() => expect(h.login).toHaveBeenCalledWith("puteri@example.com", "S3cret-pass!", true));
    expect(h.refresh).toHaveBeenCalled();
    expect(h.replace).toHaveBeenCalledWith("/dashboard");
  });

  it("clicking the TEXT of the label turns it off, and the session-only flag reaches login()", async () => {
    render(<LoginPage />);
    await userEvent.click(screen.getByText("Keep me logged in"));
    expect(screen.getByRole("checkbox", { name: "Keep me logged in" }).getAttribute("aria-checked")).toBe("false");
    await fill();
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    await waitFor(() => expect(h.login).toHaveBeenCalledWith("puteri@example.com", "S3cret-pass!", false));
  });

  it("the checkbox works from the keyboard and toggles back on", async () => {
    render(<LoginPage />);
    const box = screen.getByRole("checkbox", { name: "Keep me logged in" });
    box.focus();
    await userEvent.keyboard(" ");
    expect(box.getAttribute("aria-checked")).toBe("false");
    await userEvent.keyboard(" ");
    expect(box.getAttribute("aria-checked")).toBe("true");
  });

  it("ticking the box does not submit the form", async () => {
    render(<LoginPage />);
    await userEvent.click(screen.getByText("Keep me logged in"));
    expect(h.login).not.toHaveBeenCalled();
  });

  it("follows a safe returnTo and ignores an unsafe one", async () => {
    h.search = new URLSearchParams({ returnTo: "/jobs?x=1" });
    const { unmount } = render(<LoginPage />);
    await fill();
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/jobs?x=1"));
    unmount();

    h.replace.mockReset();
    h.search = new URLSearchParams({ returnTo: "//evil.com" });
    render(<LoginPage />);
    await fill();
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/dashboard"));
  });

  it("a failed login shows the message, marks both fields invalid and stays on the page", async () => {
    h.login.mockRejectedValue(new Error("Email or password is incorrect."));
    render(<LoginPage />);
    await fill();
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Email or password is incorrect.");
    expect(screen.getByLabelText("Email").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByLabelText("Email").getAttribute("aria-describedby")).toBe("login-error");
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("while it logs in, the button says so and cannot be pressed again", async () => {
    let finish!: () => void;
    h.login.mockImplementation(() => new Promise((resolve) => { finish = () => resolve({ user: {} }); }));
    render(<LoginPage />);
    await fill();
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    const busy = await screen.findByRole("button", { name: "Logging in…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    finish();
    await waitFor(() => expect(h.replace).toHaveBeenCalled());
  });

  it("the submit button is the taller auth button", () => {
    render(<LoginPage />);
    const submit = screen.getByRole("button", { name: "Log in" });
    expect(submit.getAttribute("type")).toBe("submit");
    expect(submit.className.split(/\s+/)).toContain("h-12");
  });

  it("shows the message for an OAuth error that came back in the URL", () => {
    h.search = new URLSearchParams({ error: "google_email_unverified" });
    render(<LoginPage />);
    expect(screen.getByRole("alert").textContent).toContain("Google says this email isn't verified");
  });
});

describe("login page: two-step verification", () => {
  const CHALLENGE = "c".repeat(64);
  const digits = () => screen.getByLabelText("Digit 1 of 6");

  /** Types the password and gets to the code step, as a person with two-step on does. */
  async function reachCodeStep() {
    h.login.mockResolvedValue({ challenge: CHALLENGE });
    render(<LoginPage />);
    await fill();
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    await screen.findByText("Enter your code");
  }

  it("a right password that needs a code does not log in: the page asks for the code and opens nothing yet", async () => {
    await reachCodeStep();
    expect(h.replace).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Password")).toBeNull(); // the password form is gone while the code is asked for
  });

  it("the six digits go to the API with the challenge, then the person is in and goes where they were going", async () => {
    h.search = new URLSearchParams({ returnTo: "/jobs" });
    await reachCodeStep();
    await userEvent.type(digits(), "123456");
    await waitFor(() => expect(h.loginWithCode).toHaveBeenCalledWith(CHALLENGE, "123456"));
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/jobs"));
    expect(h.refresh).toHaveBeenCalled();
  });

  it("a wrong code is said in words, the boxes are cleared, and the same step stays for another try", async () => {
    h.loginWithCode.mockRejectedValue(new Error("That code isn't right. Check your app and try again."));
    await reachCodeStep();
    await userEvent.type(digits(), "000000");
    expect((await screen.findByRole("alert")).textContent).toContain("That code isn't right. Check your app and try again.");
    expect((digits() as HTMLInputElement).value).toBe("");
    expect(h.replace).not.toHaveBeenCalled();
    expect(screen.getByText("Enter your code")).toBeTruthy();
  });

  it("a recovery code can be typed instead, and goes to the API as typed", async () => {
    await reachCodeStep();
    await userEvent.click(screen.getByRole("button", { name: "Use a recovery code" }));
    expect(screen.getByText("Use a recovery code", { selector: "h1, h2" })).toBeTruthy();
    const field = screen.getByLabelText("Recovery code");
    const submit = screen.getByRole("button", { name: "Log in" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await userEvent.type(field, "abcde-fghjk");
    expect(submit.disabled).toBe(false);
    await userEvent.click(submit);
    await waitFor(() => expect(h.loginWithCode).toHaveBeenCalledWith(CHALLENGE, "abcde-fghjk"));
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/dashboard"));
  });

  it("something that cannot be a recovery code does not enable the button", async () => {
    await reachCodeStep();
    await userEvent.click(screen.getByRole("button", { name: "Use a recovery code" }));
    await userEvent.type(screen.getByLabelText("Recovery code"), "short");
    expect((screen.getByRole("button", { name: "Log in" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("when the sign-in ran out (5 wrong codes, or 5 minutes) the page goes back to the password with the reason", async () => {
    h.loginWithCode.mockRejectedValue(new Error("That sign-in took too long. Enter your email and password again."));
    await reachCodeStep();
    await userEvent.type(digits(), "123456");
    expect((await screen.findByRole("alert")).textContent).toContain("That sign-in took too long. Enter your email and password again.");
    expect(screen.getByLabelText("Email")).toBeTruthy(); // the email and password form is back
    expect((document.getElementById("password") as HTMLInputElement).value).toBe(""); // and the password is not kept
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("Back to log in returns to the form without an error", async () => {
    await reachCodeStep();
    await userEvent.click(screen.getByRole("button", { name: "Back to log in" }));
    expect(screen.getByLabelText("Email")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
