# Health playbook

1. Call the health tool once — it takes no arguments.
2. Report the `status` exactly as returned and the uptime as the number the server gave (do not
   round it, estimate it or invent one).
3. Commit to one status. If the tool failed, say the server is down; do not hedge between OK
   and DOWN.

Pitfalls: reporting a plausible uptime instead of the returned one, and answering without
having called the tool.
