# Transform playbook

One call per name; then a transformation of what came back — never of what you expected to
come back.

1. Fetch each name separately (one request per name). Each response carries a `message` and a
   freshly generated `id`.
2. For each name, take the **first N characters of the id exactly as returned** (N is stated in
   the task; count carefully, do not round to a word boundary) and the message converted to
   upper case, character for character.
3. Report one entry per name in the format the task asks for. Keep the name spelled as given.

Pitfalls: reusing an id from an earlier call, truncating the id at the wrong length, and
retyping the message from memory instead of upper-casing the returned text.
