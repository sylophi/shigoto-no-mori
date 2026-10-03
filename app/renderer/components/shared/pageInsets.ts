// The full-page insets on their own, in a leaf module the views can
// import (PageHeader.tsx reads whether there is a local host as it
// loads, which a view must not). PageHeader and PageShell re-export
// them from their old homes.

// One padding for both shells: the desktop pages sit under the window
// chrome, and since the web shell became a sidebar layout its pages
// have the same open canvas above them (the former slim-top-bar shell
// carried a pt-5 variant that no longer has a caller).
// The header's padding on its own, for the pages that draw a header of
// their own shape (the diff pages, the worktree detail) and still want
// to sit at the same inset, phone layout included.
export const PAGE_HEADER_PADDING =
  "px-6 pt-7 pb-4 phone:px-4 phone:pt-4 phone:pb-3";

// The scroll region under a page's header, exported for the pages that
// build their own column (tabs between header and body, a footer under
// it) and still want the same inset, the phone's narrower one included.
export const PAGE_BODY = "min-h-0 flex-1 overflow-y-auto p-6 phone:p-4";
