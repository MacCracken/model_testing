// Shared argument parser for the bench/aggregate CLIs.

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--task": args.task = next(); break;
      case "--tasks": args.task = next(); break; // alias
      case "--mode": args.mode = next(); break;
      case "--modes": args.mode = next(); break; // alias
      case "--provider": args.provider = next(); break;
      case "--model": args.model = next(); break;
      case "--clients": args.clients = next(); break;
      case "--count": args.count = Number(next()); break;
      case "--json": args.json = true; break;
      default: args._.push(a);
    }
  }
  return args;
}
