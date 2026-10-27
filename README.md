# metro-review-runner

Runs checks for the Metro review bot (`scripts/metro-review` in Rob's devroot) on GitHub-hosted Windows and Linux runners. The bot uses it for react/metro PRs by authors it doesn't trust to run code on its own machines: each request runs on a fresh VM with no secrets and a read-only token.

A request is an orphan branch `req/<id>` holding `request.json` (`{kind, args, timeout_minutes}`) and `files/`, dispatched with `gh workflow run run.yml --ref main -f metro_sha=<sha> -f request_ref=req/<id> -f request_id=<id> -f os=<windows-latest|ubuntu-latest>`. The result is uploaded as the `result` artifact, and the bot deletes the branch afterwards.
