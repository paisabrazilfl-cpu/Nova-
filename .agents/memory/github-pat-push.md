---
name: GitHub PAT git push
description: How to push to GitHub over HTTPS with a classic personal access token from this environment.
---

# Pushing with a GitHub PAT

The `AUTHORIZATION: bearer <PAT>` http.extraheader scheme is REJECTED by GitHub's
git endpoint for classic PATs ("invalid credentials / Authentication failed"),
even when the same token works fine for REST API calls (`Authorization: Bearer`).

**Use the token-in-URL form instead:**

```
git push "https://x-access-token:${TOKEN}@github.com/<owner>/<repo>.git" main:<branch>
```

Expand the token from env so it is never typed literally, and pipe output through
`sed -E 's/[A-Za-z0-9_]{20,}/[REDACTED]/g'` to avoid leaking it in logs.

**Why:** the bearer extraheader path cost two failed attempts before switching to
the URL form, which worked first try.

**How to apply:** any HTTPS git push/fetch needing PAT auth from this environment.
Prefer pushing to a NEW branch (non-destructive) when the remote default branch
has diverged from local history — never force-push without explicit user consent.
