# Regex playbook

1. Use the matching tool, never a word-count or other unrelated tool — this job is about whether
   a pattern matches, nothing else.
2. Call it once per listed string, with the exact pattern the task gives (same anchors, same
   character classes) and the string exactly as listed. Test every string; skip none.
3. Record the tool's verdict per string and report it — a yes/no per string, in the task's
   format. Do not decide by eye when the tool has answered.

Pitfalls: paraphrasing the pattern, testing a string that is not in the list, forgetting one, and
letting your own reading override the tool's result.
