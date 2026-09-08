# Hello playbook

1. Call the endpoint once per name, one name per call.
2. Take the `message` field from each response exactly as returned — do not rephrase, re-case
   or reconstruct it from the pattern you expect.
3. Report one entry per name with the name as given and its message verbatim.

Pitfalls: combining names in one call, and writing the greeting from memory instead of copying
the server's text.
