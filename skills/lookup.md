# Lookup playbook

Each name gets its own call, and the answer is whatever the server returned — not a guess.

1. Call the endpoint once per name, one name per call. Do not combine names in one request.
2. Copy each `id` exactly as returned; ids are freshly generated per call and cannot be predicted,
   shortened or reused from another call.
3. Report one entry per name with the name spelled as given and its id verbatim.

Pitfalls: greeting several names in one call, inventing or truncating an id, and reporting the
same id for two names.
