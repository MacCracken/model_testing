// Shared argument parser for the bench/aggregate/serve CLIs.

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--task":
      case "--tasks": args.task = next(); break;
      case "--mode":
      case "--modes": args.mode = next(); break;
      case "--provider": args.provider = next(); break;
      case "--model": args.model = next(); break;
      case "--clients": args.clients = next(); break;
      case "--count": args.count = Number(next()); break;
      case "--port": args.port = Number(next()); break;
      case "--host": args.host = next(); break;
      case "--open": args.open = true; break;
      case "--json": args.json = true; break;
      case "--no-save": args.noSave = true; break;
      default: args._.push(a);
    }
  }
  return args;
}
