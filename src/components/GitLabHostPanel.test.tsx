import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test-utils";

const getHost = vi.hoisted(() => vi.fn());
const setHost = vi.hoisted(() => vi.fn());
vi.mock("@/api/gitlabHost", () => ({ getGitLabHost: getHost, setGitLabHost: setHost }));

import { GitLabHostPanel } from "./GitLabHostPanel";

beforeEach(() => {
  getHost.mockReset().mockResolvedValue("gitlab.com");
  setHost.mockReset().mockResolvedValue("gitlab-fixture.k3s.dcd.cloud");
});

it("saves the explicit host and shows the desktop login command", async () => {
  renderWithQuery(<GitLabHostPanel />);
  const input = await screen.findByRole("textbox", { name: "GitLab host" });
  await waitFor(() => expect((input as HTMLInputElement).value).toBe("gitlab.com"));
  fireEvent.change(input, { target: { value: "gitlab-fixture.k3s.dcd.cloud" } });
  fireEvent.click(screen.getByRole("button", { name: "Save GitLab host" }));
  await waitFor(() => expect(setHost.mock.calls[0]?.[0]).toBe("gitlab-fixture.k3s.dcd.cloud"));
  await waitFor(() => expect(screen.getByText(/glab auth login --hostname gitlab-fixture.k3s.dcd.cloud/)).toBeTruthy());
});

it("shows a rejected save without claiming the host changed", async () => {
  setHost.mockRejectedValue("Enter a GitLab DNS hostname.");
  renderWithQuery(<GitLabHostPanel />);
  const input = await screen.findByRole("textbox", { name: "GitLab host" });
  await waitFor(() => expect((input as HTMLInputElement).value).toBe("gitlab.com"));
  fireEvent.change(input, { target: { value: "https://wrong.example" } });
  fireEvent.click(screen.getByRole("button", { name: "Save GitLab host" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Enter a GitLab DNS hostname.");
  expect((input as HTMLInputElement).value).toBe("https://wrong.example");
});
