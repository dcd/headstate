import { createContext, createElement, useContext, type ReactNode } from "react";

// `AuthGate` always provides this in the shipped tree. The default keeps
// standalone App and StatusBar tests on their existing authenticated path.
export type GitHubAuthAvailability = boolean | null;

const GitHubAuthAvailabilityContext = createContext<GitHubAuthAvailability>(true);

export function GitHubAuthProvider({
  available,
  children,
}: {
  available: GitHubAuthAvailability;
  children: ReactNode;
}) {
  return createElement(GitHubAuthAvailabilityContext.Provider, { value: available }, children);
}

export function useGitHubAuthAvailable(): GitHubAuthAvailability {
  return useContext(GitHubAuthAvailabilityContext);
}
