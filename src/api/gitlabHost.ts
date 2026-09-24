import { call } from "./transport";

// The Rust setting is authoritative because background polling cannot read
// webview storage. These commands are registered by the integration slice.
export const getGitLabHost = () => call<string>("get_gitlab_host");
export const setGitLabHost = (host: string) => call<string>("set_gitlab_host", { host });
