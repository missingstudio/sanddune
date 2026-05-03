export type HeadBranchStrategy = { readonly type: "head" };
export type MergeToHeadBranchStrategy = { readonly type: "merge-to-head" };

export type NamedBranchStrategy = {
  readonly type: "branch";
  readonly branch: string;
};

export type BranchStrategy =
  | HeadBranchStrategy
  | MergeToHeadBranchStrategy
  | NamedBranchStrategy;

export type NonHeadBranchStrategy = Exclude<BranchStrategy, HeadBranchStrategy>;
