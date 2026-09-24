import type { Source } from "./identity";
import type { CiState, Label, ReviewState } from "./pr";

/// Rust gitlab::queues::MergeRequest. Null means the list did not measure it.
export interface MergeRequest {
  source: Source;
  id: number;
  number: number;
  title: string;
  url: string;
  repo: string;
  author: string;
  is_draft: boolean;
  head_ref: string;
  head_oid: string | null;
  base_ref: string;
  created_at: string;
  updated_at: string;
  labels: Label[];
  reviewers: string[];
  assignees: string[];
  comment_count: number;
  detailed_merge_status: string | null;
  ci: CiState | null;
  review: ReviewState | null;
  unresolved_threads: number | null;
}
