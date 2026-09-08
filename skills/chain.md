# Chain playbook

The job has two calls, and the second one **depends on the first**.

1. Make the first call with the name you were given. Copy the `id` from its response exactly —
   it is freshly generated, so it cannot be guessed or reused from memory.
2. Make the second call with that `id` as the name. Do not send both calls at once: the second
   cannot be formed until the first has answered.
3. Report what the **second** response says, verbatim (and the first id where asked). Do not
   paraphrase the greeting or re-derive it from the pattern you expect.

Pitfall: firing both calls up front, or reporting the first greeting as if it were the second.
