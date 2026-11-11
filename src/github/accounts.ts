// GitHub account index (M4 Task 02): usernames only, never secrets.
//
// The user's GitHub tokens live in the platform credential store; this
// settings key only remembers which accounts exist. The per-remote account
// resolution helper lived here while the PR list existed (M4-04, removed
// per user order) and was deleted with it.

/** Settings key holding the known GitHub usernames (never secrets). */
export const GITHUB_ACCOUNTS_KEY = "githubAccounts";
